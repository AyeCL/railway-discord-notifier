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

export type DiscordWebhookReceipt = {
  sent: boolean;
  messageId: string | null;
  channelId: string | null;
  statusCode?: number;
  errorCode?: "invalid_url" | "timeout" | "transport_error" | "http_error" | "invalid_response";
};

const transientNetworkMessages = ["fetch failed", "timeout", "network", "aborted"];
const MAX_DISCORD_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 10_000;
const MIN_RETRY_BUFFER_MS = 250;
const MAX_DISCORD_RECEIPT_BYTES = 64 * 1024;
const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

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

const toSafeDiscordErrorCode = (
  error: unknown,
): NonNullable<DiscordWebhookReceipt["errorCode"]> => {
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  return "transport_error";
};

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

const isDiscordSnowflake = (value: unknown): value is string =>
  typeof value === "string" && DISCORD_SNOWFLAKE_PATTERN.test(value);

const isDiscordWebhookPath = (pathname: string): boolean => {
  const segments = pathname.split("/").filter(Boolean);
  const [api, webhooks, webhookId, token] = segments;
  return (
    segments.length === 4 &&
    api === "api" &&
    webhooks === "webhooks" &&
    isDiscordSnowflake(webhookId) &&
    token !== undefined &&
    token.length > 0 &&
    token.length <= 256
  );
};

const parseDiscordWebhookUrl = (value: string): URL | null => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.username || parsed.password || parsed.hash) return null;
  const loopback = isLoopbackHost(parsed.hostname);
  if (loopback) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    // Loopback URLs are accepted for local/injected-fetch tests only. They
    // still use the same API path shape as the real Discord endpoint.
    return isDiscordWebhookPath(parsed.pathname) ? parsed : null;
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== "discord.com") return null;
  return isDiscordWebhookPath(parsed.pathname) ? parsed : null;
};

const readBoundedResponseBody = async (
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

/**
 * Send one operational notification and request Discord's message object.
 * This intentionally performs one bounded attempt: the caller owns episode
 * cooldowns, and retrying an ambiguous webhook response can duplicate it.
 */
export const sendDiscordWebhookWithReceipt = async (
  payload: DiscordWebhookPayload,
  webhookUrl: string,
  options?: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<DiscordWebhookReceipt> => {
  const parsedUrl = parseDiscordWebhookUrl(webhookUrl);
  if (!parsedUrl) {
    return { sent: false, messageId: null, channelId: null, errorCode: "invalid_url" };
  }
  parsedUrl.searchParams.set("wait", "true");

  const timeoutMs = Math.min(5_000, Math.max(1, options?.timeoutMs ?? 5_000));
  const fetchImpl = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options?.signal?.aborted) {
    return { sent: false, messageId: null, channelId: null, errorCode: "timeout" };
  }
  options?.signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(parsedUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...payload,
        allowed_mentions: { parse: [] },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        sent: false,
        messageId: null,
        channelId: null,
        statusCode: response.status,
        errorCode: "http_error",
      };
    }

    const bodyText = await readBoundedResponseBody(response, MAX_DISCORD_RECEIPT_BYTES);
    if (bodyText === null) {
      return {
        sent: false,
        messageId: null,
        channelId: null,
        statusCode: response.status,
        errorCode: "invalid_response",
      };
    }

    try {
      const body = JSON.parse(bodyText) as unknown;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Discord receipt was not an object");
      }

      const messageId = Reflect.get(body, "id");
      const channelId = Reflect.get(body, "channel_id");
      if (!isDiscordSnowflake(messageId) || !isDiscordSnowflake(channelId)) {
        throw new Error("Discord receipt did not contain valid message and channel IDs");
      }
      return { sent: true, messageId, channelId, statusCode: response.status };
    } catch {
      return {
        sent: false,
        messageId: null,
        channelId: null,
        statusCode: response.status,
        errorCode: "invalid_response",
      };
    }
  } catch (error) {
    return {
      sent: false,
      messageId: null,
      channelId: null,
      errorCode: toSafeDiscordErrorCode(error),
    };
  } finally {
    clearTimeout(timeoutHandle);
    options?.signal?.removeEventListener("abort", onAbort);
  }
};

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
