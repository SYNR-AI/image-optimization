// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_iam as iam,
    aws_lambda as lambda,
    aws_logs as logs,
    aws_s3 as s3,
    aws_s3_deployment as s3deploy,
    CfnOutput,
    Duration,
    Fn,
    RemovalPolicy,
    Stack,
    StackProps,
} from 'aws-cdk-lib';
import {CfnDistribution} from "aws-cdk-lib/aws-cloudfront";
import {Construct} from 'constructs';
import {getOriginShieldRegion} from './origin-shield';
import {AllowedMethods} from "aws-cdk-lib/aws-cloudfront";

// Stack Parameters

// related to architecture. If set to false, transformed images are not stored in S3, and all image requests land on Lambda
var STORE_TRANSFORMED_IMAGES = 'true';
// Parameters of S3 bucket where original images are stored
var S3_IMAGE_BUCKET_NAME: string;
// CloudFront parameters
var CLOUDFRONT_ORIGIN_SHIELD_REGION = getOriginShieldRegion(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1');
var CLOUDFRONT_CORS_ENABLED = 'true';
// Parameters of transformed images
var S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = '90';
var S3_TRANSFORMED_IMAGE_CACHE_TTL = 'max-age=31622400';
// Max image size in bytes. If generated images are stored on S3, bigger images are generated, stored on S3
// and request is redirect to the generated image. Otherwise, an application error is sent.
var MAX_IMAGE_SIZE = '4700000';
// Lambda Parameters
var LAMBDA_MEMORY = '1500';
var LAMBDA_TIMEOUT = '60';
// Whether to deploy a sample website referenced in https://aws.amazon.com/blogs/networking-and-content-delivery/image-optimization-using-amazon-cloudfront-and-aws-lambda/
var DEPLOY_SAMPLE_WEBSITE = 'false';

type ImageDeliveryCacheBehaviorConfig = {
    origin: any;
    compress: any;
    viewerProtocolPolicy: any;
    cachePolicy: any;
    functionAssociations: any;
    responseHeadersPolicy?: any;
};

type LambdaEnv = {
    originalImageBucketName: string,
    transformedImageBucketName?: any;
    transformedImageCacheTTL: string,
    maxImageSize: string,
}

export class ImageOptimizationStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        // Change stack parameters based on provided context
        STORE_TRANSFORMED_IMAGES = this.node.tryGetContext('STORE_TRANSFORMED_IMAGES') || STORE_TRANSFORMED_IMAGES;
        S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION') || S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION;
        S3_TRANSFORMED_IMAGE_CACHE_TTL = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_CACHE_TTL') || S3_TRANSFORMED_IMAGE_CACHE_TTL;
        S3_IMAGE_BUCKET_NAME = this.node.tryGetContext('S3_IMAGE_BUCKET_NAME') || S3_IMAGE_BUCKET_NAME;
        CLOUDFRONT_ORIGIN_SHIELD_REGION = this.node.tryGetContext('CLOUDFRONT_ORIGIN_SHIELD_REGION') || CLOUDFRONT_ORIGIN_SHIELD_REGION;
        CLOUDFRONT_CORS_ENABLED = this.node.tryGetContext('CLOUDFRONT_CORS_ENABLED') || CLOUDFRONT_CORS_ENABLED;
        LAMBDA_MEMORY = this.node.tryGetContext('LAMBDA_MEMORY') || LAMBDA_MEMORY;
        LAMBDA_TIMEOUT = this.node.tryGetContext('LAMBDA_TIMEOUT') || LAMBDA_TIMEOUT;
        MAX_IMAGE_SIZE = this.node.tryGetContext('MAX_IMAGE_SIZE') || MAX_IMAGE_SIZE;
        DEPLOY_SAMPLE_WEBSITE = this.node.tryGetContext('DEPLOY_SAMPLE_WEBSITE') || DEPLOY_SAMPLE_WEBSITE;


        // deploy a sample website for testing if required
        if (DEPLOY_SAMPLE_WEBSITE === 'true') {
            var sampleWebsiteBucket = new s3.Bucket(this, `${S3_IMAGE_BUCKET_NAME}-s3-sample-website-bucket`, {
                removalPolicy: RemovalPolicy.DESTROY,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                encryption: s3.BucketEncryption.S3_MANAGED,
                enforceSSL: true,
                autoDeleteObjects: true,
            });

            var sampleWebsiteDelivery = new cloudfront.Distribution(this, `${S3_IMAGE_BUCKET_NAME}-websiteDeliveryDistribution`, {
                comment: 'image optimization - sample website',
                defaultRootObject: 'index.html',
                defaultBehavior: {
                    origin: new origins.S3Origin(sampleWebsiteBucket),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                }
            });

            new CfnOutput(this, 'SampleWebsiteDomain', {
                description: 'Sample website domain',
                value: sampleWebsiteDelivery.distributionDomainName
            });
            new CfnOutput(this, 'SampleWebsiteS3Bucket', {
                description: 'S3 bucket use by the sample website',
                value: sampleWebsiteBucket.bucketName
            });
        }

        // For the bucket having original images, either use an external one, or create one with some samples photos.
        var originalImageBucket;
        var transformedImageBucket;

        if (S3_IMAGE_BUCKET_NAME) {
            originalImageBucket = s3.Bucket.fromBucketName(this, `${S3_IMAGE_BUCKET_NAME}-imported-original-image-bucket`, S3_IMAGE_BUCKET_NAME);
            new CfnOutput(this, 'OriginalImagesS3Bucket', {
                description: 'S3 bucket where original images are stored',
                value: originalImageBucket.bucketName
            });
        } else {
            originalImageBucket = new s3.Bucket(this, `${S3_IMAGE_BUCKET_NAME}-s3-sample-original-image-bucket`, {
                removalPolicy: RemovalPolicy.DESTROY,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                encryption: s3.BucketEncryption.S3_MANAGED,
                enforceSSL: true,
                autoDeleteObjects: true,
            });
            new s3deploy.BucketDeployment(this, 'DeployWebsite', {
                sources: [s3deploy.Source.asset('./image-sample')],
                destinationBucket: originalImageBucket,
                destinationKeyPrefix: 'images/rio/',
            });
            new CfnOutput(this, 'OriginalImagesS3Bucket', {
                description: 'S3 bucket where original images are stored',
                value: originalImageBucket.bucketName
            });
        }

        // create bucket for transformed images if enabled in the architecture
        if (STORE_TRANSFORMED_IMAGES === 'true') {
            transformedImageBucket = new s3.Bucket(this, `${S3_IMAGE_BUCKET_NAME}-s3-transformed-image-bucket`, {
                removalPolicy: RemovalPolicy.DESTROY,
                autoDeleteObjects: true,
                lifecycleRules: [
                    {
                        expiration: Duration.days(parseInt(S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION)),
                    },
                ],
            });
        }

        // prepare env variable for Lambda
        var lambdaEnv: LambdaEnv = {
            originalImageBucketName: originalImageBucket.bucketName,
            transformedImageCacheTTL: S3_TRANSFORMED_IMAGE_CACHE_TTL,
            maxImageSize: MAX_IMAGE_SIZE,
        };
        if (transformedImageBucket) lambdaEnv.transformedImageBucketName = transformedImageBucket.bucketName;

        // IAM policy to read from the S3 bucket containing the original images
        const s3ReadOriginalImagesPolicy = new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: ['arn:aws:s3:::' + originalImageBucket.bucketName + '/*'],
        });

        // statements of the IAM policy to attach to Lambda
        var iamPolicyStatements = [s3ReadOriginalImagesPolicy];

        // Create Lambda for image processing
        var lambdaProps = {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset('functions/image-processing'),
            timeout: Duration.seconds(parseInt(LAMBDA_TIMEOUT)),
            memorySize: parseInt(LAMBDA_MEMORY),
            environment: lambdaEnv,
            logRetention: logs.RetentionDays.ONE_DAY,
        };
        var imageProcessing = new lambda.Function(this, `${S3_IMAGE_BUCKET_NAME}-image-optimization`, lambdaProps);

        // Enable Lambda URL
        const imageProcessingURL = imageProcessing.addFunctionUrl();

        // Leverage CDK Intrinsics to get the hostname of the Lambda URL
        const imageProcessingDomainName = Fn.parseDomainName(imageProcessingURL.url);

        // Create a CloudFront origin: S3 with fallback to Lambda when image needs to be transformed, otherwise with Lambda as sole origin
        var imageOrigin;

        if (transformedImageBucket) {
            imageOrigin = new origins.OriginGroup({
                primaryOrigin: new origins.S3Origin(transformedImageBucket, {
                    originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
                }),
                fallbackOrigin: new origins.HttpOrigin(imageProcessingDomainName, {
                    originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
                }),
                fallbackStatusCodes: [403, 500, 503, 504],
            });

            // write policy for Lambda on the s3 bucket for transformed images
            var s3WriteTransformedImagesPolicy = new iam.PolicyStatement({
                actions: ['s3:PutObject'],
                resources: ['arn:aws:s3:::' + transformedImageBucket.bucketName + '/*'],
            });
            iamPolicyStatements.push(s3WriteTransformedImagesPolicy);
        } else {
            imageOrigin = new origins.HttpOrigin(imageProcessingDomainName, {
                originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
            });
        }

        // attach iam policy to the role assumed by Lambda
        imageProcessing.role?.attachInlinePolicy(
            new iam.Policy(this, `${S3_IMAGE_BUCKET_NAME}-read-write-bucket-policy`, {
                statements: iamPolicyStatements,
            }),
        );

        // Create a CloudFront Function for url rewrites
        const urlRewriteFunction = new cloudfront.Function(this, `${S3_IMAGE_BUCKET_NAME}-urlRewrite`, {
            code: cloudfront.FunctionCode.fromFile({filePath: 'functions/url-rewrite/index.js',}),
            functionName: `urlRewriteFunction${this.node.addr}`,
        });

        var imageDeliveryCacheBehaviorConfig: ImageDeliveryCacheBehaviorConfig = {
            origin: imageOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            compress: false,
            cachePolicy: new cloudfront.CachePolicy(this, `${S3_IMAGE_BUCKET_NAME}-ImageCachePolicy${this.node.addr}`, {
                defaultTtl: Duration.hours(24),
                maxTtl: Duration.days(365),
                minTtl: Duration.seconds(0)
            }),
            functionAssociations: [{
                eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                function: urlRewriteFunction,
            }],
        }

        if (CLOUDFRONT_CORS_ENABLED === 'true') {
            // Creating a custom response headers policy. CORS allowed for all origins.
            const imageResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, `${S3_IMAGE_BUCKET_NAME}-ResponseHeadersPolicy${this.node.addr}`, {
                responseHeadersPolicyName: `ImageResponsePolicy${this.node.addr}`,
                corsBehavior: {
                    accessControlAllowCredentials: false,
                    accessControlAllowHeaders: ['*'],
                    accessControlAllowMethods: ['GET'],
                    accessControlAllowOrigins: ['*'],
                    accessControlMaxAge: Duration.seconds(600),
                    originOverride: false,
                },
                // recognizing image requests that were processed by this solution
                customHeadersBehavior: {
                    customHeaders: [
                        {header: 'x-aws-image-optimization', value: 'v1.0', override: true},
                        {header: 'vary', value: 'accept', override: true},
                    ],
                }
            });
            imageDeliveryCacheBehaviorConfig.responseHeadersPolicy = imageResponseHeadersPolicy;
        }

        const imageDelivery = new cloudfront.Distribution(this, `${S3_IMAGE_BUCKET_NAME}-imageDeliveryDistribution`, {
            comment: 'image optimization - image delivery',
            defaultBehavior: {
                origin: new origins.HttpOrigin(`${S3_IMAGE_BUCKET_NAME}.s3.${CLOUDFRONT_ORIGIN_SHIELD_REGION}.amazonaws.com`, {}),
                // origin: new origins.S3Origin(originalImageBucket, {}),
                cachePolicy: {
                    cachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
                },
                originRequestPolicy:{
                    originRequestPolicyId:"d98686c1-6a46-4782-9074-a5cdc99e4c9c"
                },
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                compress: false,
                allowedMethods: AllowedMethods.ALLOW_ALL,
            },
            additionalBehaviors: {
                '*.jpg': imageDeliveryCacheBehaviorConfig,
                '*.jpeg': imageDeliveryCacheBehaviorConfig,
                '*.png': imageDeliveryCacheBehaviorConfig,
                '*.gif': imageDeliveryCacheBehaviorConfig,
                '*.webp': imageDeliveryCacheBehaviorConfig
            }
        });

        // ADD OAC between CloudFront and LambdaURL
        const oac = new cloudfront.CfnOriginAccessControl(this, `${S3_IMAGE_BUCKET_NAME}-OAC`, {
            originAccessControlConfig: {
                name: `oac${this.node.addr}`,
                originAccessControlOriginType: "lambda",
                signingBehavior: "always",
                signingProtocol: "sigv4",
            },
        });

        const cfnImageDelivery = imageDelivery.node.defaultChild as CfnDistribution;
        cfnImageDelivery.addPropertyOverride(`DistributionConfig.Origins.${(STORE_TRANSFORMED_IMAGES === 'true') ? "2" : "1"}.OriginAccessControlId`, oac.getAtt("Id"));

        imageProcessing.addPermission(`${S3_IMAGE_BUCKET_NAME}-AllowCloudFrontServicePrincipal`, {
            principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
            action: "lambda:InvokeFunctionUrl",
            sourceArn: `arn:aws:cloudfront::${this.account}:distribution/${imageDelivery.distributionId}`
        })

        new CfnOutput(this, `${S3_IMAGE_BUCKET_NAME}-ImageDeliveryDomain`, {
            description: 'Domain name of image delivery',
            value: imageDelivery.distributionDomainName
        });
    }
}
