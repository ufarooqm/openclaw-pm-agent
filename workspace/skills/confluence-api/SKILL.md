---
name: confluence-api
description: "How to interact with Confluence via REST API. Use when you need to search pages, read page content, or get comments from Confluence."
---

# Confluence API

Use these patterns whenever you need to read from Confluence. Auth uses three environment variables: `CONFLUENCE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_TOKEN`.

## Auth

All requests use HTTP Basic Auth with email and API token:

```bash
-u "$CONFLUENCE_EMAIL:$CONFLUENCE_TOKEN"
```

Base URL for all API calls is `$CONFLUENCE_URL/rest/api`.

## Core Operations

### 1. Search Pages

```bash
curl -s -u "$CONFLUENCE_EMAIL:$CONFLUENCE_TOKEN" \
  "$CONFLUENCE_URL/rest/api/content/search?cql=type=page+AND+text~\"SEARCH_TERM\"&limit=10"
```

CQL (Confluence Query Language) examples:
- `type=page AND text~"onboarding"` — pages containing "onboarding"
- `type=page AND title~"PRD"` — pages with "PRD" in the title
- `type=page AND space.key="PROD"` — pages in a specific space
- `type=page AND label="roadmap"` — pages with a specific label

### 2. Get Page Content

```bash
curl -s -u "$CONFLUENCE_EMAIL:$CONFLUENCE_TOKEN" \
  "$CONFLUENCE_URL/rest/api/content/PAGE_ID?expand=body.storage,version"
```

Returns the page title and body in Confluence storage format (HTML-like). Parse the `body.storage.value` field for content.

### 3. Get Page Comments

```bash
curl -s -u "$CONFLUENCE_EMAIL:$CONFLUENCE_TOKEN" \
  "$CONFLUENCE_URL/rest/api/content/PAGE_ID/child/comment?expand=body.storage,version&limit=25"
```

Returns `results[]` with each comment's `body.storage.value` and `version.by.displayName`.

### 4. List Spaces

```bash
curl -s -u "$CONFLUENCE_EMAIL:$CONFLUENCE_TOKEN" \
  "$CONFLUENCE_URL/rest/api/space?limit=25"
```

Returns `results[]` with `key`, `name`, `type`.

## Important Notes

- Always search first to find the page ID, then fetch content/comments by ID.
- Page content is in Confluence storage format (XML/HTML). Extract the text content and ignore markup tags.
- Comment authors are in `version.by.displayName`.
- For detailed response schemas, see `references/api-examples.md`.
