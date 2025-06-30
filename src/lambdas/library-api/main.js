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
const {
    CognitoIdentityClient,
    GetIdCommand,
} = require("@aws-sdk/client-cognito-identity");

// Env vars
const AWS_REGION = process.env.AWS_REGION;
const USER_POOL_ID = process.env.USER_POOL_ID;
const IDENTITY_POOL_ID = process.env.IDENTITY_POOL_ID;
const LIBRARY_ACCESS_TABLE = process.env.LIBRARY_ACCESS_TABLE_NAME;
const LIBRARY_SHARED_TABLE = process.env.LIBRARY_SHARED_TABLE_NAME;
const LIBRARY_BUCKET = process.env.LIBRARY_BUCKET_NAME;
const PLAYLIST_BUCKET = process.env.PLAYLIST_BUCKET_NAME;
const PLAYLIST_PRE_SIGNED_URL_EXPIRATION =
    process.env.PLAYLIST_PRE_SIGNED_URL_EXPIRATION;

// Initialize clients
const dynamodbClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamodbClient);
const s3 = new S3Client({});
const cognitoIdentityClient = new CognitoIdentityClient({ region: AWS_REGION });
const cognitoIdentityProviderClient = new CognitoIdentityProviderClient({
    region: AWS_REGION,
});

exports.handler = async (event) => {
    const { httpMethod, pathParameters, requestContext } = event;
    console.log("Starting request handler");

    // // Extract user ID from Cognito JWT token
    // const authorizer = requestContext.authorizer;
    // if (!authorizer) {
    //     return createResponse(401, {
    //         error: "Cognito authorizer not provided",
    //     });
    // }
    // const userId = authorizer.claims.sub;
    // console.log("User ID:", userId);

    // Extract Identity ID from request context
    const identityId = requestContext.identity?.cognitoIdentityId;
    if (!identityId) {
        return createResponse(401, {
            error: "Cognito Identity ID not provided",
        });
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
                    return await getUserLibraries(identityId);
                }
            case "/libraries/{ownerIdentityId}/library":
                if (httpMethod === "GET") {
                    return await getLibraryJson(
                        pathParameters.ownerIdentityId,
                        identityId
                    );
                }
            case "/libraries/{ownerIdentityId}/movies/{movieId}/playlist":
                if (httpMethod === "GET") {
                    return await getMoviePlaylist(
                        pathParameters.ownerIdentityId,
                        pathParameters.movieId,
                        identityId
                    );
                }
            case "/libraries/{ownerIdentityId}/movies/{movieId}/request":
                if (httpMethod === "POST") {
                    return await requestMovie(
                        event.body,
                        pathParameters.ownerIdentityId,
                        pathParameters.movieId,
                        identityId
                    );
                }
            case "/libraries/{ownerIdentityId}/share":
                if (httpMethod === "POST") {
                    return await shareLibrary(
                        event.body,
                        pathParameters.ownerIdentityId,
                        identityId
                    );
                } else if (httpMethod === "GET") {
                    return await listSharedAccesses(
                        pathParameters.ownerIdentityId,
                        identityId
                    );
                }
                break;
            case "/libraries/{ownerIdentityId}/share/{shareWithIdentityId}":
                if (httpMethod === "DELETE") {
                    return await removeSharedAccess(
                        pathParameters.ownerIdentityId,
                        pathParameters.shareWithIdentityId,
                        identityId
                    );
                }
                break;
            case "/libraries/{ownerIdentityId}/access":
                if (httpMethod === "POST") {
                    return await createOrUpdateLibraryAccess(
                        event.body,
                        pathParameters.ownerIdentityId,
                        identityId
                    );
                } else if (httpMethod === "GET") {
                    return await getLibraryAccess(
                        pathParameters.ownerIdentityId,
                        identityId
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
async function getUserLibraries(identityId) {
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

        return createResponse(200, result);
    } catch (error) {
        console.error("Error getting user libraries:", error);
        throw error;
    }
}

// Get library.json for a specific user's library
async function getLibraryJson(ownerIdentityId, identityId) {
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
            return createResponse(403, {
                error: "Access denied to this library",
            });
        }

        // Get the library.json file from S3
        const s3Params = {
            Bucket: LIBRARY_BUCKET,
            Key: `library/${ownerIdentityId}/library.json`,
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
async function getMoviePlaylist(ownerIdentityId, movieId, identityId) {
    try {
        console.log(
            "Getting playlist for owner:",
            ownerIdentityId,
            "movie:",
            movieId,
            "requested by:",
            identityId
        );

        // Check if user has access to this library
        const hasAccess = await checkLibraryAccess(ownerIdentityId, identityId);
        if (!hasAccess) {
            return createResponse(403, {
                error: "Access denied to this library",
            });
        }

        // // Get the playlist file from S3
        // const s3Params = {
        //     Bucket: PLAYLIST_BUCKET,
        //     Key: `playlist/${ownerIdentityId}/movie/${movieId}/playlist.m3u8`,
        // };

        // console.log("S3 params:", s3Params);

        // const s3Result = await s3.send(new GetObjectCommand(s3Params));
        // let playlistContent = await s3Result.Body.transformToString();

        // // Parse the playlist and replace segment URLs with pre-signed URLs
        // const updatedPlaylist = await generatePresignedPlaylist(
        //     playlistContent,
        //     ownerIdentityId,
        //     movieId
        // );

        // return createResponse(
        //     200,
        //     updatedPlaylist,
        //     "application/vnd.apple.mpegurl"
        // );

        // Generate pre-signed URL for the playlist file
        const playlistKey = `playlist/${ownerIdentityId}/movie/${movieId}/playlist.m3u8`;
        const command = new GetObjectCommand({
            Bucket: PLAYLIST_BUCKET,
            Key: playlistKey,
        });

        const presignedUrl = await getSignedUrl(s3, command, {
            expiresIn: Math.floor(
                Number(`${PLAYLIST_PRE_SIGNED_URL_EXPIRATION}`)
            ),
        });

        return createResponse(200, { playlistUrl: presignedUrl });
    } catch (error) {
        if (error.name === "NoSuchKey") {
            return createResponse(404, { error: "Playlist not found" });
        }
        console.error("Error getting playlist:", error);
        throw error;
    }
}

// Share library with user
async function shareLibrary(body, ownerIdentityId, requestingIdentityId) {
    let { ownerUsername, sharedWith } = JSON.parse(body);

    // Validate requesting user owns the library
    if (ownerIdentityId !== requestingIdentityId) {
        return createResponse(403, {
            error: "You can only share your own library",
        });
    }

    try {
        // Validate required fields
        if (!sharedWith) {
            return createResponse(400, {
                error: "sharedWith is required (username or email)",
            });
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
            return createResponse(404, { error: "Library not found" });
        }

        // Resolve sharedWith to identity ID and username
        const userInfo = await resolveUserInfo(sharedWith);
        if (!userInfo) {
            return createResponse(404, {
                error: "User not found with provided username or email",
            });
        }

        const {
            identityId: shareWithIdentityId,
            username: sharedWithUsername,
        } = userInfo;

        // Check if trying to share with themselves
        if (shareWithIdentityId === ownerIdentityId) {
            return createResponse(400, {
                error: "Cannot share library with yourself",
            });
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

        return createResponse(200, {
            message: existingShare.Item
                ? "Library share updated successfully"
                : "Library shared successfully",
            sharedWith: {
                identityId: shareWithIdentityId,
                username: sharedWithUsername,
                originalInput: sharedWith,
            },
        });
    } catch (error) {
        console.error("Error sharing library:", error);
        return createResponse(500, { error: "Internal server error" });
    }
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

// List all users who have access to a library
async function listSharedAccesses(ownerIdentityId, identityId) {
    try {
        console.log(
            "Listing shared accesses for owner:",
            ownerIdentityId,
            "requested by:",
            identityId
        );

        // Validate requesting user owns the library
        if (ownerIdentityId !== identityId) {
            return createResponse(403, {
                error: "You can only view shared accesses for your own library",
            });
        }

        // Check if library exists
        const library = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_ACCESS_TABLE,
                Key: { ownerIdentityId },
            })
        );

        if (!library.Item) {
            return createResponse(404, { error: "Library not found" });
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

        return createResponse(200, result);
    } catch (error) {
        console.error("Error listing shared accesses:", error);
        return createResponse(500, { error: "Internal server error" });
    }
}

// Remove shared access for a specific user
async function removeSharedAccess(
    ownerIdentityId,
    shareWithIdentityId,
    identityId
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
            return createResponse(403, {
                error: "You can only remove shared access from your own library",
            });
        }

        // Check if library exists
        const library = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_ACCESS_TABLE,
                Key: { ownerIdentityId },
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
                    ownerIdentityId: ownerIdentityId,
                    sharedWithIdentityId: shareWithIdentityId,
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
                    ownerIdentityId: ownerIdentityId,
                    sharedWithIdentityId: shareWithIdentityId,
                },
            })
        );

        return createResponse(200, {
            message: "Shared access removed successfully",
            removedIdentityId: shareWithIdentityId,
        });
    } catch (error) {
        console.error("Error removing shared access:", error);
        return createResponse(500, { error: "Internal server error" });
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

// Create or update library access record
async function createOrUpdateLibraryAccess(
    body,
    ownerIdentityId,
    requestingIdentityId
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
            return createResponse(403, {
                error: "You can only create/update your own library access record",
            });
        }

        const requestData = JSON.parse(body);

        // Validate required fields and sanitize input
        const { movieCount, collectionCount, lastScanAt, ownerUsername } =
            requestData;

        if (
            typeof movieCount !== "number" ||
            typeof collectionCount !== "number"
        ) {
            return createResponse(400, {
                error: "movieCount and collectionCount must be numbers",
            });
        }

        if (!lastScanAt || !Date.parse(lastScanAt)) {
            return createResponse(400, {
                error: "lastScanAt must be a valid ISO date string",
            });
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

        console.log(
            `LibraryAccess record ${
                existingRecord.Item ? "updated" : "created"
            } successfully`
        );

        return createResponse(200, {
            message: `Library access record ${
                existingRecord.Item ? "updated" : "created"
            } successfully`,
            record: libraryRecord,
        });
    } catch (error) {
        console.error("Error creating/updating library access:", error);
        return createResponse(500, {
            error: "Internal server error",
            details: error.message,
        });
    }
}

// Get library access record
async function getLibraryAccess(ownerIdentityId, requestingIdentityId) {
    try {
        console.log(
            "Getting library access for owner:",
            ownerIdentityId,
            "requested by:",
            requestingIdentityId
        );

        // Validate requesting user can only access their own library access record
        if (ownerIdentityId !== requestingIdentityId) {
            return createResponse(403, {
                error: "You can only access your own library access record",
            });
        }

        // Get the library access record
        const result = await dynamodb.send(
            new GetCommand({
                TableName: LIBRARY_ACCESS_TABLE,
                Key: { ownerIdentityId },
            })
        );

        if (!result.Item) {
            return createResponse(404, {
                error: "Library access record not found",
            });
        }

        return createResponse(200, result.Item);
    } catch (error) {
        console.error("Error getting library access:", error);
        return createResponse(500, {
            error: "Internal server error",
            details: error.message,
        });
    }
}

async function requestMovie() {
    console.log("request movie called");
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
            "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
    };
}
