# `openclaw-pm-agent`

PM-focused OpenClaw wrapper for Slack, Confluence, GitHub, and persisted chat recall.

## What This Repo Is

This service wraps a pinned OpenClaw build with:

- a lightweight Express control layer
- Railway-friendly startup and restart behavior
- Slack connector sync and DM defaults
- persisted chat sync into Supabase
- PM-oriented workspace prompts and skills

## Who This Is For

This repo is for a technical operator deploying a single PM assistant for a trusted user or team.

It is not packaged yet as a general self-serve or multi-tenant product.

## Current Status

Ready for:

- operator-managed Railway deployment
- Slack DMs and web chat
- Confluence and GitHub connector setup through the UI
- persisted session recall backed by Supabase

Not ready for:

- untrusted end users
- multi-tenant isolation
- strong secret compartmentalization
- one-click setup with automatic connector validation

## Requirements

Minimum production setup:

- Railway service with a persistent volume mounted at `/data`
- Supabase Postgres pooler URL
- OpenRouter API key
- Slack app configured for Socket Mode and DM scopes

Recommended:

- OpenAI API key for hybrid chat-history recall embeddings
- Browserless token for more reliable browser automation
- Optional `SETUP_USERNAME` if you do not want the default operator login name `admin`

## Quickstart

1. Deploy the repo to Railway with a persistent volume.
2. Set the required environment variables from `docs/deployment.md`.
3. Configure the Slack app exactly as documented in `docs/slack-setup.md`.
4. Open `/setup` and complete onboarding.
5. Open `/connectors` and save Slack, Confluence, and GitHub credentials as needed.
6. Test Slack DM in, Slack DM out, and PRD/status recall.

## Documentation

- `docs/deployment.md` — Railway and environment setup
- `docs/slack-setup.md` — exact Slack app configuration
- `docs/connectors.md` — connector behavior and persistence
- `docs/troubleshooting.md` — common failure modes
- `docs/security.md` — current secret model and limitations
- `docs/architecture.md` — runtime architecture and data flow
- `docs/distribution-readiness.md` — what is and is not ready for sharing

## Known Limitations

- The current secret model is operator-oriented, not tenant-isolated.
- User-entered connector credentials persist in app-managed storage and are loaded into the runtime environment.
- Slack setup is exacting; missing a single scope or event subscription can break DM behavior.
- OpenClaw status output may still show `Channel: dev (default)` even when Slack is connected.

## Local Notes

- Node version: `>=22`
- Main app entry: `src/server.js`
- Railway health check: `/setup/healthz`
- Workspace defaults are copied from `workspace/` into the runtime workspace on startup

## Local Run

```bash
npm install
npm run dev
```

This is mainly a Railway-targeted service. Local development is useful for prompt and wrapper work, but production behavior depends on persistent state, Slack credentials, and Supabase.
