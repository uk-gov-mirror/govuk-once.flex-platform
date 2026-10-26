import { DOMAIN_REGION } from "@repo/domain-infra";
import { SIGNING_REGION } from "@repo/frontdoor-origin-request";
import { cdkApp } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { CloudFormationStackArtifact } from "aws-cdk-lib/cx-api";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../../test/helpers.ts";
import { DomainStack, domainStackName } from "./domain.ts";
import { domainAccountStackName } from "./domain-account.ts";
import { frontdoorStackName } from "./frontdoor.ts";

const PROD = FIXTURE_STAGES[2];
const [DEV] = PROD.environments;

describe("DomainStack", () => {
  it("is in the region the edge signs requests for", () => {
    expect(DOMAIN_REGION).toBe(SIGNING_REGION);
  });

  it("is one per domain, in the account that hosts it, deployed after that account's stack and before the edge", () => {
    const assembly = synthesizedStage(PROD);

    for (const environment of PROD.environments) {
      const frontdoor = assembly.getStackByName(
        frontdoorStackName(environment),
      );

      for (const domainAccount of environment.domainAccounts) {
        for (const domain of domainAccount.domains) {
          const stack = assembly.getStackByName(
            domainStackName(environment, domain),
          );

          expect(stack.environment).toMatchObject({
            account: domainAccount.account,
            region: "eu-west-2",
          });
          expect(stack.terminationProtection).toBe(false);
          expect(
            stack.dependencies
              .filter(
                (dependency) =>
                  dependency instanceof CloudFormationStackArtifact,
              )
              .map(({ id }) => id),
          ).toEqual([domainAccountStackName(environment, domainAccount)]);
          expect(frontdoor.dependencies.map(({ id }) => id)).toContain(
            domainStackName(environment, domain),
          );
        }
      }
    }
  });

  it("builds the domain's API under its account's zone, letting in the environment's edge role", () => {
    const [domainAccount] = DEV.domainAccounts;
    const [domain] = domainAccount?.domains ?? [];

    if (domainAccount === undefined || domain === undefined) {
      throw new Error("No domain");
    }

    const template = Template.fromStack(
      new DomainStack(cdkApp(), { environment: DEV, domainAccount, domain }),
    );

    template.hasResourceProperties("AWS::ApiGateway::DomainName", {
      DomainName: `${domain}.${domainAccount.zone.name}`,
    });
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      HostedZoneId: domainAccount.zone.id,
    });
    template.hasResourceProperties("AWS::ApiGateway::RestApi", {
      Policy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${DEV.frontdoor.account}:root` },
            Condition: {
              ArnEquals: {
                "aws:PrincipalArn": `arn:aws:iam::${DEV.frontdoor.account}:role/frontdoor-${DEV.name}-edge`,
              },
            },
          }),
        ]),
      },
    });
  });

  it("names its stack from the environment and the domain", () => {
    expect(domainStackName(DEV, "domain-a")).toBe("domain-dev-domain-a");
  });
});
