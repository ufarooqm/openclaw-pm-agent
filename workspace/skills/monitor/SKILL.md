---
name: monitor
description: Check Slack channels for activity and summarize decisions, blockers, and action items
user-invocable: true
---

# Channel Monitor Skill

You monitor Slack channels and summarize what the PM needs to know — decisions made, blockers raised, action items assigned, and questions that need PM input.

## When Invoked

The user asks you to check channels. Examples:
- "What happened in #product today?"
- "Monitor my channels"
- "Any blockers I should know about?"
- "Summarize #engineering from this week"
- "What did I miss?"

## Monitoring Workflow

### Step 1: Determine Scope

Parse the user's request:
- **Which channels?** Specific channel or all monitored channels?
- **Time range?** Today, since last check, this week, specific date range?
- **Focus?** Everything, just blockers, just decisions, just action items?

If no channels are specified, check all channels configured in the setup.

### Step 2: Fetch Channel Activity

For each channel, use the Slack API to pull recent messages:

```bash
# List channels to find IDs
exec curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=100"

# Get channel history
exec curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.history?channel=CHANNEL_ID&oldest=TIMESTAMP&limit=100"

# Get thread replies if needed
exec curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.replies?channel=CHANNEL_ID&ts=THREAD_TS"
```

### Step 3: Analyze and Categorize

Read through the messages and categorize:
- **Decisions** — anything that was agreed upon or decided
- **Blockers** — anything blocking progress, waiting on someone, or stuck
- **Action Items** — tasks assigned to people with or without deadlines
- **Questions** — open questions that haven't been answered, especially ones needing PM input
- **FYIs** — important updates that don't require action

### Step 4: Deliver Summary

## Output Format

```
# Channel Summary
Checked: [channel list] | Period: [time range]

## Needs Your Attention
- [Blocker/question that needs PM input — who raised it, what channel]
- [Decision that needs PM sign-off]

## Decisions Made
- [Decision 1 — who decided, in which channel]
- [Decision 2]

## Action Items
- [ ] [Task] — assigned to [person], due [date if mentioned]
- [ ] [Task] — assigned to [person]

## Key Updates
- [Important FYI 1]
- [Important FYI 2]

## Quiet Channels
- [Channels with no significant activity]
```

## Rules

- **Lead with what needs attention.** The PM wants to know what requires their input first.
- **Be selective.** Don't summarize every message. Filter for what matters.
- **Attribute correctly.** Always say who said what in which channel.
- **Respect threads.** If a conversation happened in a thread, summarize the thread conclusion, not just the top message.
- **Save monitoring summaries.** Write to `memory/YYYY-MM-DD.md` after each monitoring run so you can reference it later.
- **If Slack is not connected,** tell the user to set up Slack in the connectors page and provide the URL.
- **On heartbeat,** run a lightweight version of this check and only surface urgent items.
