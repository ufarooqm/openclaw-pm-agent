---
name: github-api
description: "How to interact with GitHub via REST API. Use when you need to list issues, view pull requests, check repo status, or read issue comments from GitHub."
---

# GitHub API

Use these patterns whenever you need to read from GitHub. Auth uses the `GITHUB_TOKEN` environment variable.

## Auth

All requests use Bearer token auth:

```bash
-H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json"
```

Base URL: `https://api.github.com`

## Core Operations

### 1. Get Repo Info

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/OWNER/REPO"
```

Returns `name`, `description`, `open_issues_count`, `language`, `pushed_at`.

### 2. List Issues

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/OWNER/REPO/issues?state=open&per_page=30"
```

Filter options:
- `state=open|closed|all`
- `labels=bug,enhancement` (comma-separated)
- `assignee=username`
- `sort=created|updated|comments`
- `direction=asc|desc`

### 3. Get Single Issue

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/OWNER/REPO/issues/NUMBER"
```

### 4. Get Issue Comments

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/OWNER/REPO/issues/NUMBER/comments"
```

### 5. List Pull Requests

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/OWNER/REPO/pulls?state=open"
```

### 6. Get Recent Commits

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/OWNER/REPO/commits?per_page=5"
```

## Important Notes

- Issues and PRs share the same number space. The issues endpoint returns both; PRs have a `pull_request` key.
- To get only issues (no PRs), filter out items that have `pull_request` in the response.
- Labels are in `labels[].name`.
- For detailed response schemas, see `references/api-examples.md`.
