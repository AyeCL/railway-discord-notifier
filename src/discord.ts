import type { AppConfig } from "./config.js";

export type DiscordEmbedField = {
  name: string;
  value: string;
  inline?: boolean;
};

export type DiscordEmbed = {
  title: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: {
    text: string;
  };
  timestamp?: string;
};

export type DiscordWebhookPayload = {
  content?: string;
  embeds?: DiscordEmbed[];
  flags?: number;
  allowed_mentions?: {
    parse?: string[];
  };
};

const transientNetworkMessages = ["fetch failed", "timeout", "network", "aborted"];
const MAX_DISCORD_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 10_000;
const MIN_RETRY_BUFFER_MS = 250;

const shouldRetry = (status: number | null, error: unknown): boolean => {
  if (typeof status === "number") {
    return status === 429 || status >= 500;
  }

  if (!(error instanceof Error)) return false;
  const lowered = error.message.toLowerCase();
  return transientNetworkMessages.some((fragment) => lowered.includes(fragment));
};

const buildAllowedMentions = (content: string | undefined) => {
  if (!content) {
    return { parse: [] as string[] };
  }

  return { parse: ["users", "roles", "everyone"] as string[] };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const parseSecondsToMs = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.ceil(parsed * 1000);
};

const parseRateLimitDelayMs = (response: Response, errorBody: string): number | null => {
  const headerDelayMs =
    parseSecondsToMs(response.headers.get("retry-after")) ??
    parseSecondsToMs(response.headers.get("x-ratelimit-reset-after"));

  if (headerDelayMs !== null) {
    return headerDelayMs + MIN_RETRY_BUFFER_MS;
  }

  if (!errorBody) return null;

  try {
    const parsed = JSON.parse(errorBody) as { retry_after?: unknown };
    const rawRetryAfter = parsed.retry_after;

    if (typeof rawRetryAfter === "number" && Number.isFinite(rawRetryAfter) && rawRetryAfter >= 0) {
      return Math.ceil(rawRetryAfter * 1000) + MIN_RETRY_BUFFER_MS;
    }

    if (typeof rawRetryAfter === "string") {
      const value = parseSecondsToMs(rawRetryAfter);
      return value === null ? null : value + MIN_RETRY_BUFFER_MS;
    }
  } catch {
    return null;
  }

  return null;
};

const fallbackRetryDelayMs = (attempt: number): number =>
  Math.min(1000 * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);

export const sendDiscordWebhook = async (
  payload: DiscordWebhookPayload,
  config: AppConfig
): Promise<void> => {
  const enrichedPayload: DiscordWebhookPayload = {
    ...payload,
    allowed_mentions: payload.allowed_mentions ?? buildAllowedMentions(payload.content),
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_DISCORD_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    try {
      const response = await fetch(config.discordWebhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(enrichedPayload),
        signal: controller.signal,
      });

      clearTimeout(timeoutHandle);

      if (response.ok) {
        return;
      }

      const errorBody = await response.text();
      const error = new Error(
        `Discord webhook returned HTTP ${response.status}${errorBody ? `: ${errorBody}` : ""}`
      );
      lastError = error;

      if (!shouldRetry(response.status, error) || attempt === MAX_DISCORD_ATTEMPTS) {
        throw error;
      }

      const retryDelayMs =
        response.status === 429
          ? parseRateLimitDelayMs(response, errorBody) ?? fallbackRetryDelayMs(attempt)
          : fallbackRetryDelayMs(attempt);

      await sleep(retryDelayMs);
      continue;
    } catch (error) {
      clearTimeout(timeoutHandle);
      lastError = error;
      if (!shouldRetry(null, error) || attempt === MAX_DISCORD_ATTEMPTS) {
        throw error;
      }

      await sleep(fallbackRetryDelayMs(attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Discord webhook failed.");
};
