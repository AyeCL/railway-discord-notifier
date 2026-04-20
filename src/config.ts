import { normalizeDeploymentStatus, type DeploymentStatus } from "./types.js";

const DEFAULT_API_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const DEFAULT_WEBHOOK_PATH = "/webhooks/railway";
const DEFAULT_STATUSES: DeploymentStatus[] = ["SUCCESS", "FAILED", "CRASHED"];

export type AppConfig = {
  port: number;
  webhookPath: string;
  webhookSecret: string | null;
  discordWebhookUrl: string;
  failureMention: string | null;
  railwayApiEndpoint: string;
  railwayApiToken: string | null;
  railwayProjectToken: string | null;
  railwayProjectTokenMap: Map<string, string>;
  environmentAllowlist: Set<string>;
  serviceAllowlist: Set<string>;
  serviceDenylist: Set<string>;
  statusAllowlist: Set<DeploymentStatus>;
  ignoreEphemeralEnvironments: boolean;
  logTailLineLimit: number;
  logTailCharLimit: number;
  railwayLogFetchLimit: number;
  logFetchMaxAttempts: number;
  logFetchRetryMs: number;
  requestTimeoutMs: number;
  eventCacheTtlMs: number;
};

const optional = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const required = (value: string | undefined, name: string): string => {
  const resolved = optional(value);
  if (!resolved) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return resolved;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseCsvSet = (value: string | undefined): Set<string> =>
  new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );

const normalizePath = (value: string | null): string => {
  const base = value?.trim() || DEFAULT_WEBHOOK_PATH;
  const withLeadingSlash = base.startsWith("/") ? base : `/${base}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, "") : withLeadingSlash;
};

const parseStatusAllowlist = (value: string | undefined): Set<DeploymentStatus> => {
  const rawValues = (value ?? DEFAULT_STATUSES.join(","))
    .split(",")
    .map((entry) => normalizeDeploymentStatus(entry))
    .filter((entry): entry is DeploymentStatus => entry !== null);

  return new Set(rawValues.length > 0 ? rawValues : DEFAULT_STATUSES);
};

const parseTokenMap = (value: string | undefined): Map<string, string> => {
  const resolved = optional(value);
  if (!resolved) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(resolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON parse error";
    throw new Error(`Invalid RAILWAY_PROJECT_TOKEN_MAP_JSON: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RAILWAY_PROJECT_TOKEN_MAP_JSON must be a JSON object keyed by env name or env ID");
  }

  const entries = new Map<string, string>();
  for (const [key, token] of Object.entries(parsed)) {
    if (typeof token !== "string" || token.trim().length === 0) continue;
    entries.set(key.trim().toLowerCase(), token.trim());
  }
  return entries;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => ({
  port: parsePositiveInt(env.PORT, 3000),
  webhookPath: normalizePath(optional(env.WEBHOOK_PATH)),
  webhookSecret: optional(env.WEBHOOK_SECRET),
  discordWebhookUrl: required(env.DISCORD_WEBHOOK_URL, "DISCORD_WEBHOOK_URL"),
  failureMention: optional(env.FAILURE_MENTION),
  railwayApiEndpoint: optional(env.RAILWAY_API_ENDPOINT) ?? DEFAULT_API_ENDPOINT,
  railwayApiToken: optional(env.RAILWAY_API_TOKEN),
  railwayProjectToken: optional(env.RAILWAY_PROJECT_TOKEN) ?? optional(env.RAILWAY_TOKEN),
  railwayProjectTokenMap: parseTokenMap(env.RAILWAY_PROJECT_TOKEN_MAP_JSON),
  environmentAllowlist: parseCsvSet(env.ENVIRONMENT_ALLOWLIST),
  serviceAllowlist: parseCsvSet(env.SERVICE_ALLOWLIST),
  serviceDenylist: parseCsvSet(env.SERVICE_DENYLIST),
  statusAllowlist: parseStatusAllowlist(env.STATUS_ALLOWLIST),
  ignoreEphemeralEnvironments: parseBoolean(env.IGNORE_EPHEMERAL_ENVIRONMENTS, true),
  logTailLineLimit: parsePositiveInt(env.LOG_TAIL_LINE_LIMIT, 40),
  logTailCharLimit: parsePositiveInt(env.LOG_TAIL_CHAR_LIMIT, 2800),
  railwayLogFetchLimit: parsePositiveInt(env.RAILWAY_LOG_FETCH_LIMIT, 120),
  logFetchMaxAttempts: parsePositiveInt(env.LOG_FETCH_MAX_ATTEMPTS, 3),
  logFetchRetryMs: parsePositiveInt(env.LOG_FETCH_RETRY_MS, 1500),
  requestTimeoutMs: parsePositiveInt(env.REQUEST_TIMEOUT_MS, 5000),
  eventCacheTtlMs: parsePositiveInt(env.EVENT_CACHE_TTL_MS, 86_400_000),
});
