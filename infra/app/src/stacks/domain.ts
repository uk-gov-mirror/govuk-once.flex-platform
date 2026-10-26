import { Domain, DOMAIN_REGION } from "@repo/domain-infra";
import { edgeRoleName } from "@repo/frontdoor-infra";
import { Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

import type {
  DomainAccountConfig,
  EnvironmentConfig,
} from "../config/types.ts";

export function domainStackName(
  environment: EnvironmentConfig,
  domain: string,
): string {
  return `domain-${environment.name}-${domain}`;
}

interface DomainStackProps {
  readonly environment: EnvironmentConfig;
  readonly domainAccount: DomainAccountConfig;
  readonly domain: string;
}

export class DomainStack extends Stack {
  constructor(
    scope: Construct,
    { environment, domainAccount, domain }: DomainStackProps,
  ) {
    super(scope, domainStackName(environment, domain), {
      description: `Flex domain ${domain} for the ${environment.name} environment`,
      env: { account: domainAccount.account, region: DOMAIN_REGION },
    });

    new Domain(this, "Domain", {
      environment: environment.name,
      domain,
      zone: {
        zoneName: domainAccount.zone.name,
        hostedZoneId: domainAccount.zone.id,
      },
      edgeRole: {
        name: edgeRoleName(environment.name),
        account: environment.frontdoor.account,
      },
    });
  }
}
