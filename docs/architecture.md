# Architecture

## High-Level Design

This repo is an Express wrapper around a pinned OpenClaw build.

Main layers:

1. Express service in `src/server.js`
2. Pinned OpenClaw runtime built in the Docker image
3. Workspace defaults under `workspace/`
4. Persistent state under `/data/.openclaw`
5. Persistent workspace under `/data/workspace`
6. Supabase-backed chat sync for recall

## OpenClaw Layer

The Docker build pins OpenClaw to a specific git revision and copies this repo's workspace defaults into `/app/workspace-defaults`.

On startup, the wrapper seeds those defaults into the live workspace and enforces runtime config.

## Workspace Layer

The live workspace contains:

- `AGENTS.md`
- `TOOLS.md`
- `BOOTSTRAP.md`
- `IDENTITY.md`
- `USER.md`
- skills under `workspace/skills/`

These files define:

- PM-specific behavior
- startup persona
- status/research workflows
- chat-history recall rules

## Connector Layer

Connectors are configured through the UI and persisted in the state volume.

Current flow:

1. user saves connector values in `/connectors`
2. values are written to `connectors.json`
3. values are loaded into the runtime environment
4. the gateway restarts to apply changes

Slack has an extra sync step that writes `channels.slack` and enables the bundled Slack plugin.

## Chat Recall Layer

OpenClaw transcripts are mirrored into Supabase.

Current flow:

1. OpenClaw writes transcript JSONL files
2. background sync reads those files
3. sessions and messages are written into Supabase
4. embeddings are added when `OPENAI_API_KEY` is present
5. `/api/chat/search` exposes fast recall for the agent

Search order is effectively:

- vector similarity when embeddings exist
- full-text search
- `ILIKE` fallback

## Deployment Assumptions

The service assumes:

- Railway hosting
- one persistent volume at `/data`
- one main trusted workspace

This is why current docs describe it as operator-managed and single-tenant oriented.
