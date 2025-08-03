// media-library-stack.ts

import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cr from "aws-cdk-lib/custom-resources";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

interface LibraryAccessRecord {
    ownerIdentityId: string;
    ownerUsername: string;
    movieCount: number;
    collectionCount: number;
    createdAt: string;
    updatedAt: string;
    lastScanAt: number;
}

interface LibrarySharedRecord {
    ownerIdentityId: string;
    ownerUsername: string;
    sharedWithIdentityId: string;
    sharedWithUsername: string;
    sharedAt: string;
}

interface MediaLibraryStackProps extends cdk.StackProps {
    stageName: string;
    domainName: string;
    apiDomainName: string;
    secondaryDomainName?: string;
    secondaryApiDomainName?: string;
    secondaryDomainNameHostedZone?: string;
    awsLibraryBucketPrefix: string;
    awsMediaBucketPrefix: string;
    awsPlaylistBucketPrefix: string;
    awsPosterBucketPrefix: string;
    awsWebsiteBucketPrefix: string;
    enableFirewall: boolean;
    tmdbEndpoint: string;
    tmdbAccessToken: string;
    moviePreSignedUrlExpiration: number;
    throttlingConfig: any;
    devWebsiteUsername?: string;
    devWebsitePassword?: string;
}

export class MediaLibraryStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MediaLibraryStackProps) {
        super(scope, id, props);

        /* CONSTANTS - CORS ORIGINS */
        const allowedOriginsDev = [
            `https://${props.domainName}`,
            ...(props.secondaryDomainName
                ? [`https://${props.secondaryDomainName}`]
                : []),

            "http://localhost:3000",
            "http://localhost:8080",
            "https://localhost:3000",
            "https://localhost:8080",
            "https://localhost:8443",
        ];
        const allowedOriginsProd = [
            `https://${props.domainName}`,
            ...(props.secondaryDomainName
                ? [`https://${props.secondaryDomainName}`]
                : []),
        ];
        const allowedOrigins =
            props.stageName === "dev" ? allowedOriginsDev : allowedOriginsProd;
        const allowedOrigin = allowedOrigins[0];

        /* ROUTE 53 - CUSTOM DOMAIN HOSTED ZONES */
        const primaryHostedZone = route53.HostedZone.fromLookup(
            this,
            "PrimaryHostedZone",
            {
                domainName: props.primaryHostedZone, // Lookup existing hosted zone
            }
        );
        let secondaryHostedZone;
        if (props.secondaryDomainNameHostedZone) {
            secondaryHostedZone =
                props.stageName === "dev"
                    ? new route53.HostedZone(this, "SecondaryHostedZone", {
                          zoneName: props.secondaryDomainNameHostedZone,
                      })
                    : route53.HostedZone.fromLookup(
                          this,
                          "SecondaryHostedZone",
                          {
                              domainName: props.secondaryDomainNameHostedZone,
                          }
                      );
        }

        /* SSL CERTIFICATES - CUSTOM DOMAINS */
        const websiteCertificate = new acm.Certificate(this, "Certificate", {
            domainName: props.domainName, // media-dev.anuv.me
            subjectAlternativeNames: props.secondaryDomainName
                ? [props.secondaryDomainName] // dev.streamy.sh
                : undefined,
            validation: acm.CertificateValidation.fromDnsMultiZone({
                [props.domainName]: primaryHostedZone, // existing anuv.me zone
                ...(props.secondaryDomainName && secondaryHostedZone
                    ? {
                          [props.secondaryDomainName]: secondaryHostedZone, // new streamy.sh zone
                      }
                    : {}),
            }),
        });
        const apiCertificate = new acm.Certificate(this, "ApiCertificate", {
            domainName: props.apiDomainName, // media-api-dev.anuv.me
            subjectAlternativeNames: props.secondaryApiDomainName
                ? [props.secondaryApiDomainName] // api-dev.streamy.sh
                : undefined,
            validation: acm.CertificateValidation.fromDnsMultiZone({
                [props.apiDomainName]: primaryHostedZone, // existing anuv.me zone
                ...(props.secondaryApiDomainName && secondaryHostedZone
                    ? {
                          [props.secondaryApiDomainName]: secondaryHostedZone, // new streamy.sh zone
                      }
                    : {}),
            }),
        });

        /* DYNAMODB TABLES - LIBRARY ACCESS CONTROL */
        // Main table for library ownership and access type
        const libraryAccessTable = new dynamodb.Table(
            this,
            "LibraryAccessTableV2",
            {
                // tableName: `media-library-access-${props.stageName}`,
                partitionKey: {
                    name: "ownerIdentityId",
                    type: dynamodb.AttributeType.STRING,
                },
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                removalPolicy:
                    props.stageName === "dev"
                        ? cdk.RemovalPolicy.DESTROY
                        : cdk.RemovalPolicy.RETAIN,
            }
        );
        // Add GSI for username lookup
        libraryAccessTable.addGlobalSecondaryIndex({
            indexName: "OwnerUsernameIndex",
            partitionKey: {
                name: "ownerUsername",
                type: dynamodb.AttributeType.STRING,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // Table for library sharing relationships - cleaner structure
        const librarySharedTable = new dynamodb.Table(
            this,
            "LibrarySharedTableV2",
            {
                // tableName: `media-library-shared-${props.stageName}`,
                partitionKey: {
                    name: "ownerIdentityId",
                    type: dynamodb.AttributeType.STRING,
                }, // Owner of the library
                sortKey: {
                    name: "sharedWithIdentityId",
                    type: dynamodb.AttributeType.STRING,
                }, // User who has access
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                removalPolicy:
                    props.stageName === "dev"
                        ? cdk.RemovalPolicy.DESTROY
                        : cdk.RemovalPolicy.RETAIN,
            }
        );
        librarySharedTable.addGlobalSecondaryIndex({
            indexName: "SharedWithIdentityIndex",
            partitionKey: {
                name: "sharedWithIdentityId",
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: "ownerIdentityId",
                type: dynamodb.AttributeType.STRING,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // Table for tracking movie upload status
        const movieUploadStatusTable = new dynamodb.Table(
            this,
            "MovieUploadStatusTable",
            {
                partitionKey: {
                    name: "ownerIdentityId",
                    type: dynamodb.AttributeType.STRING,
                },
                sortKey: {
                    name: "movieId",
                    type: dynamodb.AttributeType.STRING,
                },
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                removalPolicy:
                    props.stageName === "dev"
                        ? cdk.RemovalPolicy.DESTROY
                        : cdk.RemovalPolicy.RETAIN,
                // TTL for automatic cleanup of old status records
                timeToLiveAttribute: "expiresAt",
            }
        );

        /* SQS QUEUE - WORKER COMMANDS */
        // Create SQS queue for worker commands
        const workerCommandQueue = new sqs.Queue(this, "WorkerCommandQueue", {
            queueName: `media-worker-commands-${props.stageName}`,
            // Messages will be held for 14 days max
            retentionPeriod: cdk.Duration.days(14),
            // Allow 15 minutes for processing before message becomes visible again
            visibilityTimeout: cdk.Duration.minutes(15),
            // Dead letter queue after 3 failed attempts
            deadLetterQueue: {
                queue: new sqs.Queue(this, "WorkerCommandDLQ", {
                    queueName: `media-worker-commands-dlq-${props.stageName}`,
                    retentionPeriod: cdk.Duration.days(14),
                }),
                maxReceiveCount: 3,
            },
            removalPolicy:
                props.stageName === "dev"
                    ? cdk.RemovalPolicy.DESTROY
                    : cdk.RemovalPolicy.RETAIN,
        });

        /* S3 BUCKETS - WEBSITE BUCKET */
        // Website bucket for static files
        const websiteBucket = new s3.Bucket(this, "MediaLibraryWebsiteBucket", {
            bucketName: `${props.awsWebsiteBucketPrefix}-${this.account}-${props.stageName}`,
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            versioned: true,
            lifecycleRules: [
                {
                    // Remove backups (older versions of files that have been replaced by subsequent uploads) after 4 days
                    id: "CleanupNoncurrentVersions",
                    noncurrentVersionExpiration: cdk.Duration.days(4),
                },
            ],
        });

        /* S3 BUCKET - LIBRARY BUCKET */
        // Bucket for library metadata
        const libraryBucket = new s3.Bucket(this, "MediaLibraryLibraryBucket", {
            bucketName: `${props.awsLibraryBucketPrefix}-${this.account}-${props.stageName}`,
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            versioned: true,
            lifecycleRules: [
                {
                    // Remove backups (older versions of files that have been replaced by subsequent uploads) after 4 days
                    id: "CleanupNoncurrentVersions",
                    noncurrentVersionExpiration: cdk.Duration.days(4),
                },
            ],
        });
        // Download restriction - CORS origin
        libraryBucket.addCorsRule({
            allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
            allowedOrigins: allowedOrigins,
            allowedHeaders: ["*"],
            exposedHeaders: ["ETag"],
            maxAge: 3000,
        });

        /* S3 BUCKETS - MEDIA BUCKET */
        // Input bucket for media cache
        const mediaBucket = new s3.Bucket(this, "MediaLibraryMediaBucket", {
            bucketName: `${props.awsMediaBucketPrefix}-${this.account}-${props.stageName}`, // Make unique per account
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            transferAcceleration: true,
            versioned: true,
            lifecycleRules: [
                {
                    // Create strict bucket TTL policy
                    // Cache media in cloud for 14 days
                    expiration: cdk.Duration.days(14),
                    id: "DeleteAfterFourteenDays",
                    // Ensure noncurrent versions are also deleted
                    noncurrentVersionExpiration: cdk.Duration.days(4),
                    // Cleanup incomplete multipart uploads
                    abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
                },
                {
                    // Separate rule for expired object delete markers
                    id: "CleanupExpiredDeleteMarkers",
                    // Enable expiration of delete markers with no noncurrent versions
                    expiredObjectDeleteMarker: true,
                },
            ],
        });
        // Download restriction - CORS origin
        mediaBucket.addCorsRule({
            allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
            allowedOrigins: allowedOrigins,
            allowedHeaders: ["*"],
            exposedHeaders: [
                "ETag",
                "Content-Range", // Important for range requests
                "Accept-Ranges", // Important for range requests
            ],
            maxAge: 3000,
        });

        /* S3 BUCKETS - PLAYLIST BUCKET */
        const playlistBucket = new s3.Bucket(
            this,
            "MediaLibraryPlaylistBucket",
            {
                bucketName: `${props.awsPlaylistBucketPrefix}-${this.account}-${props.stageName}`, // Make unique per account
                publicReadAccess: false,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
                transferAcceleration: true,
                versioned: true,
                lifecycleRules: [
                    {
                        // Create strict bucket TTL policy
                        // Cache media in cloud for 14 days
                        expiration: cdk.Duration.days(14),
                        id: "DeleteAfterFourteenDays",
                        // Ensure noncurrent versions are also deleted
                        noncurrentVersionExpiration: cdk.Duration.days(4),
                        // Cleanup incomplete multipart uploads
                        abortIncompleteMultipartUploadAfter:
                            cdk.Duration.days(1),
                    },
                    {
                        // Separate rule for expired object delete markers
                        id: "CleanupExpiredDeleteMarkers",
                        // Enable expiration of delete markers with no noncurrent versions
                        expiredObjectDeleteMarker: true,
                    },
                ],
            }
        );
        // Download restriction - CORS origin
        playlistBucket.addCorsRule({
            allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
            allowedOrigins: allowedOrigins,
            allowedHeaders: ["*"],
            exposedHeaders: [
                "ETag",
                "Content-Range", // Important for range requests
                "Accept-Ranges", // Important for range requests
            ],
            maxAge: 3000,
        });

        /* S3 BUCKETS - POSTER BUCKET */
        const posterBucket = new s3.Bucket(this, "MediaLibraryPosterBucket", {
            bucketName: `${props.awsPosterBucketPrefix}-${this.account}-${props.stageName}`,
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            versioned: true,
            lifecycleRules: [
                {
                    id: "CleanupNoncurrentVersions",
                    noncurrentVersionExpiration: cdk.Duration.days(4),
                },
            ],
        });
        // Download restriction - CORS origin
        posterBucket.addCorsRule({
            allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
            allowedOrigins: allowedOrigins,
            allowedHeaders: ["*"],
            exposedHeaders: ["ETag"],
            maxAge: 3000,
        });

        /* CLOUDFRONT CDN - ORIGINS */
        // CloudFront distribution origins & access identities
        const websiteOAI = new cloudfront.OriginAccessIdentity(
            this,
            `WebsiteBucketOAI`,
            {
                comment: `OAI for CloudFront -> S3 Bucket ${websiteBucket.bucketName}`,
            }
        );
        websiteBucket.grantRead(websiteOAI);
        const websiteOrigin = new origins.S3Origin(websiteBucket, {
            originAccessIdentity: websiteOAI,
        });
        const posterOAI = new cloudfront.OriginAccessIdentity(
            this,
            `PosterBucketOAI`,
            {
                comment: `OAI for CloudFront -> S3 Bucket ${posterBucket.bucketName}`,
            }
        );
        posterBucket.grantRead(posterOAI);
        const posterOrigin = new origins.S3Origin(posterBucket, {
            originAccessIdentity: posterOAI,
        });

        /* CLOUDFRONT CDN - URL REWRITES & DEV ENV ACCESS */
        // Create CloudFront Function for url rewrites and basic auth when in dev stage
        let viewerRequestFunction: cloudfront.Function | undefined;
        if (props.stageName === "dev") {
            // Base64 encode the credentials
            const credentials = Buffer.from(
                `${props.devWebsiteUsername}:${props.devWebsitePassword}`
            ).toString("base64");

            viewerRequestFunction = new cloudfront.Function(
                this,
                `ViewerRequestFunction`,
                {
                    code: cloudfront.FunctionCode.fromInline(`
                        function handler(event) {
                            var request = event.request;
                            var headers = request.headers;
                            var uri = request.uri;

                            /* Basic auth */
                            // Check for Basic auth header
                            if (!headers.authorization) {
                                return {
                                    statusCode: 401,
                                    statusDescription: 'Unauthorized',
                                    headers: {
                                        'www-authenticate': { value: 'Basic' }
                                    }
                                };
                            }
                            // Verify credentials
                            var authHeader = headers.authorization.value;
                            var expectedHeader = 'Basic ${credentials}';
                            if (authHeader !== expectedHeader) {
                                return {
                                    statusCode: 401,
                                    statusDescription: 'Unauthorized',
                                    headers: {
                                        'www-authenticate': { value: 'Basic' }
                                    }
                                };
                            }

                            /* URL rewrites */
                            // Only rewrite if not root or file
                            if (uri !== '/' && !uri.includes('.')) {
                                // Redirect /folder -> /folder/
                                if (!uri.endsWith('/')) {
                                    uri += '/';
                                }
                                // Rewrite /folder/ -> /folder/index.html
                                if (uri.endsWith('/')) {
                                    uri += 'index.html';
                                }
                            }
                            // Update request.uri
                            request.uri = uri;
                            
                            return request;
                        }
                    `),
                }
            );
        } else {
            viewerRequestFunction = new cloudfront.Function(
                this,
                `ViewerRequestFunction`,
                {
                    code: cloudfront.FunctionCode.fromInline(`
                        function handler(event) {
                            var request = event.request;
                            var uri = request.uri;

                            /* URL rewrites */
                            // Only rewrite if not root or file
                            if (uri !== '/' && !uri.includes('.')) {
                                // Redirect /folder -> /folder/
                                if (!uri.endsWith('/')) {
                                    uri += '/';
                                }
                                // Rewrite /folder/ -> /folder/index.html
                                if (uri.endsWith('/')) {
                                    uri += 'index.html';
                                }
                            }
                            // Update request.uri
                            request.uri = uri;

                            return request;
                        }
                    `),
                }
            );
        }

        /* CLOUDFRONT CDN - CACHING POLICY */
        // Create strict caching policy
        const cdnCachePolicy = new cloudfront.CachePolicy(
            this,
            "MediaLibraryCDNCachePolicy",
            {
                comment: "Policy for media library CDN content caching",
                defaultTtl: cdk.Duration.hours(6),
                minTtl: cdk.Duration.hours(6),
                maxTtl: cdk.Duration.hours(6),
                enableAcceptEncodingGzip: true,
                enableAcceptEncodingBrotli: true,
            }
        );

        /* CLOUDFRONT CDN - DISTRIBUTION */
        // Create CloudFront distribution
        const distribution = new cloudfront.Distribution(
            this,
            `WebsiteDistribution`,
            {
                defaultBehavior: {
                    origin: websiteOrigin,
                    viewerProtocolPolicy:
                        cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                    cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
                    originRequestPolicy:
                        cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
                    responseHeadersPolicy:
                        cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
                    functionAssociations: [
                        {
                            function: viewerRequestFunction,
                            eventType:
                                cloudfront.FunctionEventType.VIEWER_REQUEST,
                        },
                    ],
                },
                additionalBehaviors: {
                    "/poster/*": {
                        origin: posterOrigin,
                        viewerProtocolPolicy:
                            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                        allowedMethods:
                            cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
                        originRequestPolicy:
                            cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
                        responseHeadersPolicy:
                            cloudfront.ResponseHeadersPolicy
                                .CORS_ALLOW_ALL_ORIGINS,
                        cachePolicy: cdnCachePolicy,
                    },
                },
                priceClass:
                    props.stageName === "dev"
                        ? cloudfront.PriceClass.PRICE_CLASS_100
                        : cloudfront.PriceClass.PRICE_CLASS_ALL,
                domainNames: [
                    props.domainName,
                    ...(props.secondaryDomainName
                        ? [props.secondaryDomainName]
                        : []),
                ],
                certificate: websiteCertificate,
                defaultRootObject: "index.html",
                errorResponses: [
                    {
                        httpStatus: 403,
                        responseHttpStatus: 403,
                        responsePagePath: "/errors/403.html",
                    },
                    {
                        httpStatus: 404,
                        responseHttpStatus: 404,
                        responsePagePath: "/errors/404.html",
                    },
                ],
            }
        );

        /* COGNITO IDENTITY POOL - USER AUTHENTICATION */
        // Create User Pool for user authentication
        const userPool = new cognito.UserPool(this, "MediaLibraryUserPool", {
            userPoolName: `media-library-user-pool-${props.stageName}`,
            selfSignUpEnabled: true,
            signInAliases: {
                email: true,
                username: true,
            },
            autoVerify: {
                email: true,
            },
            passwordPolicy: {
                minLength: 8,
                requireLowercase: true,
                requireUppercase: true,
                requireDigits: true,
                requireSymbols: true,
            },
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            standardAttributes: {
                email: {
                    required: true,
                    mutable: true,
                },
                givenName: {
                    required: false,
                    mutable: true,
                },
                familyName: {
                    required: false,
                    mutable: true,
                },
            },
            userVerification: {
                emailSubject: "Verify your email for Media Library",
                emailBody:
                    "Thanks for signing up! Your verification code is {####}",
                emailStyle: cognito.VerificationEmailStyle.CODE,
            },
            removalPolicy:
                props.stageName === "dev"
                    ? cdk.RemovalPolicy.DESTROY
                    : cdk.RemovalPolicy.RETAIN,
        });
        // Create User Pool Client
        const userPoolClient = new cognito.UserPoolClient(
            this,
            "MediaLibraryUserPoolClient",
            {
                userPool,
                userPoolClientName: `media-library-user-pool-client-${props.stageName}`,
                authFlows: {
                    userSrp: true,
                    userPassword: true, // Enable username/password auth
                    adminUserPassword: true, // Allow admin to set passwords
                },
                generateSecret: false, // Important: must be false for frontend apps
                preventUserExistenceErrors: true,
                // Configure token validity
                accessTokenValidity: cdk.Duration.hours(1),
                idTokenValidity: cdk.Duration.hours(1),
                refreshTokenValidity: cdk.Duration.days(30),
                enableTokenRevocation: true,
                // OAuth settings (optional, for future social login support)
                oAuth: {
                    flows: {
                        authorizationCodeGrant: true,
                    },
                    scopes: [
                        cognito.OAuthScope.OPENID,
                        cognito.OAuthScope.EMAIL,
                        cognito.OAuthScope.PROFILE,
                    ],
                    callbackUrls: [
                        allowedOrigin,
                        ...(props.secondaryDomainName
                            ? [`https://${props.secondaryDomainName}`]
                            : []),
                    ],
                    logoutUrls: [
                        allowedOrigin,
                        ...(props.secondaryDomainName
                            ? [`https://${props.secondaryDomainName}`]
                            : []),
                    ],
                },
            }
        );
        // // Create Cognito authorizer for authenticated endpoints
        // const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
        //     this,
        //     "CognitoAuthorizer",
        //     {
        //         cognitoUserPools: [userPool],
        //         authorizerName: "CognitoAuthorizer",
        //         identitySource: "method.request.header.Authorization",
        //     }
        // );
        // Identity pool
        const identityPool = new cognito.CfnIdentityPool(
            this,
            "MediaLibraryIdentityPool",
            {
                allowUnauthenticatedIdentities: true,
                cognitoIdentityProviders: [
                    {
                        clientId: userPoolClient.userPoolClientId,
                        providerName: userPool.userPoolProviderName,
                    },
                ],
            }
        );

        /* LAMBDA FUNCTIONS - LIBRARY API */
        // Lambda function for library management API
        const libraryApiLambda = new nodejs.NodejsFunction(
            this,
            "LibraryApiLambda",
            {
                runtime: lambda.Runtime.NODEJS_18_X,
                handler: "main.handler",
                timeout: cdk.Duration.seconds(60), // Increase timeout for large playlists
                memorySize: 1024, // More memory = better CPU for parallel processing
                code: lambda.Code.fromAsset(
                    path.join(__dirname, "../lambdas/library-api")
                ),
                environment: {
                    LIBRARY_ACCESS_TABLE_NAME: libraryAccessTable.tableName,
                    LIBRARY_SHARED_TABLE_NAME: librarySharedTable.tableName,
                    LIBRARY_BUCKET_NAME: libraryBucket.bucketName,
                    PLAYLIST_BUCKET_NAME: playlistBucket.bucketName,
                    MEDIA_BUCKET_NAME: mediaBucket.bucketName,
                    POSTER_BUCKET_NAME: posterBucket.bucketName,
                    MOVIE_UPLOAD_STATUS_TABLE_NAME:
                        movieUploadStatusTable.tableName,
                    ALLOWED_ORIGINS: allowedOrigins.join(","),
                    USER_POOL_ID: userPool.userPoolId,
                    IDENTITY_POOL_ID: identityPool.ref,
                    SQS_QUEUE_URL: workerCommandQueue.queueUrl,
                    MOVIE_PRE_SIGNED_URL_EXPIRATION: `${props.moviePreSignedUrlExpiration}`,
                    NODE_OPTIONS: "--max-old-space-size=512",
                },
            }
        );

        /* IAM - COGNITO USER ROLES */
        // Create IAM role for unauthenticated access
        const unauthRole = new iam.Role(this, "CognitoUnauthRole", {
            assumedBy: new iam.FederatedPrincipal(
                "cognito-identity.amazonaws.com",
                {
                    StringEquals: {
                        "cognito-identity.amazonaws.com:aud": identityPool.ref,
                    },
                    "ForAnyValue:StringLike": {
                        "cognito-identity.amazonaws.com:amr": "unauthenticated",
                    },
                },
                "sts:AssumeRoleWithWebIdentity"
            ),
        });
        // Create authenticated role for logged-in users
        const authRole = new iam.Role(this, "CognitoAuthRole", {
            assumedBy: new iam.FederatedPrincipal(
                "cognito-identity.amazonaws.com",
                {
                    StringEquals: {
                        "cognito-identity.amazonaws.com:aud": identityPool.ref,
                    },
                    "ForAnyValue:StringLike": {
                        "cognito-identity.amazonaws.com:amr": "authenticated",
                    },
                },
                "sts:AssumeRoleWithWebIdentity"
            ),
        });
        // Set roles on identity pool
        const identityPoolRoleAttachment =
            new cognito.CfnIdentityPoolRoleAttachment(
                this,
                "IdentityPoolRoleAttachment",
                {
                    identityPoolId: identityPool.ref,
                    roles: {
                        authenticated: authRole.roleArn,
                        unauthenticated: unauthRole.roleArn,
                    },
                }
            );

        /* IAM - LIBRARY API */
        // Grant permissions to the Lambda function
        libraryAccessTable.grantReadWriteData(libraryApiLambda);
        librarySharedTable.grantReadWriteData(libraryApiLambda);
        movieUploadStatusTable.grantReadWriteData(libraryApiLambda);
        libraryBucket.grantRead(libraryApiLambda);
        playlistBucket.grantReadWrite(libraryApiLambda);
        mediaBucket.grantRead(libraryApiLambda);
        posterBucket.grantReadWrite(libraryApiLambda);
        workerCommandQueue.grantSendMessages(libraryApiLambda);
        libraryApiLambda.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["cognito-idp:ListUsers", "cognito-idp:AdminGetUser"],
                resources: [userPool.userPoolArn],
            })
        );
        libraryApiLambda.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "cognito-identity:DescribeIdentity",
                    "cognito-identity:ListIdentities",
                ],
                resources: [
                    `arn:aws:cognito-identity:${this.region}:${this.account}:identitypool/${identityPool.ref}`,
                ],
            })
        );

        /* API GATEWAY - CORS CONFIG */
        const apiCorsConfig = {
            allowOrigins: allowedOrigins,
            allowMethods: ["GET", "POST", "DELETE"],
            allowHeaders: [
                "Content-Type",
                "Authorization",
                "X-Amz-Date",
                "X-Amz-Security-Token",
                "X-Api-Key",
                "x-amz-content-sha256",
                "x-amz-target",
            ],
            maxAge: cdk.Duration.minutes(10),
            allowCredentials: true,
        };
        const getCORSResponseParametersForAPIGateway = () => {
            const corsOrigin = props.stageName === "dev" ? "*" : allowedOrigin;
            return {
                "Access-Control-Allow-Origin": `'${corsOrigin}'`,
                "Access-Control-Allow-Headers":
                    "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,x-amz-content-sha256'",
                "Access-Control-Allow-Methods": "'GET,POST,DELETE,OPTIONS'",
                "Access-Control-Allow-Credentials": "'true'",
            };
        };
        const getCORSResponseParametersForMethodResponse = () => {
            return {
                "method.response.header.Access-Control-Allow-Origin": true,
                "method.response.header.Access-Control-Allow-Headers": true,
                "method.response.header.Access-Control-Allow-Methods": true,
                "method.response.header.Access-Control-Allow-Credentials": true,
            };
        };
        const apiGatewayResponseTypes = [
            { name: "Response400", type: apigateway.ResponseType.DEFAULT_4XX },
            { name: "Response401", type: apigateway.ResponseType.DEFAULT_4XX },
            { name: "Response403", type: apigateway.ResponseType.DEFAULT_4XX },
            { name: "Response404", type: apigateway.ResponseType.DEFAULT_4XX },
            { name: "Response429", type: apigateway.ResponseType.DEFAULT_4XX },
            { name: "Response500", type: apigateway.ResponseType.DEFAULT_5XX },
        ];
        const apiGatewayStatusCodes = [
            "200",
            "204",
            "400",
            "401",
            "403",
            "404",
            "405",
            "429",
            "500",
        ];

        /* API GATEWAY - DEFINITION */
        // Log group
        const apiAccessLogGroup = new logs.LogGroup(
            this,
            "ApiGatewayAccessLogs",
            {
                retention: logs.RetentionDays.ONE_WEEK,
            }
        );
        const api = new apigateway.RestApi(this, "MediaLibraryApiV2", {
            restApiName: `MediaLibraryAPI-${this.account}-${props.stageName}`,
            defaultCorsPreflightOptions: apiCorsConfig,
            // defaultMethodOptions: {
            //     authorizationType: apigateway.AuthorizationType.IAM,
            // },
            endpointConfiguration: {
                types: [apigateway.EndpointType.REGIONAL],
            },
            deployOptions: {
                stageName: props.stageName,
                dataTraceEnabled: true,
                loggingLevel: apigateway.MethodLoggingLevel.INFO,
                accessLogDestination: new apigateway.LogGroupLogDestination(
                    apiAccessLogGroup
                ),
                accessLogFormat:
                    apigateway.AccessLogFormat.jsonWithStandardFields({
                        caller: true,
                        httpMethod: true,
                        ip: true,
                        protocol: true,
                        requestTime: true,
                        resourcePath: true,
                        responseLength: true,
                        status: true,
                        user: true,
                    }),
            },
        });
        apiGatewayResponseTypes.forEach(({ name, type }) => {
            api.addGatewayResponse(name, {
                type,
                responseHeaders: getCORSResponseParametersForAPIGateway(),
            });
        });
        const apiDefinition = new apigateway.Model(this, "ApiDefinition", {
            restApi: api,
            contentType: "application/json",
            modelName: "ApiDefinition",
            schema: {
                type: apigateway.JsonSchemaType.OBJECT,
                properties: {
                    dummy: {
                        type: apigateway.JsonSchemaType.OBJECT,
                        properties: {
                            dummy: { type: apigateway.JsonSchemaType.STRING },
                        },
                        required: ["dummy"],
                    },
                },
            },
        });

        /* API GATEWAY - INTEGRATIONS */
        const libraryApiIntegration = new apigateway.LambdaIntegration(
            libraryApiLambda
        );
        const tmdbSearchMovieApiIntegration = new apigateway.HttpIntegration(
            `${props.tmdbEndpoint}/3/search/movie`,
            {
                httpMethod: "GET",
                options: {
                    requestParameters: {
                        "integration.request.header.Authorization": `'Bearer ${props.tmdbAccessToken}'`,
                        "integration.request.querystring.query":
                            "method.request.querystring.query",
                        "integration.request.querystring.year":
                            "method.request.querystring.year",
                    },
                },
            }
        );

        /* API GATEWAY - REQUEST HANDLERS */
        // GET /libraries - Get user's accessible libraries
        const librariesResource = api.root.addResource("libraries");
        librariesResource.addMethod("GET", libraryApiIntegration, {
            authorizationType: apigateway.AuthorizationType.IAM,
        });
        // GET /libraries/{ownerIdentityId}/library - Get specific library metadata
        const ownerLibraryResource =
            librariesResource.addResource("{ownerIdentityId}");
        const libraryJsonResource = ownerLibraryResource.addResource("library");
        libraryJsonResource.addMethod("GET", libraryApiIntegration, {
            authorizationType: apigateway.AuthorizationType.IAM,
            requestParameters: {
                "method.request.path.ownerIdentityId": true,
            },
        });
        // POST /libraries/{ownerIdentityId}/refresh - Refresh library index
        const refreshResource = ownerLibraryResource.addResource("refresh");
        refreshResource.addMethod("POST", libraryApiIntegration, {
            authorizationType: apigateway.AuthorizationType.IAM,
            requestParameters: {
                "method.request.path.ownerIdentityId": true,
            },
        });
        // GET /libraries/{ownerIdentityId}/movies/{movieId}/subtitles - Get movie subtitles
        const moviesResource = ownerLibraryResource.addResource("movies");
        const movieResource = moviesResource.addResource("{movieId}");
        const subtitlesResource = movieResource.addResource("subtitles");
        subtitlesResource.addMethod("GET", libraryApiIntegration, {
            authorizationType: apigateway.AuthorizationType.IAM,
            requestParameters: {
                "method.request.path.ownerIdentityId": true,
                "method.request.path.movieId": true,
            },
        });
        // GET /libraries/{ownerIdentityId}/movies/{movieId}/playlist - Get movie playlist
        const playlistResource = movieResource.addResource("playlist");
        playlistResource.addMethod("GET", libraryApiIntegration, {
            authorizationType: apigateway.AuthorizationType.IAM,
            requestParameters: {
                "method.request.path.ownerIdentityId": true,
                "method.request.path.movieId": true,
            },
        });
        const processPlaylistResource = playlistResource.addResource("process");
        processPlaylistResource.addMethod("POST", libraryApiIntegration, {
            authorizationType: apigateway.AuthorizationType.IAM,
            requestParameters: {
                "method.request.path.ownerIdentityId": true,
                "method.request.path.movieId": true,
            },
        });
        const requestResource = movieResource.addResource("request");
        requestResource.addMethod("POST", libraryApiIntegration, {
            authorizationType: apigateway.AuthorizationType.IAM,
            requestParameters: {
                "method.request.path.ownerIdentityId": true,
                "method.request.path.movieId": true,
            },
        });
        // GET/POST /libraries/{ownerIdentityId}/movies/{movieId}/status - Movie upload status
        const statusResource = movieResource.addResource("status");
        statusResource.addMethod("GET", libraryApiIntegration, {
            authorizationType: apigateway.AuthorizationType.IAM,
            requestParameters: {
                "method.request.path.ownerIdentityId": true,
                "method.request.path.movieId": true,
            },
        });
        statusResource.addMethod("POST", libraryApiIntegration, {
            authorizationType: apigateway.AuthorizationType.IAM,
            requestParameters: {
                "method.request.path.ownerIdentityId": true,
                "method.request.path.movieId": true,
            },
        });
        // POST /libraries/{ownerIdentityId}/share - Share library with another user
        const shareResource = ownerLibraryResource.addResource("share");
        shareResource.addMethod("POST", libraryApiIntegration, {
            authorizationType: apigateway.AuthorizationType.IAM,
            requestParameters: {
                "method.request.path.ownerIdentityId": true,
            },
        });
        // GET /libraries/{ownerIdentityId}/share - List shared access for a library
        shareResource.addMethod("GET", libraryApiIntegration, {
            authorizationType: apigateway.AuthorizationType.IAM,
            requestParameters: {
                "method.request.path.ownerIdentityId": true,
            },
        });
        // DELETE /libraries/{ownerIdentityId}/share/{shareWithIdentityId} - Remove shared access
        const shareUserResource = shareResource.addResource(
            "{shareWithIdentityId}"
        );
        shareUserResource.addMethod("DELETE", libraryApiIntegration, {
            authorizationType: apigateway.AuthorizationType.IAM,
            requestParameters: {
                "method.request.path.ownerIdentityId": true,
                "method.request.path.shareWithIdentityId": true,
            },
        });
        // POST /libraries/{ownerIdentityId}/access - Create or update library access record
        const accessResource = ownerLibraryResource.addResource("access");
        accessResource.addMethod("POST", libraryApiIntegration, {
            authorizationType: apigateway.AuthorizationType.IAM,
            requestParameters: {
                "method.request.path.ownerIdentityId": true,
            },
        });
        // GET /libraries/{ownerIdentityId}/access - Get library access record
        accessResource.addMethod("GET", libraryApiIntegration, {
            authorizationType: apigateway.AuthorizationType.IAM,
            requestParameters: {
                "method.request.path.ownerIdentityId": true,
            },
        });
        // GET /metadata - Create or update library access record
        const metadataResource = api.root.addResource("metadata");
        metadataResource.addMethod("GET", tmdbSearchMovieApiIntegration, {
            authorizationType: apigateway.AuthorizationType.NONE,
            requestParameters: {
                // Declare expected query parameters
                "method.request.querystring.query": false,
                "method.request.querystring.year": false,
            },
        });

        /* API GATEWAY - CUSTOM DOMAINS */
        // Create the custom domain in API Gateway
        const apiCustomDomain = new apigateway.DomainName(
            this,
            "CustomDomainName",
            {
                domainName: props.apiDomainName,
                certificate: apiCertificate,
                endpointType: apigateway.EndpointType.REGIONAL,
                securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
            }
        );
        // Map the custom domain to your API's stage
        new apigateway.BasePathMapping(this, "ApiMapping", {
            restApi: api,
            stage: api.deploymentStage,
            domainName: apiCustomDomain,
        });
        // Add secondary API domain if provided
        let secondaryApiCustomDomain: apigateway.DomainName | undefined;
        if (props.secondaryApiDomainName && apiCertificate) {
            secondaryApiCustomDomain = new apigateway.DomainName(
                this,
                "SecondaryCustomDomainName",
                {
                    domainName: props.secondaryApiDomainName,
                    certificate: apiCertificate,
                    endpointType: apigateway.EndpointType.REGIONAL,
                    securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
                }
            );

            new apigateway.BasePathMapping(this, "SecondaryApiMapping", {
                restApi: api,
                stage: api.deploymentStage,
                domainName: secondaryApiCustomDomain,
            });
        }

        /* API GATEWAY - THROTTLING */
        // const apiLimits = calculateTPS(props.throttlingConfig);
        // // Create usage plan with throttling settings
        // const usagePlan = api.addUsagePlan("ImageGenApiUsagePlan", {
        //     name: `ImageGenApiUsagePlan-${props.stageName}`,
        //     throttle: {
        //         rateLimit: Math.max(
        //             apiLimits.limits.runTPS,
        //             apiLimits.limits.statusTPS
        //         ),
        //         burstLimit: Math.max(
        //             apiLimits.limits.runTPSBurst,
        //             apiLimits.limits.statusTPSBurst
        //         ),
        //     },
        // });
        // // Add the API stage to the usage plan with method-level throttling
        // usagePlan.addApiStage({
        //     stage: api.deploymentStage,
        //     throttle: [
        //         {
        //             method: runMethod,
        //             throttle: {
        //                 rateLimit: apiLimits.limits.runTPS,
        //                 burstLimit: apiLimits.limits.runTPSBurst,
        //             },
        //         },
        //         {
        //             method: statusMethod,
        //             throttle: {
        //                 rateLimit: apiLimits.limits.statusTPS,
        //                 burstLimit: apiLimits.limits.statusTPSBurst,
        //             },
        //         },
        //         {
        //             method: uploadUrlMethod,
        //             throttle: {
        //                 rateLimit: apiLimits.limits.runTPS,
        //                 burstLimit: apiLimits.limits.runTPSBurst,
        //             },
        //         },
        //     ],
        // });

        /* API GATEWAY - IP-LEVEL THROTTLING */
        // // Create WAF Firewall Web ACL with IP-based rate limiting
        // let wafIPRateLimit, wafAssociation;
        // if (props.enableFirewall) {
        //     wafIPRateLimit = new wafv2.CfnWebACL(this, "APIWafIPRateLimit", {
        //         defaultAction: { allow: {} },
        //         scope: "REGIONAL",
        //         name: `ImageGenAPIWaf-${props.stageName}`,
        //         visibilityConfig: {
        //             cloudWatchMetricsEnabled: true,
        //             metricName: "ImageGenAPIWafMetrics",
        //             sampledRequestsEnabled: true,
        //         },
        //         rules: [
        //             {
        //                 name: "IPRateLimitRun",
        //                 priority: 1,
        //                 statement: {
        //                     rateBasedStatement: {
        //                         limit: apiLimits.limits.ipRunLimit,
        //                         aggregateKeyType: "IP",
        //                         scopeDownStatement: {
        //                             byteMatchStatement: {
        //                                 fieldToMatch: {
        //                                     uriPath: {},
        //                                 },
        //                                 positionalConstraint: "ENDS_WITH",
        //                                 searchString: "/run",
        //                                 textTransformations: [
        //                                     { priority: 1, type: "NONE" },
        //                                 ],
        //                             },
        //                         },
        //                     },
        //                 },
        //                 visibilityConfig: {
        //                     cloudWatchMetricsEnabled: true,
        //                     metricName: "IPRateLimitRun",
        //                     sampledRequestsEnabled: true,
        //                 },
        //                 action: { block: {} },
        //             },
        //             {
        //                 name: "IPRateLimitStatus",
        //                 priority: 2,
        //                 statement: {
        //                     rateBasedStatement: {
        //                         limit: apiLimits.limits.ipStatusLimit,
        //                         aggregateKeyType: "IP",
        //                         scopeDownStatement: {
        //                             byteMatchStatement: {
        //                                 fieldToMatch: {
        //                                     uriPath: {},
        //                                 },
        //                                 positionalConstraint: "CONTAINS",
        //                                 searchString: "/status/",
        //                                 textTransformations: [
        //                                     { priority: 1, type: "NONE" },
        //                                 ],
        //                             },
        //                         },
        //                     },
        //                 },
        //                 visibilityConfig: {
        //                     cloudWatchMetricsEnabled: true,
        //                     metricName: "IPRateLimitStatus",
        //                     sampledRequestsEnabled: true,
        //                 },
        //                 action: { block: {} },
        //             },
        //             {
        //                 name: "IPRateLimitUpload",
        //                 priority: 3,
        //                 statement: {
        //                     rateBasedStatement: {
        //                         limit: apiLimits.limits.ipRunLimit,
        //                         aggregateKeyType: "IP",
        //                         scopeDownStatement: {
        //                             byteMatchStatement: {
        //                                 fieldToMatch: {
        //                                     uriPath: {},
        //                                 },
        //                                 positionalConstraint: "ENDS_WITH",
        //                                 searchString: "/upload",
        //                                 textTransformations: [
        //                                     { priority: 1, type: "NONE" },
        //                                 ],
        //                             },
        //                         },
        //                     },
        //                 },
        //                 visibilityConfig: {
        //                     cloudWatchMetricsEnabled: true,
        //                     metricName: "IPRateLimitRun",
        //                     sampledRequestsEnabled: true,
        //                 },
        //                 action: { block: {} },
        //             },
        //         ],
        //     });
        //     // Associate WAF Firewall with API Gateway stage
        //     wafAssociation = new wafv2.CfnWebACLAssociation(
        //         this,
        //         "WafAssociation",
        //         {
        //             resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${api.restApiId}/stages/${api.deploymentStage.stageName}`,
        //             webAclArn: wafIPRateLimit.attrArn,
        //         }
        //     );
        // }

        /* IAM - AUTHENTICATED USERS */
        // TODO: tighten S3 & SQS upload permissions on authenticated users
        // Grant authenticated users write access to media/playlist/library buckets for their own content
        authRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["s3:PutObject"],
                resources: [
                    // Users can access their own media files using Cognito identity ID
                    `${libraryBucket.bucketArn}/library/\${cognito-identity.amazonaws.com:sub}/*`,
                ],
            })
        );
        authRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["s3:PutObject"],
                resources: [
                    // Users can update their own media files using Cognito identity ID
                    `${mediaBucket.bucketArn}/media/\${cognito-identity.amazonaws.com:sub}/*`,
                ],
            })
        );
        authRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["s3:PutObject", "s3:GetObject"],
                resources: [
                    // Users can access & update their own playlist files using Cognito identity ID
                    `${playlistBucket.bucketArn}/playlist/\${cognito-identity.amazonaws.com:sub}/*`,
                ],
            })
        );
        authRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["s3:PutObject"],
                resources: [
                    // Users can update their own poster files using Cognito identity ID
                    `${posterBucket.bucketArn}/poster/\${cognito-identity.amazonaws.com:sub}/*`,
                ],
            })
        );
        authRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["s3:ListBucket"],
                resources: [mediaBucket.bucketArn],
                conditions: {
                    StringLike: {
                        "s3:prefix": [
                            "media/${cognito-identity.amazonaws.com:sub}/*",
                        ],
                    },
                },
            })
        );
        authRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["s3:ListBucket"],
                resources: [posterBucket.bucketArn],
                conditions: {
                    StringLike: {
                        "s3:prefix": [
                            "poster/${cognito-identity.amazonaws.com:sub}/*",
                        ],
                    },
                },
            })
        );
        // Grant authenticated users permission to receive only their own messages
        authRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage"],
                resources: [workerCommandQueue.queueArn],
            })
        );
        // Allow cache invalidations (for media source worker)
        authRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "cloudfront:CreateInvalidation",
                    // "cloudfront:GetInvalidation", // Optional: to check invalidation status
                    // "cloudfront:ListInvalidations", // Optional: to list user's invalidations
                ],
                resources: [
                    `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
                ],
            })
        );
        // Grant authenticated users permission to call the API Gateway endpoints
        const getApiResource = (method: string, path: string) =>
            `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/${api.deploymentStage.stageName}/${method}/${path}`;
        authRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["execute-api:Invoke"],
                resources: [
                    getApiResource("GET", "libraries"),
                    getApiResource("OPTIONS", "libraries"),
                    getApiResource("GET", "libraries/*/library"),
                    getApiResource("OPTIONS", "libraries/*/library"),
                    getApiResource("POST", "libraries/*/refresh"),
                    getApiResource("OPTIONS", "libraries/*/refresh"),
                    getApiResource("GET", "libraries/*/movies/*/subtitles"),
                    getApiResource("OPTIONS", "libraries/*/movies/*/subtitles"),
                    getApiResource("GET", "libraries/*/movies/*/playlist"),
                    getApiResource("OPTIONS", "libraries/*/movies/*/playlist"),
                    getApiResource(
                        "POST",
                        "libraries/*/movies/*/playlist/process"
                    ),
                    getApiResource(
                        "OPTIONS",
                        "libraries/*/movies/*/playlist/process"
                    ),
                    getApiResource("POST", "libraries/*/movies/*/request"),
                    getApiResource("OPTIONS", "libraries/*/movies/*/request"),
                    getApiResource("GET", "libraries/*/movies/*/status"),
                    getApiResource("POST", "libraries/*/movies/*/status"),
                    getApiResource("OPTIONS", "libraries/*/movies/*/status"),
                    getApiResource("POST", "libraries/*/share"),
                    getApiResource("OPTIONS", "libraries/*/share"),
                    getApiResource("GET", "libraries/*/share"),
                    getApiResource("OPTIONS", "libraries/*/share"),
                    getApiResource("DELETE", "libraries/*/share/*"),
                    getApiResource("OPTIONS", "libraries/*/share/*"),
                    getApiResource("GET", "libraries/*/access"),
                    getApiResource("POST", "libraries/*/access"),
                    getApiResource("OPTIONS", "libraries/*/access"),
                    getApiResource("GET", "metadata"),
                    getApiResource("OPTIONS", "metadata"),
                ],
            })
        );

        /* ROUTE 53 - DNS RECORDS */
        // Primary domain records (existing anuv.me zone)
        new route53.ARecord(this, "PrimaryWebsiteAliasRecord", {
            zone: primaryHostedZone,
            recordName: props.domainName, // media-dev.anuv.me or media.anuv.me
            target: route53.RecordTarget.fromAlias(
                new targets.CloudFrontTarget(distribution)
            ),
        });
        new route53.ARecord(this, "PrimaryApiAliasRecord", {
            zone: primaryHostedZone,
            recordName: props.apiDomainName, // media-api-dev.anuv.me or media-api.anuv.me
            target: route53.RecordTarget.fromAlias(
                new targets.ApiGatewayDomain(apiCustomDomain)
            ),
        });
        if (
            props.secondaryDomainName &&
            props.secondaryApiDomainName &&
            secondaryHostedZone &&
            secondaryApiCustomDomain
        ) {
            new route53.ARecord(this, "SecondaryWebsiteAliasRecord", {
                zone: secondaryHostedZone,
                recordName: props.secondaryDomainName, // dev.streamy.sh or streamy.sh
                target: route53.RecordTarget.fromAlias(
                    new targets.CloudFrontTarget(distribution)
                ),
            });
            new route53.ARecord(this, "SecondaryApiAliasRecord", {
                zone: secondaryHostedZone,
                recordName: props.secondaryApiDomainName, // api-dev.streamy.sh or api.streamy.sh
                target: route53.RecordTarget.fromAlias(
                    new targets.ApiGatewayDomain(secondaryApiCustomDomain) // Use same API gateway
                ),
            });
        }

        /* STACK OUTPUTS */
        // if (secondaryHostedZone) {
        //     new cdk.CfnOutput(this, "SecondaryNameServers", {
        //         value: cdk.Fn.join(
        //             ", ",
        //             secondaryHostedZone.hostedZoneNameServers!
        //         ),
        //         description: "Route 53 nameservers for your secondary domain",
        //     });
        // }
        new cdk.CfnOutput(this, "CloudFrontDistributionId", {
            value: distribution.distributionId,
            description: "CloudFront Distribution ID",
        });
        new cdk.CfnOutput(this, "ApiUrl", {
            value: api.url,
            description: "URL of the API Gateway endpoint",
        });
        new cdk.CfnOutput(this, "UserPoolId", {
            value: userPool.userPoolId,
            description: "Cognito User Pool ID for user authentication",
        });
        new cdk.CfnOutput(this, "UserPoolClientId", {
            value: userPoolClient.userPoolClientId,
            description:
                "Cognito User Pool Client ID for frontend authentication",
        });
        new cdk.CfnOutput(this, "UserPoolDomain", {
            value: userPool.userPoolProviderName,
            description: "Cognito User Pool domain name",
        });
        new cdk.CfnOutput(this, "IdentityPoolId", {
            value: identityPool.ref,
            description:
                "ID of the Cognito Identity Pool for frontend authentication (both auth and unauth)",
        });
        new cdk.CfnOutput(this, "AuthenticatedRoleArn", {
            value: authRole.roleArn,
            description: "ARN of the authenticated user role",
        });
        new cdk.CfnOutput(this, "UnauthenticatedRoleArn", {
            value: unauthRole.roleArn,
            description: "ARN of the unauthenticated user role",
        });
        // new cdk.CfnOutput(this, "WafWebACLArn", {
        //     value:
        //         props.enableFirewall && wafIPRateLimit
        //             ? wafIPRateLimit.attrArn
        //             : "N/A (Firewall not enabled)",
        //     description: "ARN of the WAF Web ACL for IP-based rate limiting",
        // });
        new cdk.CfnOutput(this, "LibraryAccessTableName", {
            value: libraryAccessTable.tableName,
            description: "Database table for library access records",
        });
        new cdk.CfnOutput(this, "MovieUploadStatusTableName", {
            value: movieUploadStatusTable.tableName,
            description: "Database table for movie upload status tracking",
        });
        new cdk.CfnOutput(this, "LibraryBucketName", {
            value: libraryBucket.bucketName,
            description: "S3 bucket for storing user library metadata",
        });
        new cdk.CfnOutput(this, "MediaBucketName", {
            value: mediaBucket.bucketName,
            description: "Bucket name for storing cached media",
        });
        new cdk.CfnOutput(this, "PlaylistBucketName", {
            value: playlistBucket.bucketName,
            description: "Bucket name for storing media playlists",
        });
        new cdk.CfnOutput(this, "PosterBucketName", {
            value: posterBucket.bucketName,
            description: "S3 bucket for storing movie poster artwork",
        });
        new cdk.CfnOutput(this, "WebsiteBucketName", {
            value: websiteBucket.bucketName,
            description: "Bucket name for website files",
        });
        new cdk.CfnOutput(this, "WorkerCommandQueueUrl", {
            value: workerCommandQueue.queueUrl,
            description: "SQS Queue URL for worker commands",
        });
        new cdk.CfnOutput(this, "WorkerCommandQueueArn", {
            value: workerCommandQueue.queueArn,
            description: "SQS Queue ARN for worker commands",
        });
    }
}
