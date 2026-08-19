# CLAUDE.md

The source of convention for AI agents in this repository, and a reference for humans. Read it
before making changes.

## What this is

Flex is the GOV.UK Once platform; this repo (`flex-platform`) is its multi-domain monorepo.
Domains are self-contained areas of the platform that share a common toolchain (`packages/*`) but
own their own code and lifecycle. Each domain lives in its own top-level directory.

- `gateways/` is the gateways domain (the only one so far, and the focus of everything below).
- Future domains will be added as sibling top-level directories. Keep domain-specific code inside
  its domain; `packages/` is only for tooling shared across every domain.

### The gateways domain

A set of internal services ("gateways") that mediate all access to third-party APIs. Each gateway
owns exactly one upstream. Consumers get a stable, typed RPC interface and never talk to a third
party directly.

The concept is simple: you write a `gateway.config.ts`, and codegen tooling produces the rest.
All the complexity (resilience such as timeouts, retries, circuit breaking and rate limits;
credential custody; contract validation; error normalisation) lives behind that tooling, not in
the gateway you author. Keep it that way. If a change pushes complexity back out into the
authoring surface or the consumer surface, it is probably wrong.

- No HTTP anywhere in this design. Consumers invoke gateways via `lambda:InvokeFunction`
  (`RequestResponse`), in-VPC. One Lambda per upstream.
- Upstreams are data, not code. A small set of drivers interprets config. `openapi-rest` is the
  only driver being built. A new transport is a new driver package, never a change to the runtime.
- Everything publishes under the `@govuk-once/` scope to GitHub Packages.

## Current state: M1 (walking skeleton)

The repo is early. Most packages named below are not built yet. M1's goal: one gateway, one
operation, running end-to-end against a stubbed upstream, exercised by tests, with no AWS, no
network, and no infrastructure.

What exists today:

- `packages/tsconfig`, `packages/eslint-config`, `packages/vitest-config`: shared tooling.
- `gateways/shared/config` (`@govuk-once/flex-gateway-config`): stub (`export {}`).
- `gateways/services/udp` (`@govuk-once/flex-gateway-udp`): stub service. `udp` is the first real
  gateway. (Some design notes use `acme-billing` as a placeholder example name; the real service
  is `udp`.)

What M1 will add (see build order below): `flex-gateway-runtime`, `flex-gateway-driver-openapi-rest`,
`flex-gateway-codegen`, `flex-gateway-client`, and the `udp` gateway's config plus its end-to-end
test.

Deferred past M1: CDK/infra (M4), real JWT verification (post-M1), working
breaker/limiter/retry/budget and Valkey `PolicyStore` (M2), `testkit` (M2), contract
snapshots/differ/`published/` (M3), generated types and generated client package (M3), portal (M5).

## Commands

Run from the repo root. Turborepo orchestrates per-package tasks.

```bash
pnpm install          # link workspace; run after adding/removing a package
pnpm lint             # eslint, all packages
pnpm typecheck        # tsc --noEmit, all packages
pnpm build            # tsc --build per package (depends on ^build + codegen)
pnpm test             # vitest run (depends on build)
```

Per package: `pnpm --filter <name> <script>`.

Never use `npx`/`npm`/`yarn`/`pnpx`; they are denied. Use `pnpm exec`.

## Toolchain

| | |
|---|---|
| Runtime | Node 24 (`.nvmrc`), ESM throughout, async handlers only |
| Language | TypeScript `strict: true`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` |
| Package manager | pnpm workspaces (version pinned in root `packageManager`) |
| Task runner | Turborepo |
| Bundler | esbuild (`format: esm`, `platform: node`, `target: node24`); not wired yet |
| Tests | Vitest (`globals: false`; import `describe`/`it`/`expect` explicitly) |
| Validation | Ajv standalone mode for contracts; Zod 4 for authoring escape-hatch handler schemas |
| JWT | `jose` (stubbed in M1) |
| Logging | pino, with a default-deny allowlist serializer |

Do not guess dependency versions or APIs. Check what is installed, or ask. Version pins are exact
(`savePrefix: ""`); keep them exact.

## Repository conventions

- Configuration is per package. Every package owns its own `tsconfig.json`, `eslint.config.ts`,
  and `vitest.config.ts`, each extending a shared base from `packages/*`. There is no root-level
  tsconfig/eslint/vitest config. Add a root-level tool config only if a tool genuinely cannot
  function otherwise, with a comment saying why.
- Where code lives: anything gateway-specific goes under `gateways/`, with services in
  `gateways/services/` and their libraries in `gateways/shared/`. Root `packages/` is reserved for
  tooling shared across every domain (tsconfig/eslint/vitest). A library used only by gateways
  does not belong in `packages/`, even when it looks generic.
- tsconfig bases: `base.json` (noEmit, strict), `library.json` (emits `.d.ts` plus maps, for
  shared packages), `lambda.json` (emits JS, no declarations, for services).
- ESLint presets (`@repo/eslint-config`): `base`, `driver`, `service`. `driver` and `service` add
  `no-restricted-globals` on `fetch` plus restricted imports of `node:http`, `node:https`, and
  `undici`. Driver and service packages must use the `driver`/`service` preset.
- Generated and build artifacts are gitignored: `.gen/`, `dist/`, `*.tsbuildinfo`, `.turbo/`,
  `cdk.out/`, `coverage/`. Do not commit them. The only committed generated artifact (from M3) is
  `published/`.

## Load-bearing invariants

These are the rules whose violation is silent: the build stays green while the thing quietly
breaks. Treat them as non-negotiable unless a change is explicitly agreed.

1. The driver seam is transport-neutral. `flex-gateway-runtime` and `flex-gateway-codegen` must
   never know about paths, HTTP methods, status codes, or headers; those live only inside a
   driver. Contracts cross the seam as JSON Schema, and driver-private state is opaque. If the
   runtime or codegen starts needing HTTP vocabulary, the seam has broken; stop and fix it rather
   than routing around it. (Grep both at the end of M1.)

2. Drivers reach the network only through `ctx.call`. The runtime yields a policy-wrapped
   `GatewayClient` inside `ctx.call(fn)`, and one `ctx.call` is one metered upstream unit. Raw
   `fetch`/`node:http`/`node:https`/`undici` in a driver or service is banned (ESLint enforces it,
   and the seam makes it structural). Do not replace the global `fetch` with the wrapped client:
   the AWS SDK shares that global, and its Secrets Manager/SSM calls would wrongly flow through the
   upstream's breaker and budget.

3. The dispatcher order is fixed. Parse envelope, verify token (stubbed in M1, but keep the call
   site wired), route on `op`, validate input (`INVALID_INPUT`, no upstream call), check `secure`
   bindings (`SECURE_VALUE_MISMATCH`), derive deadline, run pipeline, validate the outcome payload
   (`UPSTREAM_CONTRACT_VIOLATION`), record health, wrap envelope. Config is validated at module
   load, so a malformed policy fails cold start. Unknown `op` returns `OPERATION_NOT_FOUND` in the
   envelope; any uncaught error returns `INTERNAL`. Nothing throws out of the handler except
   genuine crashes.

4. Failures are data on the wire, typed errors at the consumer. The response envelope carries
   `{ ok: false, error }`, and the client turns that back into a thrown typed error. Success
   payloads are named outcomes with a uniform `{ outcome, data }` wrapper, even for single-outcome
   operations (an upstream field named `outcome` cannot collide with the discriminant).

5. The error taxonomy declares health semantics per code, as data. Adding a code forces stating
   what it means for the breaker. Non-obvious rulings: `NOT_FOUND` and `UPSTREAM_REJECTED` count as
   upstream success (a healthy upstream answering correctly, and counting them as failures trips
   breakers during 404 bursts); `UPSTREAM_CONTRACT_VIOLATION` counts as upstream failure. The
   breaker gates in-pipeline (fast-fail while open) but records at the top level after output
   validation.

6. Logging is default-deny. Nothing from an upstream payload is logged unless named in an
   operation's `log.fields`. A new upstream field must never be able to become a new log leak.
   Tests grep captured output for secrets, tokens, and unallowlisted fields.

7. Contracts are additive-only (M3). The contract only ever grows; there is no breaking-change
   path. A genuinely breaking change is a new gateway (`udp-v2`), not a version bump. The differ
   compares against every published version and fails closed on any construct it does not
   recognise.

8. Client `maxAttempts: 1` on the SDK, non-negotiable. The AWS SDK otherwise retries 5xx and
   throttling with no idempotency awareness, turning one slow-but-successful invoke into two
   upstream writes. Retries belong in the gateway, where the budget lives. It looks like an
   oversight, so keep the source comment explaining why.

9. The client stays thin. `flex-gateway-client` must not transitively pull in the runtime,
   drivers, or codegen. Consumers ship types only, with no Ajv and no schemas (the gateway already
   validated).

10. Nothing in code names an environment. Function names compose from an env-var prefix plus
    gateway id at module load. A deployed name containing `dev` is a fact about the deployment, not
    the code.

## M1 build order

Each step leaves something runnable. Step 5 is the risk: build the seams between packages, not
packages to completion in isolation.

1. Scaffolding: root files, three shared tooling packages, and empty workspace packages.
2. `flex-gateway-config`: types, `defineGateway` (must preserve literal types for operation keys),
   presets, type-level tests. Zero runtime dependencies.
3. Runtime skeleton: envelope, error taxonomy with health metadata, dispatcher steps 1 to 6 plus
   10, stub driver.
4. Driver seam plus `ctx.call`: `DriverContext`, wrapped client, in-memory `PolicyStore`, pipeline
   with pass-through stages (only the timeout is real in M1; composition and ordering must be
   correct now, bodies land in M2).
5. `openapi-rest`: build-time schema emission first, then the runtime path.
6. `codegen`: `loadConfig` (jiti, no build step), `emitValidators` (Ajv standalone), `emitEntry`.
   Wire validation into dispatcher steps 4 and 8.
7. `client`: invoke wrapper and error classes.
8. `udp`: config, local HTTP stub, and an end-to-end test through the real dispatcher and driver.

M1 is done when `pnpm test` passes from a clean clone with no AWS creds and no network; a test
drives the real dispatcher through the real `openapi-rest` driver against a local HTTP stub and
gets `{ outcome, data }`; input, outcome, secure, and error-taxonomy behaviour all match the
invariants above; a driver provably cannot reach the network outside `ctx.call`; no secret appears
in logs; esbuild bundles the generated entry point; and every package has its own tsconfig, eslint,
and vitest config.

## Gotchas

- Tests use `globals: false`; import from `vitest` explicitly.
- `pnpm test` depends on `build`, and `build`/`typecheck` depend on `^build` plus `codegen`. A
  stale `dist/` in a dependency can mask changes, so rebuild if results look wrong.
- Keep `CHANGELOG.md` and `published/**` out of `build.inputs` in `turbo.json`, or every release
  busts the cache.
- `codegen` depends on `^build` in `turbo.json` because it reads dependencies' `dist/`. Without
  that dependency it could run before those packages build, since `build` depending on both
  `^build` and `codegen` does not order the two against each other.
- `defineGateway` returning a widened type (`string` instead of the literal operation-key union)
  silently breaks downstream codegen typing. This is load-bearing; assert it at the type level.
