import { cdkApp } from "@repo/infra-constructs";
import { type App, Stack, Validations } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";

import { Domain } from "../src/domain.ts";
import { DomainAccount } from "../src/domain-account.ts";

export const ACCOUNT = "123456789012";

export const ZONE = {
  zoneName: "sandbox.flex-domain00.example",
  hostedZoneId: "Z100000000003",
};

export const EDGE_ROLE = {
  account: "100000000002",
  name: "frontdoor-sandbox-edge",
};

export function stackIn(region: string, nag = false): Stack {
  const app = cdkApp();

  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app));

  return new Stack(app, "Test", { env: { account: ACCOUNT, region } });
}

export function domainAccountIn(stack: Stack): DomainAccount {
  return new DomainAccount(stack, "DomainAccount", {
    environment: "sandbox",
    zone: ZONE,
    gatewayFunctions: "gateway-sandbox-*",
  });
}

export function domainAccountTemplate(nag = false): {
  app: App;
  template: Template;
} {
  const stack = stackIn("eu-west-2", nag);

  domainAccountIn(stack);

  return { app: stack.node.root as App, template: Template.fromStack(stack) };
}

export function domainIn(stack: Stack): Domain {
  return new Domain(stack, "Domain", {
    environment: "sandbox",
    domain: "domain-a",
    zone: ZONE,
    edgeRole: EDGE_ROLE,
  });
}

export function domainTemplate(nag = false): { app: App; template: Template } {
  const stack = stackIn("eu-west-2", nag);

  domainIn(stack);

  return { app: stack.node.root as App, template: Template.fromStack(stack) };
}
