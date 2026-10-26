import { ORIGIN_REQUEST_LOG_REGION } from "@repo/frontdoor-infra";
import { BucketHttpsCheck, LogGroupCheck } from "@repo/infra-constructs";
import type { App } from "aws-cdk-lib";
import { Aspects, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";

import type { Target } from "./config/select-target.ts";
import type { StageConfig } from "./config/types.ts";
import { DomainStack } from "./stacks/domain.ts";
import { DomainAccountStack } from "./stacks/domain-account.ts";
import { FrontdoorStack } from "./stacks/frontdoor.ts";
import { FrontdoorEdgeLogsStack } from "./stacks/frontdoor-edge-logs.ts";
import { StackTags } from "./tags.ts";

export function buildApp(app: App, stage: StageConfig, target: Target): void {
  // Everything that applies to the whole app: the synth checks, and the one aspect. Add any other
  // here.
  Validations.of(app).addPlugins(
    new AwsSolutionsChecks(app, { verbose: true }),
    new LogGroupCheck(),
    new BucketHttpsCheck(),
  );
  Aspects.of(app).add(new StackTags(stage));

  for (const environment of target.environments) {
    const edgeLogs = new FrontdoorEdgeLogsStack(
      app,
      environment,
      ORIGIN_REQUEST_LOG_REGION,
    );
    const frontdoor = new FrontdoorStack(app, environment);

    frontdoor.addStackDependency(
      edgeLogs,
      "The edge's Lambda@Edge role attaches the policy the edge logs stack creates, to write to its log group.",
    );

    for (const domainAccount of environment.domainAccounts) {
      const account = new DomainAccountStack(app, {
        environment,
        domainAccount,
      });

      for (const domain of domainAccount.domains) {
        const domainStack = new DomainStack(app, {
          environment,
          domainAccount,
          domain,
        });

        domainStack.addStackDependency(
          account,
          "The domain's API reads the account's certificate ARN, invokes through its integration role and logs through its API Gateway logging setting.",
        );
        frontdoor.addStackDependency(
          domainStack,
          "The edge routes to every domain's host, which must exist before it does.",
        );
      }
    }
  }
}
