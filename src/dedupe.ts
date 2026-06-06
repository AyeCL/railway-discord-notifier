import type { RailwayDeploymentEvent } from "./types.js";

const normalizeKeyPart = (value: string | null, fallback = "unknown"): string =>
  (value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;

const resourceKey = (resource: { id: string | null; name: string | null }): string =>
  normalizeKeyPart(resource.id ?? resource.name);

export const buildDeploymentDedupeKey = (event: RailwayDeploymentEvent): string =>
  `deployment:${event.deployment.id}:${event.status}`;

export const buildSemanticDedupeKey = (event: RailwayDeploymentEvent): string | null => {
  const commitHash = event.details.commitHash?.trim().toLowerCase();
  if (!commitHash) return null;

  return [
    "semantic",
    resourceKey(event.project),
    resourceKey(event.environment),
    resourceKey(event.service),
    normalizeKeyPart(event.details.branch),
    event.status,
    commitHash,
  ].join(":");
};
