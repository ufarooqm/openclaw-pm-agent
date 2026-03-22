# PM Agent — Tool Guidance

## Web Search (PRIMARY research tool — use FIRST)

You have `web_search` powered by Perplexity Sonar. It returns AI-synthesized answers with citations — not just links. This is your #1 research tool.

**HARD RULE: For ANY research task, ALWAYS call `web_search` FIRST.** Never skip it. Never guess URLs with `web_fetch` instead.

**Use `web_search` for:**
- Market research: `"[company] product launch 2026"`
- Competitive analysis: `"[competitor] pricing strategy 2026"`
- Industry trends: `"AI product management tools trends 2026"`
- Technology research: `"[technology] best practices production"`
- User research methods: `"B2B user research techniques"`

## Web Fetch (for reading a SPECIFIC known URL)

Use `web_fetch` ONLY when you already have a specific URL — from a search result, a user message, or a known source. Never guess URLs.

## Browser Tool (for JS-heavy sites only)

Use the browser ONLY when `web_search` and `web_fetch` can't do the job:
- Sites that require JavaScript rendering
- Interactive pages that need clicks or scrolling

Do NOT use the browser for simple research. Use `web_search` first.

## Tool Priority

| Task | Use This | NOT This |
|------|----------|----------|
| Research any topic | `web_search` | `web_fetch` with guessed URLs |
| Read a specific article | `web_fetch` | `browser` |
| Read a JS-heavy page | `browser` | `web_fetch` (returns empty) |
| Check Slack channels | Slack API via exec | `browser` |
| Search Confluence | Confluence API via exec | `web_fetch` |

## Skill Routing

- **Status / progress / update / PRD questions** → load `skills/status/SKILL.md` first.
- **Prioritization / what next / roadmap tradeoff questions** → load `skills/prioritize/SKILL.md` first.
- **Phone discovery / voice demo / call-business requests** → load `skills/voice-discovery/SKILL.md` first.
- **Slack channel inspection** inside a skill → use `skills/slack-api/SKILL.md`.
- **Confluence document lookup** inside a skill → use `skills/confluence-api/SKILL.md`.
- **GitHub repo / PR / issue lookup** inside a skill → use `skills/github-api/SKILL.md`.
- **Do not use `memory_search` as a substitute for a status workflow.** Memory is supporting context only.
- **Before claiming a connector is unavailable, verify it first.** Check saved connector state / environment instead of guessing.

## Internal Voice Demo API

Use the internal loopback API for live discovery calls after explicit user request.

```bash
exec curl -s -X POST http://127.0.0.1:8080/api/voice-demo/start \
  -H 'Content-Type: application/json' \
  -d '{"toNumber":"+15551234567","targetBusiness":"Example Co","assistantName":"Maya","persona":"Stay in the caller role defined by the PM brief.","discoveryGoal":"Learn their top operational pain points.","context":"Short demo call with a concrete outcome."}'
```

```bash
exec curl -s http://127.0.0.1:8080/api/voice-demo/session/SESSION_ID
```

```bash
exec curl -s http://127.0.0.1:8080/api/voice-demo/sessions
```

Use this API when:
- the user explicitly wants a live call
- the voice-discovery skill is active
- you have a real phone number to dial

Do not use it casually. Research first, then call.

## Chat History Recall

Use the persisted chat-history API before claiming you don't remember a prior conversation.

```bash
exec curl -s "http://127.0.0.1:8080/api/chat/search?q=<query>&from=<YYYY-MM-DD>&limit=20"
```

- `q` is required. Start with the topic, not the sender.
- Add `from` / `to` when the user gives a rough timeframe.
- Add `sender` only on a second pass if topic-only results are too broad.
- Results come from persisted sessions in Supabase, not just the current chat window.

Use this for:
- "Do you remember our earlier conversations?"
- "What did we say about the PRD?"
- "What did the PM / the team say yesterday?"
- "Did we already decide this?"

## Memory

Your conversation memory resets periodically. To preserve important context:

### What to save (write to `memory/YYYY-MM-DD.md`)

After completing significant work — research briefs, competitive analysis, channel summaries — append a brief summary to today's memory file:

```
## [Clear Title] — [Time]
- Key finding 1
- Key finding 2
- Action items
```

**Save after:** research reports, channel monitoring summaries, important decisions, any work product.
**Don't save:** casual Q&A, simple lookups, one-off calculations.

## Skills Available

- `/research` — Deep-dive a topic across web + your knowledge base
- `/monitor` — Check Slack channels and summarize activity
- `/status` — Cross-reference Slack, Confluence, and GitHub for project / feature / PRD status
- `/prioritize` — Recommend what to build next using internal signals plus web research
- `/voice-discovery` — Research a target, place a live phone call, and summarize the result
