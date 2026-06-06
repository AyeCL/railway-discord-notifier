import { normalizeDeploymentStatus, type DeploymentStatus } from "./types.js";

const DEFAULT_WEBHOOK_PATH = "/webhooks/railway";
const DEFAULT_STATUSES: DeploymentStatus[] = ["SUCCESS", "FAILED", "CRASHED"];

export type AppConfig = {
  port: number;
  webhookPath: string;
  webhookSecret: string | null;
  discordWebhookUrl: string;
  environmentAllowlist: Set<string>;
  serviceAllowlist: Set<string>;
  serviceDenylist: Set<string>;
  statusAllowlist: Set<DeploymentStatus>;
  ignoreEphemeralEnvironments: boolean;
  requestTimeoutMs: number;
  eventCacheTtlMs: number;
  semanticDedupeTtlMs: number;
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

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => ({
  port: parsePositiveInt(env.PORT, 3000),
  webhookPath: normalizePath(optional(env.WEBHOOK_PATH)),
  webhookSecret: optional(env.WEBHOOK_SECRET),
  discordWebhookUrl: required(env.DISCORD_WEBHOOK_URL, "DISCORD_WEBHOOK_URL"),
  environmentAllowlist: parseCsvSet(env.ENVIRONMENT_ALLOWLIST),
  serviceAllowlist: parseCsvSet(env.SERVICE_ALLOWLIST),
  serviceDenylist: parseCsvSet(env.SERVICE_DENYLIST),
  statusAllowlist: parseStatusAllowlist(env.STATUS_ALLOWLIST),
  ignoreEphemeralEnvironments: parseBoolean(env.IGNORE_EPHEMERAL_ENVIRONMENTS, true),
  requestTimeoutMs: parsePositiveInt(env.REQUEST_TIMEOUT_MS, 5000),
  eventCacheTtlMs: parsePositiveInt(env.EVENT_CACHE_TTL_MS, 86_400_000),
  semanticDedupeTtlMs: parsePositiveInt(env.SEMANTIC_DEDUPE_TTL_MS, 600_000),
});
