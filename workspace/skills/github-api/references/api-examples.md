# GitHub API Response Examples

## repos/{owner}/{repo}

```json
{
  "name": "acme-app",
  "full_name": "acme-inc/acme-app",
  "description": "Acme - Modern workspace platform",
  "language": "HTML",
  "open_issues_count": 3,
  "pushed_at": "2026-03-07T00:00:00Z",
  "default_branch": "main"
}
```

## issues (list)

```json
[
  {
    "number": 1,
    "title": "Hero CTA button not visible on mobile",
    "state": "open",
    "labels": [{ "name": "bug", "color": "d73a4a" }],
    "assignee": { "login": "benchen" },
    "body": "The Start for free button gets cut off on screens < 375px...",
    "created_at": "2026-03-07T00:00:00Z",
    "comments": 0
  },
  {
    "number": 2,
    "title": "Add SSO support",
    "state": "open",
    "labels": [{ "name": "enhancement", "color": "a2eeef" }],
    "body": "Enterprise customers requesting SSO...",
    "comments": 1
  }
]
```

Key fields:
- `number` — issue number for display and API calls
- `labels[].name` — categorization (bug, enhancement, etc.)
- `assignee.login` — who's working on it
- `comments` — number of comments (fetch separately if > 0)
- `pull_request` — present only if this item is a PR

## issues/{number}/comments

```json
[
  {
    "user": { "login": "benchen" },
    "body": "This is blocked on the security team review.",
    "created_at": "2026-03-07T12:00:00Z"
  }
]
```

## pulls (list)

```json
[
  {
    "number": 4,
    "title": "Fix mobile CTA overflow",
    "state": "open",
    "user": { "login": "benchen" },
    "head": { "ref": "fix/mobile-cta" },
    "base": { "ref": "main" },
    "draft": false,
    "requested_reviewers": [{ "login": "pm-reviewer" }]
  }
]
```

## commits (list)

```json
[
  {
    "sha": "abc123",
    "commit": {
      "message": "Initial landing page",
      "author": {
        "name": "Muhammad Farooq",
        "date": "2026-03-07T00:00:00Z"
      }
    }
  }
]
```
