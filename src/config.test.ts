import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "./config.js";

const baseEnv = (): NodeJS.ProcessEnv => ({
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/deployments",
});

test("watchdog is disabled when its endpoint pair is absent", () => {
  const config = loadConfig(baseEnv());

  assert.equal(config.watchdogCoreUrl, null);
  assert.equal(config.watchdogSecret, null);
  assert.equal(config.watchdogPollIntervalMs, 60_000);
  assert.equal(config.watchdogFailureThreshold, 3);
});

test("watchdog endpoint and bearer secret must be configured together", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv(), WATCHDOG_CORE_URL: "https://core.example.test/api/internal/ops/publishing-watchdog" }),
    /configured together/,
  );
  assert.throws(
    () => loadConfig({ ...baseEnv(), WATCHDOG_SECRET: "a".repeat(32) }),
    /configured together/,
  );
});

test("watchdog URL and secret validation reject query credentials and short secrets", () => {
  assert.throws(
    () => loadConfig({
      ...baseEnv(),
      WATCHDOG_CORE_URL: "https://core.example.test/api/internal/ops/publishing-watchdog?secret=leak",
      WATCHDOG_SECRET: "a".repeat(32),
    }),
    /without credentials or query parameters/,
  );
  assert.throws(
    () => loadConfig({
      ...baseEnv(),
      WATCHDOG_CORE_URL: "https://core.example.test/api/internal/ops/publishing-watchdog",
      WATCHDOG_SECRET: "too-short",
    }),
    /32-256/,
  );
});

test("watchdog settings are bounded and normalize endpoint paths", () => {
  const config = loadConfig({
    ...baseEnv(),
    WATCHDOG_CORE_URL: "https://core.example.test/api/internal/ops/publishing-watchdog///",
    WATCHDOG_SECRET: "a".repeat(32),
    WATCHDOG_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/operations///",
    WATCHDOG_POLL_INTERVAL_MS: "10",
    WATCHDOG_CORE_TIMEOUT_MS: "999999",
    WATCHDOG_FAILURE_THRESHOLD: "0",
    WATCHDOG_FALLBACK_COOLDOWN_MS: "999999999",
  });

  assert.equal(config.watchdogCoreUrl, "https://core.example.test/api/internal/ops/publishing-watchdog");
  assert.equal(config.watchdogFallbackDiscordWebhookUrl, "https://discord.com/api/webhooks/operations");
  assert.equal(config.watchdogPollIntervalMs, 1_000);
  assert.equal(config.watchdogCoreTimeoutMs, 15_000);
  assert.equal(config.watchdogFailureThreshold, 3);
  assert.equal(config.watchdogFallbackCooldownMs, 30 * 60_000);
});
