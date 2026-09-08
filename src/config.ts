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
  watchdogCoreUrl: string | null;
  watchdogSecret: string | null;
  watchdogPollIntervalMs: number;
  watchdogCoreTimeoutMs: number;
  watchdogFailureThreshold: number;
  watchdogFallbackDiscordWebhookUrl: string | null;
  watchdogFallbackCooldownMs: number;
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

const parseBoundedPositiveInt = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => Math.min(maximum, Math.max(minimum, parsePositiveInt(value, fallback)));

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

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

const parseWatchdogUrl = (
  value: string | undefined,
  name: string,
): string | null => {
  const candidate = optional(value);
  if (!candidate) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }

  if (
    (parsed.protocol !== "https:" && !isLoopbackHost(parsed.hostname)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname === "/"
  ) {
    throw new Error(`${name} must be an HTTPS endpoint without credentials or query parameters.`);
  }

  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return `${parsed.origin}${pathname}`;
};

const parseWatchdogSecret = (
  value: string | undefined,
  coreUrl: string | null,
): string | null => {
  const secret = optional(value);
  if (Boolean(coreUrl) !== Boolean(secret)) {
    throw new Error("WATCHDOG_CORE_URL and WATCHDOG_SECRET must be configured together.");
  }
  if (secret && (secret.length < 32 || secret.length > 256 || /\s/.test(secret))) {
    throw new Error("WATCHDOG_SECRET must contain 32-256 non-whitespace characters.");
  }
  return secret;
};

const parseStatusAllowlist = (value: string | undefined): Set<DeploymentStatus> => {
  const rawValues = (value ?? DEFAULT_STATUSES.join(","))
    .split(",")
    .map((entry) => normalizeDeploymentStatus(entry))
    .filter((entry): entry is DeploymentStatus => entry !== null);

  return new Set(rawValues.length > 0 ? rawValues : DEFAULT_STATUSES);
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const watchdogCoreUrl = parseWatchdogUrl(env.WATCHDOG_CORE_URL, "WATCHDOG_CORE_URL");
  const watchdogSecret = parseWatchdogSecret(env.WATCHDOG_SECRET, watchdogCoreUrl);

  return {
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
    watchdogCoreUrl,
    watchdogSecret,
    watchdogPollIntervalMs: parseBoundedPositiveInt(
      env.WATCHDOG_POLL_INTERVAL_MS,
      60_000,
      1_000,
      86_400_000,
    ),
    watchdogCoreTimeoutMs: parseBoundedPositiveInt(
      env.WATCHDOG_CORE_TIMEOUT_MS,
      15_000,
      1_000,
      15_000,
    ),
    watchdogFailureThreshold: parseBoundedPositiveInt(
      env.WATCHDOG_FAILURE_THRESHOLD,
      3,
      1,
      100,
    ),
    watchdogFallbackDiscordWebhookUrl: parseWatchdogUrl(
      env.WATCHDOG_DISCORD_WEBHOOK_URL,
      "WATCHDOG_DISCORD_WEBHOOK_URL",
    ),
    watchdogFallbackCooldownMs: parseBoundedPositiveInt(
      env.WATCHDOG_FALLBACK_COOLDOWN_MS,
      30 * 60_000,
      60_000,
      30 * 60_000,
    ),
  };
};
