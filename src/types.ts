export const DEPLOYMENT_STATUSES = [
  "BUILDING",
  "DEPLOYING",
  "SUCCESS",
  "FAILED",
  "CRASHED",
  "REMOVED",
  "SLEEPING",
  "SKIPPED",
  "WAITING",
  "QUEUED",
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export type RailwayWebhookPayload = {
  type?: string;
  details?: {
    id?: string;
    source?: string;
    status?: string;
    branch?: string;
    commitHash?: string;
    commitAuthor?: string;
    commitMessage?: string;
  };
  resource?: {
    workspace?: { id?: string; name?: string };
    project?: { id?: string; name?: string };
    environment?: { id?: string; name?: string; isEphemeral?: boolean };
    service?: { id?: string; name?: string };
    deployment?: { id?: string };
  };
  severity?: string;
  timestamp?: string;
};

export type RailwayDeploymentEvent = {
  eventType: string;
  status: DeploymentStatus;
  severity: string | null;
  timestamp: string;
  workspace: {
    id: string | null;
    name: string | null;
  };
  project: {
    id: string | null;
    name: string | null;
  };
  environment: {
    id: string | null;
    name: string | null;
    isEphemeral: boolean;
  };
  service: {
    id: string | null;
    name: string | null;
  };
  deployment: {
    id: string;
  };
  details: {
    source: string | null;
    branch: string | null;
    commitHash: string | null;
    commitAuthor: string | null;
    commitMessage: string | null;
  };
};

export type RailwayLogEntry = {
  timestamp: string | null;
  message: string;
  severity: string | null;
};

export type RailwayEventLogs = {
  buildLogs: RailwayLogEntry[];
  runtimeLogs: RailwayLogEntry[];
  errors: string[];
};

export const isDeploymentStatus = (value: string): value is DeploymentStatus =>
  (DEPLOYMENT_STATUSES as readonly string[]).includes(value);

const STATUS_ALIASES: Record<string, DeploymentStatus> = {
  ACTIVE: "SUCCESS",
  BUILDING: "BUILDING",
  COMPLETED: "SUCCESS",
  CRASHED: "CRASHED",
  DEPLOYED: "SUCCESS",
  DEPLOYING: "DEPLOYING",
  FAILED: "FAILED",
  INITIALIZING: "QUEUED",
  NEEDS_APPROVAL: "WAITING",
  OOM_KILLED: "CRASHED",
  QUEUED: "QUEUED",
  REDEPLOYED: "SUCCESS",
  REMOVED: "REMOVED",
  REMOVING: "REMOVED",
  RESTARTED: "SUCCESS",
  RESUMED: "SUCCESS",
  SKIPPED: "SKIPPED",
  SLEPT: "SLEEPING",
  SLEEPING: "SLEEPING",
  SUCCESS: "SUCCESS",
  SUCCEEDED: "SUCCESS",
  WAITING: "WAITING",
};

export const normalizeDeploymentStatus = (value: string | null): DeploymentStatus | null => {
  if (!value) return null;
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return STATUS_ALIASES[normalized] ?? (isDeploymentStatus(normalized) ? normalized : null);
};

export const inferStatusFromEventType = (eventType: string | null): DeploymentStatus | null => {
  if (!eventType) return null;
  const parts = eventType.split(".");
  const suffix = parts.at(-1) ?? null;
  return normalizeDeploymentStatus(suffix);
};
