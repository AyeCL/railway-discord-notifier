import assert from "node:assert/strict";
import test from "node:test";

import { buildDiscordPayload } from "./format.js";
import type { RailwayDeploymentEvent } from "./types.js";

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

test("buildDiscordPayload creates a one-line failure alert with Railway link", () => {
  const payload = buildDiscordPayload(event);

  assert.equal(
    payload.content,
    "🚨 error in `core` in `staging` · [Railway](https://railway.com/project/project-1?environmentId=env-1) · @here"
  );
  assert.equal(payload.embeds, undefined);
  assert.deepEqual(payload.allowed_mentions, { parse: ["everyone"] });
});

test("buildDiscordPayload creates a one-line success alert with Railway link", () => {
  const payload = buildDiscordPayload(
    {
      ...event,
      eventType: "Deployment.deployed",
      status: "SUCCESS",
      environment: {
        id: "env-2",
        name: "production",
        isEphemeral: false,
      },
      service: {
        id: "svc-2",
        name: "water",
      },
    }
  );

  assert.equal(
    payload.content,
    "✅ deploy succeeded for `water` in `production` · [Railway](https://railway.com/project/project-1?environmentId=env-2)"
  );
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});
