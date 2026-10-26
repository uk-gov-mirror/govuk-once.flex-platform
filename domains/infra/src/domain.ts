import { PlatformLogGroup } from "@repo/infra-constructs";
import { ArnFormat, Stack, Validations } from "aws-cdk-lib";
import {
  AccessLogField,
  AccessLogFormat,
  AuthorizationType,
  DomainName,
  EndpointAccessMode,
  EndpointType,
  Integration,
  IntegrationType,
  LogGroupLogDestination,
  MethodLoggingLevel,
  ResponseType,
  RestApi,
  SecurityPolicy,
} from "aws-cdk-lib/aws-apigateway";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AccountPrincipal,
  AnyPrincipal,
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
} from "aws-cdk-lib/aws-iam";
import {
  ARecord,
  HostedZone,
  type HostedZoneAttributes,
  RecordTarget,
} from "aws-cdk-lib/aws-route53";
import { ApiGatewayDomain } from "aws-cdk-lib/aws-route53-targets";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

import {
  apiAccessLogGroupName,
  apiExecutionLogGroupName,
  apiName,
  certificateParameterName,
  DOMAIN_REGION,
  domainFunctionName,
  domainHost,
  integrationRoleName,
  LIVE_ALIAS,
} from "./names.ts";

const STAGE_NAME = "default";

const AUTH_ERROR = { message: "Unauthorized", type: "auth_error" };
const TOO_MANY_REQUESTS = {
  message: "Too many requests",
  type: "client_error",
};
const SERVER_ERROR = { message: "Internal server error", type: "server_error" };

// API Gateway's own message for any other refusal, already a quoted JSON string. Its messages are
// fixed, so no caller's text reaches the body.
const CLIENT_ERROR =
  '{"message":$context.error.messageString,"type":"client_error"}';

const GATEWAY_RESPONSES = [
  [ResponseType.UNAUTHORIZED, JSON.stringify(AUTH_ERROR)],
  [ResponseType.ACCESS_DENIED, JSON.stringify(AUTH_ERROR)],
  [ResponseType.INVALID_SIGNATURE, JSON.stringify(AUTH_ERROR)],
  [ResponseType.MISSING_AUTHENTICATION_TOKEN, JSON.stringify(AUTH_ERROR)],
  [ResponseType.EXPIRED_TOKEN, JSON.stringify(AUTH_ERROR)],
  [ResponseType.THROTTLED, JSON.stringify(TOO_MANY_REQUESTS)],
  [ResponseType.DEFAULT_4XX, CLIENT_ERROR],
  [ResponseType.DEFAULT_5XX, JSON.stringify(SERVER_ERROR)],
] as const;

export interface DomainProps {
  readonly environment: string;
  readonly domain: string;
  readonly zone: HostedZoneAttributes;
  readonly edgeRole: { readonly account: string; readonly name: string };
}

/**
 * One domain's API: every path and method under its host, passed to the `live` alias of a
 * function created outside CloudFormation. The domain's own code routes each request.
 */
export class Domain extends Construct {
  constructor(scope: Construct, id: string, props: DomainProps) {
    super(scope, id);

    const { environment, domain, zone, edgeRole } = props;

    const stack = Stack.of(this);

    if (stack.region !== DOMAIN_REGION) {
      throw new Error(
        `A domain's resources must be created in ${DOMAIN_REGION}, the region the edge signs requests for, not ${stack.region}`,
      );
    }

    const accessLogs = new PlatformLogGroup(this, "AccessLogs", {
      logGroupName: apiAccessLogGroupName(environment, domain),
    });

    const api = this.createApi(stack, {
      environment,
      domain,
      edgeRole,
      accessLogs,
    });

    this.addRoutes(api, { stack, environment, domain });
    this.addGatewayResponses(api);
    this.createCustomDomain(api, { environment, domain, zone });
  }

  private createApi(
    stack: Stack,
    {
      environment,
      domain,
      edgeRole,
      accessLogs,
    }: {
      environment: string;
      domain: string;
      edgeRole: { account: string; name: string };
      accessLogs: PlatformLogGroup;
    },
  ): RestApi {
    // Named as a condition, never as the principal: API Gateway refuses a policy naming a role that
    // doesn't exist yet, and the Frontdoor's stacks deploy after the domains'.
    const edgeRoleArn = stack.formatArn({
      service: "iam",
      region: "",
      account: edgeRole.account,
      resource: "role",
      resourceName: edgeRole.name,
    });

    const api = new RestApi(this, "Api", {
      restApiName: apiName(environment, domain),
      endpointConfiguration: { types: [EndpointType.REGIONAL] },
      // The custom domain is the only way in, so the Frontdoor's routing is the only route.
      disableExecuteApiEndpoint: true,
      defaultMethodOptions: { authorizationType: AuthorizationType.IAM },
      // IAM authorisation would also let in any principal in this account allowed to invoke APIs,
      // so everyone but the edge role is denied outright.
      policy: new PolicyDocument({
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            principals: [new AccountPrincipal(edgeRole.account)],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
            conditions: { ArnEquals: { "aws:PrincipalArn": edgeRoleArn } },
          }),
          new PolicyStatement({
            effect: Effect.DENY,
            principals: [new AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
            conditions: { ArnNotEquals: { "aws:PrincipalArn": edgeRoleArn } },
          }),
        ],
      }),
      deployOptions: {
        stageName: STAGE_NAME,
        tracingEnabled: true,
        loggingLevel: MethodLoggingLevel.ERROR,
        dataTraceEnabled: false,
        accessLogDestination: new LogGroupLogDestination(accessLogs.logGroup),
        accessLogFormat: AccessLogFormat.custom(
          JSON.stringify({
            requestId: AccessLogField.contextRequestId(),
            xrayTraceId: AccessLogField.contextXrayTraceId(),
            requestTime: AccessLogField.contextRequestTime(),
            httpMethod: AccessLogField.contextHttpMethod(),
            resourcePath: AccessLogField.contextResourcePath(),
            status: AccessLogField.contextStatus(),
            responseLength: AccessLogField.contextResponseLength(),
            responseLatency: AccessLogField.contextResponseLatency(),
            integrationLatency: AccessLogField.contextIntegrationLatency(),
            errorResponseType: AccessLogField.contextErrorResponseType(),
          }),
        ),
      },
    });

    // CDK always adds an `Endpoint` output with the execute-api URL, even with that endpoint off, so
    // it would publish a URL that never answers.
    api.node.tryRemoveChild("Endpoint");

    // API Gateway would otherwise create it on the first error, unencrypted and kept forever.
    const executionLogs = new PlatformLogGroup(this, "ExecutionLogs", {
      logGroupName: apiExecutionLogGroupName(api.restApiId, STAGE_NAME),
    });

    api.deploymentStage.node.addDependency(executionLogs);

    Validations.of(api).acknowledge(
      {
        id: "AwsSolutions-APIG2",
        reason:
          "Every request goes to the domain's own code, which validates it. The API has no request models to check against.",
      },
      {
        id: "AwsSolutions-APIG3",
        reason:
          "WAF runs at the Frontdoor. The resource policy and IAM authorisation refuse anything the Frontdoor's edge role didn't sign.",
      },
      {
        id: "AwsSolutions-COG4",
        reason:
          "The Frontdoor verifies the caller's Cognito token, then signs the request with SigV4, which IAM authorisation checks.",
      },
    );

    return api;
  }

  // The function isn't in any template, so the integration names its `live` alias by ARN and
  // invokes it through the account's integration role. No permission on the function is needed.
  private addRoutes(
    api: RestApi,
    {
      stack,
      environment,
      domain,
    }: { stack: Stack; environment: string; domain: string },
  ): void {
    const liveFunction = stack.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: `${domainFunctionName(environment, domain)}:${LIVE_ALIAS}`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const integrationRole = Role.fromRoleArn(
      this,
      "IntegrationRole",
      stack.formatArn({
        service: "iam",
        region: "",
        resource: "role",
        resourceName: integrationRoleName(environment),
      }),
      { mutable: false },
    );

    const integration = new Integration({
      type: IntegrationType.AWS_PROXY,
      integrationHttpMethod: "POST",
      uri: `arn:${stack.partition}:apigateway:${stack.region}:lambda:path/2015-03-31/functions/${liveFunction}/invocations`,
      options: { credentialsRole: integrationRole },
    });

    api.root.addMethod("ANY", integration);
    api.root.addProxy({ defaultIntegration: integration, anyMethod: true });
  }

  private addGatewayResponses(api: RestApi): void {
    for (const [type, body] of GATEWAY_RESPONSES) {
      api.addGatewayResponse(type.responseType, {
        type,
        // As the Frontdoor's own refusals say which part refused.
        responseHeaders: { "x-rejected-by": "'api-gateway'" },
        templates: { "application/json": body },
      });
    }
  }

  private createCustomDomain(
    api: RestApi,
    {
      environment,
      domain,
      zone: attributes,
    }: { environment: string; domain: string; zone: HostedZoneAttributes },
  ): void {
    const host = domainHost(domain, attributes.zoneName);

    const certificate = Certificate.fromCertificateArn(
      this,
      "Certificate",
      StringParameter.valueForStringParameter(
        this,
        certificateParameterName(environment),
      ),
    );

    const domainName = new DomainName(this, "DomainName", {
      domainName: host,
      certificate,
      endpointType: EndpointType.REGIONAL,
      securityPolicy: SecurityPolicy.TLS13_1_2_PFS_PQ_2025_09,
      endpointAccessMode: EndpointAccessMode.STRICT,
    });

    domainName.addBasePathMapping(api, { stage: api.deploymentStage });

    // Only CloudFront reaches this host, and it does so over IPv4.
    new ARecord(this, "Alias", {
      zone: HostedZone.fromHostedZoneAttributes(this, "Zone", attributes),
      recordName: host,
      target: RecordTarget.fromAlias(new ApiGatewayDomain(domainName)),
    });
  }
}
