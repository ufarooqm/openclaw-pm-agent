---
name: prioritize
description: "Recommend what to build next by gathering signals from Slack, Confluence, GitHub, and the web. Use when asked: what should we build next, what's the next priority, help me prioritize, what feature should we focus on."
user-invocable: true
---

# Prioritize

Gather signals from all available sources and produce a ranked recommendation for what to build next.

## When Invoked

The user asks about priorities or what to build. Examples:
- "What should we build next?"
- "Help me prioritize the backlog"
- "After onboarding ships, what's next?"
- "What features should we focus on for Q2?"

## Workflow

### Step 1: Gather Signals from Slack

Use the `slack-api` skill patterns to search for:
- Feature requests or customer asks mentioned by the team
- Sales feedback ("customers want X", "we lost a deal because of Y")
- Recurring complaints or pain points
- Team sentiment on what matters

### Step 2: Gather Signals from Confluence

Use the `confluence-api` skill patterns to:
- Search for roadmap documents
- Find any prioritization or planning pages
- Check for effort estimates, capacity docs, or sprint plans

### Step 3: Gather Signals from GitHub

Use the `github-api` skill patterns to:
- List open issues and categorize by label (bug, enhancement)
- Count comments per issue as a proxy for demand/importance
- Check which issues have been open longest
- Look for blocked items

### Step 4: Research the Market

Use `web_search` to:
- Search for industry trends relevant to the product
- Check what competitors are doing
- Look for best practices related to top feature candidates

### Step 5: Synthesize and Rank

Score each candidate feature across these dimensions:
- **User demand** — how many signals from Slack/GitHub?
- **Business impact** — does it unblock revenue, reduce churn?
- **Effort** — how long does it take (from Confluence/GitHub estimates)?
- **Risk** — any dependencies or blockers?

## Output Format

```
# Priority Recommendation

## TL;DR
[One sentence: what to build next and why]

## Ranked Features

| Rank | Feature | Demand | Impact | Effort | Risk | Score |
|------|---------|--------|--------|--------|------|-------|
| 1 | ... | High | High | 3 wks | Low | ... |
| 2 | ... | Med | High | 2 wks | Med | ... |
| 3 | ... | Low | Low | 1 wk | Low | ... |

## Signal Summary

### From Slack
- [Key signals with attribution]

### From Confluence
- [Roadmap/capacity context]

### From GitHub
- [Issue/PR data]

### From Market Research
- [Industry trends or competitor moves]

## Recommendation
[2-3 sentences: what to build, why, and what to sequence after]
```

## Rules

- Check all available tools. Don't skip a source.
- Always include web research — internal data alone gives a narrow view.
- Be opinionated. Don't just present data — make a recommendation with reasoning.
- Cite your sources: who said what, where, and when.
- If effort estimates aren't available, flag it as a gap.
- Save the recommendation to `output/priority-[date].md` and log it.
