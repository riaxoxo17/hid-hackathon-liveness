import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

export class KioskStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Audit log, enrolled users and thresholds. No face images.
    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fnRole = new iam.Role(this, 'ApiRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    // The browser streams the Face Liveness video with short-lived credentials for this role only.
    const streamRole = new iam.Role(this, 'LivenessStreamRole', {
      assumedBy: new iam.ArnPrincipal(fnRole.roleArn),
      inlinePolicies: {
        stream: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({ actions: ['rekognition:StartFaceLivenessSession'], resources: ['*'] })],
        }),
      },
    });

    fnRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'rekognition:SearchFacesByImage', 'rekognition:IndexFaces', 'rekognition:DeleteFaces',
        'rekognition:CreateCollection', 'rekognition:DetectLabels', 'rekognition:DetectFaces',
        'rekognition:CreateFaceLivenessSession', 'rekognition:GetFaceLivenessSessionResults',
      ],
      resources: ['*'],
    }));
    fnRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    }));
    fnRole.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [streamRole.roleArn] }));
    table.grantReadWriteData(fnRole);

    const fn = new lambda.Function(this, 'Api', {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend')),
      memorySize: 1024,
      timeout: cdk.Duration.seconds(25),
      role: fnRole,
      environment: {
        TABLE_NAME: table.tableName,
        COLLECTION_ID: 'hid-kiosk-faces',
        STREAM_ROLE_ARN: streamRole.roleArn,
        EXPLAIN_MODEL: 'us.anthropic.claude-haiku-5-5',
        VISION_MODEL: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
    });
    const fnUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    const bucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const dist = new cloudfront.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.FunctionUrlOrigin(fnUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../app/dist'))],
      destinationBucket: bucket,
      distribution: dist,
      distributionPaths: ['/index.html'],
      memoryLimit: 1024,
    });

    new cdk.CfnOutput(this, 'KioskUrl', { value: `https://${dist.distributionDomainName}` });
    new cdk.CfnOutput(this, 'ApiUrl', { value: fnUrl.url });
  }
}
