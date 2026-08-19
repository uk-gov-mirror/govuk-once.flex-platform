# Flex

The monorepo for Flex, the GOV.UK Once platform. It is organised into domains: self-contained
areas of the platform that share a common toolchain but own their own code, contracts, and
lifecycle.

## Domains

| Domain | Location | What it is |
|---|---|---|
| Gateways | `gateways/` | Internal services that sit between our services and third-party APIs. |

More domains will be added alongside this one. Each lives in its own top-level directory and
carries its own README.

Tooling shared by every domain (TypeScript, ESLint, Vitest configs) lives in `packages/`.
Anything specific to a single domain stays inside that domain.

## The gateways domain

Each gateway owns exactly one upstream. Instead of calling a third party directly, a service
calls a gateway and gets a stable, typed interface, consistent errors, and built-in resilience
(timeouts, retries, circuit breaking, rate limiting). Upstream credentials never leave the
gateway.

You author a gateway with one config file, and codegen produces the rest:

1. Author a gateway by writing a `gateway.config.ts` describing the upstream and its operations.
2. Codegen turns that config into the contract, validators, the deployable handler, and a typed
   client.
3. Consume it by installing the generated client and calling a method:

   ```ts
   const result = await udp.getThing({ id: "123" });
   return result.data;
   ```

The moving parts live behind the tooling, so the authoring and consumer surfaces stay small.

```
gateways/shared/     Libraries that make gateways work (runtime, client, codegen, drivers)
gateways/services/   The gateways themselves, one per upstream
```

Each library and gateway has its own README covering its specifics.

## Working in this repo

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

Node 24, pnpm, Turborepo. Requires access to the `@govuk-once` scope on GitHub Packages.

Conventions and invariants for this repo live in [`CLAUDE.md`](./CLAUDE.md). It is the source of
convention for AI agents and a useful reference for humans too.
