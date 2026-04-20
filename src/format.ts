import type { AppConfig } from "./config.js";
import type { DiscordEmbed, DiscordWebhookPayload } from "./discord.js";
import type { RailwayDeploymentEvent, RailwayEventLogs, RailwayLogEntry } from "./types.js";

const colorForStatus = (status: RailwayDeploymentEvent["status"]): number => {
  switch (status) {
    case "SUCCESS":
      return 0x16a34a;
    case "FAILED":
      return 0xdc2626;
    case "CRASHED":
      return 0xb91c1c;
    default:
      return 0x2563eb;
  }
};

const emojiForStatus = (status: RailwayDeploymentEvent["status"]): string => {
  switch (status) {
    case "SUCCESS":
      return "✅";
    case "FAILED":
      return "❌";
    case "CRASHED":
      return "💥";
    default:
      return "🚆";
  }
};

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;

const inline = (value: string | null, fallback = "n/a"): string => value ?? fallback;

const shortHash = (value: string | null): string | null => (value ? value.slice(0, 7) : null);

const buildDashboardUrl = (event: RailwayDeploymentEvent): string | null => {
  if (!event.project.id || !event.environment.id) return null;
  return `https://railway.com/project/${encodeURIComponent(event.project.id)}?environmentId=${encodeURIComponent(
    event.environment.id
  )}`;
};

const flattenLogLines = (entries: RailwayLogEntry[]): string[] =>
  entries.flatMap((entry) => {
    const rawLines = entry.message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return rawLines.map((line) => {
      const time = entry.timestamp ? new Date(entry.timestamp).toISOString().slice(11, 19) : "--:--:--";
      const severity = entry.severity?.trim().toUpperCase() ?? null;
      const prefix = severity ? `[${time} ${severity}] ` : `[${time}] `;
      return truncate(`${prefix}${line}`, 220);
    });
  });

const sanitizeCodeBlock = (value: string): string => value.replaceAll("```", "`\u200b``");

const formatLogSection = (
  title: string,
  entries: RailwayLogEntry[],
  lineLimit: number
): string | null => {
  const lines = flattenLogLines(entries);
  if (lines.length === 0) return null;

  const tail = lines.slice(-lineLimit).join("\n");
  return `**${title}**\n\`\`\`text\n${sanitizeCodeBlock(tail)}\n\`\`\``;
};

const joinSectionsWithinLimit = (sections: string[], limit: number): string => {
  let output = "";

  for (const section of sections) {
    if (!section) continue;

    const nextValue = output.length === 0 ? section : `${output}\n\n${section}`;
    if (nextValue.length <= limit) {
      output = nextValue;
      continue;
    }

    const remaining = limit - output.length - (output.length === 0 ? 0 : 2);
    if (remaining <= 0) break;

    output = output.length === 0
      ? truncate(section, remaining)
      : `${output}\n\n${truncate(section, remaining)}`;
    break;
  }

  return output;
};

export const buildDiscordPayload = (
  event: RailwayDeploymentEvent,
  logs: RailwayEventLogs,
  config: AppConfig
): DiscordWebhookPayload => {
  const dashboardUrl = buildDashboardUrl(event);
  const color = colorForStatus(event.status);
  const emoji = emojiForStatus(event.status);
  const environmentName = inline(event.environment.name, "unknown");
  const serviceName = inline(event.service.name, "unknown");
  const projectName = inline(event.project.name, "unknown");

  const summarySections = [
    dashboardUrl ? `[Open in Railway](${dashboardUrl})` : null,
    event.details.commitMessage ? truncate(event.details.commitMessage, 300) : null,
  ].filter((section): section is string => Boolean(section));

  const logSections = [
    formatLogSection("Build log tail", logs.buildLogs, config.logTailLineLimit),
    formatLogSection("Runtime log tail", logs.runtimeLogs, config.logTailLineLimit),
    logs.errors.length > 0 ? `**Log fetch notes**\n${logs.errors.map((error) => `- ${truncate(error, 300)}`).join("\n")}` : null,
  ].filter((section): section is string => Boolean(section));

  const description = joinSectionsWithinLimit(
    [...summarySections, ...logSections],
    config.logTailCharLimit
  );

  const embed: DiscordEmbed = {
    title: `${emoji} [${environmentName}] ${serviceName} ${event.status.toLowerCase()}`,
    ...(dashboardUrl ? { url: dashboardUrl } : {}),
    ...(description ? { description } : {}),
    color,
    fields: [
      {
        name: "Project",
        value: truncate(projectName, 100),
        inline: true,
      },
      {
        name: "Environment",
        value: truncate(environmentName, 100),
        inline: true,
      },
      {
        name: "Service",
        value: truncate(serviceName, 100),
        inline: true,
      },
      {
        name: "Branch",
        value: truncate(inline(event.details.branch), 100),
        inline: true,
      },
      {
        name: "Commit",
        value: truncate(inline(shortHash(event.details.commitHash)), 100),
        inline: true,
      },
      {
        name: "Author",
        value: truncate(inline(event.details.commitAuthor), 100),
        inline: true,
      },
      {
        name: "Deployment",
        value: truncate(event.deployment.id, 100),
        inline: false,
      },
    ],
    footer: {
      text: `Railway event: ${event.eventType}`,
    },
    timestamp: event.timestamp,
  };

  const failureMention =
    (event.status === "FAILED" || event.status === "CRASHED") && config.failureMention
      ? config.failureMention
      : null;

  return {
    ...(failureMention ? { content: failureMention } : {}),
    embeds: [embed],
  };
};
