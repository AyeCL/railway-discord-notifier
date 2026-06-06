import assert from "node:assert/strict";
import test from "node:test";

import { buildDeploymentDedupeKey, buildSemanticDedupeKey } from "./dedupe.js";
import type { RailwayDeploymentEvent } from "./types.js";

const baseEvent: RailwayDeploymentEvent = {
  eventType: "Deployment.deployed",
  status: "SUCCESS",
  severity: null,
  timestamp: "2026-06-06T16:50:30.116Z",
  workspace: {
    id: "workspace-1",
    name: "Aayush L's Projects",
  },
  project: {
    id: "project-1",
    name: "youanai-web",
  },
  environment: {
    id: "env-1",
    name: "production",
    isEphemeral: false,
  },
  service: {
    id: "service-1",
    name: "core",
  },
  deployment: {
    id: "deployment-1",
  },
  details: {
    source: "GitHub",
    branch: "production",
    commitHash: "6f16c58485a0ecb4cb092325f58ff5a83ba6aeca",
    commitAuthor: "kaushalrijal",
    commitMessage: "Use liveness for Core healthcheck",
  },
};

test("deployment dedupe key stays specific to a single Railway deployment", () => {
  assert.equal(buildDeploymentDedupeKey(baseEvent), "deployment:deployment-1:SUCCESS");
});

test("semantic dedupe key collapses repeated deployments for the same commit", () => {
  const duplicateEvent: RailwayDeploymentEvent = {
    ...baseEvent,
    deployment: {
      id: "deployment-2",
    },
  };

  assert.equal(buildSemanticDedupeKey(duplicateEvent), buildSemanticDedupeKey(baseEvent));
});

test("semantic dedupe key changes for a new commit", () => {
  const nextCommitEvent: RailwayDeploymentEvent = {
    ...baseEvent,
    details: {
      ...baseEvent.details,
      commitHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  };

  assert.notEqual(buildSemanticDedupeKey(nextCommitEvent), buildSemanticDedupeKey(baseEvent));
});

test("semantic dedupe key is disabled when Railway omits commit hash", () => {
  const noCommitEvent: RailwayDeploymentEvent = {
    ...baseEvent,
    details: {
      ...baseEvent.details,
      commitHash: null,
    },
  };

  assert.equal(buildSemanticDedupeKey(noCommitEvent), null);
});
