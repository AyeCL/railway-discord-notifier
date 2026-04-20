import assert from "node:assert/strict";
import test from "node:test";

import { extractDeploymentEvent } from "./payload.js";

test("extractDeploymentEvent prefers status inferred from event type when docs payload is inconsistent", () => {
  const event = extractDeploymentEvent({
    type: "Deployment.failed",
    details: {
      id: "8107edff-4b8e-44fc-b43a-04566e847a2a",
      source: "GitHub",
      status: "SUCCESS",
      branch: "main",
      commitHash: "abcdef1234567890",
      commitAuthor: "acl",
      commitMessage: "ship it",
    },
    resource: {
      project: { id: "project-123", name: "youanai-lisa" },
      environment: { id: "env-123", name: "staging", isEphemeral: false },
      service: { id: "svc-123", name: "core" },
      deployment: { id: "deploy-123" },
    },
    severity: "WARNING",
    timestamp: "2026-04-19T12:00:00.000Z",
  });

  assert.ok(event);
  assert.equal(event.status, "FAILED");
  assert.equal(event.deployment.id, "deploy-123");
  assert.equal(event.environment.name, "staging");
  assert.equal(event.service.name, "core");
});

test("extractDeploymentEvent maps deployed webhook events to success", () => {
  const event = extractDeploymentEvent({
    type: "deployment.deployed",
    details: {
      id: "deploy-456",
      status: "ACTIVE",
    },
    resource: {
      environment: { id: "env-456", name: "production", isEphemeral: false },
      service: { id: "svc-456", name: "water" },
      deployment: { id: "deploy-456" },
    },
  });

  assert.ok(event);
  assert.equal(event.status, "SUCCESS");
});

test("extractDeploymentEvent maps oom killed webhook events to crashed", () => {
  const event = extractDeploymentEvent({
    type: "deployment.oom_killed",
    details: {
      id: "deploy-789",
    },
    resource: {
      environment: { id: "env-789", name: "production", isEphemeral: false },
      service: { id: "svc-789", name: "lisa" },
      deployment: { id: "deploy-789" },
    },
  });

  assert.ok(event);
  assert.equal(event.status, "CRASHED");
});
