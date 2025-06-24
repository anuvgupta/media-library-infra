const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    QueryCommand,
    DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const {
    CognitoIdentityProviderClient,
    ListUsersCommand,
    AdminGetUserCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

// Env vars
const AWS_REGION = process.env.AWS_REGION;
const USER_POOL_ID = process.env.USER_POOL_ID;
const LIBRARY_ACCESS_TABLE = process.env.LIBRARY_ACCESS_TABLE_NAME;
const LIBRARY_SHARED_TABLE = process.env.LIBRARY_SHARED_TABLE_NAME;
const LIBRARY_BUCKET = process.env.LIBRARY_BUCKET_NAME;
const PLAYLIST_BUCKET = process.env.PLAYLIST_BUCKET_NAME;

// Initialize clients
const dynamodbClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamodbClient);
const s3 = new S3Client({});
const cognitoClient = new CognitoIdentityProviderClient({
    region: AWS_REGION,
});

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
        console.log("event.resource=" + event.resource);
        switch (event.resource) {
            case "/libraries":
                if (httpMethod === "GET") {
                    return await getUserLibraries(userId);
                }
            case "/libraries/{ownerId}/library":
                if (httpMethod === "GET") {
                    return await getLibraryJson(pathParameters.ownerId, userId);
                }
            case "/libraries/{ownerId}/movies/{movieId}/playlist":
                if (httpMethod === "GET") {
                    return await getMoviePlaylist(
                        pathParameters.ownerId,
                        pathParameters.movieId,
                        userId
                    );
                }
            case "/libraries/{ownerId}/share":
                if (httpMethod === "POST") {
                    return await shareLibrary(pathParameters.ownerId, userId);
                } else if (httpMethod === "GET") {
                    return await listSharedAccesses(
                        event.body,
                        pathParameters.ownerId,
                        userId
                    );
                }
                break;
            case "/libraries/{ownerId}/share/{userId}":
                if (httpMethod === "DELETE") {
                    return await removeSharedAccess(
                        pathParameters.ownerId,
                        pathParameters.userId,
                        userId
                    );
                }
                break;
            default:
                return createResponse(404, {
                    error: "Endpoint/method not found",
                });
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

// Share library with user
async function shareLibrary(body, ownerId, requestingUserId) {
    let { shareWithIdentifier, permissions = "read" } = JSON.parse(body);

    // Validate requesting user owns the library
    if (ownerId !== requestingUserId) {
        return createResponse(403, {
            error: "You can only share your own library",
        });
    }

    // Validate permissions
    // if (!["read", "write"].includes(permissions)) {
    //     return createResponse(400, {
    //         error: "Permissions must be 'read' or 'write'",
    //     });
    // }
    permissions = "read";

    try {
        // Find user by username or email
        let targetUserId;

        // Try to find by username first
        try {
            const getUserCommand = new AdminGetUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: shareWithIdentifier,
            });
            const userResult = await cognitoClient.send(getUserCommand);
            targetUserId = userResult.UserAttributes.find(
                (attr) => attr.Name === "sub"
            )?.Value;
        } catch (error) {
            // If not found by username, try by email
            const listUsersCommand = new ListUsersCommand({
                UserPoolId: USER_POOL_ID,
                Filter: `email = "${shareWithIdentifier}"`,
            });
            const usersResult = await cognitoClient.send(listUsersCommand);

            if (usersResult.Users.length === 0) {
                return createResponse(404, { error: "User not found" });
            }

            targetUserId = usersResult.Users[0].Attributes.find(
                (attr) => attr.Name === "sub"
            )?.Value;
        }

        if (!targetUserId) {
            return createResponse(404, { error: "User not found" });
        }

        // Check if library exists and is owned by the requesting user
        const libraryParams = {
            TableName: LIBRARY_ACCESS_TABLE,
            Key: { ownerId },
        };

        const libraryResult = await dynamodb.send(
            new GetCommand(libraryParams)
        );
        if (!libraryResult.Item) {
            return createResponse(404, { error: "Library not found" });
        }

        // Add or update sharing record
        const shareParams = {
            TableName: LIBRARY_SHARED_TABLE,
            Item: {
                ownerId,
                sharedWithUserId: targetUserId,
                sharedAt: new Date().toISOString(),
                permissions,
            },
        };

        await dynamodb.send(new PutCommand(shareParams));

        return createResponse(200, {
            message: "Library shared successfully",
            sharedWith: targetUserId,
            permissions,
        });
    } catch (error) {
        console.error("Error sharing library:", error);
        return createResponse(500, { error: "Internal server error" });
    }
}

// List all users who have access to a library
async function listSharedAccesses(ownerId, userId) {
    try {
        console.log(
            "Listing shared accesses for owner:",
            ownerId,
            "requested by:",
            userId
        );

        // Validate requesting user owns the library
        if (ownerId !== userId) {
            return createResponse(403, {
                error: "You can only view shared accesses for your own library",
            });
        }

        // Check if library exists
        const library = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_ACCESS_TABLE,
                Key: { ownerId },
            })
        );

        if (!library.Item) {
            return createResponse(404, { error: "Library not found" });
        }

        // Get all shared accesses for this library
        const sharedAccesses = await dynamodb.send(
            new QueryCommand({
                TableName: LIBRARY_SHARED_TABLE,
                KeyConditionExpression: "ownerId = :ownerId",
                ExpressionAttributeValues: {
                    ":ownerId": ownerId,
                },
            })
        );

        // Enrich with user details from Cognito
        const enrichedAccesses = [];
        for (const access of sharedAccesses.Items) {
            try {
                // Get user details from Cognito
                const getUserCommand = new AdminGetUserCommand({
                    UserPoolId: USER_POOL_ID,
                    Username: access.sharedWithUserId,
                });
                const userResult = await cognitoClient.send(getUserCommand);

                const username = userResult.Username;
                const email = userResult.UserAttributes.find(
                    (attr) => attr.Name === "email"
                )?.Value;

                enrichedAccesses.push({
                    sharedWithUserId: access.sharedWithUserId,
                    username: username,
                    email: email,
                    sharedAt: access.sharedAt,
                    permissions: access.permissions,
                });
            } catch (error) {
                console.warn(
                    "Could not fetch user details for:",
                    access.sharedWithUserId,
                    error.message
                );
                // Include the access even if we can't get user details
                enrichedAccesses.push({
                    sharedWithUserId: access.sharedWithUserId,
                    username: null,
                    email: null,
                    sharedAt: access.sharedAt,
                    permissions: access.permissions,
                });
            }
        }

        const result = {
            libraryOwnerId: ownerId,
            libraryAccessType: library.Item.accessType,
            sharedAccesses: enrichedAccesses,
            totalSharedUsers: enrichedAccesses.length,
        };

        return createResponse(200, result);
    } catch (error) {
        console.error("Error listing shared accesses:", error);
        return createResponse(500, { error: "Internal server error" });
    }
}

// Remove shared access for a specific user
async function removeSharedAccess(ownerId, sharedWithUserId, userId) {
    try {
        console.log(
            "Removing shared access for owner:",
            ownerId,
            "shared with:",
            sharedWithUserId,
            "requested by:",
            userId
        );

        // Validate requesting user owns the library
        if (ownerId !== userId) {
            return createResponse(403, {
                error: "You can only remove shared access from your own library",
            });
        }

        // Check if library exists
        const library = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_ACCESS_TABLE,
                Key: { ownerId },
            })
        );

        if (!library.Item) {
            return createResponse(404, { error: "Library not found" });
        }

        // Check if shared access exists
        const sharedAccess = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_SHARED_TABLE,
                Key: {
                    ownerId: ownerId,
                    sharedWithUserId: sharedWithUserId,
                },
            })
        );

        if (!sharedAccess.Item) {
            return createResponse(404, { error: "Shared access not found" });
        }

        // Remove the shared access
        await dynamodb.send(
            new DeleteCommand({
                TableName: LIBRARY_SHARED_TABLE,
                Key: {
                    ownerId: ownerId,
                    sharedWithUserId: sharedWithUserId,
                },
            })
        );

        return createResponse(200, {
            message: "Shared access removed successfully",
            removedUserId: sharedWithUserId,
        });
    } catch (error) {
        console.error("Error removing shared access:", error);
        return createResponse(500, { error: "Internal server error" });
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
