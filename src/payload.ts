import {
  inferStatusFromEventType,
  normalizeDeploymentStatus,
  type RailwayDeploymentEvent,
  type RailwayWebhookPayload,
} from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const booleanOrFalse = (value: unknown): boolean => value === true;

export const extractDeploymentEvent = (payload: unknown): RailwayDeploymentEvent | null => {
  if (!isRecord(payload)) return null;

  const raw = payload as RailwayWebhookPayload;
  const eventType = stringOrNull(raw.type);
  if (!eventType || !eventType.toLowerCase().startsWith("deployment.")) {
    return null;
  }

  const status =
    inferStatusFromEventType(eventType) ?? normalizeDeploymentStatus(stringOrNull(raw.details?.status));
  if (!status) return null;

  const deploymentId =
    stringOrNull(raw.resource?.deployment?.id) ?? stringOrNull(raw.details?.id);
  if (!deploymentId) return null;

  return {
    eventType,
    status,
    severity: stringOrNull(raw.severity),
    timestamp: stringOrNull(raw.timestamp) ?? new Date().toISOString(),
    workspace: {
      id: stringOrNull(raw.resource?.workspace?.id),
      name: stringOrNull(raw.resource?.workspace?.name),
    },
    project: {
      id: stringOrNull(raw.resource?.project?.id),
      name: stringOrNull(raw.resource?.project?.name),
    },
    environment: {
      id: stringOrNull(raw.resource?.environment?.id),
      name: stringOrNull(raw.resource?.environment?.name),
      isEphemeral: booleanOrFalse(raw.resource?.environment?.isEphemeral),
    },
    service: {
      id: stringOrNull(raw.resource?.service?.id),
      name: stringOrNull(raw.resource?.service?.name),
    },
    deployment: {
      id: deploymentId,
    },
    details: {
      source: stringOrNull(raw.details?.source),
      branch: stringOrNull(raw.details?.branch),
      commitHash: stringOrNull(raw.details?.commitHash),
      commitAuthor: stringOrNull(raw.details?.commitAuthor),
      commitMessage: stringOrNull(raw.details?.commitMessage),
    },
  };
};
