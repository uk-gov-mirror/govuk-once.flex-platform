import { defineGateway } from "@repo/gateway-config";
import { noAuth, openapiRest } from "@repo/gateway-driver-openapi-rest";

import { REQUESTING } from "./config/requesting.ts";

export default defineGateway({
  id: "udp",
  description: "User Data Platform gateway",
  driver: openapiRest({
    // Pinned to the commit UDP last deployed to production, release v1.54.3 on 2026-08-14, not to
    // a branch: the schemas are derived from what this names, and a branch names something else
    // tomorrow. Moving it on is how this gateway takes a newer UDP.
    spec: "https://raw.githubusercontent.com/govuk-once/user-data-platform/7ed6c9a3c57c06a64995eaae00195189f533926b/docs/openapi.yml",
    // The upstream takes no credential yet. The deployment still names a secret, which must
    // be the empty object; a login flow, when the upstream gets one, replaces this definition.
    auth: noAuth(),
  }),
  // Every operation UDP describes under a path of its own, under the upstream's own names for
  // what they take.
  operations: {
    createUser: {
      description: "Create User Record",
      upstream: "POST /v1/user",
    },
    getIdentityExchange: {
      description: "Look up a linked identity record for a different service",
      upstream: "GET /v1/identity/exchange",
      parameters: {
        requiredService: { in: "query" },
        ...REQUESTING,
      },
    },
    getIdentity: {
      description: "Read Identity Record",
      upstream: "GET /v1/identity/{serviceName}/{identifier}",
      parameters: {
        serviceName: { in: "path" },
        identifier: { in: "path" },
      },
    },
    createIdentity: {
      description: "Create Identity Record",
      upstream: "POST /v1/identity/{serviceName}/{identifier}",
      parameters: {
        serviceName: { in: "path" },
        identifier: { in: "path" },
      },
    },
    deleteIdentity: {
      description: "Delete Identity Record",
      upstream: "DELETE /v1/identity/{serviceName}/{identifier}",
      parameters: {
        serviceName: { in: "path" },
        identifier: { in: "path" },
      },
    },
    getLinkedServices: {
      description: "Get All Linked Services",
      upstream: "GET /v1/identity/{serviceName}/{identifier}/linked-services",
      parameters: {
        serviceName: { in: "path" },
        identifier: { in: "path" },
      },
    },
    startDsar: {
      description: "Start a DSAR Request",
      upstream: "POST /v1/dsar",
      parameters: REQUESTING,
    },
    startSar: {
      description: "Start a SAR Request",
      upstream: "POST /v1/sar",
      parameters: REQUESTING,
    },
    getSarStatus: {
      description: "Get SAR Status",
      upstream: "GET /v1/sar/{sarId}",
      parameters: {
        sarId: { in: "path" },
        ...REQUESTING,
      },
    },
  },
});
