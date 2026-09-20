import { createHash, createHmac } from "node:crypto";

import type { SignatureV4 } from "@smithy/signature-v4";

import type { EmptySecret, OpenApiRestAuth } from "./auth.ts";
import { noAuth } from "./auth.ts";

// AWS Signature Version 4, for an upstream behind IAM authorisation: an API Gateway stage, say.
// Unlike a token, it is not a credential attached to a request but a signature over one, the
// method, the address, the headers and a hash of the body, which is why an authentication is
// shown the request it authenticates.
//
// The credentials are the gateway's own role's, from the platform's credential chain, and never
// a secret's: a role's credentials are short-lived and renewed by the platform, where a key in
// a secret is neither. What may call the upstream is then granted where the role is defined.
// The deployment still names a secret, which must be the empty object, as for an upstream that
// takes no credential.
//
// The region and the service are the upstream's, and part of what is signed. They are the same
// wherever the gateway is deployed, so they are configuration and not deployment values.

export interface SigV4Options {
  // What the upstream is, as AWS names it for signing: "execute-api" for an API Gateway stage.
  readonly service: string;
  // The region the upstream is in, which need not be the gateway's.
  readonly region: string;
}

interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

// What a test supplies in place of the platform's: credentials that are not a role's, and a
// time that is not now.
export interface SigV4Deps {
  readonly credentials?: () => Promise<Credentials>;
  readonly now?: () => Date;
}

type Bytes = string | ArrayBuffer | ArrayBufferView;

const bytes = (data: Bytes): string | Uint8Array =>
  typeof data === "string"
    ? data
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);

// SHA-256 as the signer asks for it, keyed or not, on the runtime's own implementation.
class Sha256 {
  readonly #hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;

  constructor(secret?: Bytes) {
    this.#hash =
      secret === undefined
        ? createHash("sha256")
        : createHmac("sha256", bytes(secret));
  }

  update(data: Bytes): void {
    this.#hash.update(bytes(data));
  }

  digest(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.#hash.digest()));
  }
}

// The header a payload hash is written in. The signer takes the value already on a request as
// the hash rather than computing one from the body, so a request that carried its own would be
// signed over a body it did not send: a caller mapping this header and sending
// "UNSIGNED-PAYLOAD" would sign every body the same. It is the authentication's, so nothing
// else may set it, and it is taken off whatever reaches the signer.
const PAYLOAD_HASH = "x-amz-content-sha256";

// The headers a signature travels in. The session token is a role's; a long-lived key has none.
const OWNED = [
  "authorization",
  PAYLOAD_HASH,
  "x-amz-date",
  "x-amz-security-token",
];

// A query name an object literal reads as its prototype rather than as a name. The signer
// canonicalises a query through an ordinary object, so such a name would be left out of the
// signature while the request still carried it, and the upstream would check a signature over a
// query it did not receive. A null-prototype object here would not help: the loss is the
// signer's, which is not this driver's to change.
const UNSIGNABLE_QUERY = "__proto__";

// What this signs for. Signing is not one algorithm with a service name in it: S3 wants the
// payload hash in a header and its path left unnormalised, and others differ again. What is
// listed is what this was written for; another is added by implementing what it asks for rather
// than by naming it, so one that is merely named is refused.
const SERVICES: ReadonlySet<string> = new Set(["execute-api"]);

function checked(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^[a-z0-9-]+$/.test(value)) {
    throw new TypeError(
      `sigV4 auth: ${what} must be a name of lowercase letters, digits and hyphens`,
    );
  }
  return value;
}

// The signing itself, under whatever service name it is given: AWS publishes the examples this
// is checked against under names no upstream has. Not exported from the package, so a gateway
// reaches this only through `sigV4`, which is where a service is held to one this signs for.
export function sigV4With(
  options: SigV4Options,
  deps: SigV4Deps = {},
): OpenApiRestAuth<EmptySecret> {
  const service = checked(options.service, "service");
  const region = checked(options.region, "region");

  return {
    validateSecret: noAuth().validateSecret,
    headers: OWNED,
    create: () => {
      // Loaded on the first request, not when the configuration is: codegen evaluates a
      // configuration and has no use for a signer, and a static import of the credential chain
      // could not be tree-shaken, so every gateway would carry it and not only those that sign.
      let signing: Promise<SignatureV4>;
      const signer = () =>
        (signing ??= (async () => {
          const { SignatureV4 } = await import("@smithy/signature-v4");
          const credentials =
            deps.credentials ??
            (
              await import("@aws-sdk/credential-provider-node")
            ).defaultProvider();
          return new SignatureV4({
            service,
            region,
            credentials,
            sha256: Sha256,
            // The hash of the body is part of what is signed either way; the header that
            // repeats it is for services that ask for it, which an API Gateway stage does not.
            applyChecksum: false,
          });
        })());

      return {
        async headers({ method, url, headers, body }) {
          const query: Record<string, string | string[]> = {};
          for (const name of new Set(url.searchParams.keys())) {
            if (name === UNSIGNABLE_QUERY) {
              throw new TypeError(
                `sigV4 auth: a query parameter named "${UNSIGNABLE_QUERY}" cannot be signed, and a request carrying one would be refused`,
              );
            }
            const values = url.searchParams.getAll(name);
            query[name] = values.length === 1 ? (values[0] ?? "") : values;
          }
          // The host is signed, and is the transport's to send: it is named here so the
          // signature covers the one the request goes to. The payload hash is not taken from
          // what reached here; the signer computes it from the body below.
          const given: Record<string, string> = {
            ...Object.fromEntries(headers),
            host: url.host,
          };
          delete given[PAYLOAD_HASH];

          const signed = await (
            await signer()
          ).sign(
            {
              method,
              protocol: url.protocol,
              hostname: url.hostname,
              ...(url.port === "" ? {} : { port: Number(url.port) }),
              path: url.pathname,
              query,
              headers: given,
              ...(body === undefined ? {} : { body }),
            },
            deps.now === undefined ? {} : { signingDate: deps.now() },
          );

          const found = new Headers(signed.headers);
          return Object.fromEntries(
            OWNED.flatMap((name) => {
              const value = found.get(name);
              return value === null ? [] : [[name, value]];
            }),
          );
        },
      };
    },
  };
}

export function sigV4(options: SigV4Options): OpenApiRestAuth<EmptySecret> {
  const service = checked(options.service, "service");
  if (!SERVICES.has(service)) {
    throw new TypeError(
      `sigV4 auth: service "${service}" is not one this signs for (${[...SERVICES].join(", ")}): it puts the payload hash in the signature rather than in a header, and leaves the path to be normalised, neither of which every service accepts`,
    );
  }
  return sigV4With(options);
}
