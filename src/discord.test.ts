import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";
import { sendDiscordWebhook } from "./discord.js";

test("sendDiscordWebhook retries on discord 429 responses and succeeds", async () => {
  const originalFetch = globalThis.fetch;

  const calls: number[] = [];
  globalThis.fetch = (async () => {
    calls.push(Date.now());

    if (calls.length === 1) {
      return new Response(JSON.stringify({ message: "rate limited", retry_after: 0 }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const config = loadConfig({
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test/test",
      REQUEST_TIMEOUT_MS: "1000",
    });

    await sendDiscordWebhook(
      {
        content: "hello",
      },
      config
    );

    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
