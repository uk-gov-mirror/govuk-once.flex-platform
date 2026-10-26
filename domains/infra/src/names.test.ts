import { describe, expect, it } from "vitest";

import {
  apiAccessLogGroupName,
  apiExecutionLogGroupName,
  apiName,
  certificateParameterName,
  deployRoleName,
  domainFunctionName,
  domainHost,
  executionRoleName,
  functionLogGroupName,
  integrationRoleName,
  isolatedSubnetIdsParameterName,
  lambdaEndpointSecurityGroupParameterName,
  securityGroupParameterName,
  vpcIdParameterName,
} from "./names.ts";

describe("names", () => {
  it("name a domain's function and API from the environment's and the domain's names", () => {
    expect(domainFunctionName("sandbox", "domain-a")).toBe(
      "domain-sandbox-domain-a",
    );
    expect(apiName("sandbox", "domain-a")).toBe("domain-sandbox-domain-a-api");
  });

  it("name what every domain in an environment shares from the environment's name", () => {
    expect(executionRoleName("sandbox")).toBe("domain-sandbox-execution");
    expect(integrationRoleName("sandbox")).toBe("domain-sandbox-integration");
    expect(deployRoleName("sandbox")).toBe("domain-sandbox-deploy");
  });

  it("put the platform's log groups and parameters under /flex/domain", () => {
    expect(functionLogGroupName("sandbox")).toBe(
      "/flex/domain/sandbox/function",
    );
    expect(apiAccessLogGroupName("sandbox", "domain-a")).toBe(
      "/flex/domain/sandbox/domain-a/api-access",
    );
    expect(certificateParameterName("sandbox")).toBe(
      "/flex/domain/sandbox/certificate-arn",
    );
    expect(securityGroupParameterName("sandbox")).toBe(
      "/flex/domain/sandbox/security-group-id",
    );
  });

  it("read the VPC's hand-written parameters under /flex/network", () => {
    expect(vpcIdParameterName("sandbox")).toBe("/flex/network/sandbox/vpc-id");
    expect(isolatedSubnetIdsParameterName("sandbox")).toBe(
      "/flex/network/sandbox/isolated-subnet-ids",
    );
    expect(lambdaEndpointSecurityGroupParameterName("sandbox")).toBe(
      "/flex/network/sandbox/lambda-endpoint-security-group-id",
    );
  });

  it("put a domain's host under its domain account's zone", () => {
    expect(domainHost("domain-a", "sandbox.flex-domain00.example")).toBe(
      "domain-a.sandbox.flex-domain00.example",
    );
  });

  it("follow API Gateway's name for a stage's execution logs", () => {
    expect(apiExecutionLogGroupName("abc123", "live")).toBe(
      "API-Gateway-Execution-Logs_abc123/live",
    );
  });
});
