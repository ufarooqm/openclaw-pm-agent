# Confluence API Response Examples

## content/search

```json
{
  "results": [
    {
      "id": "12345678",
      "type": "page",
      "title": "Onboarding Revamp - PRD",
      "space": { "key": "PROD", "name": "Product" },
      "_links": {
        "webui": "/spaces/PROD/pages/12345678/Onboarding+Revamp+-+PRD"
      }
    }
  ],
  "size": 1,
  "limit": 10
}
```

Use the `id` field to fetch full content or comments.

## content/{id} (with expand=body.storage)

```json
{
  "id": "12345678",
  "type": "page",
  "title": "Onboarding Revamp - PRD",
  "body": {
    "storage": {
      "value": "<p><strong>Goal:</strong> Improve activation rate from 34% to 50%</p><p><strong>Approach:</strong> Replace guided tour with checklist...</p>"
    }
  },
  "version": {
    "number": 3,
    "by": { "displayName": "Muhammad Farooq" },
    "when": "2026-03-05T10:30:00.000Z"
  }
}
```

The `body.storage.value` contains HTML. Strip tags to get plain text.

## content/{id}/child/comment

```json
{
  "results": [
    {
      "id": "87654321",
      "type": "comment",
      "body": {
        "storage": {
          "value": "<p>Should we gate the invite step behind email verification?</p>"
        }
      },
      "version": {
        "by": { "displayName": "Ben Chen" },
        "when": "2026-03-06T14:00:00.000Z"
      }
    }
  ],
  "size": 1
}
```

## space (list)

```json
{
  "results": [
    {
      "id": 123,
      "key": "PROD",
      "name": "Product",
      "type": "global"
    }
  ]
}
```

## Error Responses

- `401 Unauthorized` — bad email or API token
- `404 Not Found` — page ID doesn't exist or no access
- `400 Bad Request` — invalid CQL query (check quoting)

## CQL Tips

- Use `~` for contains: `text~"keyword"`
- Use `=` for exact match: `title="Exact Title"`
- Combine with AND/OR: `type=page AND (text~"SSO" OR text~"auth")`
- Sort results: append `&orderby=lastmodified+desc`
