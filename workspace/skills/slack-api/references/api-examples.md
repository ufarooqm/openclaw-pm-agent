# Slack API Response Examples

## conversations.list

```json
{
  "ok": true,
  "channels": [
    {
      "id": "C01ABC123",
      "name": "engineering",
      "purpose": { "value": "Engineering discussion" },
      "num_members": 12
    }
  ]
}
```

## conversations.history

```json
{
  "ok": true,
  "messages": [
    {
      "type": "message",
      "user": "U01ABC123",
      "text": "Checklist UI should be done by Thursday.",
      "ts": "1709830000.000100",
      "reply_count": 2,
      "thread_ts": "1709830000.000100"
    }
  ],
  "has_more": false
}
```

Key fields:
- `user` — user ID, must resolve via users.info
- `ts` — timestamp, also serves as message ID
- `thread_ts` — if present and equals `ts`, this message is a thread parent
- `reply_count` — number of thread replies

## conversations.replies

```json
{
  "ok": true,
  "messages": [
    {
      "user": "U01ABC123",
      "text": "Parent message",
      "ts": "1709830000.000100",
      "thread_ts": "1709830000.000100"
    },
    {
      "user": "U02DEF456",
      "text": "Reply in thread",
      "ts": "1709830100.000200",
      "thread_ts": "1709830000.000100"
    }
  ]
}
```

First message in the array is always the thread parent.

## users.info

```json
{
  "ok": true,
  "user": {
    "id": "U01ABC123",
    "name": "muhammad",
    "real_name": "Muhammad Farooq",
    "profile": {
      "display_name": "Muhammad"
    }
  }
}
```

## Error Response

```json
{
  "ok": false,
  "error": "channel_not_found"
}
```

Common errors:
- `channel_not_found` — bad channel ID
- `not_in_channel` — bot not invited to channel
- `invalid_auth` — bad or expired token
- `missing_scope` — token lacks required scope
