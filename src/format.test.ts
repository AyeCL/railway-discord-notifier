import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "./config.js";
import { buildDiscordPayload } from "./format.js";
import type { RailwayDeploymentEvent, RailwayEventLogs } from "./types.js";

const config: AppConfig = {
  port: 3000,
  webhookPath: "/webhooks/railway",
  webhookSecret: "secret",
  discordWebhookUrl: "https://discord.example/webhook",
  failureMention: "@here",
  railwayApiEndpoint: "https://backboard.railway.com/graphql/v2",
  railwayApiToken: "token",
  railwayProjectToken: null,
  railwayProjectTokenMap: new Map(),
  environmentAllowlist: new Set(["staging", "production"]),
  serviceAllowlist: new Set(),
  serviceDenylist: new Set(["redis"]),
  statusAllowlist: new Set(["SUCCESS", "FAILED", "CRASHED"]),
  ignoreEphemeralEnvironments: true,
  logTailLineLimit: 10,
  logTailCharLimit: 2200,
  railwayLogFetchLimit: 120,
  logFetchMaxAttempts: 3,
  logFetchRetryMs: 1500,
  requestTimeoutMs: 5000,
  eventCacheTtlMs: 60_000,
};

const event: RailwayDeploymentEvent = {
  eventType: "Deployment.failed",
  status: "FAILED",
  severity: "WARNING",
  timestamp: "2026-04-19T12:00:00.000Z",
  workspace: {
    id: "workspace-1",
    name: "Aayush L's Projects",
  },
  project: {
    id: "project-1",
    name: "youanai-lisa",
  },
  environment: {
    id: "env-1",
    name: "staging",
    isEphemeral: false,
  },
  service: {
    id: "svc-1",
    name: "core",
  },
  deployment: {
    id: "deploy-1",
  },
  details: {
    source: "GitHub",
    branch: "master",
    commitHash: "abcdef1234567890",
    commitAuthor: "acl",
    commitMessage: "feat: ship notifier",
  },
};

const logs: RailwayEventLogs = {
  buildLogs: [
    {
      timestamp: "2026-04-19T12:00:01.000Z",
      message: "npm run build",
      severity: "info",
    },
    {
      timestamp: "2026-04-19T12:00:02.000Z",
      message: "Type error in src/server.ts",
      severity: "error",
    },
  ],
  runtimeLogs: [],
  errors: [],
};

test("buildDiscordPayload includes mention, dashboard link, and log tail", () => {
  const payload = buildDiscordPayload(event, logs, config);

  assert.equal(payload.content, "@here");
  assert.ok(payload.embeds);
  assert.equal(payload.embeds?.[0]?.url, "https://railway.com/project/project-1?environmentId=env-1");
  assert.match(payload.embeds?.[0]?.description ?? "", /Build log tail/);
  assert.match(payload.embeds?.[0]?.description ?? "", /Type error in src\/server\.ts/);
});
