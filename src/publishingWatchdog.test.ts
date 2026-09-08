import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PUBLISHING_WATCHDOG_SCHEMA,
  PublishingWatchdog,
  validatePublishingWatchdogResponse,
  type PublishingWatchdogConfig,
} from "./publishingWatchdog.js";
import {
  sendDiscordWebhookWithReceipt,
  type DiscordWebhookPayload,
  type DiscordWebhookReceipt,
} from "./discord.js";

const NOW = Date.parse("2026-09-08T15:00:00.000Z");
const CORE_URL = "https://core.example.test/api/internal/ops/publishing-watchdog";
const CORE_SECRET = "s".repeat(40);
const FALLBACK_URL = "https://discord.com/api/webhooks/123456789012345678/operations-token";

const config = (overrides: Partial<PublishingWatchdogConfig> = {}): PublishingWatchdogConfig => ({
  watchdogCoreUrl: CORE_URL,
  watchdogSecret: CORE_SECRET,
  watchdogPollIntervalMs: 1_000,
  watchdogCoreTimeoutMs: 15_000,
  watchdogFailureThreshold: 3,
  watchdogFallbackDiscordWebhookUrl: FALLBACK_URL,
  watchdogFallbackCooldownMs: 30 * 60_000,
  ...overrides,
});

const validResponse = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  schema: PUBLISHING_WATCHDOG_SCHEMA,
  observedAt: new Date(NOW).toISOString(),
  scanId: "scan-123",
  candidateCount: 2,
  activeIncidentCount: 1,
  sentCount: 1,
  deliveryFailureCount: 0,
  truncated: false,
  ...overrides,
});

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const fakeDiscord = (calls: Array<{ payload: DiscordWebhookPayload; url: string; timeoutMs?: number }>) =>
  async (
    payload: DiscordWebhookPayload,
    url: string,
    options?: { timeoutMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal },
  ): Promise<DiscordWebhookReceipt> => {
    calls.push({
      payload,
      url,
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return {
      sent: true,
      messageId: `12345678901234567${calls.length}`,
      channelId: "234567890123456789",
    };
  };

test("validates scan freshness, shape, and delivery failures", () => {
  const good = validatePublishingWatchdogResponse(validResponse(), NOW, 90_000);
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.degraded, false);

  const truncated = validatePublishingWatchdogResponse(
    validResponse({ truncated: true }),
    NOW,
    90_000,
  );
  assert.equal(truncated.ok, true);
  if (truncated.ok) assert.equal(truncated.degraded, true);

  assert.deepEqual(
    validatePublishingWatchdogResponse(
      validResponse({ observedAt: new Date(NOW - 100_000).toISOString() }),
      NOW,
      90_000,
    ),
    { ok: false, reason: "stale_response" },
  );
  assert.deepEqual(
    validatePublishingWatchdogResponse(
      validResponse({ observedAt: new Date(NOW + 60_000).toISOString() }),
      NOW,
      90_000,
    ),
    { ok: false, reason: "future_response" },
  );
  assert.deepEqual(
    validatePublishingWatchdogResponse(
      validResponse({ deliveryFailureCount: 1 }),
      NOW,
      90_000,
    ),
    { ok: false, reason: "delivery_failure" },
  );
  assert.deepEqual(
    validatePublishingWatchdogResponse({ ok: true, schema: PUBLISHING_WATCHDOG_SCHEMA }, NOW),
    { ok: false, reason: "malformed_response" },
  );
});

test("polls Core with one authenticated POST and reports truncated scans as degraded", async () => {
  const requests: Array<{
    url: string;
    method: string;
    authorization: string | null;
    body: string;
    redirect: string | undefined;
  }> = [];
  const watchdog = new PublishingWatchdog(config(), {
    now: () => NOW,
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: String(init?.method),
        authorization: new Headers(init?.headers).get("authorization"),
        body: String(init?.body),
        redirect: init?.redirect,
      });
      return jsonResponse(validResponse({ truncated: true }));
    },
  });

  const result = await watchdog.runOnce();
  assert.equal(result.kind, "success");
  if (result.kind === "success") assert.equal(result.degraded, true);
  assert.deepEqual(requests, [{
    url: CORE_URL,
    method: "POST",
    authorization: `Bearer ${CORE_SECRET}`,
    body: JSON.stringify({ schema: PUBLISHING_WATCHDOG_SCHEMA }),
    redirect: "error",
  }]);
});

test("does not overlap Core polls", async () => {
  let resolveFetch: ((response: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const watchdog = new PublishingWatchdog(config(), {
    now: () => NOW,
    fetchImpl: async () => pending,
  });

  const first = watchdog.runOnce();
  const second = await watchdog.runOnce();
  assert.deepEqual(second, { kind: "skipped", reason: "in_flight" });
  resolveFetch?.(jsonResponse(validResponse()));
  assert.equal((await first).kind, "success");
});

test("sends one fallback after the threshold, respects cooldown, and sends one recovery", async () => {
  let now = NOW;
  let coreHealthy = false;
  const discordCalls: Array<{ payload: DiscordWebhookPayload; url: string; timeoutMs?: number }> = [];
  const watchdog = new PublishingWatchdog(config(), {
    now: () => now,
    fetchImpl: async () => coreHealthy
      ? jsonResponse(validResponse({ observedAt: new Date(now).toISOString() }))
      : jsonResponse({ error: "secret response body must not be logged" }, 503),
    sendDiscord: fakeDiscord(discordCalls),
    logger: (_level, _message, details) => {
      const serialized = JSON.stringify(details);
      assert.equal(serialized.includes(CORE_SECRET), false);
      assert.equal(serialized.includes(CORE_URL), false);
      assert.equal(serialized.includes("secret response body"), false);
    },
  });

  assert.equal((await watchdog.runOnce()).kind, "failure");
  assert.equal((await watchdog.runOnce()).kind, "failure");
  const threshold = await watchdog.runOnce();
  assert.equal(threshold.kind, "failure");
  assert.equal(discordCalls.length, 1);
  assert.equal(discordCalls[0]?.url, FALLBACK_URL);
  assert.equal(discordCalls[0]?.timeoutMs, 5_000);
  assert.deepEqual(discordCalls[0]?.payload.allowed_mentions, { parse: [] });
  assert.equal(JSON.stringify(discordCalls[0]?.payload).includes(CORE_SECRET), false);
  assert.equal(JSON.stringify(discordCalls[0]?.payload).includes(CORE_URL), false);

  await watchdog.runOnce();
  assert.equal(discordCalls.length, 1);

  now += 30 * 60_000;
  await watchdog.runOnce();
  assert.equal(discordCalls.length, 2);

  coreHealthy = true;
  now += 1_000;
  const recovered = await watchdog.runOnce();
  assert.equal(recovered.kind, "success");
  assert.equal(discordCalls.length, 3);
  assert.equal(JSON.stringify(discordCalls[2]?.payload).includes("recovered"), true);
  await watchdog.runOnce();
  assert.equal(discordCalls.length, 3);

  coreHealthy = false;
  now += 1_000;
  await watchdog.runOnce();
  await watchdog.runOnce();
  const nextEpisode = await watchdog.runOnce();
  assert.equal(nextEpisode.kind, "failure");
  assert.equal(discordCalls.length, 4);
  assert.equal(JSON.stringify(discordCalls[3]?.payload).includes("unavailable"), true);
});

test("direct Discord receipt requests wait=true and returns the message id", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const receipt = await sendDiscordWebhookWithReceipt(
    { content: "monitor fallback", allowed_mentions: { parse: ["everyone"] } },
    `${FALLBACK_URL}?thread_id=ops`,
    {
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return jsonResponse({ id: "123456789012345678", channel_id: "234567890123456789" });
      },
    },
  );

  assert.deepEqual(receipt, {
    sent: true,
    messageId: "123456789012345678",
    channelId: "234567890123456789",
    statusCode: 200,
  });
  assert.equal(new URL(requests[0]?.url ?? "https://invalid").searchParams.get("wait"), "true");
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}").allowed_mentions, { parse: [] });
});

test("does not report malformed Discord receipts as delivered", async () => {
  const validMessageId = "123456789012345678";
  const validChannelId = "234567890123456789";
  const malformedBodies = [
    {},
    { id: "discord-message-1", channel_id: validChannelId },
    { id: validMessageId, channel_id: "channel-1" },
    { id: validMessageId },
  ];

  for (const body of malformedBodies) {
    const receipt = await sendDiscordWebhookWithReceipt(
      { content: "monitor fallback" },
      FALLBACK_URL,
      { fetchImpl: async () => jsonResponse(body) },
    );
    assert.equal(receipt.sent, false);
    assert.equal(receipt.errorCode, "invalid_response");
    assert.equal(receipt.messageId, null);
    assert.equal(receipt.channelId, null);
  }

  const oversizedReceipt = await sendDiscordWebhookWithReceipt(
    { content: "monitor fallback" },
    FALLBACK_URL,
    {
      fetchImpl: async () => new Response(`{"id":"${validMessageId}","channel_id":"${validChannelId}","padding":"${"x".repeat(65 * 1024)}"}`),
    },
  );
  assert.deepEqual(oversizedReceipt, {
    sent: false,
    messageId: null,
    channelId: null,
    statusCode: 200,
    errorCode: "invalid_response",
  });

  const invalidUrlReceipt = await sendDiscordWebhookWithReceipt(
    { content: "monitor fallback" },
    "https://evil.example/api/webhooks/123456789012345678/token",
    { fetchImpl: async () => jsonResponse({ id: validMessageId, channel_id: validChannelId }) },
  );
  assert.deepEqual(invalidUrlReceipt, {
    sent: false,
    messageId: null,
    channelId: null,
    errorCode: "invalid_url",
  });
});

test("retries a failed recovery receipt after a bounded cooldown", async () => {
  let now = NOW;
  let coreHealthy = false;
  let sendAttempts = 0;
  const watchdog = new PublishingWatchdog(config(), {
    now: () => now,
    fetchImpl: async () => coreHealthy
      ? jsonResponse(validResponse({ observedAt: new Date(now).toISOString() }))
      : jsonResponse({ error: "unavailable" }, 503),
    sendDiscord: async () => {
      sendAttempts += 1;
      if (sendAttempts === 2) {
        return {
          sent: false,
          messageId: null,
          channelId: null,
          errorCode: "transport_error",
        };
      }
      return {
        sent: true,
        messageId: "123456789012345678",
        channelId: "234567890123456789",
      };
    },
  });

  await watchdog.runOnce();
  await watchdog.runOnce();
  await watchdog.runOnce();
  assert.equal(sendAttempts, 1);

  coreHealthy = true;
  now += 1_000;
  const firstRecovery = await watchdog.runOnce();
  assert.equal(firstRecovery.kind, "success");
  if (firstRecovery.kind === "success") assert.equal(firstRecovery.recoverySent, false);
  assert.equal(sendAttempts, 2);

  now += 30_000;
  await watchdog.runOnce();
  assert.equal(sendAttempts, 2);

  now += 30_000;
  const secondRecovery = await watchdog.runOnce();
  assert.equal(secondRecovery.kind, "success");
  if (secondRecovery.kind === "success") assert.equal(secondRecovery.recoverySent, true);
  assert.equal(sendAttempts, 3);

  await watchdog.runOnce();
  assert.equal(sendAttempts, 3);
});

test("retries an unconfirmed fallback after 60 seconds and uses the long cooldown after delivery", async () => {
  let now = NOW;
  let sendAttempts = 0;
  const watchdog = new PublishingWatchdog(config(), {
    now: () => now,
    fetchImpl: async () => jsonResponse({ error: "unavailable" }, 503),
    sendDiscord: async () => {
      sendAttempts += 1;
      if (sendAttempts === 1) {
        return {
          sent: false,
          messageId: null,
          channelId: null,
          errorCode: "timeout",
        };
      }
      return {
        sent: true,
        messageId: "123456789012345678",
        channelId: "234567890123456789",
      };
    },
  });

  await watchdog.runOnce();
  await watchdog.runOnce();
  const firstAttempt = await watchdog.runOnce();
  assert.equal(firstAttempt.kind, "failure");
  if (firstAttempt.kind === "failure") assert.equal(firstAttempt.fallbackSent, false);
  assert.equal(sendAttempts, 1);

  now += 59_999;
  await watchdog.runOnce();
  assert.equal(sendAttempts, 1);

  now += 1;
  const secondAttempt = await watchdog.runOnce();
  assert.equal(secondAttempt.kind, "failure");
  if (secondAttempt.kind === "failure") assert.equal(secondAttempt.fallbackSent, true);
  assert.equal(sendAttempts, 2);

  now += 30 * 60_000 - 1;
  await watchdog.runOnce();
  assert.equal(sendAttempts, 2);

  now += 1;
  await watchdog.runOnce();
  assert.equal(sendAttempts, 3);
});

test("stop clears the poller and aborts an in-flight Core request", async () => {
  let signal: AbortSignal | undefined;
  const watchdog = new PublishingWatchdog(config(), {
    fetchImpl: async (_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    },
  });

  watchdog.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  watchdog.stop();
  assert.equal(signal?.aborted, true);
});
