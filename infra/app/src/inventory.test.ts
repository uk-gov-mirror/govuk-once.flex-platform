import { cdkApp } from "@repo/infra-constructs";
import { sortedNames } from "@repo/utils/sorted-names";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../test/helpers.ts";
import { buildApp } from "./build-app.ts";
import { selectTarget } from "./config/select-target.ts";
import { STAGES } from "./config/stages.ts";
import type { EnvironmentConfig, StageConfig } from "./config/types.ts";
import { inventory, type StackInventory } from "./inventory.ts";
import { domainStackName } from "./stacks/domain.ts";
import { domainAccountStackName } from "./stacks/domain-account.ts";

// A version's logical ID carries its code's hash, and Lambda@Edge's code bakes in each
// environment's issuers, so it changes with any change to either. A new version replacing the
// old one is how Lambda@Edge deploys.
function withoutVersions(stacks: StackInventory[]): StackInventory[] {
  return stacks.map((stack) => ({
    ...stack,
    resources: stack.resources.filter(
      (resource) => resource.type !== "AWS::Lambda::Version",
    ),
  }));
}

function synthesized(stage: StageConfig): StackInventory[] {
  const app = cdkApp();
  buildApp(app, stage, selectTarget(stage, undefined));
  return withoutVersions(inventory(app.synth()));
}

// An environment's stacks by kind, each with the names and accounts config gave it replaced by
// what they stand for. Environments host different domains in different accounts, so each kind is
// compared with its own kind.
function environmentShapes(
  stacks: readonly StackInventory[],
  environment: EnvironmentConfig,
) {
  const byName = new Map(stacks.map((stack) => [stack.name, stack]));

  const stack = (name: string) => {
    const found = byName.get(name);

    if (found === undefined) throw new Error(`No stack named ${name}`);

    return found;
  };

  // Stack names are {section}-{environment}, then any -{thing} and -{region}. Environment names
  // are platform names, so they hold nothing a regular expression reads specially.
  const environmentName = new RegExp(`^([a-z0-9]+)-${environment.name}(?=-|$)`);
  const named = (name: string) =>
    name.replace(environmentName, "$1-{environment}");

  const frontdoorStacks = stacks.filter(
    ({ account }) => account === environment.frontdoor.account,
  );

  const frontdoorNames = new Set(frontdoorStacks.map(({ name }) => name));

  const frontdoor = new Map(
    frontdoorStacks.map((frontdoorStack) => [
      named(frontdoorStack.name),
      {
        ...frontdoorStack,
        name: named(frontdoorStack.name),
        account: "{frontdoor}",
        // Which domains it waits for is config, not shape.
        dependencies: frontdoorStack.dependencies
          .filter((name) => frontdoorNames.has(name))
          .map(named),
      },
    ]),
  );

  const accounts = environment.domainAccounts.map((domainAccount) => ({
    ...stack(domainAccountStackName(environment, domainAccount)),
    name: "domain-{environment}-{account}",
    account: "{domain account}",
  }));

  // CDK ends an API's deployment ID with a hash of the API, so a new deployment replaces the old one
  // whenever it changes. Each domain's API differs, so the hash does too.
  const withoutDeploymentHash = (resources: StackInventory["resources"]) =>
    resources.map((resource) =>
      resource.type === "AWS::ApiGateway::Deployment"
        ? {
            ...resource,
            logicalId: resource.logicalId.replace(/[0-9a-f]{32}$/, ""),
          }
        : resource,
    );

  const domains = environment.domainAccounts.flatMap((domainAccount) =>
    domainAccount.domains.map((domain) => {
      const accountStack = domainAccountStackName(environment, domainAccount);
      const domainStack = stack(domainStackName(environment, domain));

      return {
        ...domainStack,
        name: "domain-{environment}-{domain}",
        account: "{domain account}",
        resources: withoutDeploymentHash(domainStack.resources),
        dependencies: domainStack.dependencies.map((name) =>
          name === accountStack ? "domain-{environment}-{account}" : name,
        ),
      };
    }),
  );

  return {
    // Re-sorted: replacing the name can change where a stack sorts.
    frontdoor: sortedNames(frontdoor.keys()).map((name) => frontdoor.get(name)),
    accounts,
    domains,
  };
}

describe("inventory", () => {
  // An environment built differently in one stage, such as with `if (prod)`, fails here. The
  // committed stages are checked too, since only they hold the real environments' names.
  it.each([
    ["the fixture stages", FIXTURE_STAGES],
    ["the committed stages", STAGES],
  ] as const)(
    "builds each kind of stack the same in every environment in %s, names and accounts aside",
    (_, stages) => {
      const shapes = stages.flatMap((stage) => {
        const stacks = withoutVersions(inventory(synthesizedStage(stage)));

        return stage.environments.map((environment) =>
          environmentShapes(stacks, environment),
        );
      });

      const frontdoors = shapes.map(({ frontdoor }) => frontdoor);
      const accounts = shapes.flatMap(({ accounts }) => accounts);
      const domains = shapes.flatMap(({ domains }) => domains);

      expect(frontdoors[0]).not.toHaveLength(0);
      expect(accounts).not.toHaveLength(0);
      expect(domains).not.toHaveLength(0);

      for (const kind of [frontdoors, accounts, domains]) {
        for (const shape of kind) expect(shape).toEqual(kind[0]);
      }
    },
  );

  // A changed logical ID replaces its resource, so the change shows in review. Built from the
  // committed stages, so a config change shows what it does to the real stacks too.
  it.each(STAGES.map((stage) => [stage.name, stage] as const))(
    "matches the committed inventory of %s",
    async (name, stage) => {
      const stacks = withoutVersions(inventory(synthesizedStage(stage)));

      await expect(`${JSON.stringify(stacks, null, 2)}\n`).toMatchFileSnapshot(
        `__snapshots__/inventory.${name}.json`,
      );
    },
  );

  // Config lists are in whatever order someone wrote them, so no logical ID may depend on it.
  it("changes no logical ID when every list in config is reversed", () => {
    const issuers = [
      {
        issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_first",
        clientIds: ["first-a", "first-b"],
      },
      {
        issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_second",
        clientIds: ["second-a", "second-b"],
      },
    ];
    const [, , prod] = FIXTURE_STAGES;
    const stage: StageConfig = {
      ...prod,
      environments: prod.environments.map((environment) => ({
        ...environment,
        frontdoor: { ...environment.frontdoor, issuers },
      })),
    };
    const reversed: StageConfig = {
      ...stage,
      environments: stage.environments.toReversed().map((environment) => ({
        ...environment,
        domainAccounts: environment.domainAccounts
          .toReversed()
          .map((domainAccount) => ({
            ...domainAccount,
            domains: domainAccount.domains.toReversed(),
          })),
        frontdoor: {
          ...environment.frontdoor,
          issuers: issuers.toReversed().map((issuer) => ({
            ...issuer,
            clientIds: issuer.clientIds.toReversed(),
          })),
        },
      })),
    };

    expect(synthesized(reversed)).toEqual(synthesized(stage));
  });
});
