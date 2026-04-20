# Railway Discord Notifier

A small webhook bridge that turns Railway deployment events into clean Discord notifications.

It exists for one very specific gap in Railway's native Discord integration: getting a good deploy alert is easy, but getting useful failure context is not. This service listens for Railway deployment webhooks, fetches build and runtime log tails from Railway's GraphQL API, and posts a compact, readable alert into Discord.

## What You Get

- success notifications for deploys
- failure and crash notifications with log tails
- direct "Open in Railway" links
- environment and service filtering
- per-environment project token support
- Discord rate-limit retry handling

## How It Works

1. Railway sends a webhook to this service.
2. The service normalizes Railway's deployment event vocabulary.
3. It filters out events you do not care about.
4. On failures, it fetches build and runtime log tails from Railway.
5. It posts a Discord webhook message with the deploy status, metadata, and logs.

## Railway Event Mapping

Railway's UI currently exposes deployment webhook events such as:

- `Deployed`
- `Failed`
- `Crashed`
- `Oom Killed`

This service normalizes those into the internal statuses it filters on:

- `SUCCESS`
- `FAILED`
- `CRASHED`

That means your Railway webhook can subscribe to the UI event names above, while `STATUS_ALLOWLIST` can stay simple.

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Configure env vars

Copy `.env.example` and fill in the values you want.

The most important settings are:

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your/webhook
WEBHOOK_SECRET=replace-me
ENVIRONMENT_ALLOWLIST=staging,production
STATUS_ALLOWLIST=SUCCESS,FAILED,CRASHED
SERVICE_DENYLIST=Redis
```

### 3. Choose a Railway token strategy

You have two good options:

- `RAILWAY_API_TOKEN`
  Use a workspace or account token if you want one token that can read multiple environments.
- `RAILWAY_PROJECT_TOKEN_MAP_JSON`
  Use per-environment project tokens if you want tighter scoping. This is the cleanest least-privilege option for `staging` + `production`.

Example:

```env
RAILWAY_PROJECT_TOKEN_MAP_JSON={"staging":"token-for-staging","production":"token-for-production"}
```

You can key this map by environment name or environment ID.

### 4. Run locally

```bash
npm run dev
```

Health check:

```text
GET /health
```

### 5. Deploy to Railway

This repo is designed to deploy from the repo root.

Set your Railway service to deploy this repository, then point your source project's Railway webhook to:

```text
https://your-notifier-domain/webhooks/railway/<WEBHOOK_SECRET>
```

The service also accepts the secret via:

- `Authorization: Bearer <secret>`
- `x-webhook-secret: <secret>`
- `?secret=<secret>`

Using the secret in the path is usually the cleanest Railway setup because Railway lets you configure a URL directly.

## Recommended Railway Webhook Setup

In the source Railway project, subscribe to these deployment events:

- `Deployed`
- `Failed`
- `Crashed`
- `Oom Killed`

That gives you the clean "success or something went wrong" behavior without queue/build chatter.

## Scripts

```bash
npm run lint
npm run test
npm run build
npm run start
```

## Configuration

### Required

- `DISCORD_WEBHOOK_URL`

### Webhook receiver

- `PORT`
  Defaults to `3000`.
- `WEBHOOK_PATH`
  Defaults to `/webhooks/railway`.
- `WEBHOOK_SECRET`
  Optional but strongly recommended.

### Railway auth

- `RAILWAY_API_TOKEN`
  Workspace or account token. Uses `Authorization: Bearer`.
- `RAILWAY_PROJECT_TOKEN`
  Single project token. Uses `Project-Access-Token`.
- `RAILWAY_PROJECT_TOKEN_MAP_JSON`
  JSON object keyed by environment name or environment ID. Uses `Project-Access-Token`.
- `RAILWAY_API_ENDPOINT`
  Defaults to `https://backboard.railway.com/graphql/v2`.

### Filtering

- `ENVIRONMENT_ALLOWLIST`
  Comma-separated list of environment names to notify for.
- `SERVICE_ALLOWLIST`
  Comma-separated list of services to include.
- `SERVICE_DENYLIST`
  Comma-separated list of services to exclude.
- `STATUS_ALLOWLIST`
  Comma-separated list of normalized statuses. Defaults to `SUCCESS,FAILED,CRASHED`.
- `IGNORE_EPHEMERAL_ENVIRONMENTS`
  Defaults to `true`.

### Discord formatting

- `FAILURE_MENTION`
  Optional mention payload like `@here` or `<@&ROLE_ID>`. Only sent for `FAILED` and `CRASHED`.

### Log fetch tuning

- `LOG_TAIL_LINE_LIMIT`
  Defaults to `40`.
- `LOG_TAIL_CHAR_LIMIT`
  Defaults to `2800`.
- `RAILWAY_LOG_FETCH_LIMIT`
  Defaults to `120`.
- `LOG_FETCH_MAX_ATTEMPTS`
  Defaults to `3`.
- `LOG_FETCH_RETRY_MS`
  Defaults to `1500`.
- `REQUEST_TIMEOUT_MS`
  Defaults to `5000`.
- `EVENT_CACHE_TTL_MS`
  In-memory duplicate suppression window. Defaults to `86400000`.

## Notes

- Railway's native Discord muxer is fine for basic status pings, but this project exists because it can also fetch and include useful log tails.
- Discord webhook sends automatically retry on `429` and transient `5xx` responses using Discord's returned rate-limit delay when available.
- Railway's "Test Webhook" button is initiated from the browser and can fail for CORS reasons. A real deploy or replayed payload is a better end-to-end verification path.
- Duplicate suppression is in-memory right now. That keeps the service tiny and portable, but it is not cross-instance durable.

## Documentation References

- [Railway Webhooks](https://docs.railway.com/observability/webhooks)
- [Railway Manage Deployments API](https://docs.railway.com/integrations/api/manage-deployments)
- [Railway GraphQL Overview](https://docs.railway.com/integrations/api/graphql-overview)
- [Discord Rate Limits](https://discord.com/developers/docs/topics/rate-limits)
