import { createHash, createHmac } from "node:crypto";

import { defineGateway } from "@repo/gateway-config";
import { describe, expect, it, vi } from "vitest";

import {
  fakeFetch,
  fakeSecret,
  json,
  passthroughContext,
} from "../../test/helpers.ts";
import { buildExecutor } from "../runtime/executor.ts";
import type { OpenApiRestAuthDeps, OpenApiRestAuthRequest } from "./auth.ts";
import { openapiRest } from "./definition.ts";
import { sigV4, sigV4With } from "./sigv4.ts";

// The credentials and the moment of AWS's own published examples. Not a real key.
const EXAMPLE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const AT = new Date("2015-08-30T12:36:00Z");

const DEPS = {} as OpenApiRestAuthDeps<Record<never, never>>;

const request = (
  overrides: Partial<OpenApiRestAuthRequest> & { url: URL },
): OpenApiRestAuthRequest => ({
  operation: "op",
  signal: new AbortController().signal,
  method: "GET",
  headers: new Headers(),
  body: undefined,
  ...overrides,
});

const signing = (
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  } = EXAMPLE,
  options = { service: "service", region: "us-east-1" },
) =>
  sigV4With(options, {
    credentials: () => Promise.resolve(credentials),
    now: () => AT,
  }).create(DEPS);

// Signature Version 4 worked through from its specification, with nothing of the signer's: the
// same answer from two implementations is what says either is right.
function bySpecification(
  { method, url, headers, body }: OpenApiRestAuthRequest,
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  },
  { service, region }: { service: string; region: string },
  at = "20150830T123600Z",
): string {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const hmac = (key: string | Buffer, text: string) =>
    createHmac("sha256", key).update(text).digest();
  const rfc3986 = (text: string) =>
    encodeURIComponent(text).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );

  const date = at.slice(0, 8);
  const all = new Headers(headers);
  all.set("host", url.host);
  all.set("x-amz-date", at);
  if (credentials.sessionToken !== undefined) {
    all.set("x-amz-security-token", credentials.sessionToken);
  }
  const names = [...all.keys()].sort();
  const canonical = [
    method,
    url.pathname.split("/").map(rfc3986).join("/"),
    [...url.searchParams]
      .map(([name, value]) => `${rfc3986(name)}=${rfc3986(value)}`)
      .sort()
      .join("&"),
    ...names.map(
      (name) => `${name}:${(all.get(name) ?? "").trim().replace(/\s+/g, " ")}`,
    ),
    "",
    names.join(";"),
    sha(body ?? ""),
  ].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", at, scope, sha(canonical)].join("\n");
  const key = [date, region, service, "aws4_request"].reduce<string | Buffer>(
    (derived, part) => hmac(derived, part),
    `AWS4${credentials.secretAccessKey}`,
  );
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
}

describe("sigV4", () => {
  it("signs AWS's own published example as AWS does", async () => {
    // "get-vanilla" from the Signature Version 4 test suite.
    const headers = await signing().headers(
      request({ url: new URL("https://example.amazonaws.com/") }),
    );

    expect(headers).toEqual({
      authorization:
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
      "x-amz-date": "20150830T123600Z",
    });
  });

  it("signs the method, the address, the headers and the body, as the specification works them out", async () => {
    const credentials = { ...EXAMPLE, sessionToken: "SYNTHETIC-SESSION-TOKEN" };
    const options = { service: "execute-api", region: "eu-west-2" };
    const posted = request({
      method: "POST",
      url: new URL(
        "https://abc123.execute-api.eu-west-2.amazonaws.com/prod/v1/groups?pushID=p%201&b=2&a=1",
      ),
      headers: new Headers({
        accept: "application/json",
        "content-type": "application/json",
        "x-api-version": "2",
      }),
      body: '[{"Namespace":"n","Group":"g","Action":"JOIN"}]',
    });

    const headers = await signing(credentials, options).headers(posted);

    expect(headers).toEqual({
      authorization: bySpecification(posted, credentials, options),
      "x-amz-date": "20150830T123600Z",
      "x-amz-security-token": "SYNTHETIC-SESSION-TOKEN",
    });
    expect(headers.authorization).toContain(
      "SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token;x-api-version",
    );
  });

  it("signs a name the query repeats, and a path the address encodes", async () => {
    const options = { service: "execute-api", region: "eu-west-2" };
    // Both are canonicalised before they are signed: a segment is escaped again, so what the
    // path already encodes is signed as written, and a repeated name is signed as every value
    // it carries. Signing either as the transport does not send it is refused by the upstream.
    const sent = request({
      url: new URL(
        "https://abc123.execute-api.eu-west-2.amazonaws.com/prod/a%20b/c%2Fd?id=2&id=1&q=a%20b",
      ),
    });

    const headers = await signing(EXAMPLE, options).headers(sent);

    expect(headers.authorization).toBe(bySpecification(sent, EXAMPLE, options));
  });

  it("signs what the transport sends, on credentials the platform's chain read", async () => {
    // `sigV4` itself, which takes no credentials: these are the environment's, as the chain
    // reads a deployed gateway's role from it. SYNTHETIC values, and no key of anyone's.
    const credentials = {
      accessKeyId: "AKIDSYNTHETIC",
      secretAccessKey: "SYNTHETIC-SECRET-ACCESS-KEY",
      sessionToken: "SYNTHETIC-SESSION-TOKEN",
    };
    vi.stubEnv("AWS_ACCESS_KEY_ID", credentials.accessKeyId);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", credentials.secretAccessKey);
    vi.stubEnv("AWS_SESSION_TOKEN", credentials.sessionToken);

    const options = { service: "execute-api", region: "eu-west-2" };
    const ff = fakeFetch(() => json(200, { id: "u1" }));
    const gateway = defineGateway({
      id: "signed",
      driver: openapiRest({
        spec: "https://example.test/openapi.yml",
        auth: sigV4(options),
      }),
      operations: {
        getUser: {
          upstream: "GET /users/{id}",
          parameters: { id: { in: "path" } },
        },
      },
    });
    const execute = await buildExecutor(
      gateway,
      {
        target: "https://abc123.execute-api.eu-west-2.amazonaws.com/prod",
        secret: fakeSecret({}).provider,
      },
      { fetch: ff.fetch },
    );

    await execute(passthroughContext(), "getUser", { id: "u 1" });

    const [sent] = ff.calls;
    const signed = new Headers(sent?.init.headers);
    // What the signature is over is the rest of the request as it went out, so the signature's
    // own headers come off and the worked example puts back the ones it accounts for.
    const carried = new Headers(signed);
    for (const owned of [
      "authorization",
      "x-amz-content-sha256",
      "x-amz-date",
      "x-amz-security-token",
    ]) {
      carried.delete(owned);
    }

    expect(signed.get("x-amz-security-token")).toBe(credentials.sessionToken);
    expect(signed.get("authorization")).toBe(
      bySpecification(
        request({ url: new URL(sent?.url ?? ""), headers: carried }),
        credentials,
        options,
        signed.get("x-amz-date") ?? "",
      ),
    );
  });

  it("hashes the body it is given, whatever a request claims the hash is", async () => {
    const url = new URL("https://example.amazonaws.com/things");
    const signed = (headers: Headers, body: string) =>
      signing().headers(request({ method: "POST", url, headers, body }));
    const claimed = new Headers({ "x-amz-content-sha256": "UNSIGNED-PAYLOAD" });

    // The claim is not what is signed: the same body signs the same way with it and without.
    expect((await signed(claimed, '{"a":1}')).authorization).toBe(
      (await signed(new Headers(), '{"a":1}')).authorization,
    );

    // And two bodies still sign differently, which is what the claim would have taken away.
    expect((await signed(claimed, '{"a":1}')).authorization).not.toBe(
      (await signed(claimed, '{"a":2}')).authorization,
    );
  });

  it("refuses a query name it could not put in the signature", async () => {
    // The signer canonicalises a query through an ordinary object, so this name would be left
    // out of the signature while the request still carried it, and the upstream would check a
    // signature over a query it did not receive.
    const url = new URL("https://example.amazonaws.com/things");
    url.searchParams.set("__proto__", "one");

    await expect(signing().headers(request({ url }))).rejects.toThrow(
      /a query parameter named "__proto__" cannot be signed/,
    );
  });

  it("signs for the services it signs correctly for, and no others", () => {
    expect(() =>
      sigV4({ service: "execute-api", region: "eu-west-2" }),
    ).not.toThrow();
    // S3 wants the payload hash in a header and its path left unnormalised; this does neither.
    for (const service of ["s3", "glacier"]) {
      expect(() => sigV4({ service, region: "eu-west-2" })).toThrow(
        /is not one this signs for \(execute-api\)/,
      );
    }
  });

  it("signs a different body differently, so what was signed is what must be sent", async () => {
    const url = new URL("https://example.amazonaws.com/things");
    const one = await signing().headers(
      request({ method: "POST", url, body: "{}" }),
    );
    const other = await signing().headers(
      request({ method: "POST", url, body: '{"a":1}' }),
    );

    expect(one.authorization).not.toBe(other.authorization);
  });

  it("owns the headers a signature travels in, and takes no credential from a secret", () => {
    const definition = sigV4({ service: "execute-api", region: "eu-west-2" });

    expect(definition.headers).toEqual([
      "authorization",
      // The payload hash is a header a caller must not supply: the signer would sign that value
      // rather than the body, and "UNSIGNED-PAYLOAD" would sign every body alike.
      "x-amz-content-sha256",
      "x-amz-date",
      "x-amz-security-token",
    ]);
    expect(definition.validateSecret({})).toBe(true);
    expect(definition.validateSecret({ accessKeyId: "SYNTHETIC" })).toBe(false);
  });

  it("asks the credential chain once, and only when a request is signed", async () => {
    const credentials = vi.fn(() => Promise.resolve(EXAMPLE));
    const instance = sigV4With(
      { service: "service", region: "us-east-1" },
      { credentials, now: () => AT },
    ).create(DEPS);
    expect(credentials).not.toHaveBeenCalled();

    const url = new URL("https://example.amazonaws.com/");
    await instance.headers(request({ url }));
    await instance.headers(request({ url }));

    // The signer asks each time; what it is given is the provider, which renews for itself.
    expect(credentials).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a service", { service: "", region: "eu-west-2" }],
    ["a region", { service: "execute-api", region: "EU West" }],
    ["either", { service: "execute-api" } as never],
  ])("refuses a configuration without %s it can sign for", (_what, options) => {
    expect(() => sigV4(options)).toThrow(TypeError);
  });
});
