# Troubleshooting

## Agent says it has no memory or acts like a fresh install

Check:

- the workspace path in `/setup/api/config`
- that the default agent workspace is `/data/workspace`
- that `AGENTS.md`, `IDENTITY.md`, and `USER.md` in the live workspace are the PM versions, not the generic templates

Expected current behavior:

- fresh sessions should start as `PM Agent`
- `USER.md` should reflect the saved setup name when one has been configured
- recall questions should search persisted chat history before saying memory is empty

## Slack DM does not appear in `/chat`

Usually one of:

- missing `im:read`
- missing `im:history`
- missing `message.im`
- app was not reinstalled after scope changes
- Slack connector token values were not saved correctly

## Slack DM appears in `/chat` but no reply is sent back

Usually:

- missing `im:write`

For group DMs, also check:

- `mpim:read`
- `mpim:history`
- `mpim:write`
- `message.mpim`

## Slack shows connected but OpenClaw status still says `Channel: dev (default)`

This is a cosmetic OpenClaw status quirk.

Use the runtime logs and actual Slack behavior as the source of truth.

## Confluence or GitHub says not connected even after saving credentials

Check:

- `/connectors` shows the connector as configured
- the connector values were saved on the current volume
- the gateway was restarted after the save

If the connector is present but the model still claims it is unavailable, the issue is usually prompt routing or the specific session state, not missing credentials.

## Chat recall is weak

Check:

- `SUPABASE_POOLER_URL` is set
- chat sync is running
- transcripts are being mirrored into Supabase
- `OPENAI_API_KEY` is set for embedding-backed recall

Without `OPENAI_API_KEY`, recall still works via full-text fallback, but quality is lower.

## Connectors disappear after deploy

Usually:

- the Railway volume is missing
- the volume mount changed
- the state directory moved

Expected production paths:

- state: `/data/.openclaw`
- workspace: `/data/workspace`

## Slack app looks correct but DMs still fail

Re-check all of:

- scopes
- event subscriptions
- App Home Messages Tab
- reinstall to workspace

Slack failures often come from one missing permission rather than a code defect.
