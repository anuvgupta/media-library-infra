// media-library-stack.ts

import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cr from "aws-cdk-lib/custom-resources";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

import { Construct } from "constructs";

interface LibraryAccessRecord {
    ownerId: string;
    accessType: "private" | "shared" | "public";
    createdAt: string;
    updatedAt: string;
}

interface LibrarySharedRecord {
    ownerId: string;
    sharedWithUserId: string;
    sharedAt: string;
    permissions: "read" | "write";
}

interface MediaLibraryStackProps extends cdk.StackProps {
    stageName: string;
    domainName: string;
    apiDomainName: string;
    awsLibraryBucketPrefix: string;
    awsMediaBucketPrefix: string;
    awsPlaylistBucketPrefix: string;
    awsWebsiteBucketPrefix: string;
    enableFirewall: boolean;
    throttlingConfig: any;
    devWebsiteUsername?: string;
    devWebsitePassword?: string;
}

export class MediaLibraryStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: MediaLibraryStackProps) {
        super(scope, id, props);

        /* CONSTANTS */
        const allowedOrigin = `https://${props.domainName}`;

        /* SSL CERTIFICATES - CUSTOM DOMAINS */
        // Create SSL certificate for the domain
        const websiteCertificate = new acm.Certificate(this, "Certificate", {
            domainName: props.domainName,
            validation: acm.CertificateValidation.fromDns(),
        });
        const apiCertificate = new acm.Certificate(this, "ApiCertificate", {
            domainName: props.apiDomainName,
            validation: acm.CertificateValidation.fromDns(),
        });

        /* DYNAMODB TABLES - LIBRARY ACCESS CONTROL */
        // Main table for library ownership and access type
        const libraryAccessTable = new dynamodb.Table(
            this,
            "LibraryAccessTable",
            {
                tableName: `media-library-access-${props.stageName}`,
                partitionKey: {
                    name: "ownerId",
                    type: dynamodb.AttributeType.STRING,
                },
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                removalPolicy:
                    props.stageName === "dev"
                        ? cdk.RemovalPolicy.DESTROY
                        : cdk.RemovalPolicy.RETAIN,
            }
        );
        // Table for library sharing relationships - cleaner structure
        const librarySharedTable = new dynamodb.Table(
            this,
            "LibrarySharedTable",
            {
                tableName: `media-library-shared-${props.stageName}`,
                partitionKey: {
                    name: "ownerId",
                    type: dynamodb.AttributeType.STRING,
                }, // Owner of the library
                sortKey: {
                    name: "sharedWithUserId",
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
            indexName: "SharedWithUserIndex",
            partitionKey: {
                name: "sharedWithUserId",
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: "ownerId",
                type: dynamodb.AttributeType.STRING,
            },
            projectionType: dynamodb.ProjectionType.ALL,
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
                    id: "CleanupNoncurrentVersions",
                    noncurrentVersionExpiration: cdk.Duration.days(30),
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
                    id: "CleanupNoncurrentVersions",
                    noncurrentVersionExpiration: cdk.Duration.days(30),
                },
            ],
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
                    // Minimum is 3 days
                    // No need to store cached media for more than 3 days
                    expiration: cdk.Duration.days(3),
                    id: "DeleteAfterThreeDays",
                    // Ensure noncurrent versions are also deleted
                    noncurrentVersionExpiration: cdk.Duration.days(3),
                    // Cleanup incomplete multipart uploads
                    abortIncompleteMultipartUploadAfter: cdk.Duration.days(3),
                },
                {
                    // Separate rule for expired object delete markers
                    id: "CleanupExpiredDeleteMarkers",
                    // Enable expiration of delete markers with no noncurrent versions
                    expiredObjectDeleteMarker: true,
                },
            ],
        });
        // // Upload restriction - CORS origin
        // mediaBucket.addCorsRule({
        //     allowedMethods: [
        //         s3.HttpMethods.PUT,
        //         s3.HttpMethods.POST,
        //         // s3.HttpMethods.GET,
        //         // s3.HttpMethods.HEAD,
        //     ],
        //     allowedOrigins: [allowedOrigin],
        //     allowedHeaders: ["*"],
        //     exposedHeaders: ["ETag"],
        //     maxAge: 3000,
        // });

        /* S3 BUCKETS - PLAYLIST BUCKET */
        const playlistBucket = new s3.Bucket(
            this,
            "MediaLibraryPlaylistBucket",
            {
                bucketName: `${props.awsPlaylistBucketPrefix}-${this.account}-${props.stageName}`, // Make unique per account
                publicReadAccess: true,
                blockPublicAccess: new s3.BlockPublicAccess({
                    blockPublicAcls: false,
                    blockPublicPolicy: false,
                    ignorePublicAcls: false,
                    restrictPublicBuckets: false,
                }),
                objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
                transferAcceleration: true,
                versioned: true,
                lifecycleRules: [
                    {
                        // Create strict bucket TTL policy
                        // Minimum is 3 days
                        // No need to store cached media for more than 3 days
                        expiration: cdk.Duration.days(3),
                        id: "DeleteAfterThreeDays",
                        // Ensure noncurrent versions are also deleted
                        noncurrentVersionExpiration: cdk.Duration.days(3),
                        // Cleanup incomplete multipart uploads
                        abortIncompleteMultipartUploadAfter:
                            cdk.Duration.days(3),
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
            allowedOrigins: [allowedOrigin],
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
                // additionalBehaviors: {},
                priceClass:
                    props.stageName === "dev"
                        ? cloudfront.PriceClass.PRICE_CLASS_100
                        : cloudfront.PriceClass.PRICE_CLASS_ALL,
                domainNames: [props.domainName],
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

        /* LAMBDA FUNCTIONS - LIBRARY API */
        // Lambda function for library management API
        const libraryApiLambda = new nodejs.NodejsFunction(
            this,
            "LibraryApiLambda",
            {
                runtime: lambda.Runtime.NODEJS_18_X,
                handler: "handler",
                code: lambda.Code.fromInline(`
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

const LIBRARY_ACCESS_TABLE = process.env.LIBRARY_ACCESS_TABLE_NAME;
const LIBRARY_SHARED_TABLE = process.env.LIBRARY_SHARED_TABLE_NAME;
const LIBRARY_BUCKET = process.env.LIBRARY_BUCKET_NAME;
const PLAYLIST_BUCKET = process.env.PLAYLIST_BUCKET_NAME;

exports.handler = async (event) => {
    const { httpMethod, pathParameters, requestContext } = event;
    const userId = requestContext.authorizer.claims.sub;
    
    console.log('Request:', { httpMethod, pathParameters, userId });
    
    try {
        switch (event.resource) {
            case '/libraries':
                return await getUserLibraries(userId);
            case '/libraries/{ownerId}/library.json':
                return await getLibraryJson(pathParameters.ownerId, userId);
            case '/libraries/{ownerId}/movies/{movieId}/playlist.m3u8':
                return await getMoviePlaylist(pathParameters.ownerId, pathParameters.movieId, userId);
            default:
                return createResponse(404, { error: 'Endpoint not found' });
        }
    } catch (error) {
        console.error('Error:', error);
        return createResponse(500, { error: 'Internal server error' });
    }
};

// Get all libraries accessible to the user
async function getUserLibraries(userId) {
    try {
        // Get user's own library
        const ownedLibrary = await dynamodb.get({
            TableName: LIBRARY_ACCESS_TABLE,
            Key: { ownerId: userId }
        }).promise();
        
        // Get libraries shared with user
        const sharedLibraries = await dynamodb.query({
            TableName: LIBRARY_SHARED_TABLE,
            IndexName: 'SharedWithUserIndex',
            KeyConditionExpression: 'sharedWithUserId = :userId',
            ExpressionAttributeValues: {
                ':userId': userId
            }
        }).promise();
        
        const result = {
            ownedLibrary: ownedLibrary.Item || null,
            sharedLibraries: sharedLibraries.Items.map(item => ({
                ownerId: item.ownerId,
                sharedAt: item.sharedAt,
                permissions: item.permissions
            }))
        };
        
        return createResponse(200, result);
    } catch (error) {
        console.error('Error getting user libraries:', error);
        throw error;
    }
}

// Get library.json for a specific user's library
async function getLibraryJson(ownerId, userId) {
    try {
        // Check if user has access to this library
        const hasAccess = await checkLibraryAccess(ownerId, userId);
        if (!hasAccess) {
            return createResponse(403, { error: 'Access denied to this library' });
        }
        
        // Get the library.json file from S3
        const s3Params = {
            Bucket: LIBRARY_BUCKET,
            Key: \`library/\${ownerId}/library.json\`
        };
        
        const s3Result = await s3.getObject(s3Params).promise();
        const libraryData = JSON.parse(s3Result.Body.toString());
        
        return createResponse(200, libraryData, 'application/json');
        
    } catch (error) {
        if (error.code === 'NoSuchKey') {
            return createResponse(404, { error: 'Library not found' });
        }
        console.error('Error getting library.json:', error);
        throw error;
    }
}

// Get playlist for a specific movie
async function getMoviePlaylist(ownerId, movieId, userId) {
    try {
        // Check if user has access to this library
        const hasAccess = await checkLibraryAccess(ownerId, userId);
        if (!hasAccess) {
            return createResponse(403, { error: 'Access denied to this library' });
        }
        
        // Get the playlist file from S3
        const s3Params = {
            Bucket: PLAYLIST_BUCKET,
            Key: \`media/\${ownerId}/movies/\${movieId}/playlist.m3u8\`
        };
        
        const s3Result = await s3.getObject(s3Params).promise();
        const playlistContent = s3Result.Body.toString();
        
        return createResponse(200, playlistContent, 'application/vnd.apple.mpegurl');
        
    } catch (error) {
        if (error.code === 'NoSuchKey') {
            return createResponse(404, { error: 'Playlist not found' });
        }
        console.error('Error getting playlist:', error);
        throw error;
    }
}

// Check if user has access to a library
async function checkLibraryAccess(ownerId, userId) {
    // Owner always has access
    if (ownerId === userId) {
        return true;
    }
    
    // Check if library exists and get its access type
    const library = await dynamodb.get({
        TableName: LIBRARY_ACCESS_TABLE,
        Key: { ownerId }
    }).promise();
    
    if (!library.Item) {
        return false;
    }
    
    if (library.Item.accessType === 'public') {
        return true;
    }
    
    if (library.Item.accessType === 'shared') {
        // Check if user has shared access
        const sharedAccess = await dynamodb.get({
            TableName: LIBRARY_SHARED_TABLE,
            Key: {
                ownerId: ownerId,
                sharedWithUserId: userId
            }
        }).promise();
        
        return !!sharedAccess.Item;
    }
    
    return false; // Private library, no access
}

function createResponse(statusCode, body, contentType = 'application/json') {
    return {
        statusCode,
        headers: {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN,
            'Access-Control-Allow-Credentials': 'true',
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    };
}
        `),
                environment: {
                    LIBRARY_ACCESS_TABLE_NAME: libraryAccessTable.tableName,
                    LIBRARY_SHARED_TABLE_NAME: librarySharedTable.tableName,
                    LIBRARY_BUCKET_NAME: libraryBucket.bucketName,
                    PLAYLIST_BUCKET_NAME: playlistBucket.bucketName,
                    ALLOWED_ORIGIN: allowedOrigin,
                },
                timeout: cdk.Duration.seconds(30),
            }
        );
        // Grant permissions to the Lambda function
        libraryAccessTable.grantReadData(libraryApiLambda);
        librarySharedTable.grantReadData(libraryApiLambda);
        libraryBucket.grantRead(libraryApiLambda);
        playlistBucket.grantRead(libraryApiLambda);

        /* LAMBDA - APIS */
        // // Create Lambda function for generating pre-signed URLs
        // const uploadUrlLambda = new nodejs.NodejsFunction(
        //     this,
        //     "UploadUrlLambda",
        //     {
        //         runtime: lambda.Runtime.NODEJS_18_X,
        //         code: lambda.Code.fromAsset(
        //             path.join(__dirname, "../lambdas/get-upload-url")
        //         ),
        //         handler: "main.handler",
        //         environment: {
        //             S3_BUCKET_NAME: cacheBucket.bucketName,
        //             ALLOWED_ORIGIN: allowedOrigin,
        //         },
        //         bundling: {
        //             minify: true,
        //             sourceMap: true,
        //             forceDockerBundling: true, // Force Docker bundling
        //             nodeModules: [
        //                 "@aws-sdk/client-s3",
        //                 "@aws-sdk/s3-request-presigner",
        //             ],
        //         },
        //         timeout: cdk.Duration.seconds(10),
        //     }
        // );
        // // Grant the Lambda permissions to generate pre-signed URLs for the input bucket
        // uploadUrlLambda.addToRolePolicy(
        //     new iam.PolicyStatement({
        //         actions: ["s3:PutObject"],
        //         resources: [`${cacheBucket.bucketArn}/*`],
        //         effect: iam.Effect.ALLOW,
        //     })
        // );

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
                    callbackUrls: [allowedOrigin],
                    logoutUrls: [allowedOrigin],
                },
            }
        );
        // Create Cognito authorizer for authenticated endpoints
        const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
            this,
            "CognitoAuthorizer",
            {
                cognitoUserPools: [userPool],
                authorizerName: "CognitoAuthorizer",
                identitySource: "method.request.header.Authorization",
            }
        );
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
        // Grant authenticated users read access to media/playlist bucket for their own content
        // Grant authenticated users read access to media bucket for their own content
        authRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["s3:GetObject", "s3:ListBucket"],
                resources: [
                    // Allow access to the bucket itself for listing
                    mediaBucket.bucketArn,
                    // Users can read their own media files using Cognito identity ID
                    `${mediaBucket.bucketArn}/media/\${cognito-identity.amazonaws.com:sub}/*`,
                ],
                conditions: {
                    StringLike: {
                        "s3:prefix": [
                            "media/${cognito-identity.amazonaws.com:sub}/*",
                        ],
                    },
                },
            })
        );
        // Grant authenticated users read access to playlist bucket for their own content
        authRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["s3:GetObject", "s3:ListBucket"],
                resources: [
                    // Allow access to the playlist bucket itself for listing
                    playlistBucket.bucketArn,
                    // Users can read their own playlist files using Cognito identity ID
                    `${playlistBucket.bucketArn}/media/\${cognito-identity.amazonaws.com:sub}/*`,
                ],
                conditions: {
                    StringLike: {
                        "s3:prefix": [
                            "media/${cognito-identity.amazonaws.com:sub}/*",
                        ],
                    },
                },
            })
        );
        // // Add execute-api permission to role
        // unauthRole.addToPolicy(
        //     new iam.PolicyStatement({
        //         effect: iam.Effect.ALLOW,
        //         actions: ["execute-api:Invoke"],
        //         resources: [
        //             // POST methods
        //             `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/${api.deploymentStage.stageName}/POST/upload`,
        //             `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/${api.deploymentStage.stageName}/POST/run`,
        //             // OPTIONS preflight for POST methods
        //             `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/${api.deploymentStage.stageName}/OPTIONS/upload`,
        //             `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/${api.deploymentStage.stageName}/OPTIONS/run`,
        //             // GET methods
        //             `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/${api.deploymentStage.stageName}/GET/status/*`,
        //             // OPTIONS preflight for GET methods
        //             `arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/${api.deploymentStage.stageName}/OPTIONS/status/*`,
        //         ],
        //     })
        // );
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

        /* IAM - SOURCE WORKER USER */
        // IAM user for source worker to upload to cache bucket
        const sourceWorkerUser = new iam.User(
            this,
            "MediaLibrarySourceWorkerUser"
        );
        // Create access key and store in Secrets Manager
        const sourceWorkerUserAccessKey = new iam.AccessKey(
            this,
            "MediaLibrarySourceWorkerUserAccessKey",
            {
                user: sourceWorkerUser,
            }
        );
        const sourceWorkerUserCredentialsSecret = new secretsmanager.Secret(
            this,
            "MediaLibrarySourceWorkerUserUploadCredentials",
            {
                description: `AWS credentials for media library source worker's S3 upload access in ${props.stageName}`,
                secretObjectValue: {
                    accessKeyId: cdk.SecretValue.unsafePlainText(
                        sourceWorkerUserAccessKey.accessKeyId
                    ),
                    secretAccessKey: sourceWorkerUserAccessKey.secretAccessKey,
                },
            }
        );
        // Grant S3 upload permissions
        mediaBucket.grantWrite(sourceWorkerUser);
        playlistBucket.grantWrite(sourceWorkerUser);

        /* API GATEWAY - CORS CONFIG */
        const apiCorsConfig = {
            allowOrigins: [allowedOrigin],
            allowMethods: ["GET", "POST"],
            allowHeaders: [
                "Content-Type",
                "Authorization",
                "X-Amz-Date",
                "X-Amz-Security-Token",
                "X-Api-Key",
                "x-amz-content-sha256",
            ],
            maxAge: cdk.Duration.minutes(10),
            allowCredentials: true,
        };
        const getCORSResponseParametersForAPIGateway = () => {
            return {
                "Access-Control-Allow-Origin": `'${allowedOrigin}'`,
                "Access-Control-Allow-Headers":
                    "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,x-amz-content-sha256'",
                "Access-Control-Allow-Methods": "'POST,OPTIONS'",
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
        const api = new apigateway.RestApi(this, "MediaLibraryApi", {
            restApiName: `MediaLibraryAPI-${this.account}-${props.stageName}`,
            defaultCorsPreflightOptions: apiCorsConfig,
            defaultMethodOptions: {
                authorizationType: apigateway.AuthorizationType.IAM,
            },
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
                    input: {
                        type: apigateway.JsonSchemaType.OBJECT,
                        properties: {
                            prompt: { type: apigateway.JsonSchemaType.STRING },
                            workflow: {
                                type: apigateway.JsonSchemaType.STRING,
                            },
                            aspect_ratio: {
                                type: apigateway.JsonSchemaType.STRING,
                            },
                        },
                        required: ["prompt"],
                    },
                },
            },
        });

        /* API GATEWAY - INTEGRATIONS */
        const libraryApiIntegration = new apigateway.LambdaIntegration(
            libraryApiLambda
        );
        // const runpodsRunIntegration = new apigateway.HttpIntegration(
        //     `${props.runpodsEndpoint}/run`,
        //     {
        //         httpMethod: "POST",
        //         options: {
        //             requestParameters: {
        //                 "integration.request.header.Authorization": `'Bearer ${props.runpodsApiKey}'`,
        //             },
        //             requestTemplates: {
        //                 "application/json": `{
        //                     "input": $input.json('$.input')
        //                 }`,
        //             },
        //         },
        //     }
        // );
        // const runpodsStatusIntegration = new apigateway.HttpIntegration(
        //     `${props.runpodsEndpoint}/status/{jobId}`,
        //     {
        //         httpMethod: "GET",
        //         options: {
        //             requestParameters: {
        //                 "integration.request.header.Authorization": `'Bearer ${props.runpodsApiKey}'`,
        //                 "integration.request.path.jobId":
        //                     "method.request.path.jobId",
        //             },
        //         },
        //     }
        // );
        // const uploadUrlLambdaIntegration = new apigateway.LambdaIntegration(
        //     uploadUrlLambda
        // );

        /* API GATEWAY - REQUEST HANDLERS */
        // GET /libraries - Get user's accessible libraries
        const librariesResource = api.root.addResource("libraries");
        librariesResource.addMethod("GET", libraryApiIntegration, {
            authorizer: cognitoAuthorizer,
            authorizationType: apigateway.AuthorizationType.COGNITO,
        });
        // GET /libraries/{ownerId}/library - Get specific library metadata
        const ownerLibraryResource = librariesResource.addResource("{ownerId}");
        const libraryJsonResource = ownerLibraryResource.addResource("library");
        libraryJsonResource.addMethod("GET", libraryApiIntegration, {
            authorizer: cognitoAuthorizer,
            authorizationType: apigateway.AuthorizationType.COGNITO,
            requestParameters: {
                "method.request.path.ownerId": true,
            },
        });
        // GET /libraries/{ownerId}/movies/{movieId}/playlist - Get movie playlist
        const moviesResource = ownerLibraryResource.addResource("movies");
        const movieResource = moviesResource.addResource("{movieId}");
        const playlistResource = movieResource.addResource("playlist");
        playlistResource.addMethod("GET", libraryApiIntegration, {
            authorizer: cognitoAuthorizer,
            authorizationType: apigateway.AuthorizationType.COGNITO,
            requestParameters: {
                "method.request.path.ownerId": true,
                "method.request.path.movieId": true,
            },
        });
        // // POST /run endpoint
        // const runResource = api.root.addResource("run");
        // // Request model for validation
        // const runRequestModel = api.addModel("RunRequestModel", {
        //     contentType: "application/json",
        //     modelName: `RunRequestModel${this.account}${props.stageName}`,
        //     schema: {
        //         type: apigateway.JsonSchemaType.OBJECT,
        //         required: ["input"],
        //         properties: {
        //             input: {
        //                 type: apigateway.JsonSchemaType.OBJECT,
        //                 required: ["prompt"],
        //                 properties: {
        //                     prompt: { type: apigateway.JsonSchemaType.STRING },
        //                     workflow: {
        //                         type: apigateway.JsonSchemaType.STRING,
        //                     },
        //                     aspect_ratio: {
        //                         type: apigateway.JsonSchemaType.STRING,
        //                     },
        //                     input_filename: {
        //                         type: apigateway.JsonSchemaType.STRING,
        //                     },
        //                     output_format: {
        //                         type: apigateway.JsonSchemaType.STRING,
        //                     },
        //                 },
        //             },
        //         },
        //     },
        // });
        // const runMethod = runResource.addMethod("POST", runpodsRunIntegration, {
        //     requestModels: {
        //         "application/json": runRequestModel,
        //     },
        //     requestValidator: new apigateway.RequestValidator(
        //         this,
        //         `RunRequestValidator`,
        //         {
        //             restApi: api,
        //             validateRequestBody: true,
        //         }
        //     ),
        // });
        // // GET /status/{jobId} endpoint
        // const statusResource = api.root
        //     .addResource("status")
        //     .addResource("{jobId}");
        // const statusMethod = statusResource.addMethod(
        //     "GET",
        //     runpodsStatusIntegration,
        //     {
        //         requestParameters: {
        //             "method.request.path.jobId": true,
        //         },
        //         // methodResponses: [{ statusCode: "200" }],
        //     }
        // );

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

        /* STACK OUTPUTS */
        new cdk.CfnOutput(this, "CertificateValidationRecords", {
            value:
                "IMPORTANT!! Check Certificate Manager in AWS Console for DNS validation records to add to external DNS provider ie. Namecheap, GoDaddy, Yandex. " +
                "Initial stack deployment won't complete until the DNS is updated & propagates (which takes a while).",
            description:
                "DNS records needed for website SSL certificate validation",
        });
        new cdk.CfnOutput(this, "ApiCertificateValidationRecords", {
            value:
                "IMPORTANT!! Check Certificate Manager in AWS Console for DNS validation records to add to external DNS provider ie. Namecheap, GoDaddy, Yandex. " +
                "Initial stack deployment won't complete until the DNS is updated & propagates (which takes a while).",
            description:
                "DNS records needed for API SSL certificate validation",
        });
        new cdk.CfnOutput(this, "CloudFrontDomainSetup", {
            value: `DNS Record:\nDomain: ${props.domainName}\nType: CNAME\nTarget: ${distribution.distributionDomainName}`,
            description:
                "CloudFront Domain CNAME record to add in external DNS provider ie. Namecheap, GoDaddy, Yandex",
        });
        new cdk.CfnOutput(this, "ApiDomainSetup", {
            value: `DNS Record:\nDomain: ${props.apiDomainName}\nType: CNAME\nTarget: ${apiCustomDomain.domainNameAliasDomainName}`,
            description:
                "API Gateway Domain CNAME record to add in external DNS provider ie. Namecheap, GoDaddy, Yandex",
        });
        new cdk.CfnOutput(this, "CloudFrontDistributionId", {
            value: distribution.distributionId,
            description: "CloudFront Distribution ID",
        });
        new cdk.CfnOutput(this, "SourceWorkerUserCredentialsSecretArn", {
            value: sourceWorkerUserCredentialsSecret.secretArn,
            description:
                "ARN of the secret containing worker S3 upload/download credentials",
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
        new cdk.CfnOutput(this, "WebsiteBucketName", {
            value: websiteBucket.bucketName,
            description: "Bucket name for website files",
        });
        // new cdk.CfnOutput(this, "MaxConcurrentUsers", {
        //     value: `${apiLimits.details.metrics.maxSupportedUsers} users / sec`,
        //     description: `Maximum concurrent users per second supported, calculated from maxWorkers=${apiLimits.inputs.maxWorkers}, generationTimeSeconds=${apiLimits.inputs.generationTimeSeconds}, statusPollIntervalSeconds=${apiLimits.inputs.statusPollIntervalSeconds}, imagesPerSession=${apiLimits.inputs.imagesPerSession}, averageThinkTimeSeconds=${apiLimits.inputs.averageThinkTimeSeconds}`,
        // });
        // new cdk.CfnOutput(this, "TPSLimits", {
        //     value: `runTPS=${apiLimits.limits.runTPS}tps, runTPSBurst=${apiLimits.limits.runTPSBurst}tps, ipRunLimit=${apiLimits.limits.ipRunLimit} runs per ${apiLimits.inputs.ipLimitWindowMinutes}min, statusTPS=${apiLimits.limits.statusTPS}tps, statusTPSBurst=${apiLimits.limits.statusTPSBurst}tps, ipStatusLimit=${apiLimits.limits.ipStatusLimit} status checks per ${apiLimits.inputs.ipLimitWindowMinutes}min`,
        //     description: `TPS limits, calculated from maxWorkers=${apiLimits.inputs.maxWorkers}, generationTimeSeconds=${apiLimits.inputs.generationTimeSeconds}, statusPollIntervalSeconds=${apiLimits.inputs.statusPollIntervalSeconds}, imagesPerSession=${apiLimits.inputs.imagesPerSession}, averageThinkTimeSeconds=${apiLimits.inputs.averageThinkTimeSeconds}`,
        // });
    }
}
