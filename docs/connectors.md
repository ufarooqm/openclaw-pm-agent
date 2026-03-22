# Connectors

The PM agent currently supports:

- Slack
- Confluence
- GitHub

## Where Connectors Are Configured

Connectors are entered in the UI at `/connectors`.

The backend currently persists connector values in app-managed state and reloads them on startup.

## Current Persistence Model

Today, connector credentials are:

1. entered in the UI
2. written to `connectors.json` under the state directory
3. loaded back into `process.env` on startup
4. used by the wrapper and runtime tools

With the recommended Railway configuration:

- state dir: `/data/.openclaw`
- connectors file: `/data/.openclaw/connectors.json`

This means connector values persist across deploys as long as the Railway volume remains attached.

## What Happens When You Click Save

On save, the service:

1. validates connector field names
2. stores the provided values
3. updates the in-process environment
4. syncs Slack channel config if the Slack connector was changed
5. restarts the gateway so the new config takes effect

## Connector Notes

### Slack

- Requires both bot token and app token
- The wrapper syncs Slack config into OpenClaw config automatically
- DM behavior depends on the Slack app scopes and event subscriptions, not just the saved tokens

### Confluence

- Requires:
  - base URL
  - Atlassian account email
  - API token
- Best for searching PRDs, project notes, and wiki pages

### GitHub

- Requires a Personal Access Token
- Scope the token as narrowly as your workflow allows

## What Persists Across Deploys

Persists if the volume is intact:

- connector values
- workspace files
- OpenClaw state
- transcripts used for chat sync

Does not persist if the volume is wiped or replaced:

- connectors
- workspace customizations
- local OpenClaw state not mirrored elsewhere

## Current Limitation

This connector design is acceptable for a trusted operator deployment.

It is not the right long-term design for untrusted multi-user distribution, because credentials become app-owned runtime secrets rather than isolated per-user secrets.
