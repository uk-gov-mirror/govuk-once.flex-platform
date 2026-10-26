import { DOMAIN_REGION, DomainAccount } from "@repo/domain-infra";
import { Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

import type {
  DomainAccountConfig,
  EnvironmentConfig,
} from "../config/types.ts";

export function domainAccountStackName(
  environment: EnvironmentConfig,
  domainAccount: DomainAccountConfig,
): string {
  return `domain-${environment.name}-${domainAccount.name}`;
}

interface DomainAccountStackProps {
  readonly environment: EnvironmentConfig;
  readonly domainAccount: DomainAccountConfig;
}

/**
 * What every domain in a domain account shares in one environment. Built for every domain account,
 * whether or not it hosts a domain, so adding a domain never needs its account's stack deployed.
 */
export class DomainAccountStack extends Stack {
  constructor(
    scope: Construct,
    { environment, domainAccount }: DomainAccountStackProps,
  ) {
    super(scope, domainAccountStackName(environment, domainAccount), {
      description: `Flex domain account ${domainAccount.name} for the ${environment.name} environment`,
      env: { account: domainAccount.account, region: DOMAIN_REGION },
      // Deleting it would leave the account's API Gateway logging setting naming a deleted role,
      // and take the roles and certificate every domain in it uses.
      terminationProtection: true,
    });

    new DomainAccount(this, "DomainAccount", {
      environment: environment.name,
      zone: {
        zoneName: domainAccount.zone.name,
        hostedZoneId: domainAccount.zone.id,
      },
      // Every gateway is gateway-<environment>-<id>, and any domain may invoke any of them.
      gatewayFunctions: `gateway-${environment.name}-*`,
    });
  }
}
