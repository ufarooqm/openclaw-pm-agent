# Deployment

This repo is designed for Railway with a persistent volume.

## Prerequisites

- Railway project and service
- Railway persistent volume mounted at `/data`
- Supabase project with pooled Postgres access
- Slack app configured for Socket Mode
- OpenRouter API key

## Required Environment Variables

| Variable | Required | Notes |
|---|---|---|
| `SETUP_PASSWORD` | yes | Protects the setup and connector UI |
| `SETUP_USERNAME` | optional | Defaults to `admin` for the sign-in page |
| `OPENROUTER_API_KEY` | yes | Primary model provider |
| `SUPABASE_POOLER_URL` | yes | Postgres pooler URL for chat sync |
| `OPENCLAW_STATE_DIR` | yes | Set to `/data/.openclaw` |
| `OPENCLAW_WORKSPACE_DIR` | yes | Set to `/data/workspace` |
| `OPENCLAW_PUBLIC_PORT` | yes | Usually `8080` |
| `PORT` | yes | Usually `8080` |

## Recommended Environment Variables

| Variable | Recommended | Why |
|---|---|---|
| `OPENAI_API_KEY` | yes | Improves chat-history recall via embeddings |
| `BROWSERLESS_API_TOKEN` | yes | Better browser automation reliability |
| `OPENCLAW_MODEL_PRIMARY` | optional | Defaults to `openrouter/anthropic/claude-sonnet-4.6` |
| `OPENCLAW_MODEL_FALLBACKS` | optional | Defaults to `openrouter/google/gemini-2.5-flash` |

## Railway Notes

- Use a persistent volume. Without it, workspace files, connectors, and OpenClaw state will not survive redeploys.
- Keep the volume mounted at `/data`.
- The service expects:
  - state dir: `/data/.openclaw`
  - workspace dir: `/data/workspace`

## First Deploy

1. Create the Railway service from this repo.
2. Attach a persistent volume mounted at `/data`.
3. Set the environment variables listed above.
4. Deploy.
5. Confirm `/setup/healthz` returns `200`.
6. Open `/setup` and complete onboarding.
7. Open `/connectors` and save connector credentials.

## Post-Deploy Validation

Check these after the first successful deploy:

- `/setup/api/status` shows:
  - `configured: true`
  - `gatewayRunning: true`
  - `stateDir: /data/.openclaw`
  - `workspaceDir: /data/workspace`
- Slack can receive a DM
- Slack can send a DM reply
- `/chat` can answer a recall question using prior conversations

## Supabase Notes

- The app auto-creates the required schema and the `vector` extension if available.
- Chat sync reads OpenClaw JSONL transcripts and mirrors them into Postgres.
- Search works best with `OPENAI_API_KEY`, but still has full-text fallback behavior.

## Common Mistakes

- Missing persistent volume
- Leaving workspace path at the OpenClaw default instead of `/data/workspace`
- Forgetting Slack app reinstall after scope changes
- Missing `OPENAI_API_KEY` and expecting strong semantic recall
- Treating this as multi-tenant infrastructure without additional hardening
