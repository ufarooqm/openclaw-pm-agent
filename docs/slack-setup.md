# Slack Setup

Slack must be configured exactly for reliable DM behavior.

## App Features

Enable:

- Socket Mode
- App Home
- App Home Messages Tab
- Event Subscriptions

## Bot Token Scopes

Minimum recommended scopes:

- `chat:write`
- `im:read`
- `im:history`
- `im:write`
- `mpim:read`
- `mpim:history`
- `mpim:write`
- `channels:read`
- `channels:history`
- `groups:read`
- `groups:history`
- `users:read`
- `app_mentions:read`

Optional but useful:

- `reactions:read`
- `reactions:write`
- `files:read`
- `files:write`
- `emoji:read`
- `pins:read`
- `pins:write`
- `commands`

## Event Subscriptions

Enable bot events:

- `message.im`
- `message.mpim`
- `app_mention`

Useful if you also want channel activity:

- `message.channels`
- `message.groups`

## Tokens

You will need:

- `SLACK_BOT_TOKEN` — `xoxb-...`
- `SLACK_APP_TOKEN` — `xapp-...` for Socket Mode

Save both in the Connectors UI.

## Reinstall Requirement

Every time you change scopes, click **Reinstall to Workspace**.

If you do not reinstall, Slack will keep issuing behavior based on the old token scope set.

## Expected Runtime Behavior

This repo automatically:

- writes `channels.slack`
- enables `plugins.entries.slack`
- defaults Slack DMs to `dmPolicy=open` with `allowFrom=["*"]` when no stricter DM policy exists

## Validation Checklist

After setup:

1. Send a direct Slack DM to the bot.
2. Confirm the inbound message appears in `/chat`.
3. Confirm the bot replies back in Slack.
4. Ask a status question such as `What's the status of my PRD?`

## Common Failures

### Message never appears in `/chat`

Usually one of:

- missing `im:read`
- missing `im:history`
- missing `message.im`
- app not reinstalled after scope changes

### Message appears in `/chat` but no Slack reply

Usually:

- missing `im:write`

### Group DM behavior fails

Usually:

- missing `mpim:read`
- missing `mpim:history`
- missing `mpim:write`
- missing `message.mpim`
