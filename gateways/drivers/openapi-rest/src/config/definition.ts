import type {
  AnyOperations,
  DriverDefinition,
  ExecutorOptions,
  GatewayConfig,
} from "@repo/gateway-config";
import type { JSONSchema } from "@repo/gateway-types";

import type { MetadataConfig } from "../metadata.ts";
import {
  type HttpMethod,
  OPENAPI_REST_DRIVER_TYPE,
  type OpenApiRestHandler,
} from "../types.ts";
import type { OpenApiRestAuth } from "./auth.ts";
import { checkOperationSchemas } from "./check.ts";

// Behaviour lives here, reviewed with the gateway. Deployment values such as the target and
// the secret arrive as executor options instead.
export interface OpenApiRestDriverConfig {
  // Location of the OpenAPI document describing the upstream: an https URL, or a path within
  // the gateway's directory. The gateway's schemas are derived from it when someone runs
  // `gateway-schemas`; nothing fetches it at runtime or when generating.
  readonly spec: string;
  // Static headers sent on every request, such as an API version.
  readonly headers?: Readonly<Record<string, string>>;
  // Largest response body the driver buffers, in bytes. Defaults to 1 MiB.
  readonly maxResponseBytes?: number;
  // What the gateway reports about an exchange beside its result, by the name a caller reads it
  // under: the response header it is read from, and the schema of the scalar it carries. An
  // upstream's own id for a request, say. Returned on a failure as on a success, and logged.
  readonly metadata?: MetadataConfig;
  // How requests are authenticated: bearerToken(), apiKey() or noAuth() from this package, or
  // a definition written with defineAuth. It says what the secret must hold and which headers
  // it owns. Required, so a gateway that sends no credential says so.
  readonly auth: OpenApiRestAuth;
}

// This package's own export of what derives a gateway's schemas from `spec`.
const DERIVE_MODULE = "@repo/gateway-driver-openapi-rest/derive";

export type UpstreamTemplate = `${HttpMethod} /${string}`;

// Where one input field goes, in the OpenAPI document's own vocabulary. `name` is the upstream
// parameter or header when it differs from the input field.
export interface ParameterMapping {
  readonly in: "path" | "query" | "header";
  readonly name?: string;
}

// The caller's input is one flat object and does not know how it maps to HTTP. The operation
// declares that per field: a path parameter, a query parameter or a header. Every path
// parameter in the template needs an entry. The request body, when there is one, travels under
// the top-level `payload` field.
// What an operation says about its schemas that the upstream's document cannot. Each is set
// beside what the document says, as a second part of an `allOf`, so it can make a schema admit
// less and never more or other than the upstream describes.
export interface OperationNarrowing {
  // The request body, where the document types it no further than "an object".
  readonly payload?: JSONSchema;
  // An outcome's data, by the outcome's name.
  readonly outcomes?: Readonly<Record<string, JSONSchema>>;
}

export type OpenApiRestOperationFields = {
  readonly upstream: UpstreamTemplate;
  readonly parameters?: Readonly<Record<string, ParameterMapping>>;
  // The path template of the upstream's document that serves this operation's path, where the
  // document does not declare the path itself: "/v1/{resourcePath+}" for "GET /v1/notifications".
  // Said, never inferred. A template that takes any path serves one the document has not
  // described, so nothing in the document says what this operation sends or gets back; an
  // operation that goes through one does so because someone wrote that it should, and deriving
  // fails for a path the document lacks and no `matches` accounts for. The request is sent to
  // the path in `upstream` either way; only deriving reads this.
  readonly matches?: `/${string}`;
  // What such a template leaves unsaid. It holds data of any shape, so the shape a gateway's
  // own services keep there is theirs to state.
  readonly narrow?: OperationNarrowing;
};

export interface OpenApiRestDriver
  extends
    DriverDefinition<OpenApiRestOperationFields, OpenApiRestHandler>,
    OpenApiRestDriverConfig {
  readonly type: typeof OPENAPI_REST_DRIVER_TYPE;
}

export type OpenApiRestGatewayConfig = GatewayConfig<
  OpenApiRestDriver,
  AnyOperations<OpenApiRestDriver>
>;

export function openapiRest(
  config: OpenApiRestDriverConfig,
): OpenApiRestDriver {
  return {
    type: OPENAPI_REST_DRIVER_TYPE,
    // Loaded on first call, not at import, so codegen never evaluates the runtime.
    createExecutor: (
      config: OpenApiRestGatewayConfig,
      options: ExecutorOptions,
    ) =>
      import("../runtime/executor.ts").then((m) =>
        m.createExecutor(config, options),
      ),
    // Build-time only, so it is imported statically: nothing here reaches the network, a
    // secret or the environment.
    checkSchemas: checkOperationSchemas,
    // Named, never imported: what it needs to read an OpenAPI document must not follow this
    // module into a deployed gateway, and the bundler follows every import it can see.
    deriveSchemasModule: DERIVE_MODULE,
    spec: config.spec,
    auth: config.auth,
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    ...(config.maxResponseBytes !== undefined
      ? { maxResponseBytes: config.maxResponseBytes }
      : {}),
    ...(config.metadata !== undefined ? { metadata: config.metadata } : {}),
  };
}
