---
name: voice-discovery
description: Research a target, place a short live phone call through the internal voice demo service, and summarize the outcome for the PM
user-invocable: true
---

# Voice Discovery Skill

Use this skill when the user wants you to place or orchestrate a phone call and turn the result into a PM-ready outcome.

## When Invoked

Examples:
- "Call a target business and ask this question"
- "Run a discovery call with a prospect"
- "Find a target and call them"
- "Use the voice demo"
- "Run a live phone interview and summarize it"
- "Find a top coffee shop in New York, call them, and figure out their biggest rush-hour pain point"
- "Find a top dentist in Toronto, call them, and learn the most important scheduling issue"
- "Find a top landscaping business, call them, and determine the biggest bottleneck in quoting jobs"

## Workflow

### Step 1: Clarify the target and goal

Extract:
- the type of business or person to call
- any geography constraint
- the discovery goal
- the exact question or hypothesis to test

If the user already named a business and question set, do not over-research. Move quickly.

If the user gives a short demo-style command, do not ask them to fill in a long brief unless something critical is missing. Infer the rest.

### Step 2: Research first

Use `web_search` first. Find:
- a real target business or contact
- a public phone number
- enough context to avoid a vague call opener

Use `web_fetch` only after you have a specific URL worth reading.

### Step 3: Safety and dialing rule

- Prefer a consenting participant for demos.
- If the target is a real outside business and the user did not clearly ask you to place the call, ask one confirmation before dialing.
- If the user explicitly asked you to call, proceed.
- Keep the call brief and outcome-oriented. The user decides the caller persona and framing.

### Step 4: Synthesize the call brief

When the user gives a short command, synthesize a crisp call brief yourself instead of asking for every field.

Default synthesis rules:
- Pick a plausible everyday caller role unless the user specifies otherwise.
- Keep the opener minimal.
- Put the explanation in `reasonForCalling`, not the opener.
- Make `firstQuestion` a single natural question.
- Build a `questionPlan` that explains how to choose the next best question based on the answer.
- Derive `outcomeSchema` from the user's goal.
- If the caller role is a customer or local inquirer, translate the research goal into customer-plausible proxy questions instead of direct internal questions.
- Assume the person who answers is busy. The brief should earn only 20-40 seconds of attention unless they choose to stay on longer.
- If the user says `2-3 questions`, treat that as an upper bound, not a script requirement. The call should follow the answer naturally.
- If the user gives a branch, street, neighborhood, mall, or other location cue, preserve it in the brief. Do not drop that detail just because the call itself should stay short.

Use these defaults unless the user overrides them:

- `assistantName`
  - Default to `Joe`

- `persona`
  - If the goal is subtle discovery, default to a casual prospective customer or local inquirer
  - If the goal is operational depth, default to a peer operator or project lead
  - Keep it human, brief, credible, and lightly assertive
  - Default tone: calm, direct, and matter-of-fact. Friendly is fine, but avoid sounding overly bubbly, overly grateful, apologetic, or eager to please

- `opener`
  - Prefer one of:
    - `Hi, is this <business>?`
    - `Hi, did I reach <business>?`
  - After they confirm, go straight into the reason for calling and the first real question
  - Do not spend a separate turn asking whether now is a good time unless the user explicitly wants a softer opener

- `reasonForCalling`
  - One plain-language sentence only
  - Example shape: `I was thinking of stopping by and wanted to ask something.`
  - Keep it short enough to say in one breath
  - Keep it straightforward. Do not pad it with extra niceties unless the user explicitly wants a softer tone

- `firstQuestion`
  - One question only
  - Avoid jargon unless the user explicitly wants it
  - If the caller is a customer, make it something a customer would naturally ask
  - Do not ask direct staff-facing questions like `what is the biggest challenge` unless the caller is explicitly an operator, founder, peer, or researcher
  - Do not front-load both hidden hypotheses in the first question. Let the contact name the friction first.
  - Avoid loaded phrases like `laptop people`, `camp out`, or `taking up seats` unless the contact already introduced that framing

- `follow-up style`
  - For subtle customer-style calls, infer pain from customer-visible effects like line length, wait time, crowding, finding a seat, pickup backups, or slow service
  - Use an adaptive plan, not a rigid script
  - Ask plainly. Prefer crisp, specific questions over overly warm lead-ins or repeated reassurance
  - If the first answer only gives timing, ask what a customer would actually notice first at that time
  - If the first answer already includes both timing and a visible signal, you may only need a quick clarification or no follow-up at all
  - Ask a second clarifier only if the first answer is partial and the contact still sounds engaged
  - If the first answer is vague like `it's busy` or `it gets hectic`, ask at most one softer decision-oriented follow-up about what the caller should do, not another forced-choice research question
  - Prefer questions like:
    - `If I came around then, what would I notice first?`
    - `If I came around then, is it usually more of a line or more that it gets crowded?`
    - `If I wanted it calmer, what time would you suggest?`
    - `Does it get hard to find a seat when it is busy?`
    - `If I wanted to grab coffee and maybe sit for a bit, would that be a bad time?`
  - Avoid questions like:
    - `What is the biggest pain point?`
    - `What breaks down during rush hour?`
    - `What frustrates customers the most?`
    - `What makes it feel really busy?`
    - `Is it more of a line to order or more that it gets hard to find a seat with all the laptop people?`

- `outcomeSchema`
  - Infer 2-5 fields from the user's goal
  - Example mappings:
    - If the user says `determine the most important pain point`
      - `top_pain`
      - `evidence`
      - `severity`
      - `next_probe`
    - If the user says `learn how busy they get`
      - `peak_window`
      - `quiet_window`
      - `confidence`
      - `next_probe`
    - If the user says `understand why customers choose them`
      - `primary_reason`
      - `supporting_reason`
      - `evidence`
      - `next_probe`

Do not force the user to provide this structure manually in the demo. Build it.

- `questionPlan`
  - A short adaptive questioning strategy for the phone agent
  - Example shape:
    - `Start by getting the busy window. If they only give timing, ask what a customer would notice first at that time. If they give both timing and a visible signal, confirm once if needed and close. If they sound rushed, skip the extra follow-up and end politely.`

### Step 5: Prepare the payload

Build a tight payload for the internal voice service:
- `toNumber`
- `targetName`
- `targetBusiness`
- `assistantName`
- `persona`
- `discoveryGoal`
- `context`
- `reasonForCalling`
- `firstQuestion`
- `questionPlan`
- `opener`
- `outcomeSchema`
- `summaryInstructions`

Guidance:
- Keep `discoveryGoal` and `context` concise. The voice agent performs better with a crisp brief.
- If the user specified a location or branch constraint, keep that constraint in `context` in one short sentence. This helps the runtime pick the right branch if the business answers with an automated menu.
- `opener` should usually be short. Prefer a simple confirmation opener like “Hi, is this X?” unless the user explicitly wants a different opening line.
- `reasonForCalling` should be one plain-language sentence the caller can say immediately after the other person confirms they reached the right place.
- `firstQuestion` should be one natural question, not a bundle of questions.
- Unless the user explicitly wants a softer opener, do not burn a turn asking if this is a good time to talk. Confirm the business, then get to the point.
- `questionPlan` should tell the phone agent how to decide the next best question from the answer, not hard-code a full script.
- `outcomeSchema` should be an array of 2-5 fields describing what to extract from the call. Infer a sensible schema from the user’s goal if they do not spell one out.
- If the user wants subtle discovery while acting as a customer, do not feed the phone agent direct internal phrasing. Translate the goal into customer-visible questions and let the outcome schema capture the underlying insight.
- If the user wants urgency or subtlety, optimize for the shortest believable exchange rather than maximum information extraction.
- For customer-style discovery, avoid hypothesis leakage. Do not name both candidate explanations in the opener just because the PM cares about that distinction internally.
- If the contact gets guarded, answer once in plain customer language and either ask one softer follow-up or end the call. Do not keep pressing.

### Step 5: Start the call

Use the internal loopback endpoint:

```bash
exec curl -s -X POST http://127.0.0.1:8080/api/voice-demo/start \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{"toNumber":"+15551234567","targetName":"Sam","targetBusiness":"Target business","assistantName":"Joe","persona":"You are Joe, a credible human caller. Stay in character and sound calm, direct, and natural.","discoveryGoal":"Learn how this team currently handles a critical workflow and where the biggest friction shows up.","context":"The user decides the caller role, framing, and desired outcome. Follow that brief tightly and stay in character.","reasonForCalling":"I wanted to ask something.","firstQuestion":"What is usually the hardest part of that workflow for you?","questionPlan":"Start with the main question. If the answer is partial, ask the single best clarifier. If the answer is already clear, confirm if needed and close.","opener":"Hi, is this Sam?","outcomeSchema":[{"key":"core_answer","label":"Core Answer","description":"The clearest direct answer the contact gave to the main question."},{"key":"constraint","label":"Constraint","description":"Any limitation, friction, or caveat the contact mentioned."},{"key":"next_probe","label":"Next Probe","description":"The best next question to tighten the learning."}],"summaryInstructions":"Keep the write-up useful for the PM, but do not invent product opportunities unless the call clearly supports them."}
JSON
```

Always use a heredoc JSON body like the example above. Do not inline complex JSON inside a single-quoted shell string.

The response returns:
- `sessionId`
- `callSid`
- `sessionUrl`

### Step 6: Keep the user prompt short

For live demos, prefer that the user can say something like:
- `Find a top coffee shop in New York, call them, and determine the biggest rush-hour pain point`
- `Find a top dentist in Toronto, call them, and learn the most important scheduling problem`
- `Find a top florist nearby, call them, and figure out what slows down same-day orders`

Your job is to translate that short instruction into the payload above.

### Step 7: Tell the user what is happening

Once the call starts, immediately tell the user:
- who you are calling
- why
- where to watch it live: `/voice/live?sessionId=...`

### Step 8: Poll for status

Poll until the session is complete or a summary is available:

```bash
exec curl -s http://127.0.0.1:8080/api/voice-demo/session/SESSION_ID
```

If needed, check recent sessions:

```bash
exec curl -s http://127.0.0.1:8080/api/voice-demo/sessions
```

### Step 9: Deliver the PM result

Return:
- who was called
- the extracted outcomes
- the PM-ready summary
- the saved artifact path if present

Keep the chat response concise. Do not dump the full payload back to the user unless they ask.
Do not over-interpret ambiguous answers in the chat write-up.

## Rules

- Research before you dial.
- One live business call at a time.
- Do not invent phone numbers or business details.
- Do not say the browser monitor is synthetic. It is intended to reflect the live call audio path in the browser.
- If the internal voice service returns an error, explain the error briefly and stop.
- If no number is found, say so and do not fabricate a target.
- Do not hardcode domain-specific output fields in your response. Let the user’s goal or the inferred `outcomeSchema` define what gets extracted.
- For demo prompts, optimize for speed. Infer the brief and move.
- For customer-style demos, do not ask direct internal pain-point questions. Use indirect, believable customer questions and infer the friction from the answers.
- For customer-style demos, keep the tone calm and direct. Friendly is good, but do not overdo enthusiasm, gratitude, or softening language.
- If the contact uses ambiguous wording, quote it literally and do not resolve the ambiguity unless they clarified it.
- If the contact already gave the main signal, choose whether a clarifier is still worth it. Do not ask extra questions just to hit a quota.
- Do not hardcode the conversation to exactly 2-3 questions. Let the plan adapt to the signal quality and the contact's patience.
- Do not end the call just because you got one answer. End it when the answer is clear enough and the contact sounds done.
- Do not treat a polite `thanks` in the middle of a sentence as a closing.
