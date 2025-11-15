const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    QueryCommand,
    DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
    S3Client,
    GetObjectCommand,
    ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { Upload } = require("@aws-sdk/lib-storage");
const {
    CognitoIdentityProviderClient,
    ListUsersCommand,
    AdminGetUserCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const {
    CognitoIdentityClient,
    GetIdCommand,
} = require("@aws-sdk/client-cognito-identity");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");

// Env vars
const AWS_REGION = process.env.AWS_REGION;
const USER_POOL_ID = process.env.USER_POOL_ID;
const IDENTITY_POOL_ID = process.env.IDENTITY_POOL_ID;
const LIBRARY_ACCESS_TABLE = process.env.LIBRARY_ACCESS_TABLE_NAME;
const LIBRARY_SHARED_TABLE = process.env.LIBRARY_SHARED_TABLE_NAME;
const MEDIA_UPLOAD_STATUS_TABLE = process.env.MEDIA_UPLOAD_STATUS_TABLE_NAME;
const LIBRARY_BUCKET = process.env.LIBRARY_BUCKET_NAME;
const PLAYLIST_BUCKET = process.env.PLAYLIST_BUCKET_NAME;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET_NAME;
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;
const MEDIA_PRE_SIGNED_URL_EXPIRATION =
    process.env.MEDIA_PRE_SIGNED_URL_EXPIRATION;

// Initialize clients
const dynamodbClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamodbClient);
const s3 = new S3Client({});
const sqs = new SQSClient({});
const cognitoIdentityClient = new CognitoIdentityClient({ region: AWS_REGION });
const cognitoIdentityProviderClient = new CognitoIdentityProviderClient({
    region: AWS_REGION,
});

exports.handler = async (event) => {
    const { httpMethod, pathParameters, requestContext } = event;
    const requestOrigin = event.headers?.origin || event.headers?.Origin;
    console.log("Starting request handler");

    // // Extract user ID from Cognito JWT token
    // const authorizer = requestContext.authorizer;
    // if (!authorizer) {
    //     return createResponse(
    //         401,
    //         {
    //             error: "Cognito authorizer not provided",
    //         },
    //         "application/json",
    //         requestOrigin
    //     );
    // }
    // const userId = authorizer.claims.sub;
    // console.log("User ID:", userId);

    // Extract Identity ID from request context
    const identityId = requestContext.identity?.cognitoIdentityId;
    if (!identityId) {
        return createResponse(
            401,
            {
                error: "Cognito Identity ID not provided",
            },
            requestOrigin
        );
    }
    console.log("Identity ID:", identityId);

    console.log("Request:", {
        httpMethod,
        pathParameters,
        identityId,
        resource: event.resource,
    });

    try {
        console.log("event.resource=" + event.resource);
        switch (event.resource) {
            case "/libraries":
                if (httpMethod === "GET") {
                    return await getUserLibraries(identityId, requestOrigin);
                }
            case "/libraries/{ownerIdentityId}/library":
                if (httpMethod === "GET") {
                    return await getLibraryJson(
                        pathParameters.ownerIdentityId,
                        identityId,
                        requestOrigin
                    );
                }
            case "/libraries/{ownerIdentityId}/refresh":
                if (httpMethod === "POST") {
                    return await refreshLibraryIndex(
                        pathParameters.ownerIdentityId,
                        identityId,
                        requestOrigin
                    );
                }
            case "/libraries/{ownerIdentityId}/media/type/{mediaType}/id/{mediaId}/subtitles":
                if (httpMethod === "GET") {
                    return await getMediaSubtitles(
                        pathParameters.ownerIdentityId,
                        pathParameters.mediaId,
                        pathParameters.mediaType,
                        identityId,
                        requestOrigin
                    );
                }
            case "/libraries/{ownerIdentityId}/media/type/{mediaType}/id/{mediaId}/playlist":
                if (httpMethod === "GET") {
                    return await getMediaPlaylist(
                        pathParameters.ownerIdentityId,
                        pathParameters.mediaId,
                        pathParameters.mediaType,
                        identityId,
                        requestOrigin
                    );
                }
            case "/libraries/{ownerIdentityId}/media/type/{mediaType}/id/{mediaId}/playlist/process":
                if (httpMethod === "POST") {
                    return await processPlaylistTemplate(
                        event.body,
                        pathParameters.ownerIdentityId,
                        pathParameters.mediaId,
                        pathParameters.mediaType,
                        identityId,
                        requestOrigin
                    );
                }
            case "/libraries/{ownerIdentityId}/media/type/{mediaType}/id/{mediaId}/request":
                if (httpMethod === "POST") {
                    return await requestMedia(
                        event.body,
                        pathParameters.ownerIdentityId,
                        pathParameters.mediaId,
                        pathParameters.mediaType,
                        identityId,
                        requestOrigin
                    );
                }
            case "/libraries/{ownerIdentityId}/media/type/{mediaType}/id/{mediaId}/status":
                if (httpMethod === "GET") {
                    return await getMediaUploadStatus(
                        pathParameters.ownerIdentityId,
                        pathParameters.mediaId,
                        pathParameters.mediaType,
                        identityId,
                        requestOrigin
                    );
                } else if (httpMethod === "POST") {
                    return await updateMediaUploadStatus(
                        event.body,
                        pathParameters.ownerIdentityId,
                        pathParameters.mediaId,
                        identityId,
                        requestOrigin
                    );
                }
            case "/libraries/{ownerIdentityId}/share":
                if (httpMethod === "POST") {
                    return await shareLibrary(
                        event.body,
                        pathParameters.ownerIdentityId,
                        identityId,
                        requestOrigin
                    );
                } else if (httpMethod === "GET") {
                    return await listSharedAccesses(
                        pathParameters.ownerIdentityId,
                        identityId,
                        requestOrigin
                    );
                }
            case "/libraries/{ownerIdentityId}/share/{shareWithIdentityId}":
                if (httpMethod === "DELETE") {
                    return await removeSharedAccess(
                        pathParameters.ownerIdentityId,
                        pathParameters.shareWithIdentityId,
                        identityId,
                        requestOrigin
                    );
                }
            case "/libraries/{ownerIdentityId}/access":
                if (httpMethod === "POST") {
                    return await createOrUpdateLibraryAccess(
                        event.body,
                        pathParameters.ownerIdentityId,
                        identityId,
                        requestOrigin
                    );
                } else if (httpMethod === "GET") {
                    return await getLibraryAccess(
                        pathParameters.ownerIdentityId,
                        identityId,
                        requestOrigin
                    );
                }
            default:
                return createResponse(
                    404,
                    {
                        error: "Endpoint/method not found",
                    },
                    "application/json",
                    requestOrigin
                );
        }
    } catch (error) {
        console.error("Error:", error);
        return createResponse(
            500,
            {
                error: "Internal server error",
                details: error.message,
            },
            "application/json",
            requestOrigin
        );
    }
};

/* API ROUTES */

// Get all libraries accessible to the user
async function getUserLibraries(identityId, requestOrigin) {
    try {
        console.log("Getting libraries for identity:", identityId);

        // Get user's own library
        const ownedLibrary = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_ACCESS_TABLE,
                Key: { ownerIdentityId: identityId },
            })
        );

        console.log("Owned library result:", ownedLibrary);

        // Get libraries shared with user
        const sharedLibraries = await dynamodb.send(
            new QueryCommand({
                TableName: LIBRARY_SHARED_TABLE,
                IndexName: "SharedWithIdentityIndex",
                KeyConditionExpression: "sharedWithIdentityId = :identityId",
                ExpressionAttributeValues: {
                    ":identityId": identityId,
                },
            })
        );

        console.log("Shared libraries result:", sharedLibraries);

        const result = {
            ownedLibrary: ownedLibrary.Item || null,
            sharedLibraries: sharedLibraries.Items.map((item) => ({
                ownerUsername: item.ownerUsername,
                ownerIdentityId: item.ownerIdentityId,
                sharedAt: item.sharedAt,
            })),
        };

        return createResponse(200, result, "application/json", requestOrigin);
    } catch (error) {
        console.error("Error getting user libraries:", error);
        throw error;
    }
}

// Get library.json for a specific user's library
async function getLibraryJson(ownerIdentityId, identityId, requestOrigin) {
    try {
        console.log(
            "Getting library JSON for owner:",
            ownerIdentityId,
            "requested by:",
            identityId
        );

        // Check if user has access to this library
        const hasAccess = await checkLibraryAccess(ownerIdentityId, identityId);
        if (!hasAccess) {
            return createResponse(
                403,
                {
                    error: "Access denied to this library",
                },
                "application/json",
                requestOrigin
            );
        }

        // Get the library.json file from S3
        const s3Params = {
            Bucket: LIBRARY_BUCKET,
            Key: `library/${ownerIdentityId}/library.json`,
        };

        console.log("S3 params:", s3Params);

        const s3Result = await s3.send(new GetObjectCommand(s3Params));
        const libraryData = JSON.parse(await s3Result.Body.transformToString());

        return createResponse(
            200,
            libraryData,
            "application/json",
            requestOrigin
        );
    } catch (error) {
        if (error.name === "NoSuchKey") {
            return createResponse(
                404,
                { error: "Library not found" },
                "application/json",
                requestOrigin
            );
        }
        console.error("Error getting library.json:", error);
        throw error;
    }
}

async function getMediaSubtitles(
    ownerIdentityId,
    mediaId,
    mediaType,
    identityId,
    requestOrigin
) {
    try {
        console.log(
            "Getting subtitles for media:",
            mediaId,
            "type:",
            mediaType
        );

        // Check if user has access to this library
        const hasAccess = await checkLibraryAccess(ownerIdentityId, identityId);
        if (!hasAccess) {
            return createResponse(
                403,
                {
                    error: "Access denied to this library",
                },
                "application/json",
                requestOrigin
            );
        }

        // List subtitle files in S3
        const listParams = {
            Bucket: MEDIA_BUCKET,
            Prefix: `media/${ownerIdentityId}/media/${mediaId}/type-${mediaType}/subtitles/`,
            MaxKeys: 100,
        };

        const listResult = await s3.send(new ListObjectsV2Command(listParams));

        if (!listResult.Contents || listResult.Contents.length === 0) {
            return createResponse(
                200,
                { subtitles: [] },
                "application/json",
                requestOrigin
            );
        }

        // Generate pre-signed URLs for subtitle files
        const subtitles = await Promise.all(
            listResult.Contents.map(async (object) => {
                const filename = object.Key.split("/").pop();

                // Parse language from filename (subtitle_eng_0.vtt -> eng)
                const languageMatch = filename.match(/subtitle_([^_]+)_/);
                const language = languageMatch ? languageMatch[1] : "unknown";

                const command = new GetObjectCommand({
                    Bucket: MEDIA_BUCKET,
                    Key: object.Key,
                });

                const url = await getSignedUrl(s3, command, {
                    expiresIn: Math.floor(
                        Number(MEDIA_PRE_SIGNED_URL_EXPIRATION)
                    ),
                });

                return {
                    language: language,
                    label: language.toUpperCase(),
                    url: url,
                    filename: filename,
                };
            })
        );

        return createResponse(
            200,
            { subtitles },
            "application/json",
            requestOrigin
        );
    } catch (error) {
        console.error("Error getting media subtitles:", error);
        return createResponse(
            500,
            { error: "Failed to get subtitles" },
            "application/json",
            requestOrigin
        );
    }
}

// Get playlist for a specific media
async function getMediaPlaylist(
    ownerIdentityId,
    mediaId,
    mediaType,
    identityId,
    requestOrigin
) {
    try {
        console.log(
            "Getting playlist for owner:",
            ownerIdentityId,
            "media:",
            mediaId,
            "requested by:",
            identityId
        );

        // Check if user has access to this library
        const hasAccess = await checkLibraryAccess(ownerIdentityId, identityId);
        if (!hasAccess) {
            return createResponse(
                403,
                {
                    error: "Access denied to this library",
                },
                "application/json",
                requestOrigin
            );
        }

        // First, check if template playlist exists to determine segment count
        const templatePlaylistKey = `playlist/${ownerIdentityId}/media/${mediaId}/type-${mediaType}/playlist-template.m3u8`;

        let templatePlaylist;
        try {
            const templateResult = await s3.send(
                new GetObjectCommand({
                    Bucket: PLAYLIST_BUCKET,
                    Key: templatePlaylistKey,
                })
            );
            templatePlaylist = await templateResult.Body.transformToString();
        } catch (error) {
            if (error.name === "NoSuchKey") {
                return createResponse(
                    404,
                    {
                        error: `Media not found or not yet processed for key ${templatePlaylistKey}`,
                    },
                    "application/json",
                    requestOrigin
                );
            }
            throw error;
        }

        // Count segments in template to know how many to process
        const templateLines = templatePlaylist.split("\n");
        const totalSegmentsInTemplate = templateLines.filter((line) =>
            line.endsWith(".ts")
        ).length;

        // Check how many segments are actually uploaded to S3
        const listParams = {
            Bucket: MEDIA_BUCKET,
            Prefix: `media/${ownerIdentityId}/media/${mediaId}/type-${mediaType}/segments/`,
            MaxKeys: 1000,
        };

        const listResult = await s3.send(new ListObjectsV2Command(listParams));
        const actualUploadedSegments = listResult.Contents
            ? listResult.Contents.length
            : 0;

        // Reprocess the playlist to ensure fresh URLs
        console.log(
            `Reprocessing playlist with ${actualUploadedSegments}/${totalSegmentsInTemplate} segments`
        );

        const reprocessBody = JSON.stringify({
            segmentCount: actualUploadedSegments, // Number actually uploaded
            totalSegments: totalSegmentsInTemplate, // Total that will exist when complete
            isComplete: actualUploadedSegments >= totalSegmentsInTemplate,
        });

        const reprocessResult = await processPlaylistTemplate(
            reprocessBody,
            ownerIdentityId,
            mediaType,
            mediaId,
            ownerIdentityId, // Use owner's identity for processing
            requestOrigin
        );

        if (reprocessResult.statusCode !== 200) {
            console.error("Failed to reprocess playlist:", reprocessResult);
            return createResponse(
                500,
                {
                    error: "Failed to refresh playlist URLs",
                    details: JSON.parse(reprocessResult.body),
                },
                "application/json",
                requestOrigin
            );
        }

        // Now get the freshly processed playlist
        const playlistFileKey = `playlist/${ownerIdentityId}/media/${mediaId}/type-${mediaType}/playlist.m3u8`;

        // Generate pre-signed URL for the playlist file
        const command = new GetObjectCommand({
            Bucket: PLAYLIST_BUCKET,
            Key: playlistFileKey,
        });

        const presignedUrl = await getSignedUrl(s3, command, {
            expiresIn: Math.floor(Number(`${MEDIA_PRE_SIGNED_URL_EXPIRATION}`)),
        });

        return createResponse(
            200,
            {
                playlistUrl: presignedUrl,
                reprocessed: true,
                segmentCount: actualUploadedSegments,
            },
            "application/json",
            requestOrigin
        );
    } catch (error) {
        if (error.name === "NoSuchKey") {
            return createResponse(
                404,
                { error: "Playlist not found" },
                "application/json",
                requestOrigin
            );
        }
        console.error("Error getting playlist:", error);
        throw error;
    }
}

// Refresh library index
async function refreshLibraryIndex(
    ownerIdentityId,
    requestingIdentityId,
    requestOrigin
) {
    try {
        console.log(
            "Refreshing library index for owner:",
            ownerIdentityId,
            "requested by:",
            requestingIdentityId
        );

        // Validate requesting user owns the library
        if (ownerIdentityId !== requestingIdentityId) {
            return createResponse(
                403,
                {
                    error: "You can only refresh your own library index",
                },
                "application/json",
                requestOrigin
            );
        }

        // Check if library exists
        const library = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_ACCESS_TABLE,
                Key: { ownerIdentityId },
            })
        );

        if (!library.Item) {
            return createResponse(
                404,
                { error: "Library not found" },
                "application/json",
                requestOrigin
            );
        }

        // Send SQS message for library refresh
        const message = {
            command: "refresh-library",
            identityId: ownerIdentityId,
        };

        const sqsParams = {
            QueueUrl: SQS_QUEUE_URL,
            MessageBody: JSON.stringify(message),
        };

        await sqs.send(new SendMessageCommand(sqsParams));

        console.log("Library refresh request sent to SQS queue");

        return createResponse(
            200,
            {
                message: "Library refresh request submitted successfully",
                ownerIdentityId: ownerIdentityId,
            },
            "application/json",
            requestOrigin
        );
    } catch (error) {
        console.error("Error refreshing library index:", error);
        return createResponse(
            500,
            {
                error: "Internal server error",
                details: error.message,
            },
            "application/json",
            requestOrigin
        );
    }
}

// Share library with user
async function shareLibrary(
    body,
    ownerIdentityId,
    requestingIdentityId,
    requestOrigin
) {
    let { ownerUsername, sharedWith } = JSON.parse(body);

    // Validate requesting user owns the library
    if (ownerIdentityId !== requestingIdentityId) {
        return createResponse(
            403,
            {
                error: "You can only share your own library",
            },
            "application/json",
            requestOrigin
        );
    }

    try {
        // Validate required fields
        if (!sharedWith) {
            return createResponse(
                400,
                {
                    error: "sharedWith is required (username or email)",
                },
                "application/json",
                requestOrigin
            );
        }

        // Check if library exists and is owned by the requesting user
        const libraryParams = {
            TableName: LIBRARY_ACCESS_TABLE,
            Key: { ownerIdentityId },
        };

        const libraryResult = await dynamodb.send(
            new GetCommand(libraryParams)
        );
        if (!libraryResult.Item) {
            return createResponse(
                404,
                { error: "Library not found" },
                "application/json",
                requestOrigin
            );
        }

        // Resolve sharedWith to identity ID and username
        const userInfo = await resolveUserInfo(sharedWith);
        if (!userInfo) {
            return createResponse(
                404,
                {
                    error: "User not found with provided username or email",
                },
                "application/json",
                requestOrigin
            );
        }

        const {
            identityId: shareWithIdentityId,
            username: sharedWithUsername,
        } = userInfo;

        // Check if trying to share with themselves
        if (shareWithIdentityId === ownerIdentityId) {
            return createResponse(
                400,
                {
                    error: "Cannot share library with yourself",
                },
                "application/json",
                requestOrigin
            );
        }

        // Check if already shared with this user
        const existingShare = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_SHARED_TABLE,
                Key: {
                    ownerIdentityId,
                    sharedWithIdentityId: shareWithIdentityId,
                },
            })
        );

        // Add or update sharing record
        const shareParams = {
            TableName: LIBRARY_SHARED_TABLE,
            Item: {
                ownerUsername,
                ownerIdentityId,
                sharedWithIdentityId: shareWithIdentityId,
                sharedWithUsername: sharedWithUsername,
                sharedAt: existingShare.Item
                    ? existingShare.Item.sharedAt
                    : new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        };

        await dynamodb.send(new PutCommand(shareParams));

        return createResponse(
            200,
            {
                message: existingShare.Item
                    ? "Library share updated successfully"
                    : "Library shared successfully",
                sharedWith: {
                    identityId: shareWithIdentityId,
                    username: sharedWithUsername,
                    originalInput: sharedWith,
                },
            },
            "application/json",
            requestOrigin
        );
    } catch (error) {
        console.error("Error sharing library:", error);
        return createResponse(
            500,
            { error: "Internal server error" },
            "application/json",
            requestOrigin
        );
    }
}

// List all users who have access to a library
async function listSharedAccesses(ownerIdentityId, identityId, requestOrigin) {
    try {
        console.log(
            "Listing shared accesses for owner:",
            ownerIdentityId,
            "requested by:",
            identityId
        );

        // Validate requesting user owns the library
        if (ownerIdentityId !== identityId) {
            return createResponse(
                403,
                {
                    error: "You can only view shared accesses for your own library",
                },
                "application/json",
                requestOrigin
            );
        }

        // Check if library exists
        const library = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_ACCESS_TABLE,
                Key: { ownerIdentityId },
            })
        );

        if (!library.Item) {
            return createResponse(
                404,
                { error: "Library not found" },
                "application/json",
                requestOrigin
            );
        }

        // Get all shared accesses for this library
        const sharedAccesses = await dynamodb.send(
            new QueryCommand({
                TableName: LIBRARY_SHARED_TABLE,
                KeyConditionExpression: "ownerIdentityId = :ownerIdentityId",
                ExpressionAttributeValues: {
                    ":ownerIdentityId": ownerIdentityId,
                },
            })
        );

        // Return enriched accesses with usernames already stored
        const enrichedAccesses = sharedAccesses.Items.map((access) => ({
            sharedWithIdentityId: access.sharedWithIdentityId,
            sharedWithUsername: access.sharedWithUsername,
            sharedAt: access.sharedAt,
            updatedAt: access.updatedAt,
        }));

        const result = {
            libraryOwnerIdentityId: ownerIdentityId,
            libraryAccessType: library.Item.accessType,
            sharedAccesses: enrichedAccesses,
            totalSharedUsers: enrichedAccesses.length,
        };

        return createResponse(200, result, "application/json", requestOrigin);
    } catch (error) {
        console.error("Error listing shared accesses:", error);
        return createResponse(
            500,
            { error: "Internal server error" },
            "application/json",
            requestOrigin
        );
    }
}

// Remove shared access for a specific user
async function removeSharedAccess(
    ownerIdentityId,
    shareWithIdentityId,
    identityId,
    requestOrigin
) {
    try {
        console.log(
            "Removing shared access for owner:",
            ownerIdentityId,
            "shared with:",
            shareWithIdentityId,
            "requested by:",
            identityId
        );

        // Validate requesting user owns the library
        if (ownerIdentityId !== identityId) {
            return createResponse(
                403,
                {
                    error: "You can only remove shared access from your own library",
                },
                "application/json",
                requestOrigin
            );
        }

        // Check if library exists
        const library = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_ACCESS_TABLE,
                Key: { ownerIdentityId },
            })
        );

        if (!library.Item) {
            return createResponse(
                404,
                { error: "Library not found" },
                "application/json",
                requestOrigin
            );
        }

        // Check if shared access exists
        const sharedAccess = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_SHARED_TABLE,
                Key: {
                    ownerIdentityId: ownerIdentityId,
                    sharedWithIdentityId: shareWithIdentityId,
                },
            })
        );

        if (!sharedAccess.Item) {
            return createResponse(
                404,
                { error: "Shared access not found" },
                "application/json",
                requestOrigin
            );
        }

        // Remove the shared access
        await dynamodb.send(
            new DeleteCommand({
                TableName: LIBRARY_SHARED_TABLE,
                Key: {
                    ownerIdentityId: ownerIdentityId,
                    sharedWithIdentityId: shareWithIdentityId,
                },
            })
        );

        return createResponse(
            200,
            {
                message: "Shared access removed successfully",
                removedIdentityId: shareWithIdentityId,
            },
            "application/json",
            requestOrigin
        );
    } catch (error) {
        console.error("Error removing shared access:", error);
        return createResponse(
            500,
            { error: "Internal server error" },
            "application/json",
            requestOrigin
        );
    }
}

// Create or update library access record
async function createOrUpdateLibraryAccess(
    body,
    ownerIdentityId,
    requestingIdentityId,
    requestOrigin
) {
    try {
        console.log(
            "Creating/updating library access for owner:",
            ownerIdentityId,
            "requested by:",
            requestingIdentityId
        );

        // Validate requesting user can only modify their own library
        if (ownerIdentityId !== requestingIdentityId) {
            return createResponse(
                403,
                {
                    error: "You can only create/update your own library access record",
                },
                "application/json",
                requestOrigin
            );
        }

        const requestData = JSON.parse(body);

        // Validate required fields and sanitize input
        const { movieCount, collectionCount, lastScanAt, ownerUsername } =
            requestData;

        if (
            typeof movieCount !== "number" ||
            typeof collectionCount !== "number"
        ) {
            return createResponse(
                400,
                {
                    error: "movieCount and collectionCount must be numbers",
                },
                "application/json",
                requestOrigin
            );
        }

        if (!lastScanAt || !Date.parse(lastScanAt)) {
            return createResponse(
                400,
                {
                    error: "lastScanAt must be a valid ISO date string",
                },
                "application/json",
                requestOrigin
            );
        }

        const currentTime = new Date().toISOString();

        // Check if record already exists
        const existingRecord = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_ACCESS_TABLE,
                Key: { ownerIdentityId },
            })
        );

        // Prepare the record
        let libraryRecord = {
            ownerIdentityId,
            movieCount,
            collectionCount,
            lastScanAt,
            updatedAt: currentTime,
        };
        // Optional fields
        if (ownerUsername) {
            libraryRecord = {
                ownerUsername,
                ...libraryRecord,
            };
        }

        // If record exists, preserve the createdAt timestamp and ownerUsername if not being updated
        if (existingRecord.Item) {
            libraryRecord.createdAt = existingRecord.Item.createdAt;
            if (!libraryRecord.ownerUsername) {
                libraryRecord.ownerUsername = existingRecord.Item.ownerUsername;
            }
            console.log("Updating existing LibraryAccess record");
        } else {
            libraryRecord.createdAt = currentTime;
            console.log("Creating new LibraryAccess record");
        }

        // Put the record (this will create or update)
        await dynamodb.send(
            new PutCommand({
                TableName: LIBRARY_ACCESS_TABLE,
                Item: libraryRecord,
            })
        );

        console.log(
            `LibraryAccess record ${
                existingRecord.Item ? "updated" : "created"
            } successfully`
        );

        return createResponse(
            200,
            {
                message: `Library access record ${
                    existingRecord.Item ? "updated" : "created"
                } successfully`,
                record: libraryRecord,
            },
            "application/json",
            requestOrigin
        );
    } catch (error) {
        console.error("Error creating/updating library access:", error);
        return createResponse(
            500,
            {
                error: "Internal server error",
                details: error.message,
            },
            "application/json",
            requestOrigin
        );
    }
}

// Get library access record
async function getLibraryAccess(
    ownerIdentityId,
    requestingIdentityId,
    requestOrigin
) {
    try {
        console.log(
            "Getting library access for owner:",
            ownerIdentityId,
            "requested by:",
            requestingIdentityId
        );

        // Validate requesting user can only access their own library access record
        if (ownerIdentityId !== requestingIdentityId) {
            return createResponse(
                403,
                {
                    error: "You can only access your own library access record",
                },
                "application/json",
                requestOrigin
            );
        }

        // Get the library access record
        const result = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_ACCESS_TABLE,
                Key: { ownerIdentityId },
            })
        );

        if (!result.Item) {
            return createResponse(
                404,
                {
                    error: "Library access record not found",
                },
                "application/json",
                requestOrigin
            );
        }

        return createResponse(
            200,
            result.Item,
            "application/json",
            requestOrigin
        );
    } catch (error) {
        console.error("Error getting library access:", error);
        return createResponse(
            500,
            {
                error: "Internal server error",
                details: error.message,
            },
            "application/json",
            requestOrigin
        );
    }
}

async function processPlaylistTemplate(
    body,
    ownerIdentityId,
    mediaId,
    mediaType,
    requestingIdentityId,
    requestOrigin
) {
    try {
        console.log(
            "Processing playlist template for media:",
            mediaId,
            "type:",
            mediaType
        );

        // Validate requesting user owns the content
        if (ownerIdentityId !== requestingIdentityId) {
            return createResponse(
                403,
                {
                    error: "You can only process playlists for your own content",
                },
                "application/json",
                requestOrigin
            );
        }

        const requestData = JSON.parse(body);
        const { segmentCount, totalSegments, isComplete } = requestData;

        const startTime = Date.now();

        // Get the template playlist
        const templateKey = `playlist/${ownerIdentityId}/media/${mediaId}/type-${mediaType}/playlist-template.m3u8`;

        let templatePlaylist;
        try {
            const templateResult = await s3.send(
                new GetObjectCommand({
                    Bucket: PLAYLIST_BUCKET,
                    Key: templateKey,
                })
            );
            templatePlaylist = await templateResult.Body.transformToString();
        } catch (error) {
            if (error.name === "NoSuchKey") {
                return createResponse(
                    404,
                    {
                        error: `Template playlist not found for key ${templateKey}`,
                    },
                    "application/json",
                    requestOrigin
                );
            }
            throw error;
        }

        // Try to get existing processed playlist to reuse valid URLs
        const finalPlaylistKey = `playlist/${ownerIdentityId}/media/${mediaId}/type-${mediaType}/playlist.m3u8`;
        let existingPlaylist = null;
        let existingSegmentUrls = new Map(); // filename -> {url, lineIndex}

        try {
            const existingResult = await s3.send(
                new GetObjectCommand({
                    Bucket: PLAYLIST_BUCKET,
                    Key: finalPlaylistKey,
                })
            );
            existingPlaylist = await existingResult.Body.transformToString();

            // Parse existing playlist to extract segment URLs that might still be valid
            const existingLines = existingPlaylist.split("\n");
            let lineIndex = 0;

            for (const line of existingLines) {
                if (line.startsWith("https://") && line.includes(".ts")) {
                    // Extract the filename from the pre-signed URL
                    const urlParts = line.split("/");
                    const segmentPart = urlParts.find(
                        (part) =>
                            part.includes("segment_") && part.includes(".ts")
                    );

                    if (segmentPart) {
                        // Extract just the filename (before query parameters)
                        const filename = segmentPart.split("?")[0];

                        // Check if URL is still valid (has at least 30 minutes left)
                        const url = new URL(line);
                        const expiresParam =
                            url.searchParams.get("X-Amz-Expires");
                        const dateParam = url.searchParams.get("X-Amz-Date");

                        if (expiresParam && dateParam) {
                            const signedTime = new Date(
                                dateParam.slice(0, 4) +
                                    "-" +
                                    dateParam.slice(4, 6) +
                                    "-" +
                                    dateParam.slice(6, 8) +
                                    "T" +
                                    dateParam.slice(9, 11) +
                                    ":" +
                                    dateParam.slice(11, 13) +
                                    ":" +
                                    dateParam.slice(13, 15) +
                                    "Z"
                            );
                            const expiresTime = new Date(
                                signedTime.getTime() +
                                    parseInt(expiresParam) * 1000
                            );
                            const timeLeft = expiresTime.getTime() - Date.now();
                            const thirtyMinutes = 30 * 60 * 1000;

                            if (timeLeft > thirtyMinutes) {
                                existingSegmentUrls.set(filename, {
                                    url: line,
                                    lineIndex: lineIndex,
                                });
                                console.log(
                                    `📋 Reusing valid URL for ${filename} (${Math.round(
                                        timeLeft / 60000
                                    )}min left)`
                                );
                            }
                        }
                    }
                }
                lineIndex++;
            }

            console.log(
                `📋 Found ${existingSegmentUrls.size} existing valid URLs to reuse`
            );
        } catch (error) {
            if (error.name !== "NoSuchKey") {
                console.warn(
                    "Failed to load existing playlist for URL reuse:",
                    error.message
                );
            }
            // Continue without reusing URLs
        }

        // Parse template and identify segment lines that need processing
        const lines = templatePlaylist.split("\n");
        const segmentLines = [];
        const segmentFilenames = [];
        const segmentsNeedingUrls = [];

        // First pass: collect all segment filenames and determine which need new URLs
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.endsWith(".ts")) {
                if (segmentLines.length < segmentCount) {
                    segmentLines.push(i);
                    segmentFilenames.push(line);

                    // Check if we can reuse existing URL
                    if (!existingSegmentUrls.has(line)) {
                        segmentsNeedingUrls.push({
                            filename: line,
                            index: segmentLines.length - 1,
                        });
                    }
                } else {
                    break; // Don't process segments that haven't been uploaded yet
                }
            }
        }

        console.log(
            `🔄 Need to generate ${segmentsNeedingUrls.length} new pre-signed URLs (${existingSegmentUrls.size} reused)`
        );

        // Generate pre-signed URLs only for segments that need them
        const BATCH_SIZE = 50; // Process 50 URLs at a time
        const newPresignedUrls = new Map(); // filename -> url

        if (segmentsNeedingUrls.length > 0) {
            const urlStartTime = Date.now();

            // Process in batches for better performance and to avoid timeouts
            for (let i = 0; i < segmentsNeedingUrls.length; i += BATCH_SIZE) {
                const batch = segmentsNeedingUrls.slice(i, i + BATCH_SIZE);
                console.log(
                    `🔄 Processing URL batch ${
                        Math.floor(i / BATCH_SIZE) + 1
                    }/${Math.ceil(segmentsNeedingUrls.length / BATCH_SIZE)} (${
                        batch.length
                    } URLs)`
                );

                const batchPromises = batch.map(async ({ filename }) => {
                    const segmentKey = `media/${ownerIdentityId}/media/${mediaId}/type-${mediaType}/segments/${filename}`;

                    const command = new GetObjectCommand({
                        Bucket: MEDIA_BUCKET,
                        Key: segmentKey,
                    });

                    const url = await getSignedUrl(s3, command, {
                        expiresIn: Math.floor(
                            Number(MEDIA_PRE_SIGNED_URL_EXPIRATION)
                        ),
                    });

                    return { filename, url };
                });

                const batchResults = await Promise.all(batchPromises);

                // Add batch results to the map
                for (const { filename, url } of batchResults) {
                    newPresignedUrls.set(filename, url);
                }
            }

            const urlGenerationTime = Date.now() - urlStartTime;
            console.log(
                `✅ Generated ${newPresignedUrls.size} new pre-signed URLs in ${urlGenerationTime}ms`
            );
        }

        // Build the final playlist using both existing and new URLs
        let processedPlaylist = "";
        let urlIndex = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (segmentLines.includes(i)) {
                const filename = segmentFilenames[urlIndex];

                // Use existing URL if available, otherwise use newly generated URL
                let segmentUrl;
                if (existingSegmentUrls.has(filename)) {
                    segmentUrl = existingSegmentUrls.get(filename).url;
                } else {
                    segmentUrl = newPresignedUrls.get(filename);
                }

                if (segmentUrl) {
                    processedPlaylist += segmentUrl + "\n";
                } else {
                    console.error(
                        `❌ No URL available for segment: ${filename}`
                    );
                    processedPlaylist += `# ERROR: Missing URL for ${filename}\n`;
                }

                urlIndex++;
            } else if (line.endsWith(".ts")) {
                // This is a segment line beyond our segmentCount - stop processing
                break;
            } else {
                // This is a metadata line - keep as-is
                processedPlaylist += line + "\n";
            }
        }

        // Add end tag if upload is complete
        if (isComplete && !processedPlaylist.includes("#EXT-X-ENDLIST")) {
            processedPlaylist += "#EXT-X-ENDLIST\n";
        }

        // Save the processed playlist
        const uploadParams = {
            Bucket: PLAYLIST_BUCKET,
            Key: finalPlaylistKey,
            Body: processedPlaylist,
            ContentType: "application/vnd.apple.mpegurl",
            Metadata: {
                mediaId: mediaId,
                mediaType: mediaType,
                segmentCount: segmentCount.toString(),
                totalSegments: totalSegments.toString(),
                isComplete: isComplete.toString(),
                lastUpdated: new Date().toISOString(),
                urlsReused: existingSegmentUrls.size.toString(),
                urlsGenerated: newPresignedUrls.size.toString(),
            },
        };

        const upload = new Upload({
            client: s3,
            params: uploadParams,
        });

        await upload.done();

        const totalTime = Date.now() - startTime;
        console.log(
            `✅ Playlist processed in ${totalTime}ms (${segmentCount}/${totalSegments} segments, ${existingSegmentUrls.size} URLs reused, ${newPresignedUrls.size} URLs generated)`
        );

        return createResponse(
            200,
            {
                message: "Playlist processed successfully",
                segmentCount,
                totalSegments,
                isComplete,
                processingTimeMs: totalTime,
                urlsReused: existingSegmentUrls.size,
                urlsGenerated: newPresignedUrls.size,
                efficiency:
                    existingSegmentUrls.size > 0
                        ? `${Math.round(
                              (existingSegmentUrls.size /
                                  (existingSegmentUrls.size +
                                      newPresignedUrls.size)) *
                                  100
                          )}% URLs reused`
                        : "No URLs reused (first processing)",
            },
            "application/json",
            requestOrigin
        );
    } catch (error) {
        console.error("Error processing playlist template:", error);
        return createResponse(
            500,
            {
                error: "Internal server error",
                details: error.message,
            },
            "application/json",
            requestOrigin
        );
    }
}

async function requestMedia(
    body,
    ownerIdentityId,
    mediaId,
    mediaType,
    requestingIdentityId,
    requestOrigin
) {
    try {
        // Validate mediaType
        if (!mediaType || !["movie", "episode"].includes(mediaType)) {
            return createResponse(
                400,
                {
                    error: "mediaType is required and must be 'movie' or 'episode'",
                },
                "application/json",
                requestOrigin
            );
        }

        console.log(
            "Processing media request for owner:",
            ownerIdentityId,
            "media:",
            mediaId,
            "type:",
            mediaType,
            "requested by:",
            requestingIdentityId
        );

        // Check if user has access to this library
        const hasAccess = await checkLibraryAccess(
            ownerIdentityId,
            requestingIdentityId
        );
        if (!hasAccess) {
            return createResponse(
                403,
                {
                    error: "Access denied to this library",
                },
                "application/json",
                requestOrigin
            );
        }

        // Send SQS message
        const message = {
            command: "upload-media",
            identityId: ownerIdentityId,
            mediaId: mediaId,
            mediaType: mediaType,
        };

        const sqsParams = {
            QueueUrl: SQS_QUEUE_URL,
            MessageBody: JSON.stringify(message),
        };

        await sqs.send(new SendMessageCommand(sqsParams));

        console.log("Media upload request sent to SQS queue");

        return createResponse(
            200,
            {
                message: "Media upload request submitted successfully",
                mediaId: mediaId,
                ownerIdentityId: ownerIdentityId,
            },
            "application/json",
            requestOrigin
        );
    } catch (error) {
        console.error("Error requesting media:", error);
        return createResponse(
            500,
            {
                error: "Internal server error",
                details: error.message,
            },
            "application/json",
            requestOrigin
        );
    }
}

// Update media upload status (only owner can update)
async function updateMediaUploadStatus(
    body,
    ownerIdentityId,
    mediaId,
    requestingIdentityId,
    requestOrigin
) {
    try {
        console.log("Updating upload status for media:", mediaId);

        // Validate requesting user owns the content
        if (ownerIdentityId !== requestingIdentityId) {
            return createResponse(
                403,
                {
                    error: "You can only update upload status for your own content",
                },
                "application/json",
                requestOrigin
            );
        }

        const requestData = JSON.parse(body);
        const { percentage, eta, stageName, message, mediaType } = requestData;

        // Validate required fields
        if (!mediaType || !["movie", "episode"].includes(mediaType)) {
            return createResponse(
                400,
                {
                    error: "mediaType is required and must be 'movie' or 'episode'",
                },
                "application/json",
                requestOrigin
            );
        }

        if (
            typeof percentage !== "number" ||
            percentage < 0 ||
            percentage > 100
        ) {
            return createResponse(
                400,
                {
                    error: "percentage must be a number between 0 and 100",
                },
                "application/json",
                requestOrigin
            );
        }

        if (!stageName || typeof stageName !== "string") {
            return createResponse(
                400,
                {
                    error: "stageName is required and must be a string",
                },
                "application/json",
                requestOrigin
            );
        }

        const currentTime = new Date().toISOString();

        // Create status record with TTL (expire after 7 days)
        const statusRecord = {
            ownerIdentityId,
            mediaId,
            mediaType,
            percentage,
            stageName,
            updatedAt: currentTime,
            expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days from now
        };

        // Optional fields
        if (eta) {
            statusRecord.eta = eta;
        }
        if (message) {
            statusRecord.message = message;
        }

        // Save the status record
        await dynamodb.send(
            new PutCommand({
                TableName: MEDIA_UPLOAD_STATUS_TABLE,
                Item: statusRecord,
            })
        );

        console.log("Upload status updated successfully");

        return createResponse(
            200,
            {
                message: "Upload status updated successfully",
                status: statusRecord,
            },
            "application/json",
            requestOrigin
        );
    } catch (error) {
        console.error("Error updating upload status:", error);
        return createResponse(
            500,
            {
                error: "Internal server error",
                details: error.message,
            },
            "application/json",
            requestOrigin
        );
    }
}

// Get media upload status (anyone with library access can view)
async function getMediaUploadStatus(
    ownerIdentityId,
    mediaId,
    mediaType,
    identityId,
    requestOrigin
) {
    try {
        console.log(
            "Getting upload status for owner:",
            ownerIdentityId,
            "media:",
            mediaId,
            "type:",
            mediaType,
            "requested by:",
            identityId
        );

        // Check if user has access to this library
        const hasAccess = await checkLibraryAccess(ownerIdentityId, identityId);
        if (!hasAccess) {
            return createResponse(
                403,
                {
                    error: "Access denied to this library",
                },
                "application/json",
                requestOrigin
            );
        }

        // Get the upload status record
        const result = await dynamodb.send(
            new GetCommand({
                TableName: MEDIA_UPLOAD_STATUS_TABLE,
                Key: {
                    ownerIdentityId,
                    mediaId,
                },
            })
        );

        if (!result.Item) {
            return createResponse(
                404,
                {
                    error: "Upload status not found",
                },
                "application/json",
                requestOrigin
            );
        }

        // Validate mediaType matches if you want to be strict
        if (result.Item.mediaType !== mediaType) {
            return createResponse(
                400,
                {
                    error: `Media type mismatch: expected ${mediaType}, found ${result.Item.mediaType}`,
                },
                "application/json",
                requestOrigin
            );
        }

        // Remove internal fields before returning
        const { expiresAt, ...statusData } = result.Item;

        return createResponse(
            200,
            statusData,
            "application/json",
            requestOrigin
        );
    } catch (error) {
        console.error("Error getting upload status:", error);
        return createResponse(
            500,
            {
                error: "Internal server error",
                details: error.message,
            },
            "application/json",
            requestOrigin
        );
    }
}

/* HELPERS */

function createResponse(
    statusCode,
    body,
    contentType = "application/json",
    requestOrigin = null // Get the request origin from the event (you'll need to pass this down)
) {
    // Get allowed origins from environment variable
    const allowedOrigins = process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(",")
        : [process.env.ALLOWED_ORIGIN]; // Fallback to single origin

    // Determine which origin to use in response
    let responseOrigin = allowedOrigins[0]; // Default to first allowed origin

    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
        responseOrigin = requestOrigin;
    }

    return {
        statusCode,
        headers: {
            "Content-Type": contentType,
            "Access-Control-Allow-Origin": responseOrigin,
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Headers":
                "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
            "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
    };
}

// Updated resolveUserInfo function
async function resolveUserInfo(sharedWith) {
    try {
        console.log("Resolving user info for:", sharedWith);

        // Step 1: Resolve to username using Cognito
        const username = await resolveToUsername(sharedWith);
        if (!username) {
            return null;
        }

        // Step 2: Get identity ID from library access table using username
        const identityId = await getIdentityIdFromUsername(username);
        if (!identityId) {
            console.log(
                "Username found in Cognito but no library exists:",
                username
            );
            return null;
        }

        return {
            username,
            identityId,
        };
    } catch (error) {
        console.error("Error resolving user info:", error);
        return null;
    }
}

// Helper function to resolve email or username to username
async function resolveToUsername(sharedWith) {
    const isEmail = sharedWith.includes("@");

    try {
        if (isEmail) {
            // Search by email
            const listUsersParams = {
                UserPoolId: USER_POOL_ID,
                Filter: `email = "${sharedWith}"`,
                Limit: 1,
            };

            const listResult = await cognitoIdentityProviderClient.send(
                new ListUsersCommand(listUsersParams)
            );

            if (!listResult.Users || listResult.Users.length === 0) {
                console.log("No user found with email:", sharedWith);
                return null;
            }

            const cognitoUser = listResult.Users[0];
            const usernameFromAttr = cognitoUser.UserAttributes?.find(
                (attr) => attr.Name === "preferred_username"
            );
            return usernameFromAttr?.Value || cognitoUser.Username;
        } else {
            // Assume it's a username, verify it exists in Cognito
            const getUserParams = {
                UserPoolId: USER_POOL_ID,
                Username: sharedWith,
            };

            const getUserResult = await cognitoIdentityProviderClient.send(
                new AdminGetUserCommand(getUserParams)
            );
            const usernameFromAttr = getUserResult.UserAttributes?.find(
                (attr) => attr.Name === "preferred_username"
            );
            return usernameFromAttr?.Value || getUserResult.Username;
        }
    } catch (error) {
        if (error.name === "UserNotFoundException") {
            console.log("No user found with username:", sharedWith);
            return null;
        }
        throw error;
    }
}

// Helper function to get identity ID from username using library access table
async function getIdentityIdFromUsername(username) {
    try {
        const queryParams = {
            TableName: LIBRARY_ACCESS_TABLE,
            IndexName: "OwnerUsernameIndex",
            KeyConditionExpression: "ownerUsername = :username",
            ExpressionAttributeValues: {
                ":username": username,
            },
            Limit: 1,
        };

        const result = await dynamodb.send(new QueryCommand(queryParams));

        if (!result.Items || result.Items.length === 0) {
            console.log("No library found for username:", username);
            return null;
        }

        return result.Items[0].ownerIdentityId;
    } catch (error) {
        console.error("Error querying library access table:", error);
        throw error;
    }
}

// Check if user has access to a library
async function checkLibraryAccess(ownerIdentityId, identityId) {
    try {
        console.log(
            "Checking access for owner:",
            ownerIdentityId,
            "identity:",
            identityId
        );

        // Owner always has access
        if (ownerIdentityId === identityId) {
            console.log("User is owner, access granted");
            return true;
        }

        // Check if library exists and get its access type
        const library = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_ACCESS_TABLE,
                Key: { ownerIdentityId },
            })
        );

        console.log("Library found:", library);

        if (!library.Item) {
            console.log("Library not found");
            return false;
        }

        // if (library.Item.accessType === "public") {
        //     console.log("Library is public, access granted");
        //     return true;
        // }

        // Check if user has shared access
        const sharedAccess = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_SHARED_TABLE,
                Key: {
                    ownerIdentityId: ownerIdentityId,
                    sharedWithIdentityId: identityId,
                },
            })
        );

        console.log("Shared access check:", sharedAccess);
        return !!sharedAccess.Item;
    } catch (error) {
        console.error("Error checking library access:", error);
        return false;
    }
}
