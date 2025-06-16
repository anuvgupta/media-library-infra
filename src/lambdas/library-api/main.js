const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
    DynamoDBDocumentClient,
    GetCommand,
    QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

// Initialize clients
const dynamodbClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamodbClient);
const s3 = new S3Client({});

const LIBRARY_ACCESS_TABLE = process.env.LIBRARY_ACCESS_TABLE_NAME;
const LIBRARY_SHARED_TABLE = process.env.LIBRARY_SHARED_TABLE_NAME;
const LIBRARY_BUCKET = process.env.LIBRARY_BUCKET_NAME;
const PLAYLIST_BUCKET = process.env.PLAYLIST_BUCKET_NAME;

exports.handler = async (event) => {
    const { httpMethod, pathParameters, requestContext } = event;

    // Extract user ID from Cognito JWT token
    const authorizer = requestContext.authorizer;
    if (!authorizer) {
        return createResponse(401, {
            error: "Cognito authorizer not provided",
        });
    }
    const userId = authorizer.claims.sub;

    console.log("Request:", {
        httpMethod,
        pathParameters,
        userId,
        resource: event.resource,
    });

    try {
        switch (event.resource) {
            case "/libraries":
                return await getUserLibraries(userId);
            case "/libraries/{ownerId}/library":
                return await getLibraryJson(pathParameters.ownerId, userId);
            case "/libraries/{ownerId}/movies/{movieId}/playlist":
                return await getMoviePlaylist(
                    pathParameters.ownerId,
                    pathParameters.movieId,
                    userId
                );
            default:
                return createResponse(404, { error: "Endpoint not found" });
        }
    } catch (error) {
        console.error("Error:", error);
        return createResponse(500, {
            error: "Internal server error",
            details: error.message,
        });
    }
};

// Get all libraries accessible to the user
async function getUserLibraries(userId) {
    try {
        console.log("Getting libraries for user:", userId);

        // Get user's own library
        const ownedLibrary = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_ACCESS_TABLE,
                Key: { ownerId: userId },
            })
        );

        console.log("Owned library result:", ownedLibrary);

        // Get libraries shared with user
        const sharedLibraries = await dynamodb.send(
            new QueryCommand({
                TableName: LIBRARY_SHARED_TABLE,
                IndexName: "SharedWithUserIndex",
                KeyConditionExpression: "sharedWithUserId = :userId",
                ExpressionAttributeValues: {
                    ":userId": userId,
                },
            })
        );

        console.log("Shared libraries result:", sharedLibraries);

        const result = {
            ownedLibrary: ownedLibrary.Item || null,
            sharedLibraries: sharedLibraries.Items.map((item) => ({
                ownerId: item.ownerId,
                sharedAt: item.sharedAt,
                permissions: item.permissions,
            })),
        };

        return createResponse(200, result);
    } catch (error) {
        console.error("Error getting user libraries:", error);
        throw error;
    }
}

// Get library.json for a specific user's library
async function getLibraryJson(ownerId, userId) {
    try {
        console.log(
            "Getting library JSON for owner:",
            ownerId,
            "requested by:",
            userId
        );

        // Check if user has access to this library
        const hasAccess = await checkLibraryAccess(ownerId, userId);
        if (!hasAccess) {
            return createResponse(403, {
                error: "Access denied to this library",
            });
        }

        // Get the library.json file from S3
        const s3Params = {
            Bucket: LIBRARY_BUCKET,
            Key: `library/${ownerId}/library.json`,
        };

        console.log("S3 params:", s3Params);

        const s3Result = await s3.send(new GetObjectCommand(s3Params));
        const libraryData = JSON.parse(await s3Result.Body.transformToString());

        return createResponse(200, libraryData);
    } catch (error) {
        if (error.name === "NoSuchKey") {
            return createResponse(404, { error: "Library not found" });
        }
        console.error("Error getting library.json:", error);
        throw error;
    }
}

// Get playlist for a specific movie
async function getMoviePlaylist(ownerId, movieId, userId) {
    try {
        console.log(
            "Getting playlist for owner:",
            ownerId,
            "movie:",
            movieId,
            "requested by:",
            userId
        );

        // Check if user has access to this library
        const hasAccess = await checkLibraryAccess(ownerId, userId);
        if (!hasAccess) {
            return createResponse(403, {
                error: "Access denied to this library",
            });
        }

        // Get the playlist file from S3
        const s3Params = {
            Bucket: PLAYLIST_BUCKET,
            Key: `media/${ownerId}/movies/${movieId}/playlist.m3u8`,
        };

        console.log("S3 params:", s3Params);

        const s3Result = await s3.send(new GetObjectCommand(s3Params));
        const playlistContent = await s3Result.Body.transformToString();

        return createResponse(
            200,
            playlistContent,
            "application/vnd.apple.mpegurl"
        );
    } catch (error) {
        if (error.name === "NoSuchKey") {
            return createResponse(404, { error: "Playlist not found" });
        }
        console.error("Error getting playlist:", error);
        throw error;
    }
}

// Check if user has access to a library
async function checkLibraryAccess(ownerId, userId) {
    try {
        console.log("Checking access for owner:", ownerId, "user:", userId);

        // Owner always has access
        if (ownerId === userId) {
            console.log("User is owner, access granted");
            return true;
        }

        // Check if library exists and get its access type
        const library = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_ACCESS_TABLE,
                Key: { ownerId },
            })
        );

        console.log("Library found:", library);

        if (!library.Item) {
            console.log("Library not found");
            return false;
        }

        if (library.Item.accessType === "public") {
            console.log("Library is public, access granted");
            return true;
        }

        if (library.Item.accessType === "shared") {
            // Check if user has shared access
            const sharedAccess = await dynamodb.send(
                new GetCommand({
                    TableName: LIBRARY_SHARED_TABLE,
                    Key: {
                        ownerId: ownerId,
                        sharedWithUserId: userId,
                    },
                })
            );

            console.log("Shared access check:", sharedAccess);
            return !!sharedAccess.Item;
        }

        console.log("Library is private, access denied");
        return false; // Private library, no access
    } catch (error) {
        console.error("Error checking library access:", error);
        return false;
    }
}

function createResponse(statusCode, body, contentType = "application/json") {
    return {
        statusCode,
        headers: {
            "Content-Type": contentType,
            "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN,
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Headers":
                "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
    };
}
