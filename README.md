# Railway Discord Notifier

A small webhook bridge that turns Railway deployment events into one-line Discord notifications.

It listens for Railway deployment webhooks, filters the events you care about, and posts a compact status line into Discord.

## What You Get

- success notifications for deploys
- failure and crash notifications
- direct Railway links
- environment and service filtering
- Discord rate-limit retry handling

## How It Works

1. Railway sends a webhook to this service.
2. The service normalizes Railway's deployment event vocabulary.
3. It filters out events you do not care about.
4. It posts a one-line Discord webhook message with the deploy status, service, environment, and Railway link.

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

### 3. Run locally

```bash
npm run dev
```

Health check:

```text
GET /health
```

### 4. Deploy to Railway

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

### Runtime tuning

- `REQUEST_TIMEOUT_MS`
  Discord request timeout. Defaults to `5000`.
- `EVENT_CACHE_TTL_MS`
  In-memory duplicate suppression window. Defaults to `86400000`.

## Notes

- Discord messages are intentionally content-only, without embeds or log tails.
- Failed and crashed deployments append `@here`; other statuses do not mention anyone.
- Discord webhook sends automatically retry on `429` and transient `5xx` responses using Discord's returned rate-limit delay when available.
- Railway's "Test Webhook" button is initiated from the browser and can fail for CORS reasons. A real deploy or replayed payload is a better end-to-end verification path.
- Duplicate suppression is in-memory right now. That keeps the service tiny and portable, but it is not cross-instance durable.

## Documentation References

- [Railway Webhooks](https://docs.railway.com/observability/webhooks)
- [Discord Rate Limits](https://discord.com/developers/docs/topics/rate-limits)
