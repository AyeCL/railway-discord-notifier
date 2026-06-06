import type { DiscordWebhookPayload } from "./discord.js";
import type { RailwayDeploymentEvent } from "./types.js";

const MAX_DISCORD_CONTENT_LENGTH = 2000;
const ERROR_MENTION = "@here";

const emojiForStatus = (status: RailwayDeploymentEvent["status"]): string => {
  switch (status) {
    case "SUCCESS":
      return "✅";
    case "FAILED":
    case "CRASHED":
      return "🚨";
    default:
      return "🚆";
  }
};

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;

const inline = (value: string | null, fallback = "n/a"): string => value ?? fallback;

const code = (value: string | null, fallback = "unknown"): string =>
  `\`${truncate(inline(value, fallback).replaceAll("`", "'"), 80)}\``;

const buildDashboardUrl = (event: RailwayDeploymentEvent): string | null => {
  if (!event.project.id || !event.environment.id) return null;
  return `https://railway.com/project/${encodeURIComponent(event.project.id)}?environmentId=${encodeURIComponent(
    event.environment.id
  )}`;
};

const statusLine = (event: RailwayDeploymentEvent): string => {
  const emoji = emojiForStatus(event.status);
  const environment = code(event.environment.name);
  const service = code(event.service.name);

  switch (event.status) {
    case "SUCCESS":
      return `${emoji} deploy succeeded for ${service} in ${environment}`;
    case "FAILED":
    case "CRASHED":
      return `${emoji} error in ${service} in ${environment}`;
    case "BUILDING":
      return `${emoji} building ${service} in ${environment}`;
    case "DEPLOYING":
      return `${emoji} deploying ${service} to ${environment}`;
    case "REMOVED":
      return `${emoji} removed ${service} from ${environment}`;
    case "SLEEPING":
      return `${emoji} sleeping ${service} in ${environment}`;
    case "SKIPPED":
      return `${emoji} skipped ${service} in ${environment}`;
    case "WAITING":
      return `${emoji} waiting on ${service} in ${environment}`;
    case "QUEUED":
      return `${emoji} queued ${service} in ${environment}`;
  }
};

export const buildDiscordPayload = (
  event: RailwayDeploymentEvent
): DiscordWebhookPayload => {
  const dashboardUrl = buildDashboardUrl(event);
  const isError = event.status === "FAILED" || event.status === "CRASHED";

  const content = [
    statusLine(event),
    dashboardUrl ? `[Railway](${dashboardUrl})` : null,
    isError ? ERROR_MENTION : null,
  ].filter((section): section is string => Boolean(section)).join(" · ");

  return {
    content: truncate(content, MAX_DISCORD_CONTENT_LENGTH),
    allowed_mentions: {
      parse: isError ? ["everyone"] : [],
    },
  };
};
