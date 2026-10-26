import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT,
  domainIn,
  domainTemplate,
  EDGE_ROLE,
  stackIn,
  ZONE,
} from "../test/helpers.ts";

const HOST = `domain-a.${ZONE.zoneName}`;

const EDGE_ROLE_ARN = `arn:aws:iam::${EDGE_ROLE.account}:role/${EDGE_ROLE.name}`;

const INTEGRATION = {
  Type: "AWS_PROXY",
  IntegrationHttpMethod: "POST",
  Uri: `arn:aws:apigateway:eu-west-2:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-west-2:${ACCOUNT}:function:domain-sandbox-domain-a:live/invocations`,
  Credentials: `arn:aws:iam::${ACCOUNT}:role/domain-sandbox-integration`,
};

const API = { Ref: Match.stringLikeRegexp("^DomainApi") };

describe("Domain", () => {
  it("refuses any region but eu-west-2", () => {
    expect(() => domainIn(stackIn("us-east-1"))).toThrow("eu-west-2");
  });

  it("has no unacknowledged cdk-nag finding", () => {
    const { app } = domainTemplate(true);

    expect(() => app.synth()).not.toThrow();
  });

  describe("the API", () => {
    it("is one regional API, reachable only through its custom domain", () => {
      const { template } = domainTemplate();

      template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
      template.hasResourceProperties("AWS::ApiGateway::RestApi", {
        Name: "domain-sandbox-domain-a-api",
        EndpointConfiguration: { Types: ["REGIONAL"] },
        DisableExecuteApiEndpoint: true,
      });
      const { Outputs: outputs = {} } = template.toJSON() as {
        Outputs?: Record<string, unknown>;
      };

      expect(Object.keys(outputs)).toEqual([]);
    });

    it("lets in only the Frontdoor's edge role, and denies everyone else", () => {
      domainTemplate().template.hasResourceProperties(
        "AWS::ApiGateway::RestApi",
        {
          Policy: {
            Statement: [
              {
                Action: "execute-api:Invoke",
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${EDGE_ROLE.account}:root` },
                Resource: "execute-api:/*",
                Condition: {
                  ArnEquals: { "aws:PrincipalArn": EDGE_ROLE_ARN },
                },
              },
              {
                Action: "execute-api:Invoke",
                Effect: "Deny",
                Principal: { AWS: "*" },
                Resource: "execute-api:/*",
                Condition: {
                  ArnNotEquals: { "aws:PrincipalArn": EDGE_ROLE_ARN },
                },
              },
            ],
            Version: "2012-10-17",
          },
        },
      );
    });
  });

  describe("the routes", () => {
    it("pass every method on the root and every path below it to the domain's code, with IAM authorisation", () => {
      const { template } = domainTemplate();

      const methods = Object.values(
        template.findResources("AWS::ApiGateway::Method"),
      ).map(
        (method) =>
          method.Properties as {
            HttpMethod: string;
            AuthorizationType: string;
            Integration: unknown;
          },
      );

      expect(methods).toHaveLength(2);
      for (const method of methods) {
        expect(method).toMatchObject({
          HttpMethod: "ANY",
          AuthorizationType: "AWS_IAM",
          Integration: INTEGRATION,
        });
      }

      template.resourceCountIs("AWS::ApiGateway::Resource", 1);
      template.hasResourceProperties("AWS::ApiGateway::Resource", {
        PathPart: "{proxy+}",
      });
    });

    it("invoke the function's live alias through the integration role, and add nothing to the function", () => {
      const { template } = domainTemplate();

      for (const type of [
        "AWS::Lambda::Function",
        "AWS::Lambda::Alias",
        "AWS::Lambda::Version",
        "AWS::Lambda::Permission",
        "AWS::IAM::Role",
        "AWS::WAFv2::WebACL",
        "AWS::WAFv2::WebACLAssociation",
      ]) {
        template.resourceCountIs(type, 0);
      }
    });
  });

  describe("the stage", () => {
    it("is named default, traced, and keeps request bodies out of its logs", () => {
      domainTemplate().template.hasResourceProperties(
        "AWS::ApiGateway::Stage",
        {
          StageName: "default",
          TracingEnabled: true,
          MethodSettings: [
            {
              HttpMethod: "*",
              ResourcePath: "/*",
              LoggingLevel: "ERROR",
              DataTraceEnabled: false,
            },
          ],
        },
      );
    });

    it("writes JSON access logs, with the X-Ray trace ID, to the domain's own log group", () => {
      const { template } = domainTemplate();

      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: "/flex/domain/sandbox/domain-a/api-access",
      });

      const [stage] = Object.values(
        template.findResources("AWS::ApiGateway::Stage"),
      );
      const { AccessLogSetting: setting } = stage?.Properties as {
        AccessLogSetting: { DestinationArn: unknown; Format: string };
      };

      expect(setting.DestinationArn).toEqual({
        "Fn::GetAtt": [expect.stringMatching(/^DomainAccessLogs/), "Arn"],
      });
      expect(JSON.parse(setting.Format)).toEqual({
        requestId: "$context.requestId",
        xrayTraceId: "$context.xrayTraceId",
        requestTime: "$context.requestTime",
        httpMethod: "$context.httpMethod",
        resourcePath: "$context.resourcePath",
        status: "$context.status",
        responseLength: "$context.responseLength",
        responseLatency: "$context.responseLatency",
        integrationLatency: "$context.integrationLatency",
        errorResponseType: "$context.error.responseType",
      });
    });

    it("waits for its execution log group, created ahead of API Gateway", () => {
      const { template } = domainTemplate();

      const groups = template.findResources("AWS::Logs::LogGroup", {
        Properties: {
          LogGroupName: {
            "Fn::Join": ["", ["API-Gateway-Execution-Logs_", API, "/default"]],
          },
        },
      });
      const [executionLogs] = Object.keys(groups);

      expect(executionLogs).toBeDefined();
      template.hasResource("AWS::ApiGateway::Stage", {
        DependsOn: [executionLogs],
      });
    });
  });

  it("answers its own refusals in the Frontdoor's shape, saying API Gateway refused", () => {
    const { template } = domainTemplate();

    const responses = Object.fromEntries(
      Object.values(
        template.findResources("AWS::ApiGateway::GatewayResponse"),
      ).map((response) => {
        const { ResponseType, ResponseTemplates, ResponseParameters } =
          response.Properties as {
            ResponseType: string;
            ResponseTemplates: Record<string, string>;
            ResponseParameters: Record<string, string>;
          };

        expect(ResponseParameters).toEqual({
          "gatewayresponse.header.x-rejected-by": "'api-gateway'",
        });

        return [ResponseType, ResponseTemplates["application/json"]];
      }),
    );

    const unauthorized = '{"message":"Unauthorized","type":"auth_error"}';

    expect(responses).toEqual({
      UNAUTHORIZED: unauthorized,
      ACCESS_DENIED: unauthorized,
      INVALID_SIGNATURE: unauthorized,
      MISSING_AUTHENTICATION_TOKEN: unauthorized,
      EXPIRED_TOKEN: unauthorized,
      THROTTLED: '{"message":"Too many requests","type":"client_error"}',
      DEFAULT_4XX:
        '{"message":$context.error.messageString,"type":"client_error"}',
      DEFAULT_5XX: '{"message":"Internal server error","type":"server_error"}',
    });
  });

  describe("the custom domain", () => {
    it("answers at the domain's host with the account's certificate, on TLS 1.3 or 1.2", () => {
      const { template } = domainTemplate();

      const parameters = template.toJSON().Parameters as Record<
        string,
        { Default: string }
      >;
      const [certificateArn] = Object.entries(parameters).find(
        ([, parameter]) =>
          parameter.Default === "/flex/domain/sandbox/certificate-arn",
      ) ?? [undefined];

      expect(certificateArn).toBeDefined();
      template.hasResourceProperties("AWS::ApiGateway::DomainName", {
        DomainName: HOST,
        EndpointConfiguration: { Types: ["REGIONAL"] },
        RegionalCertificateArn: { Ref: certificateArn },
        SecurityPolicy: "SecurityPolicy_TLS13_1_2_PFS_PQ_2025_09",
        EndpointAccessMode: "STRICT",
      });
    });

    it("maps the host's root to the API's stage", () => {
      domainTemplate().template.hasResourceProperties(
        "AWS::ApiGateway::BasePathMapping",
        {
          DomainName: { Ref: Match.stringLikeRegexp("^DomainDomainName") },
          RestApiId: API,
          Stage: { Ref: Match.stringLikeRegexp("Stagedefault") },
          BasePath: Match.absent(),
        },
      );
    });

    it("points the host at the custom domain in the account's zone", () => {
      const { template } = domainTemplate();

      template.resourceCountIs("AWS::Route53::RecordSet", 1);
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: `${HOST}.`,
        Type: "A",
        HostedZoneId: ZONE.hostedZoneId,
        AliasTarget: {
          DNSName: {
            "Fn::GetAtt": [
              Match.stringLikeRegexp("^DomainDomainName"),
              "RegionalDomainName",
            ],
          },
        },
      });
    });
  });
});
