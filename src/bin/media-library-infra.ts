// media-library-infra.ts

import * as cdk from "aws-cdk-lib";
import * as fs from "fs";
import * as path from "path";

import { MediaLibraryStack } from "../lib/media-library-stack";

const app = new cdk.App();

// Get stage context
const stage = app.node.tryGetContext("stage");
if (!stage) {
    throw new Error("Please specify config using --context stage=dev|prod");
}

// Validate environment variables
const tmdbApiAccessTokenName =
    stage === "prod"
        ? "TMDB_API_ACCESS_TOKEN_PROD"
        : "TMDB_API_ACCESS_TOKEN_DEV";
const requiredEnvVars = [tmdbApiAccessTokenName];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        throw new Error(`Missing required environment variable: ${envVar}`);
    }
}

// Load environment config
const configPath = path.join(__dirname, `../../config/${stage}.json`);
if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// Create the stack
new MediaLibraryStack(app, `MediaLibrary-${stage}`, {
    ...config,
    // Securely pass sensitive values from environment variables
    tmdbAccessToken:
        stage === "prod"
            ? process.env.TMDB_API_ACCESS_TOKEN_PROD!
            : process.env.TMDB_API_ACCESS_TOKEN_DEV!,
    playlistPreSignedUrlExpiration: config.playlistPreSignedUrlExpiration,
    devWebsiteUsername: process.env.DEV_WEBSITE_USERNAME!,
    devWebsitePassword: process.env.DEV_WEBSITE_PASSWORD!,
    stageName: stage,
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    },
    stackName: `${config.stackNamePrefix}-${stage}`,
    tags: config.tags,
});

app.synth();
