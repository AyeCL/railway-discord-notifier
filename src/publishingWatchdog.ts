import type { AppConfig } from "./config.js";
import {
  sendDiscordWebhookWithReceipt,
  type DiscordWebhookPayload,
  type DiscordWebhookReceipt,
} from "./discord.js";

export const PUBLISHING_WATCHDOG_SCHEMA = "youanai.publishing-watchdog/v1" as const;
export const PUBLISHING_WATCHDOG_MAX_RESPONSE_BYTES = 64 * 1024;
export const PUBLISHING_WATCHDOG_DISCORD_TIMEOUT_MS = 5_000;
export const PUBLISHING_WATCHDOG_CLOCK_SKEW_MS = 30_000;
export const PUBLISHING_WATCHDOG_RECOVERY_RETRY_COOLDOWN_MS = 60_000;
export const PUBLISHING_WATCHDOG_FALLBACK_RETRY_COOLDOWN_MS = 60_000;

const DEFAULT_RESPONSE_MAX_AGE_MS = 150_000;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

export type PublishingWatchdogConfig = Pick<
  AppConfig,
  | "watchdogCoreUrl"
  | "watchdogSecret"
  | "watchdogPollIntervalMs"
  | "watchdogCoreTimeoutMs"
  | "watchdogFailureThreshold"
  | "watchdogFallbackDiscordWebhookUrl"
  | "watchdogFallbackCooldownMs"
>;

export type PublishingWatchdogLogLevel = "INFO" | "WARN" | "ERROR";
export type PublishingWatchdogLogger = (
  level: PublishingWatchdogLogLevel,
  message: string,
  details?: Readonly<Record<string, string | number | boolean | null>>,
) => void;

export type PublishingWatchdogScan = Readonly<{
  ok: true;
  schema: typeof PUBLISHING_WATCHDOG_SCHEMA;
  observedAt: string;
  scanId: string;
  candidateCount: number;
  activeIncidentCount: number;
  sentCount: number;
  deliveryFailureCount: 0;
  truncated: boolean;
}>;

export type PublishingWatchdogScanValidation =
  | Readonly<{
      ok: true;
      scan: PublishingWatchdogScan;
      degraded: boolean;
    }>
  | Readonly<{
      ok: false;
      reason:
        | "malformed_response"
        | "stale_response"
        | "future_response"
        | "delivery_failure";
    }>;

export type PublishingWatchdogRunResult =
  | Readonly<{ kind: "disabled" | "skipped"; reason: "disabled" | "in_flight" | "stopped" }>
  | Readonly<{
      kind: "success";
      scan: PublishingWatchdogScan;
      degraded: boolean;
      recoverySent: boolean;
    }>
  | Readonly<{
      kind: "failure";
      reason: PublishingWatchdogFailureReason;
      consecutiveFailures: number;
      fallbackSent: boolean;
    }>;

export type PublishingWatchdogFailureReason =
  | "timeout"
  | "transport_error"
  | "http_error"
  | "malformed_response"
  | "stale_response"
  | "future_response"
  | "delivery_failure";

type SendDiscord = (
  payload: DiscordWebhookPayload,
  webhookUrl: string,
  options?: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  },
) => Promise<DiscordWebhookReceipt>;

export type PublishingWatchdogOptions = Readonly<{
  fetchImpl?: typeof fetch;
  sendDiscord?: SendDiscord;
  now?: () => number;
  logger?: PublishingWatchdogLogger;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isSafeIdentifier = (value: unknown): value is string =>
  typeof value === "string" && SAFE_IDENTIFIER_PATTERN.test(value);

const readCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000
    ? value
    : null;

const readObservedAt = (value: unknown): number | null => {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const validatePublishingWatchdogResponse = (
  value: unknown,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_RESPONSE_MAX_AGE_MS,
): PublishingWatchdogScanValidation => {
  if (!isRecord(value) || value.ok !== true || value.schema !== PUBLISHING_WATCHDOG_SCHEMA) {
    return { ok: false, reason: "malformed_response" };
  }

  const observedAtMs = readObservedAt(value.observedAt);
  if (observedAtMs === null) return { ok: false, reason: "malformed_response" };
  if (observedAtMs > nowMs + PUBLISHING_WATCHDOG_CLOCK_SKEW_MS) {
    return { ok: false, reason: "future_response" };
  }
  if (observedAtMs < nowMs - maxAgeMs) {
    return { ok: false, reason: "stale_response" };
  }

  const candidateCount = readCount(value.candidateCount);
  const activeIncidentCount = readCount(value.activeIncidentCount);
  const sentCount = readCount(value.sentCount);
  const deliveryFailureCount = readCount(value.deliveryFailureCount);
  if (
    candidateCount === null ||
    activeIncidentCount === null ||
    sentCount === null ||
    deliveryFailureCount === null ||
    !isSafeIdentifier(value.scanId) ||
    typeof value.truncated !== "boolean" ||
    activeIncidentCount > candidateCount
  ) {
    return { ok: false, reason: "malformed_response" };
  }

  if (deliveryFailureCount > 0) {
    return { ok: false, reason: "delivery_failure" };
  }

  const scan: PublishingWatchdogScan = {
    ok: true,
    schema: PUBLISHING_WATCHDOG_SCHEMA,
    observedAt: value.observedAt as string,
    scanId: value.scanId as string,
    candidateCount,
    activeIncidentCount,
    sentCount,
    deliveryFailureCount: 0,
    truncated: value.truncated,
  };
  return { ok: true, scan, degraded: value.truncated };
};

const failureReasonFromError = (error: unknown): "timeout" | "transport_error" =>
  error instanceof Error && error.name === "AbortError" ? "timeout" : "transport_error";

const safeLog = (
  logger: PublishingWatchdogLogger,
  level: PublishingWatchdogLogLevel,
  message: string,
  details?: Readonly<Record<string, string | number | boolean | null>>,
) => {
  try {
    logger(level, message, details);
  } catch {
    // Monitoring must never take down the notifier.
  }
};

const buildFallbackPayload = (failureThreshold: number): DiscordWebhookPayload => ({
  embeds: [
    {
      title: "Publishing watchdog unavailable",
      description: "The independent monitor could not complete a Core scan.",
      color: 0xdc2626,
      fields: [
        {
          name: "Consecutive failures",
          value: String(failureThreshold),
          inline: true,
        },
        {
          name: "Action",
          value: "Check Core health and the scheduled-post worker.",
          inline: true,
        },
      ],
      footer: { text: "Youanai publishing watchdog" },
    },
  ],
  allowed_mentions: { parse: [] },
});

const buildRecoveryPayload = (degraded: boolean): DiscordWebhookPayload => ({
  embeds: [
    {
      title: "Publishing watchdog recovered",
      description: degraded
        ? "Core responded again, but the scan reported a truncated backlog."
        : "Core completed a valid publishing watchdog scan again.",
      color: degraded ? 0xf59e0b : 0x16a34a,
      footer: { text: "Youanai publishing watchdog" },
    },
  ],
  allowed_mentions: { parse: [] },
});

const readBoundedBody = async (
  response: Response,
  maxBytes: number,
): Promise<string | null> => {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxBytes) return null;
  }

  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") <= maxBytes ? text : null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
};

export class PublishingWatchdog {
  readonly enabled: boolean;

  private readonly fetchImpl: typeof fetch;
  private readonly sendDiscord: SendDiscord;
  private readonly now: () => number;
  private readonly logger: PublishingWatchdogLogger;
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private stopped = false;
  private consecutiveFailures = 0;
  private lastFallbackAttemptAt: number | null = null;
  private lastFallbackDelivered = false;
  private fallbackEpisodeNotified = false;
  private recoveryPending = false;
  private lastRecoveryAttemptAt: number | null = null;
  private coreAbortController: AbortController | null = null;
  private discordAbortController: AbortController | null = null;

  constructor(
    private readonly config: PublishingWatchdogConfig,
    options: PublishingWatchdogOptions = {},
  ) {
    this.enabled = Boolean(config.watchdogCoreUrl && config.watchdogSecret);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sendDiscord = options.sendDiscord ?? sendDiscordWebhookWithReceipt;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? (() => undefined);
  }

  start(): void {
    if (!this.enabled || this.started) return;
    this.started = true;
    this.stopped = false;
    void this.runOnce();
    this.interval = setInterval(() => {
      void this.runOnce();
    }, this.config.watchdogPollIntervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.coreAbortController?.abort();
    this.discordAbortController?.abort();
  }

  async runOnce(): Promise<PublishingWatchdogRunResult> {
    if (!this.enabled) return { kind: "disabled", reason: "disabled" };
    if (this.stopped) return { kind: "skipped", reason: "stopped" };
    if (this.running) return { kind: "skipped", reason: "in_flight" };
    this.running = true;

    try {
      const result = await this.scanCore();
      if (result.kind === "success") {
        return await this.handleSuccess(result.scan, result.degraded);
      }
      if (result.kind === "stopped") {
        return { kind: "skipped", reason: "stopped" };
      }
      return await this.handleFailure(result.reason);
    } finally {
      this.running = false;
    }
  }

  private async scanCore(): Promise<
    | Readonly<{ kind: "success"; scan: PublishingWatchdogScan; degraded: boolean }>
    | Readonly<{ kind: "failure"; reason: PublishingWatchdogFailureReason }>
    | Readonly<{ kind: "stopped" }>
  > {
    const coreUrl = this.config.watchdogCoreUrl;
    const secret = this.config.watchdogSecret;
    if (!coreUrl || !secret) return { kind: "stopped" };

    const controller = new AbortController();
    this.coreAbortController = controller;
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      Math.min(15_000, this.config.watchdogCoreTimeoutMs),
    );
    try {
      const response = await this.fetchImpl(coreUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        redirect: "error",
        body: JSON.stringify({ schema: PUBLISHING_WATCHDOG_SCHEMA }),
        signal: controller.signal,
      });
      if (!response.ok) return { kind: "failure", reason: "http_error" };

      const body = await readBoundedBody(response, PUBLISHING_WATCHDOG_MAX_RESPONSE_BYTES);
      if (body === null) return { kind: "failure", reason: "malformed_response" };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return { kind: "failure", reason: "malformed_response" };
      }
      const validation = validatePublishingWatchdogResponse(
        parsed,
        this.now(),
        Math.max(90_000, this.config.watchdogPollIntervalMs * 2 + 30_000),
      );
      if (!validation.ok) return { kind: "failure", reason: validation.reason };
      return { kind: "success", scan: validation.scan, degraded: validation.degraded };
    } catch (error) {
      if (this.stopped) return { kind: "stopped" };
      return { kind: "failure", reason: failureReasonFromError(error) };
    } finally {
      clearTimeout(timeoutHandle);
      if (this.coreAbortController === controller) this.coreAbortController = null;
    }
  }

  private async handleSuccess(
    scan: PublishingWatchdogScan,
    degraded: boolean,
  ): Promise<PublishingWatchdogRunResult> {
    this.consecutiveFailures = 0;
    let recoverySent = false;
    if (this.fallbackEpisodeNotified && this.config.watchdogFallbackDiscordWebhookUrl) {
      this.recoveryPending = true;
      const now = this.now();
      const retryAllowed =
        this.lastRecoveryAttemptAt === null ||
        now - this.lastRecoveryAttemptAt >= PUBLISHING_WATCHDOG_RECOVERY_RETRY_COOLDOWN_MS;
      if (retryAllowed) {
        this.lastRecoveryAttemptAt = now;
        const receipt = await this.sendDirectNotification(buildRecoveryPayload(degraded));
        recoverySent = receipt.sent;
        if (receipt.sent) {
          this.recoveryPending = false;
          this.fallbackEpisodeNotified = false;
          this.lastRecoveryAttemptAt = null;
          this.lastFallbackAttemptAt = null;
          this.lastFallbackDelivered = false;
        }
        safeLog(this.logger, receipt.sent ? "INFO" : "WARN", "publishing_watchdog_recovery", {
          delivered: receipt.sent,
          degraded,
          recoveryPending: this.recoveryPending,
          messageId: receipt.messageId,
          channelId: receipt.channelId,
        });
      }
    }
    safeLog(this.logger, degraded ? "WARN" : "INFO", "publishing_watchdog_scan_succeeded", {
      degraded,
      candidateCount: scan.candidateCount,
      activeIncidentCount: scan.activeIncidentCount,
      sentCount: scan.sentCount,
      truncated: scan.truncated,
    });
    return { kind: "success", scan, degraded, recoverySent };
  }

  private async handleFailure(
    reason: PublishingWatchdogFailureReason,
  ): Promise<PublishingWatchdogRunResult> {
    // A new failed check supersedes a recovery that could not be confirmed.
    // Keep the outage episode active so the next valid scan can retry recovery.
    this.recoveryPending = false;
    this.lastRecoveryAttemptAt = null;
    this.consecutiveFailures = Math.min(this.consecutiveFailures + 1, 1_000_000);
    let fallbackSent = false;
    const fallbackUrl = this.config.watchdogFallbackDiscordWebhookUrl;
    const now = this.now();
    const fallbackCooldownMs = this.lastFallbackDelivered
      ? this.config.watchdogFallbackCooldownMs
      : PUBLISHING_WATCHDOG_FALLBACK_RETRY_COOLDOWN_MS;
    const cooldownElapsed =
      this.lastFallbackAttemptAt === null ||
      now - this.lastFallbackAttemptAt >= fallbackCooldownMs;
    if (
      fallbackUrl &&
      this.consecutiveFailures >= this.config.watchdogFailureThreshold &&
      cooldownElapsed
    ) {
      this.lastFallbackAttemptAt = now;
      const receipt = await this.sendDirectNotification(
        buildFallbackPayload(this.config.watchdogFailureThreshold),
      );
      fallbackSent = receipt.sent;
      this.lastFallbackDelivered = receipt.sent;
      if (receipt.sent) {
        this.fallbackEpisodeNotified = true;
        this.recoveryPending = false;
        this.lastRecoveryAttemptAt = null;
      }
      safeLog(this.logger, receipt.sent ? "WARN" : "ERROR", "publishing_watchdog_fallback", {
        delivered: receipt.sent,
        failureReason: reason,
        consecutiveFailures: this.consecutiveFailures,
        messageId: receipt.messageId,
        channelId: receipt.channelId,
      });
    }
    safeLog(this.logger, "ERROR", "publishing_watchdog_scan_failed", {
      failureReason: reason,
      consecutiveFailures: this.consecutiveFailures,
    });
    return { kind: "failure", reason, consecutiveFailures: this.consecutiveFailures, fallbackSent };
  }

  private async sendDirectNotification(payload: DiscordWebhookPayload): Promise<DiscordWebhookReceipt> {
    const webhookUrl = this.config.watchdogFallbackDiscordWebhookUrl;
    if (!webhookUrl) {
      return { sent: false, messageId: null, channelId: null, errorCode: "invalid_url" };
    }
    const controller = new AbortController();
    this.discordAbortController = controller;
    try {
      try {
        return await this.sendDiscord(payload, webhookUrl, {
          timeoutMs: PUBLISHING_WATCHDOG_DISCORD_TIMEOUT_MS,
          fetchImpl: this.fetchImpl,
          signal: controller.signal,
        });
      } catch {
        return { sent: false, messageId: null, channelId: null, errorCode: "transport_error" };
      }
    } finally {
      if (this.discordAbortController === controller) this.discordAbortController = null;
    }
  }
}

export const createPublishingWatchdog = (
  config: PublishingWatchdogConfig,
  options?: PublishingWatchdogOptions,
): PublishingWatchdog => new PublishingWatchdog(config, options);
