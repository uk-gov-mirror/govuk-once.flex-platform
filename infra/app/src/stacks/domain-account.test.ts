import { cdkApp } from "@repo/infra-constructs";
import { Match, Template } from "aws-cdk-lib/assertions";
import { CloudFormationStackArtifact } from "aws-cdk-lib/cx-api";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../../test/helpers.ts";
import {
  DomainAccountStack,
  domainAccountStackName,
} from "./domain-account.ts";

const PROD = FIXTURE_STAGES[2];
const [DEV] = PROD.environments;

describe("DomainAccountStack", () => {
  it("is one per domain account in every environment, hosting a domain or not, in eu-west-2, protected from deletion", () => {
    const assembly = synthesizedStage(PROD);

    const domainAccounts = PROD.environments.flatMap((environment) =>
      environment.domainAccounts.map((domainAccount) => ({
        environment,
        domainAccount,
      })),
    );

    // The prod environment's second account hosts no domain.
    expect(
      domainAccounts.some(
        ({ domainAccount }) => domainAccount.domains.length === 0,
      ),
    ).toBe(true);

    for (const { environment, domainAccount } of domainAccounts) {
      const stack = assembly.getStackByName(
        domainAccountStackName(environment, domainAccount),
      );

      expect(stack.environment).toMatchObject({
        account: domainAccount.account,
        region: "eu-west-2",
      });
      expect(stack.terminationProtection).toBe(true);
      expect(
        stack.dependencies.filter(
          (dependency) => dependency instanceof CloudFormationStackArtifact,
        ),
      ).toEqual([]);
    }
  });

  it("builds what the account's domains share, for its environment and zone", () => {
    const [domainAccount] = DEV.domainAccounts;

    if (domainAccount === undefined) throw new Error("No domain account");

    const template = Template.fromStack(
      new DomainAccountStack(cdkApp(), { environment: DEV, domainAccount }),
    );

    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: `*.${domainAccount.zone.name}`,
      DomainValidationOptions: [
        {
          DomainName: `*.${domainAccount.zone.name}`,
          HostedZoneId: domainAccount.zone.id,
        },
      ],
    });
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: `domain-${DEV.name}-execution`,
      Policies: [
        {
          PolicyName: "Execution",
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Action: "lambda:InvokeFunction",
                Effect: "Allow",
                Resource: `arn:aws:lambda:eu-west-2:${domainAccount.account}:function:gateway-${DEV.name}-*`,
              },
            ]),
          },
        },
      ],
    });
  });

  it("names its stack from the environment and the account", () => {
    const [domainAccount] = DEV.domainAccounts;

    if (domainAccount === undefined) throw new Error("No domain account");

    expect(domainAccountStackName(DEV, domainAccount)).toBe("domain-dev-main");
  });
});
