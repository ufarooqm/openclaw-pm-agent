---
name: slack-api
description: "How to interact with Slack via API. Use when you need to list channels, read channel messages, read thread replies, or resolve user names from Slack."
---

# Slack API

Use these patterns whenever you need to read from Slack. Auth is via the `SLACK_BOT_TOKEN` environment variable.

## Auth

All requests use Bearer token auth:

```
-H "Authorization: Bearer $SLACK_BOT_TOKEN"
```

## Core Operations

### 1. List Channels

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200"
```

Returns `channels[]` with `id`, `name`, `purpose.value`.

### 2. Get Channel History

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.history?channel=CHANNEL_ID&limit=50"
```

Add `&oldest=UNIX_TIMESTAMP` to filter by time. Returns `messages[]` with `ts`, `user`, `text`.

### 3. Get Thread Replies

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.replies?channel=CHANNEL_ID&ts=THREAD_TS"
```

Use the `ts` from a message that has `reply_count > 0`.

### 4. Resolve User ID to Name

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/users.info?user=USER_ID"
```

Returns `user.real_name` and `user.profile.display_name`.

## Important Notes

- Always resolve user IDs to names before presenting results. Raw IDs like `U12345` mean nothing to the user.
- Messages are returned newest-first by default.
- Check `ok: true` in every response. If `ok: false`, read the `error` field.
- For detailed response schemas, see `references/api-examples.md`.
