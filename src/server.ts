import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { loadConfig, type AppConfig } from "./config.js";
import { sendDiscordWebhook } from "./discord.js";
import { EventCache } from "./eventCache.js";
import { buildDiscordPayload } from "./format.js";
import { extractDeploymentEvent } from "./payload.js";
import { fetchBuildLogs, fetchRuntimeLogs } from "./railway.js";
import type { RailwayDeploymentEvent, RailwayEventLogs } from "./types.js";

const config = loadConfig();
const eventCache = new EventCache(config.eventCacheTtlMs);

if (!config.railwayApiToken && !config.railwayProjectToken && config.railwayProjectTokenMap.size === 0) {
  console.warn(
    `[${new Date().toISOString()}] WARN No Railway token configured. Notifications can still send, but log tails will be unavailable.`
  );
}

const log = (level: "INFO" | "WARN" | "ERROR", message: string, details?: Record<string, unknown>) => {
  const prefix = `[${new Date().toISOString()}] ${level}`;
  if (!details || Object.keys(details).length === 0) {
    console.log(`${prefix} ${message}`);
    return;
  }

  console.log(`${prefix} ${message} ${JSON.stringify(details)}`);
};

const normalizePath = (value: string): string =>
  value.length > 1 ? value.replace(/\/+$/, "") : value;

const isAuthorized = (request: IncomingMessage, url: URL, appConfig: AppConfig): boolean => {
  if (!appConfig.webhookSecret) {
    return true;
  }

  const pathname = normalizePath(url.pathname);
  if (pathname === `${appConfig.webhookPath}/${appConfig.webhookSecret}`) {
    return true;
  }

  const querySecret = url.searchParams.get("secret");
  if (querySecret === appConfig.webhookSecret) {
    return true;
  }

  const headerSecret = request.headers["x-webhook-secret"];
  if (typeof headerSecret === "string" && headerSecret.trim() === appConfig.webhookSecret) {
    return true;
  }

  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    const bearer = authorization.slice("Bearer ".length).trim();
    if (bearer === appConfig.webhookSecret) {
      return true;
    }
  }

  return false;
};

const matchesWebhookPath = (url: URL, appConfig: AppConfig): boolean => {
  const pathname = normalizePath(url.pathname);
  return pathname === appConfig.webhookPath || pathname === `${appConfig.webhookPath}/${appConfig.webhookSecret}`;
};

const readJsonBody = async (request: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new Error(`Request body exceeded ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    throw new Error("Request body was empty");
  }

  return JSON.parse(raw);
};

const shouldNotify = (event: RailwayDeploymentEvent, appConfig: AppConfig): boolean => {
  if (appConfig.ignoreEphemeralEnvironments && event.environment.isEphemeral) {
    return false;
  }

  if (!appConfig.statusAllowlist.has(event.status)) {
    return false;
  }

  const environmentName = event.environment.name?.trim().toLowerCase() ?? null;
  if (appConfig.environmentAllowlist.size > 0 && (!environmentName || !appConfig.environmentAllowlist.has(environmentName))) {
    return false;
  }

  const serviceName = event.service.name?.trim().toLowerCase() ?? null;
  if (appConfig.serviceAllowlist.size > 0 && (!serviceName || !appConfig.serviceAllowlist.has(serviceName))) {
    return false;
  }

  if (serviceName && appConfig.serviceDenylist.has(serviceName)) {
    return false;
  }

  return true;
};

const collectLogs = async (
  event: RailwayDeploymentEvent,
  appConfig: AppConfig
): Promise<RailwayEventLogs> => {
  const result: RailwayEventLogs = {
    buildLogs: [],
    runtimeLogs: [],
    errors: [],
  };

  if (event.status !== "FAILED" && event.status !== "CRASHED") {
    return result;
  }

  const tasks: Array<Promise<void>> = [];

  if (event.status === "FAILED") {
    tasks.push(
      fetchBuildLogs(event, appConfig)
        .then((logs) => {
          result.buildLogs = logs;
        })
        .catch((error) => {
          result.errors.push(error instanceof Error ? error.message : String(error));
        })
    );
  }

  tasks.push(
    fetchRuntimeLogs(event, appConfig)
      .then((logs) => {
        result.runtimeLogs = logs;
      })
      .catch((error) => {
        result.errors.push(error instanceof Error ? error.message : String(error));
      })
  );

  await Promise.all(tasks);
  return result;
};

const processWebhook = async (payload: unknown, appConfig: AppConfig): Promise<void> => {
  const event = extractDeploymentEvent(payload);
  if (!event) {
    log("INFO", "Ignoring non-deployment webhook event.");
    return;
  }

  if (!shouldNotify(event, appConfig)) {
    log("INFO", "Ignoring filtered deployment event.", {
      status: event.status,
      environment: event.environment.name,
      service: event.service.name,
    });
    return;
  }

  const dedupeKey = `${event.deployment.id}:${event.status}`;
  if (!eventCache.begin(dedupeKey)) {
    log("INFO", "Suppressing duplicate deployment event.", {
      dedupeKey,
    });
    return;
  }

  try {
    const logs = await collectLogs(event, appConfig);
    const discordPayload = buildDiscordPayload(event, logs, appConfig);
    await sendDiscordWebhook(discordPayload, appConfig);

    log("INFO", "Sent Discord notification.", {
      deploymentId: event.deployment.id,
      status: event.status,
      environment: event.environment.name,
      service: event.service.name,
    });
  } catch (error) {
    eventCache.markFailed(dedupeKey);
    throw error;
  }
};

const sendJson = (response: ServerResponse, statusCode: number, body: Record<string, unknown>) => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method !== "POST" || !matchesWebhookPath(url, config)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  if (!isAuthorized(request, url, config)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }

  let payload: unknown;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request body";
    sendJson(response, 400, { error: message });
    return;
  }

  sendJson(response, 202, { accepted: true });

  processWebhook(payload, config).catch((error) => {
    log("ERROR", "Failed to process Railway webhook.", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

server.listen(config.port, () => {
  log("INFO", "Railway Discord notifier listening.", {
    port: config.port,
    webhookPath: config.webhookPath,
  });
});
