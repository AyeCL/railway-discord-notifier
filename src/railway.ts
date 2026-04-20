import { setTimeout as sleep } from "node:timers/promises";

import type { AppConfig } from "./config.js";
import type { RailwayDeploymentEvent, RailwayLogEntry } from "./types.js";

type GraphQLSuccess<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

type GraphQLLogResult = {
  buildLogs?: Array<{
    timestamp?: string;
    message?: string;
    severity?: string;
  }>;
  deploymentLogs?: Array<{
    timestamp?: string;
    message?: string;
    severity?: string;
  }>;
};

const BUILD_LOGS_QUERY = `
  query buildLogs($deploymentId: String!, $limit: Int) {
    buildLogs(deploymentId: $deploymentId, limit: $limit) {
      timestamp
      message
      severity
    }
  }
`;

const RUNTIME_LOGS_QUERY = `
  query deploymentLogs($deploymentId: String!, $limit: Int) {
    deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
      timestamp
      message
      severity
    }
  }
`;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const normalizeLogEntries = (
  entries: Array<{ timestamp?: string; message?: string; severity?: string }> | undefined
): RailwayLogEntry[] =>
  (entries ?? [])
    .filter((entry) => isNonEmptyString(entry.message))
    .map((entry) => ({
      timestamp: isNonEmptyString(entry.timestamp) ? entry.timestamp : null,
      message: entry.message!.trimEnd(),
      severity: isNonEmptyString(entry.severity) ? entry.severity : null,
    }))
    .sort((a, b) => {
      const aTime = a.timestamp ? Date.parse(a.timestamp) : 0;
      const bTime = b.timestamp ? Date.parse(b.timestamp) : 0;
      return aTime - bTime;
    });

const resolveProjectAccessToken = (
  event: RailwayDeploymentEvent,
  config: AppConfig
): { headerName: string; headerValue: string } => {
  if (config.railwayApiToken) {
    return {
      headerName: "Authorization",
      headerValue: `Bearer ${config.railwayApiToken}`,
    };
  }

  const keys = [event.environment.id, event.environment.name]
    .map((value) => value?.trim().toLowerCase() ?? null)
    .filter((value): value is string => value !== null);

  for (const key of keys) {
    const mappedToken = config.railwayProjectTokenMap.get(key);
    if (mappedToken) {
      return {
        headerName: "Project-Access-Token",
        headerValue: mappedToken,
      };
    }
  }

  if (config.railwayProjectToken) {
    return {
      headerName: "Project-Access-Token",
      headerValue: config.railwayProjectToken,
    };
  }

  throw new Error(
    "No Railway API token configured. Set RAILWAY_API_TOKEN, RAILWAY_PROJECT_TOKEN, or RAILWAY_PROJECT_TOKEN_MAP_JSON."
  );
};

async function requestRailwayGraphQL<TData>(
  query: string,
  variables: Record<string, unknown>,
  event: RailwayDeploymentEvent,
  config: AppConfig
): Promise<TData> {
  const auth = resolveProjectAccessToken(event, config);
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(config.railwayApiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [auth.headerName]: auth.headerValue,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    const payload = (await response.json()) as GraphQLSuccess<TData>;
    if (!response.ok) {
      const errorMessage =
        payload.errors?.map((error) => error.message).filter(Boolean).join("; ") ||
        `Railway API returned HTTP ${response.status}`;
      throw new Error(errorMessage);
    }

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(
        payload.errors.map((error) => error.message ?? "Unknown GraphQL error").join("; ")
      );
    }

    if (!payload.data) {
      throw new Error("Railway API response did not include data.");
    }

    return payload.data;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function withRetries<T>(
  label: string,
  config: AppConfig,
  task: () => Promise<T>
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.logFetchMaxAttempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt >= config.logFetchMaxAttempts) {
        break;
      }
      await sleep(config.logFetchRetryMs);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} failed after ${config.logFetchMaxAttempts} attempts: ${message}`);
}

export const fetchBuildLogs = async (
  event: RailwayDeploymentEvent,
  config: AppConfig
): Promise<RailwayLogEntry[]> =>
  withRetries("build log fetch", config, async () => {
    const data = await requestRailwayGraphQL<GraphQLLogResult>(
      BUILD_LOGS_QUERY,
      {
        deploymentId: event.deployment.id,
        limit: config.railwayLogFetchLimit,
      },
      event,
      config
    );

    return normalizeLogEntries(data.buildLogs);
  });

export const fetchRuntimeLogs = async (
  event: RailwayDeploymentEvent,
  config: AppConfig
): Promise<RailwayLogEntry[]> =>
  withRetries("runtime log fetch", config, async () => {
    const data = await requestRailwayGraphQL<GraphQLLogResult>(
      RUNTIME_LOGS_QUERY,
      {
        deploymentId: event.deployment.id,
        limit: config.railwayLogFetchLimit,
      },
      event,
      config
    );

    return normalizeLogEntries(data.deploymentLogs);
  });
