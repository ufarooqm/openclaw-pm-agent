---
name: status
description: "Get the status of a project, feature, PRD, or workstream by cross-referencing Slack, Confluence, and GitHub. Use when asked: what's the status, what's the status of my PRD, how's X going, where are we on X, any updates on X, any blockers."
user-invocable: true
---

# Status Check

Cross-reference all connected tools to give a complete picture of where a project or feature stands.

## When Invoked

The user asks about the status of something. Examples:
- "What's the status of the onboarding revamp?"
- "What's the status of my PRD?"
- "Where are we on SSO?"
- "Any blockers I should know about?"
- "How's the sprint going?"

## Workflow

### Step 1: Identify the Topic

Parse the user's request for the project, feature, or area they're asking about. Extract keywords for searching.

If the request is somewhat ambiguous but clearly asks for status on an artifact like a PRD, spec, initiative, or feature, do an initial search pass before asking a clarifying question.

Ask a clarifying question only if:
- multiple plausible matches appear, or
- all connected sources come back empty after the first search pass.

### Step 2: Check Prior Conversations

Search persisted chat history first for prior discussions on the topic:

```bash
exec curl -s "http://127.0.0.1:8080/api/chat/search?q=TOPIC&from=YYYY-MM-DD&limit=20"
```

Use chat history as supporting context:
- prior summaries
- decisions already discussed
- references to docs, channels, or repos

### Step 3: Check Slack

Use the `slack-api` skill patterns to:
1. List channels to find relevant ones
2. Pull recent history from each channel
3. Search messages for the topic keywords
4. Read any threads with relevant discussion

Look for: progress updates, blockers mentioned, decisions made, deadlines referenced.

### Step 4: Check Confluence

Use the `confluence-api` skill patterns to:
1. Search pages with CQL: `type=page AND text~"TOPIC"`
2. Fetch the most relevant page content
3. Check for comments on that page

Look for: PRD status, open questions, action items, meeting notes.

### Step 5: Check GitHub

Use the `github-api` skill patterns to:
1. Search issues related to the topic
2. Check open PRs
3. Look at recent commits

Look for: issue state (open/closed), blockers (labels), PR review status, recent activity.

### Step 6: Synthesize

Combine findings into a single status report. Do not just list raw data from each tool — connect the dots.

## Output Format

```
# Status: [Topic]

## Progress
- [What's been done, with sources]

## Current Blockers
- [What's stuck and why — cross-reference if the same blocker appears in multiple tools]

## Upcoming Deadlines
- [Any dates or milestones mentioned]

## Open Questions
- [Unresolved questions from Confluence comments or Slack threads]

## Recommendation
[One sentence: what the PM should do next]
```

## Rules

- Check all available tools. Don't skip a source.
- Cross-reference: if a blocker appears in both Slack and GitHub, call that out.
- Be specific: include who said what and where.
- If a tool is not connected, note it and move on with the others.
- Do not answer a status question from `memory_search` alone.
- Use memory and saved outputs as supporting context, not as the primary status source.
- Save the status report to `output/status-[topic]-[date].md` if it's substantial.
