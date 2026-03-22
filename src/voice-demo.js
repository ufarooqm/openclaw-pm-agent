import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
}

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const FEATURE_VOICE_DEMO_ENABLED = envFlag("FEATURE_VOICE_DEMO_ENABLED", false);

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID?.trim() || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN?.trim() || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER?.trim() || "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY?.trim() || "";
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID?.trim() || "";
const ELEVENLABS_API_BASE_URL = (process.env.ELEVENLABS_API_BASE_URL?.trim() || "https://api.elevenlabs.io").replace(/\/+$/, "");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY?.trim() || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() || "";

const PUBLIC_BASE_URL = (
  process.env.VOICE_DEMO_BASE_URL?.trim()
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")
).replace(/\/+$/, "");

const VOICE_DEMO_MODEL = (
  process.env.VOICE_DEMO_MODEL?.trim()
  || process.env.OPENCLAW_MODEL_PRIMARY?.trim()
  || "openrouter/anthropic/claude-sonnet-4.6"
);

const VOICE_DEMO_PROVIDER = (process.env.VOICE_DEMO_PROVIDER?.trim() || (ELEVENLABS_API_KEY ? "elevenlabs-register-call" : "relay")).toLowerCase();
const VOICE_DEMO_TTS_VOICE = process.env.VOICE_DEMO_TWILIO_VOICE?.trim() || "ZF6FPAbjXT4488VcRRnw-flash_v2_5-1.0_0.8_0.95";
const VOICE_DEMO_TEXT_NORMALIZATION = process.env.VOICE_DEMO_ELEVENLABS_TEXT_NORMALIZATION?.trim() || "on";
const VOICE_DEMO_SYSTEM_NAME = process.env.VOICE_DEMO_ASSISTANT_NAME?.trim() || "Joe";
const VOICE_DEMO_ELEVENLABS_AGENT_NAME = process.env.VOICE_DEMO_ELEVENLABS_AGENT_NAME?.trim() || "PM Voice Discovery Caller";
const VOICE_DEMO_ELEVENLABS_LLM = process.env.VOICE_DEMO_ELEVENLABS_LLM?.trim() || "claude-sonnet-4-6";
const VOICE_DEMO_ELEVENLABS_TTS_MODEL = process.env.VOICE_DEMO_ELEVENLABS_TTS_MODEL?.trim() || "eleven_v3_conversational";
const VOICE_DEMO_MONITOR_TTS_MODEL = process.env.VOICE_DEMO_MONITOR_TTS_MODEL?.trim() || "eleven_turbo_v2_5";
const VOICE_DEMO_ELEVENLABS_VOICE_ID = process.env.VOICE_DEMO_ELEVENLABS_VOICE_ID?.trim() || "cjVigY5qzO86Huf0OWal";
const VOICE_DEMO_SCRIBE_MODEL = process.env.VOICE_DEMO_SCRIBE_MODEL?.trim() || "scribe_v2_realtime";
const VOICE_DEMO_ELEVENLABS_AGENT_VERSION = process.env.VOICE_DEMO_ELEVENLABS_AGENT_VERSION?.trim() || "2026-03-21-ivr-autonavigate-v2";
const VOICE_DEMO_MONITOR_MODE = (process.env.VOICE_DEMO_MONITOR_MODE?.trim() || "telephony_live").toLowerCase();
const VOICE_DEMO_MONITOR_TELEPHONY_DELAY_MS = Math.max(120, envNumber("VOICE_DEMO_MONITOR_TELEPHONY_DELAY_MS", 220));
const VOICE_DEMO_MONITOR_OUTBOUND_FALLBACK_GAIN = Math.min(0.24, Math.max(0.03, envNumber("VOICE_DEMO_MONITOR_OUTBOUND_FALLBACK_GAIN", 0.08)));
const VOICE_DEMO_MONITOR_AGENT_PCM_RATE = Math.max(16000, envNumber("VOICE_DEMO_MONITOR_AGENT_PCM_RATE", 24000));
const VOICE_DEMO_INITIAL_ANSWER_PAUSE_SECONDS = Math.max(0, Math.min(3, Math.round(envNumber("VOICE_DEMO_INITIAL_ANSWER_PAUSE_SECONDS", 1))));
const SESSION_RETENTION_MS = 6 * 60 * 60 * 1000;

function voiceDemoUsesElevenLabsRegisterCall() {
  return VOICE_DEMO_PROVIDER === "elevenlabs-register-call";
}

function voiceDemoUsesHybridCleanAgentMonitor() {
  return VOICE_DEMO_MONITOR_MODE === "hybrid_clean_agent"
    && voiceDemoUsesElevenLabsRegisterCall()
    && Boolean(ELEVENLABS_API_KEY)
    && Boolean(VOICE_DEMO_ELEVENLABS_VOICE_ID);
}

function voiceDemoConfigured() {
  return FEATURE_VOICE_DEMO_ENABLED
    && Boolean(PUBLIC_BASE_URL)
    && Boolean(TWILIO_ACCOUNT_SID)
    && Boolean(TWILIO_AUTH_TOKEN)
    && Boolean(TWILIO_PHONE_NUMBER)
    && (!voiceDemoUsesElevenLabsRegisterCall() || Boolean(ELEVENLABS_API_KEY));
}

function normalizePhoneNumber(raw) {
  const input = String(raw || "").trim();
  const digits = input.replace(/\D/g, "");
  if (input.startsWith("+") && digits.length >= 7) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function nowIso() {
  return new Date().toISOString();
}

function isTerminalSessionStatus(status) {
  const normalized = String(status || "").toLowerCase();
  return normalized.includes("completed")
    || normalized.includes("error")
    || normalized.includes("canceled")
    || normalized.includes("cancelled")
    || normalized.includes("failed")
    || normalized.includes("busy")
    || normalized.includes("no-answer")
    || normalized.includes("rejected");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localDateStamp(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localTimeStamp(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "voice-discovery";
}

function prettifyKeyLabel(key) {
  return String(key || "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase()) || "Outcome";
}

const GENERIC_TARGET_LABELS = new Set([
  "",
  "the business",
  "business",
  "business name",
  "target business",
  "local business",
  "unknown",
  "there",
  "target",
]);

function isMeaningfulTargetLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return Boolean(normalized) && !GENERIC_TARGET_LABELS.has(normalized);
}

function parseMaybeJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeOutcomeSchema(raw) {
  const parsed = Array.isArray(raw) ? raw : parseMaybeJson(raw);
  if (!Array.isArray(parsed)) return [];
  const seen = new Set();
  const items = [];
  for (const [index, item] of parsed.entries()) {
    const source = typeof item === "string" ? { key: item, label: item } : (item || {});
    const rawKey = String(source.key || source.id || source.name || source.label || `outcome_${index + 1}`).trim();
    const key = rawKey
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || `outcome_${index + 1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      key,
      label: String(source.label || prettifyKeyLabel(key)).trim() || prettifyKeyLabel(key),
      description: String(source.description || source.prompt || "").trim(),
    });
    if (items.length >= 8) break;
  }
  return items;
}

function effectiveOutcomeSchema(session) {
  if (Array.isArray(session.outcomeSchema) && session.outcomeSchema.length) return session.outcomeSchema;
  return [
    {
      key: "direct_answer",
      label: "Direct Answer",
      description: "The clearest direct answer or signal the contact gave in response to the core question.",
    },
    {
      key: "supporting_signal",
      label: "Supporting Signal",
      description: "Important nuance, caveat, or contradiction that adds context to the direct answer.",
    },
    {
      key: "follow_up_path",
      label: "Follow-up Path",
      description: "The best next question or action to tighten what was learned.",
    },
  ];
}

function normalizeModelName(raw) {
  const model = String(raw || "").trim();
  if (!model) return "";
  return model.startsWith("openrouter/") ? model.slice("openrouter/".length) : model;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function buildGreeting(session) {
  if (session.opener) return session.opener;
  if (isMeaningfulTargetLabel(session.targetName)) {
    return `Hi, is this ${session.targetName}?`;
  }
  if (isMeaningfulTargetLabel(session.targetBusiness)) {
    return `Hi, is this ${session.targetBusiness}?`;
  }
  return "Hi, did I reach the right place?";
}

function normalizeSentence(value) {
  const normalized = normalizeTranscriptText(value);
  if (!normalized) return "";
  return /[.?!]$/.test(normalized) ? normalized : `${normalized}.`;
}

function isCustomerStyleCall(session) {
  const text = [
    session.persona,
    session.context,
    session.reasonForCalling,
    session.discoveryGoal,
  ].filter(Boolean).join(" ").toLowerCase();
  const customerSignals = [
    "customer",
    "regular",
    "local",
    "neighbor",
    "prospective customer",
    "prospective",
    "stopping by",
    "stop by",
    "swing by",
    "come by",
    "visit",
    "avoid the rush",
    "avoid a wait",
  ];
  const nonCustomerSignals = [
    "operator",
    "peer",
    "project lead",
    "founder",
    "researcher",
    "sales rep",
    "product team",
    "vendor",
  ];
  return customerSignals.some((signal) => text.includes(signal))
    && !nonCustomerSignals.some((signal) => text.includes(signal));
}

function buildCustomerStyleRules() {
  return [
    "- Assume the other person is busy and mildly impatient. Earn every extra second you keep them on the phone.",
    "- If the caller role is a customer, local, regular, neighbor, or prospective customer, ask only customer-plausible questions.",
    "- For customer-style calls, never directly ask internal questions like 'what is your biggest challenge', 'what breaks down', 'what frustrates customers', 'what is the pain point', or 'what is the bottleneck.'",
    "- For customer-style calls, infer internal friction from customer-facing signals like line length, wait time, crowding, finding a seat, pace of service, pickup congestion, or order readiness.",
    "- Do not front-load multiple hidden hypotheses in the first question. Start with one open customer-visible prompt and let the contact name the friction first.",
    "- Avoid loaded phrases like 'laptop people', 'camp out', or 'take up the seats' unless the contact already introduced that framing.",
    "- Avoid abstract follow-ups like 'what makes it feel busy' or 'what is it like during rush hour.' Ask about a visible effect instead.",
    "- When you need a second question, prefer a proxy like 'If I came around then, what would I notice first?' or 'Is it more of a line issue or more that it gets crowded?' or 'If I wanted it calmer, when would you recommend coming?'",
    "- Keep the reason-for-calling sentence short and ordinary. It should sound like something a real customer would say in under 12 words.",
    "- If the other person sounds guarded or asks why you are asking, answer once in plain customer language and either ask one softer follow-up or end the call politely.",
    "- If the first answer is vague like 'it's busy' or 'it gets hectic', ask at most one softer decision question such as whether grabbing coffee and sitting briefly would be realistic, or what time would be calmer.",
    "- If they stay vague or guarded after that softer follow-up, stop probing and close.",
    "- If an answer is ambiguous, preserve that ambiguity or ask one brief natural clarification. Do not assume details that were not said.",
    "- Use an adaptive question plan, not a rigid script. Start with the single highest-signal customer question, then choose the next best follow-up based on what they actually said.",
    "- If the first answer only gives timing, ask what a customer would notice first at that busy time.",
    "- If the first answer already includes both timing and a visible signal, you may only need to confirm or close.",
    "- You can ask a second clarifier if the first answer is partial and the other person still sounds engaged. Do not force a second clarifier if they already sound done.",
    "- Do not chase a question quota. Ask the next question only if it materially sharpens what the PM will learn.",
    "- After you have a useful answer and the contact sounds done, wrap up and thank them.",
    "- Closings should be one short sentence. Do not add a long thank-you paragraph.",
    "- When you close, do not hang up instantly after saying thanks. Give the other person a brief chance to acknowledge or say bye, then end the call.",
    "- If the other person replies to your closing with 'thanks', 'thank you', 'okay', or 'bye', answer once with a short farewell like 'Thanks, bye' or 'Bye' and then end the call.",
  ];
}

function defaultQuestionPlan(session) {
  if (isCustomerStyleCall(session)) {
    return [
      "Question plan:",
      "1. Start with one open customer-plausible question that gets the busy window or main visible effect into the open without revealing your hidden hypotheses.",
      "2. If they only give a time, ask what a customer would notice first at that time: a line, crowding, trouble finding a seat, slow drinks, or pickup congestion.",
      "3. If they give a vague answer like 'it's busy', ask at most one softer decision question about what the caller should do, such as whether it is a bad time to grab coffee and sit briefly or what time would be calmer.",
      "4. If they already give a visible signal, ask at most one narrower clarifier only if it changes the learning.",
      "5. If they sound rushed, guarded, or done, stop probing and close politely.",
      "6. Do not aim for a question count. Aim for one concrete rush window and the clearest visible effect the customer would notice.",
    ].join("\n");
  }
  return [
    "Question plan:",
    "1. Start with the single highest-signal question implied by the PM brief.",
    "2. Ask the next best clarifier based on the actual answer, not a fixed script.",
    "3. Stop once the main signal is clear.",
  ].join("\n");
}

function buildSystemPrompt(session) {
  const rules = [
    `You are ${session.assistantName}, speaking live on a phone call.`,
    session.persona
      ? `Stay in this caller identity and framing: ${session.persona}`
      : "Stay in the caller identity implied by the PM brief and opener.",
    `Primary outcome: ${session.discoveryGoal || "learn the clearest answer to the caller's main question and qualify it with concrete details."}`,
    session.reasonForCalling
      ? `Plain-language reason for calling: ${session.reasonForCalling}`
      : "Plain-language reason for calling: explain in one short everyday sentence why you are calling before you ask the main question.",
    session.firstQuestion
      ? `Preferred first question: ${session.firstQuestion}`
      : "Preferred first question: ask the clearest first question implied by the PM brief.",
    session.questionPlan
      ? `Question strategy: ${session.questionPlan}`
      : `Question strategy: ${defaultQuestionPlan(session)}`,
    session.context
      ? `Context from the PM team: ${session.context}`
      : "Context from the PM team: keep the call outcome-focused and ask concrete follow-up questions.",
    isMeaningfulTargetLabel(session.targetBusiness)
      ? `You are speaking with someone from ${session.targetBusiness}.`
      : "You are speaking with a business operator.",
    isMeaningfulTargetLabel(session.targetName)
      ? `If natural, address them as ${session.targetName}.`
      : "If you do not know the person's name, stay polite and direct.",
    "Rules:",
    "- Sound natural, calm, and conversational. Do not sound like a presentation.",
    "- Be friendly but matter-of-fact. Sound lightly assertive and in control, not overly bubbly, apologetic, or eager to please.",
    "- Keep every reply short: usually one sentence, sometimes two, and ask one question at a time.",
    "- Stay in character and follow the PM brief. Do not volunteer that you are AI or automated unless the PM brief explicitly tells you to.",
    "- Default opening sequence: first confirm you reached the right person or business. After they confirm, go straight into your reason for calling and the first question in the next turn.",
    "- After your opener, do not take a second turn until the other side has clearly responded as a live human.",
    "- Unless the PM brief explicitly asks for a softer opener, do not ask permission-check questions like 'is now a good time' or 'can I ask a quick question' at the start.",
    "- Keep the opening tight. Do not waste a turn on throat-clearing or extra setup before the first real question.",
    "- Never answer your own opener, never speak on behalf of the callee, and never say 'yes' as if you were the business.",
    "- If the other side is a recording, IVR, phone tree, menu, voicemail, or hold message, do not treat it as a live person.",
    "- If you hear an automated menu, do not keep asking your main question into the menu. Stay silent and wait for navigation or a live human.",
    "- If the other person sounds cautious, briefly restate your reason in everyday language and keep moving.",
    "- Prefer concrete follow-up questions over generic empathy statements.",
    "- Use everyday language from the caller's role. Avoid jargon like 'foot traffic', 'research', 'product', or 'discovery' unless the PM brief explicitly calls for it.",
    "- Never make up facts about the business.",
    "- Do not mention pricing or make a sales pitch. This is research, not selling.",
    "- The call should stay under 3 minutes unless the other person wants to keep talking.",
    "- End gracefully once you have enough information.",
    "- Avoid filler phrases like 'give me one second' or 'let me think.' If you need to recover, ask one crisp follow-up question instead.",
    "- Do not repeat yourself, stack two versions of the same question, or restart the call mid-turn.",
    "- Assume the other person is busy. Keep momentum and cut unnecessary words.",
    "- Do not optimize for a preset number of questions. Optimize for the clearest useful answer with the fewest words.",
    "- If the first answer only gives timing, it is usually worth asking one short follow-up about what a customer would actually notice.",
    "- If the first answer already gives both timing and a useful visible signal, confirm only if needed and then close cleanly.",
    "- If the other person says bye, thank you, that's all, or clearly starts ending the call, stop asking questions and close immediately.",
    "- Do not leave an unfinished fragment at the end of a turn.",
    "- When you decide to close, say one short closing sentence and allow a brief beat for the other person to acknowledge before ending the call.",
    "- Prefer a closing sentence that already contains the farewell, for example 'Got it, thanks so much, bye.' rather than a wrap-up sentence followed by a separate goodbye later.",
    "- If they answer your closing with a short acknowledgment like 'thanks', 'thank you', 'okay', or 'bye', give one short farewell back before you end the call.",
    "- Your final spoken line before ending the call must include an explicit farewell word like 'bye' or 'goodbye'. Do not end the call on a line that only says thanks or says you will plan around it.",
    "- Do not invoke the end-call behavior immediately after a wrap-up sentence that lacks an explicit farewell.",
    "- If the other person says 'bye' or 'thank you, bye', answer with one short farewell like 'Thanks, bye.' or 'Bye.' and then end the call.",
  ];
  if (isCustomerStyleCall(session)) rules.push(...buildCustomerStyleRules());
  return rules.join("\n");
}

function buildElevenLabsAgentPromptTemplate() {
  return [
    "You are {{assistant_name}}, speaking live on a phone call.",
    "Stay in this caller identity and framing: {{persona}}",
    "Primary outcome: {{discovery_goal}}",
    "Plain-language reason for calling: {{reason_for_call}}",
    "Preferred first question: {{first_question}}",
    "Question strategy: {{question_plan}}",
    "Context from the PM team: {{context}}",
    "You are speaking with someone from {{target_business}}.",
    "If natural, address them as {{target_name}}.",
    "Rules:",
    "- Sound natural, calm, and conversational. Do not sound like a presentation.",
    "- Be friendly but matter-of-fact. Sound lightly assertive and in control, not overly bubbly, apologetic, or eager to please.",
    "- Keep every reply short: usually one sentence, sometimes two, and ask one question at a time.",
    "- Stay in character and follow the PM brief. Do not volunteer that you are AI or automated unless the PM brief explicitly tells you to.",
    "- Default opening sequence: first confirm you reached the right person or business. After they confirm, go straight into your reason for calling and the first question in the next turn.",
    "- After your opener, do not take a second turn until the other side has clearly responded as a live human.",
    "- Unless the PM brief explicitly asks for a softer opener, do not ask permission-check questions like 'is now a good time' or 'can I ask a quick question' at the start.",
    "- Keep the opening tight. Do not waste a turn on throat-clearing or extra setup before the first real question.",
    "- Never answer your own opener, never speak on behalf of the callee, and never say 'yes' as if you were the business.",
    "- If the other side is a recording, IVR, phone tree, menu, voicemail, or hold message, do not treat it as a live person.",
    "- If you hear an automated menu, do not keep asking your main question into the menu. Stay silent and wait for navigation or a live human.",
    "- If the other person sounds cautious, briefly restate your reason in everyday language and keep moving.",
    "- Prefer concrete follow-up questions over generic empathy statements.",
    "- Use everyday language from the caller's role. Avoid jargon like 'foot traffic', 'research', 'product', or 'discovery' unless the PM brief explicitly calls for it.",
    "- Never make up facts about the business.",
    "- Do not mention pricing or make a sales pitch. This is research, not selling.",
    "- The call should stay under 3 minutes unless the other person wants to keep talking.",
    "- End gracefully once you have enough information.",
    "- Avoid filler phrases like 'give me one second' or 'let me think.' If you need to recover, ask one crisp follow-up question instead.",
    "- Do not repeat yourself, stack two versions of the same question, or restart the call mid-turn.",
    "- Assume the other person is busy. Keep momentum and cut unnecessary words.",
    "- Do not optimize for a preset number of questions. Optimize for the clearest useful answer with the fewest words.",
    "- If the first answer only gives timing, it is usually worth asking one short follow-up about what a customer would actually notice.",
    "- If the first answer already gives both timing and a useful visible signal, confirm only if needed and then close cleanly.",
    "- If the other person says bye, thank you, that's all, or clearly starts ending the call, stop asking questions and close immediately.",
    "- Do not leave an unfinished fragment at the end of a turn.",
    "- When you decide to close, say one short closing sentence and allow a brief beat for the other person to acknowledge before ending the call.",
    "- If the caller role sounds like a customer, local, regular, neighbor, or prospective customer, ask only customer-plausible questions.",
    "- For customer-style calls, never ask direct internal questions like 'what is your biggest challenge', 'what breaks down', 'what frustrates customers', 'what is the pain point', or 'what is the bottleneck.'",
    "- For customer-style calls, infer internal friction from customer-facing signals like line length, wait time, crowding, finding a seat, pace of service, pickup congestion, or order readiness.",
    "- For customer-style calls, do not front-load multiple hidden hypotheses in the first question. Start with one open customer-visible prompt and let the contact name the friction first.",
    "- Avoid loaded phrases like 'laptop people', 'camp out', or 'take up the seats' unless the contact already introduced that framing.",
    "- For customer-style calls, if you need a second question, prefer a proxy like 'Is it more of a line issue or more that it gets crowded?' or 'If I wanted it calmer, when would you recommend coming?'",
    "- Keep the reason-for-calling sentence short and ordinary. It should sound like a real customer in under 12 words.",
    "- If the other person sounds guarded or asks why you are asking, answer once in plain customer language and either ask one softer follow-up or end the call politely.",
    "- If the first answer is vague like 'it's busy' or 'it gets hectic', ask at most one softer customer decision question about whether the caller should grab and go, sit briefly, or come at a calmer time.",
    "- If they stay vague or guarded after that softer follow-up, stop probing and close.",
    "- If an answer is ambiguous, preserve that ambiguity or ask one brief natural clarification. Do not assume details that were not said.",
    "- Do not chase a question quota. Ask the next question only if it materially sharpens what the PM will learn.",
    "- After the first clear answer, decide whether one brief clarifier is still worth it. If not, wrap up.",
    "- Closings should be one short sentence. Do not add a long thank-you paragraph.",
    "- Prefer a closing sentence that already contains the farewell, for example 'Got it, thanks so much, bye.' rather than a wrap-up sentence followed by a separate goodbye later.",
    "- After your closing sentence, wait briefly for acknowledgment before ending the call.",
    "- If they answer your closing with a short acknowledgment like 'thanks', 'thank you', 'okay', or 'bye', give one short farewell back before you end the call.",
    "- Your final spoken line before ending the call must include an explicit farewell word like 'bye' or 'goodbye'. Do not end the call on a line that only says thanks or says you will plan around it.",
    "- Do not invoke the end-call behavior immediately after a wrap-up sentence that lacks an explicit farewell.",
    "- If the other person says 'bye' or 'thank you, bye', answer with one short farewell like 'Thanks, bye.' or 'Bye.' and then end the call.",
  ].join("\n");
}

function buildStructuredSummaryPrompt(session) {
  const schema = effectiveOutcomeSchema(session);
  const transcript = session.transcript
    .map((entry) => `${entry.speaker === "agent" ? "Agent" : "Customer"}: ${entry.text}`)
    .join("\n");
  return [
    "Analyze this phone call and return strict JSON only.",
    "Use this exact shape:",
    '{',
    '  "tlDr": "one short paragraph",',
    '  "callDisposition": "brief label like completed, partial, guarded, wrong_target, or no_signal",',
    '  "schemaResults": [',
    '    { "key": "schema_key", "label": "Schema Label", "value": "concise extracted result" }',
    "  ],",
    '  "evidence": ["short quoted line or fact", "another quote or fact"],',
    '  "nextStep": "best next action in one sentence"',
    '}',
    "",
    "Rules:",
    "- Return valid JSON only. No markdown fences.",
    "- Keep values concise and concrete.",
    "- If something was not learned, say \"Not learned\".",
    "- Do not invent product opportunities unless the schema or instructions explicitly ask for them.",
    "- Preserve ambiguous wording literally. For example, if someone says 'can't find a space,' do not assume whether that means parking, seating, or something else unless they clarified it.",
    "- If the schema includes confidence, base it on evidence quality rather than answer length alone. A brief but direct answer can still justify medium confidence.",
    session.summaryInstructions
      ? `- Additional summary instructions: ${session.summaryInstructions}`
      : "- Additional summary instructions: keep the summary broadly useful and not domain-specific unless the PM brief makes it domain-specific.",
    "",
    "Requested extraction schema:",
    ...schema.map((item) => `- ${item.key} | ${item.label} | ${item.description || "No extra description"}`),
    "",
    transcript,
  ].join("\n");
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function customerTranscriptEntries(session) {
  return (session.transcript || []).filter((entry) => entry.speaker === "customer");
}

function timeMentionFromText(text) {
  const match = String(text || "").match(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i);
  return match ? match[0].replace(/\s+/g, " ").trim() : "";
}

function looksLikeMinimalAcknowledgement(text) {
  const normalized = normalizeTranscriptText(text).toLowerCase();
  if (!normalized) return true;
  if (normalized.split(" ").length <= 3 && /^(yes|yeah|yep|sure|ok|okay|hello|goodbye|bye|i guess|what\??)$/.test(normalized)) {
    return true;
  }
  return false;
}

function isGuardedCustomerText(text) {
  const normalized = normalizeTranscriptText(text).toLowerCase();
  return normalized.includes("why are you asking")
    || normalized.includes("what's this")
    || normalized.includes("what is this")
    || normalized.includes("who is this")
    || normalized.includes("hello?");
}

function substantiveCustomerAnswers(session) {
  return customerTranscriptEntries(session)
    .map((entry) => normalizeTranscriptText(entry.text))
    .filter((text) => text && !looksLikeMinimalAcknowledgement(text));
}

function findPeakWindowAnswer(session) {
  for (const text of substantiveCustomerAnswers(session)) {
    const time = timeMentionFromText(text);
    if (time) return time;
  }
  return "";
}

function findCustomerPainAnswer(session) {
  const answers = substantiveCustomerAnswers(session);
  for (const text of answers) {
    if (timeMentionFromText(text)) continue;
    if (/^(what|why)\b/i.test(text)) continue;
    return text;
  }
  return "";
}

function deriveFallbackCallDisposition(session) {
  const answers = substantiveCustomerAnswers(session);
  if (!answers.length) return "no_signal";
  if (answers.some((text) => isGuardedCustomerText(text))) return "guarded";
  if (String(session.status || "").includes("completed")) return "completed";
  return "partial";
}

function fallbackSchemaValue(item, session) {
  const descriptor = `${item.key} ${item.label || ""} ${item.description || ""}`.toLowerCase();
  if (descriptor.includes("next_probe")) {
    if (isCustomerStyleCall(session)) {
      return "Ask one softer customer-style follow-up that clarifies a visible effect without asking about internal operations directly.";
    }
    return "Ask one concrete follow-up that tightens the main answer without repeating the same question.";
  }
  if (/(peak|rush|busy|busiest|window|when)/.test(descriptor)) {
    return findPeakWindowAnswer(session) || "Not learned";
  }
  if (/impact/.test(descriptor)) {
    const answer = findCustomerPainAnswer(session);
    if (!answer || /space/i.test(answer)) return "Not learned";
    return answer;
  }
  if (/(quiet|calm|slow|off[- ]?peak|relaxed)/.test(descriptor)) {
    return "Not learned";
  }
  if (/(pain|challenge|constraint|friction|bottleneck|problem|impact|core_answer|answer|reason)/.test(descriptor)) {
    const answer = findCustomerPainAnswer(session);
    if (!answer) return "Not learned";
    if (/space/i.test(answer)) {
      return `They said "${answer}" and did not clarify what kind of space they meant.`;
    }
    return answer;
  }
  return "Not learned";
}

function buildFallbackStructuredAnalysis(session) {
  const schema = effectiveOutcomeSchema(session);
  const evidence = substantiveCustomerAnswers(session)
    .slice(0, 4)
    .map((text) => `"${text}"`);
  const peakWindow = findPeakWindowAnswer(session);
  const painAnswer = findCustomerPainAnswer(session);
  const tlDrParts = [];
  if (peakWindow) tlDrParts.push(`The clearest busy-time signal was ${peakWindow}.`);
  if (painAnswer) {
    tlDrParts.push(/space/i.test(painAnswer)
      ? `The strongest friction signal was the contact saying "${painAnswer}", but the meaning stayed ambiguous.`
      : `The strongest friction signal was "${painAnswer}".`);
  }
  if (!tlDrParts.length) {
    tlDrParts.push("The call produced only partial signal, so the safest summary is the direct transcript evidence below.");
  }
  return {
    tlDr: tlDrParts.join(" "),
    callDisposition: deriveFallbackCallDisposition(session),
    schemaResults: schema.map((item) => ({
      key: item.key,
      label: item.label,
      value: fallbackSchemaValue(item, session),
    })),
    evidence: evidence.length ? evidence : ["No strong evidence captured."],
    nextStep: isCustomerStyleCall(session)
      ? "If you retry, keep the follow-up customer-plausible and clarify one visible effect instead of asking about internal challenges."
      : "If you retry, ask one tighter follow-up that clarifies the strongest quoted signal.",
  };
}

function normalizeReasonForCalling(text, customerStyle) {
  const normalized = normalizeSentence(text);
  if (!normalized) return "";
  if (!customerStyle) return normalized;
  const wordCount = normalized.replace(/[.?!]+$/g, "").trim().split(/\s+/).filter(Boolean).length;
  if (wordCount > 12 || normalized.length > 72 || normalized.split(/[,;:]/).length > 1) {
    if (/\b(stop by|come by|swing by|drop by|come in|visit)\b/i.test(normalized)) {
      return "I wanted to ask something before I stop by.";
    }
    return "I wanted to ask something.";
  }
  return normalized;
}

function extractCustomerTimeHint(text) {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return "";
  const patterns = [
    /\b(around\s+\d{1,2}(?::\d{2})?(?:\s*(?:or|-|to)\s*\d{1,2}(?::\d{2})?)?(?:\s*(?:am|pm))?(?:\s+in the morning)?)\b/i,
    /\b(at\s+\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?(?:\s+in the morning)?)\b/i,
    /\b(in the morning)\b/i,
    /\b(at opening)\b/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function looksLikeCustomerHypothesisLeak(text) {
  const normalized = normalizeTranscriptText(text).toLowerCase();
  if (!normalized) return false;
  const hasQueueHypothesis = /\b(line|queue|wait(?:ing)? to order|order line|line to order)\b/.test(normalized);
  const hasSeatHypothesis = /\b(seat|sit down|find a seat|laptop|camp out|taken up|take up the seats)\b/.test(normalized);
  return normalized.includes("laptop people") || (hasQueueHypothesis && hasSeatHypothesis);
}

function normalizeFirstQuestion(text, customerStyle, goal = "") {
  const normalized = normalizeSentence(text);
  if (!normalized) return "";
  if (!customerStyle) return normalized;
  if (/\b(biggest challenge|pain point|bottleneck|breaks down|frustrates customers|hardest part|makes it feel busy)\b/i.test(normalized)) {
    if (/\b(wait|line|rush|busy|busiest|peak|crowd|crowded)\b/i.test(goal)) {
      return "If I wanted to avoid the rush, what time would you recommend?";
    }
    return "If I came by at a busy time, what would I notice most?";
  }
  if (looksLikeCustomerHypothesisLeak(normalized)) {
    const timeHint = extractCustomerTimeHint(normalized) || extractCustomerTimeHint(goal);
    if (timeHint) return `If I came ${timeHint}, what would I notice first?`;
    if (/\bmorning\b/i.test(`${normalized} ${goal}`)) {
      return "If I came by in the morning, what would I notice first?";
    }
    return "If I came by when it's busy, what would I notice first?";
  }
  return normalized;
}

function normalizeQuestionPlan(text, session) {
  const normalized = String(text || "").trim();
  if (!isCustomerStyleCall(session)) {
    return normalized || defaultQuestionPlan(session);
  }
  const customerGuardrails = [
    "Guardrails:",
    "- Do not reveal multiple hidden hypotheses in the first question.",
    "- Do not say 'laptop people', 'camp out', or 'take up the seats' unless the contact introduces that framing first.",
    "- If they answer vaguely with something like 'it's busy', ask at most one softer customer decision question about whether the caller should grab and go, sit briefly, or come at a calmer time.",
    "- If they sound suspicious after that softer follow-up, explain once in plain customer language and close.",
  ].join("\n");
  if (!normalized) return `${defaultQuestionPlan(session)}\n${customerGuardrails}`;
  return `${normalized}\n${customerGuardrails}`;
}

function formatStructuredSummary(session, analysis) {
  const schema = effectiveOutcomeSchema(session);
  const resultMap = new Map(
    Array.isArray(analysis?.schemaResults)
      ? analysis.schemaResults.map((item) => [String(item?.key || "").trim(), item])
      : [],
  );
  const renderedSchema = schema.map((item) => {
    const match = resultMap.get(item.key);
    const value = String(match?.value || "Not learned").trim() || "Not learned";
    return `- **${item.label}:** ${value}`;
  }).join("\n");
  const evidence = Array.isArray(analysis?.evidence) && analysis.evidence.length
    ? analysis.evidence.map((item) => `- ${String(item || "").trim()}`).join("\n")
    : "- No strong evidence captured.";

  return [
    "## TL;DR",
    String(analysis?.tlDr || "Summary not available.").trim(),
    "",
    "## Call Outcome",
    `- **Disposition:** ${String(analysis?.callDisposition || "unknown").trim() || "unknown"}`,
    "",
    "## Extracted Outcomes",
    renderedSchema || "- No extracted outcomes.",
    "",
    "## Evidence",
    evidence,
    "",
    "## Recommended Next Step",
    String(analysis?.nextStep || "No next step identified.").trim(),
  ].join("\n");
}

function currentElevenAgentFingerprint() {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      version: VOICE_DEMO_ELEVENLABS_AGENT_VERSION,
      prompt: buildElevenLabsAgentPromptTemplate(),
      llm: VOICE_DEMO_ELEVENLABS_LLM,
      ttsModel: VOICE_DEMO_ELEVENLABS_TTS_MODEL,
      voiceId: VOICE_DEMO_ELEVENLABS_VOICE_ID,
      builtInTools: ["end_call"],
    }))
    .digest("hex");
}

function sessionLabel(session) {
  return session.targetBusiness || session.targetName || session.toNumber || "voice discovery";
}

function firstMeaningfulSummaryLine(summary) {
  return String(summary || "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#")) || "";
}

function normalizeTranscriptText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function parseClockTimeTokenHoursAndMinutes(token) {
  const match = String(token || "").match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3].toUpperCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (hour === 12) hour = 0;
  if (meridiem === "PM") hour += 12;
  return { totalMinutes: (hour * 60) + minute, meridiem };
}

function isSequentialClockTimeLadder(text) {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return false;
  const timeTokens = normalized.match(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/gi) || [];
  if (timeTokens.length < 4) return false;

  const stripped = normalized
    .replace(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/gi, " ")
    .replace(/[.,!?;:/()\-]/g, " ")
    .replace(/\s+/g, "")
    .trim();
  if (stripped) return false;

  const parsed = timeTokens
    .map(parseClockTimeTokenHoursAndMinutes)
    .filter(Boolean);
  if (parsed.length !== timeTokens.length) return false;

  let sequentialSteps = 0;
  for (let i = 1; i < parsed.length; i += 1) {
    const delta = parsed[i].totalMinutes - parsed[i - 1].totalMinutes;
    if (delta === 1) sequentialSteps += 1;
  }
  return sequentialSteps >= Math.max(3, parsed.length - 2);
}

function sanitizeCommittedTranscript(session, trackState, text) {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return "";
  if (trackState?.speaker !== "customer") return normalized;
  if (!isSequentialClockTimeLadder(normalized)) return normalized;

  const fallback = normalizeTranscriptText(trackState.lastPartial);
  if (fallback && fallback !== trackState.lastCommitted && !isSequentialClockTimeLadder(fallback)) {
    recordEvent(session, "scribe_filter", `${trackState.track}: replaced suspicious committed transcript with partial`);
    return fallback;
  }

  recordEvent(session, "scribe_filter", `${trackState.track}: dropped suspicious committed transcript`);
  return "";
}

const IVR_DIGIT_TOKENS = Object.freeze({
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  star: "*",
  asterisk: "*",
  pound: "#",
  hash: "#",
});

function normalizeDtmfDigits(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[^0-9*#wW]/g, "")
    .trim();
}

function parseIvrDigitToken(token) {
  const normalized = String(token || "").trim().toLowerCase();
  if (!normalized) return "";
  if (/^[0-9*#]$/.test(normalized)) return normalized;
  return IVR_DIGIT_TOKENS[normalized] || "";
}

function parseIvrMenuOptions(text) {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return [];
  const options = [];
  const seen = new Set();
  const patterns = [
    {
      regex: /\b(?:press|dial|select|choose)\s+(zero|one|two|three|four|five|six|seven|eight|nine|[0-9]|star|asterisk|pound|hash)\b(?:\s+(?:for|to reach|to get|to select|to speak to|to connect to))?\s+(.+?)(?=(?:\s*,?\s*(?:press|dial|select|choose)\b|[.?!;]|$))/gi,
      digitIndex: 1,
      labelIndex: 2,
    },
    {
      regex: /\bfor\s+(.+?)\s*,?\s*(?:press|dial|select|choose)\s+(zero|one|two|three|four|five|six|seven|eight|nine|[0-9]|star|asterisk|pound|hash)\b/gi,
      digitIndex: 2,
      labelIndex: 1,
    },
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.regex.exec(normalized))) {
      const digit = parseIvrDigitToken(match[pattern.digitIndex]);
      const label = normalizeTranscriptText(match[pattern.labelIndex]).replace(/^(the|a|an)\s+/i, "");
      if (!digit || !label) continue;
      const dedupeKey = `${digit}:${label.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      options.push({ digit, label });
    }
  }
  return options;
}

function isLikelyIvrTranscript(text) {
  const normalized = normalizeTranscriptText(text).toLowerCase();
  if (!normalized) return false;
  if (parseIvrMenuOptions(normalized).length) return true;
  return normalized.includes("thank you for calling")
    || normalized.includes("main menu")
    || normalized.includes("please listen carefully")
    || normalized.includes("for the location")
    || /\bpress\s+(?:zero|one|two|three|four|five|six|seven|eight|nine|[0-9]|star|asterisk|pound|hash)\b/.test(normalized)
    || normalized.includes("to repeat this menu")
    || normalized.includes("to hear these options again");
}

function fingerprintIvrMenu(text, options = []) {
  const normalized = normalizeTranscriptText(text).toLowerCase();
  const optionSummary = options
    .map((option) => `${option.digit}:${option.label.toLowerCase()}`)
    .join("|");
  return crypto
    .createHash("sha1")
    .update(optionSummary || normalized)
    .digest("hex")
    .slice(0, 12);
}

function buildArtifactMarkdown(session) {
  const transcript = session.transcript.length
    ? session.transcript.map((entry) => {
      const speaker = entry.speaker === "agent" ? session.assistantName : "Customer";
      return `### ${speaker}\n${entry.text}`;
    }).join("\n\n")
    : "_No transcript captured._";

  const events = session.events.length
    ? session.events.map((event) => `- ${event.at} | ${event.type} | ${event.detail || ""}`.trim()).join("\n")
    : "_No events recorded._";

  const summary = session.summary || "_Summary not available yet._";
  const title = session.targetBusiness || session.targetName || session.toNumber || session.id;

  return [
    `# Voice Discovery Call: ${title}`,
    "",
    `- **Session ID:** ${session.id}`,
    `- **Status:** ${session.status}`,
    `- **Assistant:** ${session.assistantName}`,
    `- **Target Business:** ${session.targetBusiness || "Unknown"}`,
    `- **Target Person:** ${session.targetName || "Unknown"}`,
    `- **Phone:** ${session.toNumber || "Unknown"}`,
    `- **Created:** ${session.createdAt}`,
    `- **Updated:** ${session.updatedAt}`,
    session.callSid ? `- **Twilio Call SID:** ${session.callSid}` : "",
    "",
    "## Discovery Goal",
    session.discoveryGoal || "_Not provided._",
    "",
    "## PM Context",
    session.context || "_Not provided._",
    "",
    "## Reason For Calling",
    session.reasonForCalling || "_Not provided._",
    "",
    "## First Question",
    session.firstQuestion || "_Not provided._",
    "",
    "## Question Plan",
    session.questionPlan || "_Not provided._",
    "",
    "## Caller Persona",
    session.persona || "_Not provided._",
    "",
    "## Opening Line",
    session.opener || session.greeting || "_Not provided._",
    "",
    "## Outcome Schema",
    effectiveOutcomeSchema(session).map((item) => `- **${item.label}** (${item.key})${item.description ? ` — ${item.description}` : ""}`).join("\n"),
    "",
    "## PM Summary",
    summary,
    "",
    "## Transcript",
    transcript,
    "",
    "## Session Events",
    events,
    "",
  ].filter(Boolean).join("\n");
}

async function runModel(messages, { maxTokens = 180, temperature = 0.4 } = {}) {
  if (OPENROUTER_API_KEY) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": PUBLIC_BASE_URL || "https://openclaw-pm-agent-production.up.railway.app",
          "X-Title": "PM Agent Voice Sessions",
        },
        body: JSON.stringify({
          model: normalizeModelName(VOICE_DEMO_MODEL),
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
      });
      if (!response.ok) {
        const bodyText = await response.text();
        throw new Error(`OpenRouter error ${response.status}: ${bodyText.slice(0, 300)}`);
      }
      const json = await response.json();
      const content = json?.choices?.[0]?.message?.content;
      return typeof content === "string" ? content.trim() : "";
    } catch (err) {
      if (!OPENAI_API_KEY) throw err;
    }
  }

  if (OPENAI_API_KEY) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.VOICE_DEMO_OPENAI_MODEL?.trim() || "gpt-4o-mini",
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI error ${response.status}`);
    }
    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content.trim() : "";
  }

  throw new Error("No model provider configured for voice demo");
}

function coerceVoiceReply(text) {
  return String(text || "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildWebhookUrl(pathWithQuery = "") {
  return `${PUBLIC_BASE_URL}${pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`}`;
}

function buildWebSocketUrl(pathname = "") {
  return buildWebhookUrl(pathname).replace(/^http/i, "ws");
}

function webhookRequestIsValid(req) {
  const signature = req.headers["x-twilio-signature"];
  if (!signature || !TWILIO_AUTH_TOKEN) return false;
  try {
    return twilio.validateRequest(
      TWILIO_AUTH_TOKEN,
      String(signature),
      buildWebhookUrl(req.originalUrl || req.url || "/"),
      req.body || {},
    );
  } catch {
    return false;
  }
}

function snapshotSession(session) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    provider: session.provider,
    status: session.status,
    targetName: session.targetName,
    targetBusiness: session.targetBusiness,
    toNumber: session.toNumber,
    assistantName: session.assistantName,
    persona: session.persona,
    discoveryGoal: session.discoveryGoal,
    context: session.context,
    reasonForCalling: session.reasonForCalling,
    firstQuestion: session.firstQuestion,
    questionPlan: session.questionPlan,
    summaryInstructions: session.summaryInstructions,
    outcomeSchema: effectiveOutcomeSchema(session),
    callSid: session.callSid,
    relaySessionId: session.relaySessionId,
    elevenAgentId: session.elevenAgentId,
    lastError: session.lastError,
    transcript: session.transcript.slice(-80),
    events: session.events.slice(-30),
    summary: session.summary,
    artifactPath: session.artifactPath,
    monitorKey: session.monitorKey,
    monitorMode: session.monitorMode || VOICE_DEMO_MONITOR_MODE,
    monitorTelephonyDelayMs: session.monitorTelephonyDelayMs || VOICE_DEMO_MONITOR_TELEPHONY_DELAY_MS,
    monitorOutboundFallbackGain: session.monitorOutboundFallbackGain || VOICE_DEMO_MONITOR_OUTBOUND_FALLBACK_GAIN,
    ivr: session.ivr ? {
      detected: Boolean(session.ivr.detected),
      menuText: session.ivr.menuText || "",
      options: Array.isArray(session.ivr.options) ? session.ivr.options.slice(0, 12) : [],
      deciding: Boolean(session.ivr.deciding),
      awaitingResume: Boolean(session.ivr.awaitingResume),
      lastDigits: session.ivr.lastDigits || "",
      lastDigitsAt: session.ivr.lastDigitsAt || "",
      lastDecision: session.ivr.lastDecision || "",
    } : null,
  };
}

export function createVoiceDemo(options = {}) {
  const workspaceDir = String(options.workspaceDir || process.env.OPENCLAW_WORKSPACE_DIR || "").trim();
  const stateDir = String(options.stateDir || process.env.OPENCLAW_STATE_DIR || "").trim();
  const voiceOutputDir = workspaceDir ? path.join(workspaceDir, "output", "voice-demo") : "";
  const workLogPath = workspaceDir ? path.join(workspaceDir, "WORK_LOG.md") : "";
  const memoryDir = workspaceDir ? path.join(workspaceDir, "memory") : "";
  const elevenStatePath = stateDir ? path.join(stateDir, "voice-demo-elevenlabs.json") : "";
  const sessions = new Map();
  const relayWss = new WebSocketServer({ noServer: true });
  const mediaWss = new WebSocketServer({ noServer: true });
  const monitorWss = new WebSocketServer({ noServer: true });
  const monitorClients = new Map();
  const twilioClient = voiceDemoConfigured()
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;
  let cachedElevenAgentId = ELEVENLABS_AGENT_ID;
  let cachedElevenAgentFingerprint = ELEVENLABS_AGENT_ID ? currentElevenAgentFingerprint() : "";

  function recordEvent(session, type, detail = "") {
    session.updatedAt = nowIso();
    session.events.push({
      id: crypto.randomUUID(),
      at: session.updatedAt,
      type,
      detail,
    });
    if (session.events.length > 200) session.events.shift();
  }

  function clearScheduledHangup(session) {
    if (!session?.hangupTimer) return;
    clearTimeout(session.hangupTimer);
    session.hangupTimer = null;
    session.hangupPendingReason = "";
  }

  function clearScheduledFinalize(session) {
    if (!session?.finalizeTimer) return;
    clearTimeout(session.finalizeTimer);
    session.finalizeTimer = null;
  }

  function isFarewellText(text) {
    const normalized = normalizeTranscriptText(text).toLowerCase();
    if (!normalized) return false;
    return /\b(bye|goodbye|have a good one|have a good day|take care|see you)\b/.test(normalized)
      || /(thank you[,! ]+bye)/.test(normalized);
  }

  function isShortThanksClose(text) {
    const normalized = normalizeTranscriptText(text).toLowerCase();
    if (!normalized) return false;
    return normalized.length <= 36
      && /^(okay[, ]+)?(thanks|thank you)( so much)?[.! ]*$/.test(normalized);
  }

  function isShortAcknowledgementText(text) {
    const normalized = normalizeTranscriptText(text).toLowerCase();
    if (!normalized || normalized.includes("?") || normalized.length > 48) return false;
    return /^(ok|okay|great|sounds good|all right|alright|got it|perfect|sure|yeah|yep|nice|awesome|thank you|thanks|appreciate it|no worries|no problem)([.! ,]+(thanks|thank you|bye))?[.! ]*$/.test(normalized)
      || /^(great|ok|okay|sounds good|all right|alright)[.! ,]+(thank you|thanks)[.! ]*$/.test(normalized);
  }

  function isClosingCueText(text) {
    const normalized = normalizeTranscriptText(text).toLowerCase();
    if (!normalized) return false;
    return isFarewellText(normalized)
      || isShortThanksClose(normalized)
      || normalized.includes("that's all")
      || normalized.includes("that is all")
      || normalized.includes("anything else")
      || normalized.includes("that's it")
      || normalized.includes("that is it");
  }

  function isAgentWrapUpText(text) {
    const normalized = normalizeTranscriptText(text).toLowerCase();
    if (!normalized || normalized.includes("?")) return false;
    return /\b(thanks|thank you|helpful|appreciate|that helps|plan to come|i'll come|i will come|got it)\b/.test(normalized);
  }

  function isExplicitAgentFarewellText(text) {
    const normalized = normalizeTranscriptText(text).toLowerCase();
    if (!normalized) return false;
    return /\b(bye|goodbye|take care|have a good one|have a good day|see you)\b/.test(normalized);
  }

  function lastAgentCloseHasExplicitFarewell(session) {
    return isExplicitAgentFarewellText(session?.lastAgentCloseText || "");
  }

  function hasActiveCloseState(session) {
    return session?.closeState === "agent_wrapping"
      || session?.closeState === "agent_farewell"
      || session?.closeState === "customer_waiting_for_agent_farewell"
      || session?.closeState === "customer_acknowledged_close";
  }

  function scheduleCustomerCloseFollowThrough(session, reasonAfterFarewell, reasonAwaitingFarewell, delayAfterFarewell, delayAwaitingFarewell) {
    if (!session) return;
    if (lastAgentCloseHasExplicitFarewell(session)) {
      session.closeState = "customer_acknowledged_close";
      scheduleCallHangup(session, reasonAfterFarewell, delayAfterFarewell);
      return;
    }
    session.closeState = "customer_waiting_for_agent_farewell";
    scheduleCallHangup(session, reasonAwaitingFarewell, delayAwaitingFarewell);
  }

  async function requestCallHangup(session, reason) {
    if (!session || !session.callSid || !twilioClient || session.status === "completed" || session.hangupRequested) return;
    session.hangupRequested = true;
    session.hangupPendingReason = "";
    recordEvent(session, "hangup_requested", reason);
    try {
      await twilioClient.calls(session.callSid).update({ status: "completed" });
    } catch (err) {
      session.hangupRequested = false;
      session.lastError = err.message;
      recordEvent(session, "hangup_error", err.message);
    }
  }

  function ensureIvrState(session) {
    if (!session.ivr) {
      session.ivr = {
        detected: false,
        menuText: "",
        options: [],
        menuHash: "",
        attemptedMenuHashes: [],
        lastEvaluatedMenuKey: "",
        deciding: false,
        awaitingResume: false,
        lastDigits: "",
        lastDigitsAt: "",
        lastDecision: "",
      };
    }
    return session.ivr;
  }

  async function chooseIvrDigitsForMenu(session, menuText, options, { source = "committed" } = {}) {
    if (!options.length) {
      return { digits: "", reason: "No actionable IVR options were parsed." };
    }
    if (source !== "partial" && options.length === 1) {
      return {
        digits: options[0].digit,
        reason: `Only one IVR option was available: ${options[0].label}.`,
      };
    }

    const result = await runModel([
      {
        role: "system",
        content: [
          "You route automated phone menus for a live outbound caller.",
          "Return strict JSON only with this shape: {\"digits\":\"1\"|\"2\"|...|\"NONE\",\"reason\":\"one short sentence\"}.",
          "Choose the single best menu option from the provided digits based on the call brief.",
          source === "partial"
            ? "The transcript may be partial. Only choose a digit if a currently listed option is already a clear match to explicit branch or location cues in the brief. Otherwise return digits as \"NONE\" until more of the menu arrives."
            : "If the call brief does not clearly identify one branch, return digits as \"NONE\".",
          "Never invent digits, locations, or branches that are not in the menu.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Target business: ${session.targetBusiness || "Unknown"}`,
          `Target person: ${session.targetName || "Unknown"}`,
          `Goal: ${session.discoveryGoal || "Unknown"}`,
          `Context: ${session.context || "None provided"}`,
          `Reason for calling: ${session.reasonForCalling || "None provided"}`,
          `First question: ${session.firstQuestion || "None provided"}`,
          "",
          "Menu options:",
          ...options.map((option) => `- ${option.digit}: ${option.label}`),
          "",
          `Raw menu transcript: ${menuText || "Not available"}`,
        ].join("\n"),
      },
    ], { maxTokens: 80, temperature: 0 });

    const parsed = extractJsonObject(result) || {};
    const digits = normalizeDtmfDigits(
      parsed.digits || parsed.digit || parsed.selection || parsed.key || "",
    ).slice(0, 1);
    const reason = normalizeSentence(parsed.reason || "");
    const validDigits = new Set(options.map((option) => option.digit));
    if (!digits || digits.toUpperCase() === "N" || !validDigits.has(digits)) {
      return {
        digits: "",
        reason: reason || "No single menu option matched the call brief closely enough.",
      };
    }
    return {
      digits,
      reason: reason || `Selected IVR option ${digits}.`,
    };
  }

  function buildSendDigitsTwiml(session, digits) {
    const normalizedDigits = normalizeDtmfDigits(digits);
    const response = new twilio.twiml.VoiceResponse();
    response.pause({ length: 1 });
    response.play({ digits: normalizedDigits });
    response.pause({ length: 1 });
    response.redirect(
      { method: "POST" },
      buildWebhookUrl(`/twilio/voice/call?sessionId=${encodeURIComponent(session.id)}&ivrResume=1`),
    );
    return response.toString();
  }

  async function sendCallDigits(session, digits, { source = "auto", reason = "" } = {}) {
    if (!session || !twilioClient || !session.callSid) {
      throw new Error("Call is not active");
    }
    const normalizedDigits = normalizeDtmfDigits(digits);
    if (!normalizedDigits || !/^[0-9*#wW]+$/.test(normalizedDigits)) {
      throw new Error("Invalid DTMF digits");
    }

    const ivr = ensureIvrState(session);
    ivr.lastDigits = normalizedDigits;
    ivr.lastDigitsAt = nowIso();
    ivr.awaitingResume = true;
    ivr.lastDecision = normalizeSentence(reason || `Sent IVR digits ${normalizedDigits}`) || `Sent IVR digits ${normalizedDigits}.`;
    session.status = "ivr_navigating";
    recordEvent(session, "dtmf_sent", `${source}:${normalizedDigits}${reason ? ` | ${reason}` : ""}`);

    await twilioClient.calls(session.callSid).update({
      twiml: buildSendDigitsTwiml(session, normalizedDigits),
    });
  }

  async function maybeAutoNavigateIvr(session, { source = "committed" } = {}) {
    if (!session || !twilioClient || !session.callSid) return false;
    const ivr = ensureIvrState(session);
    if (!ivr.detected || ivr.deciding || ivr.awaitingResume || !ivr.menuHash || !ivr.options.length) return false;
    if (ivr.attemptedMenuHashes.includes(ivr.menuHash)) return false;
    const evaluationKey = `${source}:${ivr.menuHash}`;
    if (ivr.lastEvaluatedMenuKey === evaluationKey) return false;

    ivr.deciding = true;
    ivr.lastEvaluatedMenuKey = evaluationKey;
    recordEvent(session, "ivr_deciding", `${source}:${ivr.options.length} parsed menu option(s)`);
    try {
      const decision = await chooseIvrDigitsForMenu(session, ivr.menuText, ivr.options, { source });
      ivr.lastDecision = decision.reason || "";
      if (!decision.digits) {
        recordEvent(session, "ivr_no_match", `${source}:${decision.reason || "No IVR selection made"}`);
        return false;
      }
      ivr.attemptedMenuHashes.push(ivr.menuHash);
      await sendCallDigits(session, decision.digits, { source: "auto_model", reason: decision.reason });
      recordEvent(session, "ivr_autonavigate", `${decision.digits}${decision.reason ? ` | ${decision.reason}` : ""}`);
      return true;
    } catch (err) {
      session.lastError = err.message;
      recordEvent(session, "ivr_error", err.message);
      return false;
    } finally {
      ivr.deciding = false;
    }
  }

  function maybeHandleIvrTranscript(session, speaker, text, source = "committed") {
    if (!session || speaker !== "customer") return false;
    const normalized = normalizeTranscriptText(text);
    if (!normalized || !isLikelyIvrTranscript(normalized)) return false;

    const ivr = ensureIvrState(session);
    const options = parseIvrMenuOptions(normalized);
    const menuHash = fingerprintIvrMenu(normalized, options);
    const menuChanged = menuHash && ivr.menuHash !== menuHash;
    ivr.detected = true;
    ivr.menuText = normalized;
    ivr.options = options;
    ivr.menuHash = menuHash;

    if (menuChanged && (source === "committed" || options.length)) {
      const optionSummary = options.length
        ? options.map((option) => `${option.digit}:${option.label}`).join(" | ")
        : normalized.slice(0, 160);
      recordEvent(session, "ivr_detected", optionSummary);
    }

    if (options.length && menuChanged) {
      maybeAutoNavigateIvr(session, { source }).catch(() => {});
    }
    return true;
  }

  function scheduleCallHangup(session, reason, delayMs = 900) {
    if (!session || !session.callSid || session.status === "completed") return;
    clearScheduledHangup(session);
    session.hangupPendingReason = reason;
    session.hangupTimer = setTimeout(() => {
      session.hangupTimer = null;
      requestCallHangup(session, reason).catch(() => {});
    }, delayMs);
    session.hangupTimer.unref?.();
  }

  function scheduleFinalizeSession(session, statusOverride = "", delayMs = 0) {
    if (!session || session.finalized) return;
    clearScheduledFinalize(session);
    session.finalizeTimer = setTimeout(() => {
      session.finalizeTimer = null;
      finalizeSession(session, statusOverride).catch((err) => {
        session.lastError = err.message;
        recordEvent(session, "finalize_error", err.message);
      });
    }, Math.max(0, delayMs));
    session.finalizeTimer.unref?.();
  }

  function handleTranscriptSideEffects(session, speaker, text) {
    if (!session || !text) return;
    const normalized = normalizeTranscriptText(text);
    if (!normalized) return;
    if (session.hangupPendingReason) {
      clearScheduledHangup(session);
    }
    if (speaker === "agent") {
      if (isAgentWrapUpText(normalized)) {
        session.closeState = "agent_wrapping";
        session.lastAgentCloseText = normalized;
        scheduleCallHangup(session, "agent_wrap_silence_timeout", 4500);
      } else if (session.closeState !== "open") {
        session.closeState = "open";
        session.lastAgentCloseText = "";
      }
      if (isExplicitAgentFarewellText(normalized)) {
        session.closeState = "agent_farewell";
        session.lastAgentCloseText = normalized;
        scheduleCallHangup(session, "agent_farewell", 1700);
        return;
      }
    }
    if (speaker === "customer" && isFarewellText(normalized)) {
      if (hasActiveCloseState(session)) {
        scheduleCustomerCloseFollowThrough(
          session,
          "customer_ack_after_agent_close",
          "customer_farewell_waiting_for_agent_farewell",
          2600,
          4200
        );
      } else {
        scheduleCallHangup(session, "customer_farewell", 650);
      }
      return;
    }
    if (speaker === "customer" && isClosingCueText(normalized)) {
      if (hasActiveCloseState(session)) {
        scheduleCustomerCloseFollowThrough(
          session,
          "customer_close_ack",
          "customer_close_ack_waiting_for_agent_farewell",
          2800,
          4200
        );
      } else {
        scheduleCallHangup(session, "customer_closing", 850);
      }
      return;
    }
    if (speaker === "customer" && isShortAcknowledgementText(normalized)) {
      if (hasActiveCloseState(session)) {
        scheduleCustomerCloseFollowThrough(
          session,
          "customer_acknowledgment",
          "customer_ack_waiting_for_agent_farewell",
          3000,
          4300
        );
        return;
      }
    }
    if (speaker === "customer" && session.closeState !== "open") {
      session.closeState = "open";
      session.lastAgentCloseText = "";
    }
  }

  function recordTranscript(session, speaker, text) {
    const normalized = normalizeTranscriptText(text);
    if (!normalized) return;
    const lastEntry = session.transcript[session.transcript.length - 1];
    if (lastEntry && lastEntry.speaker === speaker && normalizeTranscriptText(lastEntry.text) === normalized) {
      return;
    }
    session.updatedAt = nowIso();
    session.transcript.push({
      id: crypto.randomUUID(),
      at: session.updatedAt,
      speaker,
      text: normalized,
    });
    if (session.transcript.length > 300) session.transcript.shift();
    maybeHandleIvrTranscript(session, speaker, normalized, "committed");
    handleTranscriptSideEffects(session, speaker, normalized);
  }

  function getMonitorClientSet(sessionId) {
    if (!monitorClients.has(sessionId)) {
      monitorClients.set(sessionId, new Set());
    }
    return monitorClients.get(sessionId);
  }

  function broadcastMonitorMessage(sessionId, message) {
    const clients = monitorClients.get(sessionId);
    if (!clients || !clients.size) return;
    const serialized = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }

  function ensureMonitorState(session) {
    if (!session.monitorState) {
      session.monitorState = {
        trackTimestamps: {
          inbound: null,
          outbound: null,
        },
        cleanAgentSequence: 0,
      };
    }
    return session.monitorState;
  }

  function updateMonitorTrackTimestamp(session, track, timestamp) {
    if (!session || !Number.isFinite(timestamp) || timestamp < 0) return;
    const state = ensureMonitorState(session);
    const key = track === "outbound" ? "outbound" : "inbound";
    state.trackTimestamps[key] = timestamp;
  }

  async function synthesizeMonitorAgentAudio(text) {
    const params = new URLSearchParams({
      output_format: `pcm_${VOICE_DEMO_MONITOR_AGENT_PCM_RATE}`,
    });
    const response = await fetch(`${ELEVENLABS_API_BASE_URL}/v1/text-to-speech/${encodeURIComponent(VOICE_DEMO_ELEVENLABS_VOICE_ID)}?${params.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        text,
        model_id: VOICE_DEMO_MONITOR_TTS_MODEL,
      }),
    });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`ElevenLabs monitor TTS error ${response.status}: ${bodyText.slice(0, 300)}`);
    }
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    return {
      audioBase64: audioBuffer.toString("base64"),
      sampleRate: VOICE_DEMO_MONITOR_AGENT_PCM_RATE,
      durationMs: Math.round((audioBuffer.length / 2 / VOICE_DEMO_MONITOR_AGENT_PCM_RATE) * 1000),
    };
  }

  async function maybeBroadcastCleanAgentMonitorAudio(session, text) {
    if (!voiceDemoUsesHybridCleanAgentMonitor() || !session || !text) return;
    const normalized = normalizeTranscriptText(text);
    if (!normalized) return;
    const state = ensureMonitorState(session);
    const endTimestampMs = state.trackTimestamps.outbound;
    if (!Number.isFinite(endTimestampMs) || endTimestampMs < 0) return;
    const sequence = ++state.cleanAgentSequence;
    try {
      const cleanAudio = await synthesizeMonitorAgentAudio(normalized);
      if (!sessions.has(session.id) || sequence !== state.cleanAgentSequence) return;
      broadcastMonitorMessage(session.id, {
        type: "agent_clean_audio",
        text: normalized,
        audioBase64: cleanAudio.audioBase64,
        sampleRate: cleanAudio.sampleRate,
        durationMs: cleanAudio.durationMs,
        endTimestamp: endTimestampMs,
      });
    } catch (err) {
      recordEvent(session, "monitor_synth_error", err.message);
    }
  }

  function readElevenState() {
    if (!elevenStatePath || !fs.existsSync(elevenStatePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(elevenStatePath, "utf8"));
    } catch {
      return {};
    }
  }

  function writeElevenState(nextState) {
    if (!elevenStatePath) return;
    fs.mkdirSync(path.dirname(elevenStatePath), { recursive: true });
    fs.writeFileSync(elevenStatePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  }

  async function elevenlabsRequestJson(apiPath, body) {
    const response = await fetch(`${ELEVENLABS_API_BASE_URL}${apiPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_API_KEY,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`ElevenLabs error ${response.status}: ${bodyText.slice(0, 400)}`);
    }
    return response.json();
  }

  async function elevenlabsRequestText(apiPath, body) {
    const response = await fetch(`${ELEVENLABS_API_BASE_URL}${apiPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_API_KEY,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`ElevenLabs error ${response.status}: ${bodyText.slice(0, 400)}`);
    }
    return response.text();
  }

  async function createElevenLabsAgent() {
    const payload = {
      name: VOICE_DEMO_ELEVENLABS_AGENT_NAME,
      ignore_default_personality: true,
      conversation_config: {
        asr: {
          provider: "elevenlabs",
          quality: "high",
          user_input_audio_format: "ulaw_8000",
        },
        turn: {
          turn_timeout: 7,
          initial_wait_time: 1.1,
          silence_end_call_timeout: 10,
          turn_eagerness: "normal",
          speculative_turn: false,
          soft_timeout_config: {
            timeout_seconds: 6,
            message: "Could you say that one more time?",
            use_llm_generated_message: false,
          },
        },
        tts: {
          model_id: VOICE_DEMO_ELEVENLABS_TTS_MODEL,
          voice_id: VOICE_DEMO_ELEVENLABS_VOICE_ID,
          agent_output_audio_format: "ulaw_8000",
          optimize_streaming_latency: 1,
          stability: 0.45,
          speed: 0.97,
          similarity_boost: 0.82,
        },
        conversation: {
          max_duration_seconds: 210,
          client_events: ["audio", "interruption"],
        },
        agent: {
          first_message: "{{opener}}",
          language: "en",
          disable_first_message_interruptions: false,
          prompt: {
            prompt: buildElevenLabsAgentPromptTemplate(),
            llm: VOICE_DEMO_ELEVENLABS_LLM,
            temperature: 0.25,
            max_tokens: 180,
            built_in_tools: {
              end_call: {
                type: "system",
                name: "end_call",
                description: "End the call when the conversation naturally concludes, when the callee clearly indicates they are done, or after the main question and any useful follow-up have been answered. Prefer a one-line close that already contains the farewell, such as 'Got it, thanks so much, bye.' Give a brief chance for the callee to acknowledge or say bye, and if they answer your closing with a short thanks or bye, reply once with a short farewell before ending the call. The final spoken line before calling end_call must contain an explicit farewell word like 'bye' or 'goodbye'; never end the call immediately after a wrap-up line that lacks a farewell.",
                response_timeout_secs: 20,
                params: {
                  system_tool_type: "end_call",
                },
              },
            },
          },
        },
      },
      tags: ["pm-agent", "voice-demo"],
    };

    const created = await elevenlabsRequestJson("/v1/convai/agents/create", payload);
    const agentId = String(created?.agent_id || "").trim();
    if (!agentId) {
      throw new Error("ElevenLabs agent creation returned no agent_id");
    }

    cachedElevenAgentId = agentId;
    cachedElevenAgentFingerprint = currentElevenAgentFingerprint();
    writeElevenState({
      agentId,
      name: VOICE_DEMO_ELEVENLABS_AGENT_NAME,
      createdAt: nowIso(),
      fingerprint: cachedElevenAgentFingerprint,
    });
    return agentId;
  }

  async function ensureElevenLabsAgent() {
    const expectedFingerprint = currentElevenAgentFingerprint();
    if (cachedElevenAgentId && cachedElevenAgentFingerprint === expectedFingerprint) return cachedElevenAgentId;
    const stored = readElevenState();
    const storedId = String(stored.agentId || "").trim();
    const storedFingerprint = String(stored.fingerprint || "").trim();
    if (storedId && storedFingerprint === expectedFingerprint) {
      cachedElevenAgentId = storedId;
      cachedElevenAgentFingerprint = storedFingerprint;
      return storedId;
    }
    return createElevenLabsAgent();
  }

  function extractTwimlResponseBody(xmlText) {
    const match = String(xmlText || "").match(/<Response[^>]*>([\s\S]*)<\/Response>/i);
    return match ? match[1].trim() : String(xmlText || "").trim();
  }

  function buildMediaStreamInnerTwiml(session) {
    const response = new twilio.twiml.VoiceResponse();
    const start = response.start();
    const stream = start.stream({
      url: buildWebSocketUrl("/twilio/media"),
      track: "both_tracks",
    });
    stream.parameter({ name: "sessionId", value: session.id });
    stream.parameter({ name: "mediaKey", value: session.mediaKey });
    return extractTwimlResponseBody(response.toString());
  }

  async function buildElevenLabsRegisterCallTwiml(session, fromNumber, toNumber) {
    const agentId = await ensureElevenLabsAgent();
    const runtimeContext = [
      session.context || "Keep the call outcome-focused and ask concrete follow-up questions.",
      session.ivr?.awaitingResume
        ? "An automated phone menu may have just been navigated. Do not greet the menu or answer for the business. Wait for a live human, then continue naturally."
        : "",
    ].filter(Boolean).join(" ");
    const twiml = await elevenlabsRequestText("/v1/convai/twilio/register-call", {
      agent_id: agentId,
      from_number: fromNumber,
      to_number: toNumber,
      direction: "outbound",
      conversation_initiation_client_data: {
        dynamic_variables: {
          pm_session_id: session.id,
          assistant_name: session.assistantName,
          target_name: isMeaningfulTargetLabel(session.targetName) ? session.targetName : "there",
          target_business: isMeaningfulTargetLabel(session.targetBusiness) ? session.targetBusiness : "the business",
          discovery_goal: session.discoveryGoal || "learn the clearest answer to the caller's main question and qualify it with concrete details",
          context: runtimeContext,
          persona: session.persona || "Stay in the caller identity implied by the PM brief and opener.",
          reason_for_call: session.reasonForCalling || "I wanted to ask something before I stop by.",
          first_question: session.firstQuestion || "Ask the clearest first question implied by the PM brief as soon as the other person confirms you reached the right place.",
          question_plan: session.questionPlan || defaultQuestionPlan(session),
          opener: session.greeting,
        },
      },
    });
    session.elevenAgentId = agentId;
    recordEvent(session, "elevenlabs_registered", agentId);
    const pauseTag = VOICE_DEMO_INITIAL_ANSWER_PAUSE_SECONDS > 0
      ? `<Pause length="${VOICE_DEMO_INITIAL_ANSWER_PAUSE_SECONDS}"/>`
      : "";
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${buildMediaStreamInnerTwiml(session)}${pauseTag}${extractTwimlResponseBody(twiml)}</Response>`;
  }

  function ensureSpeechTracks(session) {
    if (!session.speechTracks) {
      session.speechTracks = {
        inbound: {
          track: "inbound",
          speaker: "customer",
          socket: null,
          queue: [],
          ready: false,
          lastCommitted: "",
          lastPartial: "",
        },
        outbound: {
          track: "outbound",
          speaker: "agent",
          socket: null,
          queue: [],
          ready: false,
          lastCommitted: "",
          lastPartial: "",
        },
      };
    }
    return session.speechTracks;
  }

  function flushSpeechTrack(trackState) {
    if (!trackState.ready || !trackState.socket || trackState.socket.readyState !== WebSocket.OPEN) return;
    while (trackState.queue.length) {
      trackState.socket.send(trackState.queue.shift());
    }
  }

  function connectSpeechTrack(session, trackState) {
    if (!ELEVENLABS_API_KEY || trackState.socket) return;
    const sttUrl = `${ELEVENLABS_API_BASE_URL.replace(/^http/i, "ws")}/v1/speech-to-text/realtime?model_id=${encodeURIComponent(VOICE_DEMO_SCRIBE_MODEL)}&audio_format=ulaw_8000&language_code=en&commit_strategy=vad&include_timestamps=true`;
    const socket = new WebSocket(sttUrl, {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
    });
    trackState.socket = socket;

    socket.on("open", () => {
      trackState.ready = true;
      recordEvent(session, "scribe_connected", trackState.track);
      flushSpeechTrack(trackState);
    });

    socket.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      const type = String(msg.message_type || "");
      if (type === "partial_transcript") {
        const partialText = normalizeTranscriptText(msg.text);
        if (!partialText || partialText === trackState.lastPartial || partialText === trackState.lastCommitted) return;
        trackState.lastPartial = partialText;
        if (trackState.speaker === "customer") {
          maybeHandleIvrTranscript(session, "customer", partialText, "partial");
        }
        const partialTimestamp = ensureMonitorState(session).trackTimestamps[trackState.track];
        broadcastMonitorMessage(session.id, {
          type: "transcript_partial",
          speaker: trackState.speaker,
          text: partialText,
          timestamp: Number.isFinite(partialTimestamp) ? partialTimestamp : null,
        });
        return;
      }
      if (type !== "committed_transcript" && type !== "committed_transcript_with_timestamps") return;
      const committedTimestamp = ensureMonitorState(session).trackTimestamps[trackState.track];
      const text = sanitizeCommittedTranscript(session, trackState, msg.text);
      trackState.lastPartial = "";
      broadcastMonitorMessage(session.id, {
        type: "transcript_partial",
        speaker: trackState.speaker,
        text: "",
        timestamp: Number.isFinite(committedTimestamp) ? committedTimestamp : null,
      });
      if (!text || text === trackState.lastCommitted) return;
      trackState.lastCommitted = text;
      recordTranscript(session, trackState.speaker, text);
      broadcastMonitorMessage(session.id, {
        type: "transcript",
        speaker: trackState.speaker,
        text,
        timestamp: Number.isFinite(committedTimestamp) ? committedTimestamp : null,
      });
      if (trackState.speaker === "agent") {
        maybeBroadcastCleanAgentMonitorAudio(session, text).catch(() => {});
      }
    });

    socket.on("error", (err) => {
      recordEvent(session, "scribe_error", `${trackState.track}: ${err.message}`);
    });

    socket.on("close", () => {
      trackState.ready = false;
      trackState.socket = null;
    });
  }

  function sendSpeechAudio(session, track, payload) {
    if (!payload || !voiceDemoUsesElevenLabsRegisterCall()) return;
    const tracks = ensureSpeechTracks(session);
    const trackState = tracks[track];
    if (!trackState) return;
    connectSpeechTrack(session, trackState);
    const frame = JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: payload,
      sample_rate: 8000,
    });
    if (trackState.ready && trackState.socket?.readyState === WebSocket.OPEN) {
      trackState.socket.send(frame);
      return;
    }
    if (trackState.queue.length < 400) trackState.queue.push(frame);
  }

  function closeSpeechTracks(session) {
    if (!session?.speechTracks) return;
    for (const trackState of Object.values(session.speechTracks)) {
      const openSocket = trackState.socket?.readyState === WebSocket.OPEN ? trackState.socket : null;
      try {
        if (openSocket) {
          openSocket.send(JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: "",
            sample_rate: 8000,
            commit: true,
          }));
        }
      } catch { /* ignore */ }
      if (openSocket) {
        setTimeout(() => {
          try {
            openSocket.close();
          } catch { /* ignore */ }
        }, 1000).unref?.();
      } else {
        try {
          trackState.socket?.close();
        } catch { /* ignore */ }
      }
      trackState.socket = null;
      trackState.ready = false;
      trackState.queue = [];
    }
  }

  function buildFallbackReply(session) {
    const goal = String(session.discoveryGoal || "").trim();
    if (isCustomerStyleCall(session)) {
      return "If I wanted to avoid the rush, what time would you recommend coming instead?";
    }
    if (goal) {
      return `What part of ${goal.replace(/\.$/, "")} tends to get toughest in practice?`;
    }
    return "What part of that tends to get toughest in practice?";
  }

  function ensureArtifactPath(session) {
    if (session.artifactPath || !workspaceDir) return session.artifactPath;
    const created = new Date(session.createdAt || Date.now());
    const datePart = localDateStamp(created);
    const slug = slugify(session.targetBusiness || session.targetName || session.toNumber || "voice-discovery");
    const filename = `${datePart}-${slug}-${session.id.slice(0, 8)}.md`;
    session.artifactPath = path.posix.join("output", "voice-demo", filename);
    session.artifactAbsolutePath = path.join(voiceOutputDir, filename);
    return session.artifactPath;
  }

  function persistSessionArtifacts(session) {
    if (!workspaceDir) return "";
    const artifactPath = ensureArtifactPath(session);
    if (!artifactPath || !session.artifactAbsolutePath) return "";

    fs.mkdirSync(path.dirname(session.artifactAbsolutePath), { recursive: true });
    fs.writeFileSync(session.artifactAbsolutePath, buildArtifactMarkdown(session), "utf8");

    if (!session.artifactLogged) {
      const created = new Date(session.createdAt || Date.now());
      const datePart = localDateStamp(created);
      const timePart = localTimeStamp(created);
      const summaryLine = firstMeaningfulSummaryLine(session.summary);
      fs.mkdirSync(path.dirname(workLogPath), { recursive: true });
      fs.appendFileSync(
        workLogPath,
        `${datePart} ${timePart} | voice discovery call with ${sessionLabel(session)} | ${artifactPath}\n`,
        "utf8",
      );

      if (memoryDir) {
        fs.mkdirSync(memoryDir, { recursive: true });
        const memoryPath = path.join(memoryDir, `${datePart}.md`);
        const blockLines = [
          "",
          `## Voice Discovery Call — ${timePart}`,
          `- Target: ${sessionLabel(session)}`,
          `- Status: ${session.status}`,
          `- Saved: ${artifactPath}`,
        ];
        if (summaryLine) blockLines.push(`- Summary: ${summaryLine}`);
        fs.appendFileSync(memoryPath, `${blockLines.join("\n")}\n`, "utf8");
      }

      session.artifactLogged = true;
      recordEvent(session, "saved", artifactPath);
    }

    return artifactPath;
  }

  function createSession(payload) {
    const outcomeSchema = normalizeOutcomeSchema(payload.outcomeSchema);
    const session = {
      id: crypto.randomUUID(),
      provider: voiceDemoUsesElevenLabsRegisterCall() ? "elevenlabs-register-call" : "relay",
      relayKey: crypto.randomBytes(24).toString("hex"),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: "created",
      assistantName: String(payload.assistantName || VOICE_DEMO_SYSTEM_NAME).trim() || VOICE_DEMO_SYSTEM_NAME,
      targetName: String(payload.targetName || "").trim(),
      targetBusiness: String(payload.targetBusiness || "").trim(),
      toNumber: normalizePhoneNumber(payload.toNumber),
      discoveryGoal: String(payload.discoveryGoal || "").trim(),
      context: String(payload.context || "").trim(),
      reasonForCalling: String(payload.reasonForCalling || payload.callReason || "").trim(),
      firstQuestion: String(payload.firstQuestion || "").trim(),
      questionPlan: String(payload.questionPlan || payload.callPlan || "").trim(),
      summaryInstructions: String(payload.summaryInstructions || "").trim(),
      opener: String(payload.opener || "").trim(),
      persona: String(payload.persona || "").trim(),
      outcomeSchema,
      ttsVoice: String(payload.ttsVoice || VOICE_DEMO_TTS_VOICE).trim() || VOICE_DEMO_TTS_VOICE,
      greeting: "",
      callSid: null,
      relaySessionId: null,
      elevenAgentId: "",
      mediaStreamSid: null,
      lastError: "",
      promptBuffer: "",
      generation: 0,
      history: [],
      transcript: [],
      events: [],
      summary: "",
      analysis: null,
      artifactPath: "",
      artifactAbsolutePath: "",
      artifactLogged: false,
      finalized: false,
      finalizeTimer: null,
      completionAt: "",
      closeState: "open",
      lastAgentCloseText: "",
      hangupTimer: null,
      hangupPendingReason: "",
      hangupRequested: false,
      mediaKey: crypto.randomBytes(24).toString("hex"),
      monitorKey: crypto.randomBytes(24).toString("hex"),
      monitorMode: voiceDemoUsesHybridCleanAgentMonitor() ? "hybrid_clean_agent" : "telephony_live",
      monitorTelephonyDelayMs: VOICE_DEMO_MONITOR_TELEPHONY_DELAY_MS,
      monitorOutboundFallbackGain: VOICE_DEMO_MONITOR_OUTBOUND_FALLBACK_GAIN,
      monitorState: null,
      speechTracks: null,
      ivr: null,
    };
    const customerStyle = isCustomerStyleCall(session);
    session.reasonForCalling = normalizeReasonForCalling(session.reasonForCalling, customerStyle);
    session.firstQuestion = normalizeFirstQuestion(session.firstQuestion, customerStyle, session.discoveryGoal);
    session.questionPlan = normalizeQuestionPlan(session.questionPlan, session);
    session.greeting = buildGreeting(session);
    session.history.push({ role: "assistant", content: session.greeting });
    if (!voiceDemoUsesElevenLabsRegisterCall()) {
      recordTranscript(session, "agent", session.greeting);
    }
    recordEvent(session, "created", `Prepared call to ${session.toNumber}`);
    sessions.set(session.id, session);
    return session;
  }

  async function generateAssistantReply(session, userText) {
    const messages = [
      { role: "system", content: buildSystemPrompt(session) },
      ...session.history.slice(-10),
      { role: "user", content: userText },
    ];
    const result = await runModel(messages, { maxTokens: 140, temperature: 0.35 });
    return coerceVoiceReply(result);
  }

  async function generatePostCallSummary(session) {
    if (!session.transcript.length) return "";
    const result = await runModel([
      { role: "system", content: "You analyze phone calls and return precise structured JSON." },
      { role: "user", content: buildStructuredSummaryPrompt(session) },
    ], { maxTokens: 420, temperature: 0.2 });
    const parsed = extractJsonObject(result);
    const analysis = parsed || buildFallbackStructuredAnalysis(session);
    if (!parsed) {
      recordEvent(session, "summary_fallback", "Used deterministic fallback after invalid JSON");
    }
    session.analysis = analysis;
    session.summary = formatStructuredSummary(session, analysis);
    session.updatedAt = nowIso();
    recordEvent(session, "summary_ready", "Generated PM summary");
    return session.summary;
  }

  async function finalizeSession(session, statusOverride = "") {
    if (!session || session.finalized) return;
    session.finalized = true;
    clearScheduledFinalize(session);
    clearScheduledHangup(session);
    session.hangupRequested = false;
    if (statusOverride) session.status = statusOverride;
    if (voiceDemoUsesElevenLabsRegisterCall()) {
      await delay(2200);
    }
    const lastTranscript = session.transcript[session.transcript.length - 1];
    if (voiceDemoUsesElevenLabsRegisterCall()
      && lastTranscript
      && lastTranscript.speaker === "customer"
      && session.status === "completed") {
      recordEvent(session, "closeout_gap", "Call ended after customer turn; final agent close may have been provider-side or not transcribed");
    }
    if (!session.summary && session.transcript.length > 1) {
      try {
        await generatePostCallSummary(session);
      } catch (err) {
        session.lastError = err.message;
        recordEvent(session, "summary_error", err.message);
      }
    }
    try {
      persistSessionArtifacts(session);
    } catch (err) {
      session.lastError = err.message;
      recordEvent(session, "persist_error", err.message);
    }
  }

  relayWss.on("connection", (socket) => {
    let session = null;

    socket.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.type === "setup") {
        const sessionId = msg?.customParameters?.sessionId;
        session = sessions.get(sessionId) || null;
        if (!session) {
          socket.close(1011, "Unknown session");
          return;
        }
        session.status = "connected";
        session.callSid = msg.callSid || session.callSid;
        session.relaySessionId = msg.sessionId || session.relaySessionId;
        recordEvent(session, "relay_connected", `Call ${session.callSid || ""}`.trim());
        return;
      }

      if (!session) return;

      if (msg.type === "prompt") {
        session.promptBuffer += String(msg.voicePrompt || "");
        if (!msg.last) return;

        const callerText = session.promptBuffer.replace(/\s+/g, " ").trim();
        session.promptBuffer = "";
        if (!callerText) return;

        session.status = "thinking";
        recordTranscript(session, "customer", callerText);
        session.history.push({ role: "user", content: callerText });
        recordEvent(session, "prompt", callerText);
        broadcastMonitorMessage(session.id, {
          type: "transcript",
          speaker: "customer",
          text: callerText,
        });

        const generation = ++session.generation;
        try {
          const reply = await generateAssistantReply(session, callerText);
          if (!reply || generation !== session.generation) return;

          session.history.push({ role: "assistant", content: reply });
          recordTranscript(session, "agent", reply);
          session.status = "speaking";
          broadcastMonitorMessage(session.id, {
            type: "transcript",
            speaker: "agent",
            text: reply,
          });
          socket.send(JSON.stringify({
            type: "text",
            token: reply,
            last: true,
            interruptible: true,
            preemptible: true,
          }));
          recordEvent(session, "response", reply);
        } catch (err) {
          session.status = "error";
          session.lastError = err.message;
          recordEvent(session, "error", err.message);
          const fallbackReply = buildFallbackReply(session);
          session.history.push({ role: "assistant", content: fallbackReply });
          recordTranscript(session, "agent", fallbackReply);
          broadcastMonitorMessage(session.id, {
            type: "transcript",
            speaker: "agent",
            text: fallbackReply,
          });
          socket.send(JSON.stringify({
            type: "text",
            token: fallbackReply,
            last: true,
            interruptible: true,
            preemptible: true,
          }));
        }
        return;
      }

      if (msg.type === "interrupt") {
        session.generation += 1;
        session.status = "interrupted";
        recordEvent(session, "interrupt", String(msg.utteranceUntilInterrupt || ""));
        return;
      }

      if (msg.type === "error") {
        session.status = "error";
        session.lastError = String(msg.description || "Unknown Twilio relay error");
        recordEvent(session, "relay_error", session.lastError);
      }
    });

    socket.on("close", async () => {
      if (!session) return;
      recordEvent(session, "relay_closed", session.status);
      if (session.status === "completed") {
        scheduleFinalizeSession(session, "", 0);
      }
    });
  });

  mediaWss.on("connection", (socket) => {
    let session = null;

    socket.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.event === "start") {
        const custom = msg.start?.customParameters || {};
        const sessionId = String(custom.sessionId || "");
        const mediaKey = String(custom.mediaKey || "");
        const candidate = sessions.get(sessionId);
        if (!candidate || candidate.mediaKey !== mediaKey) {
          socket.close(1008, "Unauthorized media stream");
          return;
        }
        session = candidate;
        session.mediaStreamSid = msg.streamSid || session.mediaStreamSid;
        recordEvent(session, "media_stream_started", session.mediaStreamSid || "stream");
        ensureSpeechTracks(session);
        broadcastMonitorMessage(session.id, { type: "media_ready" });
        return;
      }

      if (!session) return;

      if (msg.event === "media" && msg.media?.payload) {
        updateMonitorTrackTimestamp(session, msg.media.track || "inbound", Number(msg.media.timestamp || 0));
        sendSpeechAudio(session, msg.media.track || "inbound", msg.media.payload);
        broadcastMonitorMessage(session.id, {
          type: "media",
          track: msg.media.track || "inbound",
          payload: msg.media.payload,
          timestamp: Number(msg.media.timestamp || 0),
        });
        return;
      }

      if (msg.event === "stop") {
        recordEvent(session, "media_stream_stopped", msg.stop?.reason || "stop");
        closeSpeechTracks(session);
        broadcastMonitorMessage(session.id, { type: "media_stopped" });
      }
    });

    socket.on("close", () => {
      if (!session) return;
      closeSpeechTracks(session);
      broadcastMonitorMessage(session.id, { type: "media_closed" });
    });
  });

  monitorWss.on("connection", (socket, req) => {
    let sessionId = "";
    try {
      const parsed = new URL(req.url, "http://localhost");
      sessionId = String(parsed.searchParams.get("sessionId") || "");
      const monitorKey = String(parsed.searchParams.get("monitorKey") || "");
      const session = sessions.get(sessionId);
      if (!session || session.monitorKey !== monitorKey) {
        socket.close(1008, "Unauthorized monitor");
        return;
      }
      getMonitorClientSet(sessionId).add(socket);
      socket.send(JSON.stringify({ type: "monitor_connected" }));
    } catch {
      socket.close(1008, "Bad request");
      return;
    }

    socket.on("close", () => {
      const clients = monitorClients.get(sessionId);
      if (!clients) return;
      clients.delete(socket);
      if (!clients.size) monitorClients.delete(sessionId);
    });
  });

  setInterval(() => {
    const cutoff = Date.now() - SESSION_RETENTION_MS;
    for (const [id, session] of sessions.entries()) {
      const updated = Date.parse(session.updatedAt || session.createdAt || 0);
      if (Number.isFinite(updated) && updated < cutoff) {
        closeSpeechTracks(session);
        sessions.delete(id);
      }
    }
  }, 15 * 60 * 1000).unref?.();

  function renderVoiceDemoPage() {
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voice Sessions - PM Agent</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#F9F9F9;
  --surface:#FFFFFF;
  --text:#1E1E1E;
  --muted:#6B6B6B;
  --border:#E5E5E5;
  --cta:#2F2F2F;
  --ok:#2E7D32;
  --warn:#B26A00;
  --danger:#C62828;
  --agent:#EEF4FF;
  --agent-strong:#2563EB;
  --target:#F5F5F5;
  --target-strong:#1E1E1E;
  --font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:.875rem 1.25rem;border-bottom:1px solid var(--border);background:#fff}
.brand{display:flex;flex-direction:column;gap:.1rem}
.brand strong{font-size:1.05rem;letter-spacing:-.02em;line-height:1}
.brand span{font-size:.7rem;color:var(--muted)}
.top-links{display:flex;align-items:center;gap:1.25rem;font-size:.875rem}
.top-links a{color:var(--muted)}
.top-links a:hover{color:var(--text)}
.shell{max-width:1200px;margin:0 auto;padding:1.5rem 1.5rem 3rem}
.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;margin-bottom:1rem}
.hero h1{margin:0;font-size:1.9rem;letter-spacing:-.03em}
.hero p{margin:.35rem 0 0;color:var(--muted);max-width:720px;line-height:1.5}
.status-pill{display:inline-flex;align-items:center;gap:.45rem;padding:.35rem .7rem;border-radius:999px;background:#F3F4F6;font-size:.8rem;font-weight:600}
.status-dot{width:8px;height:8px;border-radius:50%;background:#9CA3AF}
.status-dot.ok{background:var(--ok)}
.status-dot.warn{background:var(--warn)}
.status-dot.danger{background:var(--danger)}
.layout{display:grid;grid-template-columns:300px 1fr;gap:1rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1rem;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.card h2,.card h3{margin:0}
.subtle,.muted{font-size:.82rem;color:var(--muted);line-height:1.45}
.stack{display:flex;flex-direction:column;gap:.75rem}
.rail-card-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:.5rem}
.rail-note{margin-bottom:.9rem}
.session-list{display:flex;flex-direction:column;gap:.55rem}
.session-item{display:flex;align-items:flex-start;justify-content:space-between;gap:.65rem;padding:.8rem .85rem;border:1px solid var(--border);border-radius:10px;background:#FCFCFC;transition:border-color .15s, background .15s}
.session-item:hover{border-color:#D4D4D4;background:#FAFAFA}
.session-item.active{border-color:#D9E5FF;background:#F7FAFF}
.session-item-link{display:block;flex:1;min-width:0}
.session-item-title{font-size:.86rem;font-weight:600;line-height:1.3}
.session-item-meta{font-size:.76rem;color:var(--muted);margin-top:.25rem}
.session-delete{display:inline-flex;align-items:center;justify-content:center;padding:.1rem 0;border:none;background:transparent;color:var(--muted);font:inherit;font-size:.74rem;font-weight:500;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .15s,color .15s}
.session-item:hover .session-delete,.session-item.active .session-delete,.session-delete:focus-visible{opacity:1;pointer-events:auto}
.session-delete:hover{color:var(--text)}
.session-delete:disabled{opacity:1;pointer-events:none;color:#AFAFAF}
.empty{color:var(--muted);font-size:.88rem;padding:1rem 0}
.control-stack{display:flex;flex-direction:column;gap:.65rem}
.audio-btn{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;width:100%;padding:.8rem 1rem;border:none;border-radius:10px;background:var(--cta);color:#fff;font:inherit;font-weight:600;cursor:pointer;transition:opacity .15s}
.audio-btn:hover{opacity:.9}
.audio-btn.off{background:#E5E7EB;color:#1E1E1E}
.audio-btn:disabled{opacity:.55;cursor:not-allowed}
.hangup-btn{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;width:100%;padding:.8rem 1rem;border:1px solid #E7C8C8;border-radius:10px;background:#FFF7F7;color:#8F2D2D;font:inherit;font-weight:600;cursor:pointer;transition:opacity .15s,border-color .15s,background .15s}
.hangup-btn:hover{opacity:.92;border-color:#D9A3A3;background:#FFF1F1}
.hangup-btn:disabled{opacity:.55;cursor:not-allowed}
.main-stack{display:flex;flex-direction:column;gap:1rem}
.session-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.session-title{font-size:1.1rem;font-weight:700}
.meta-line{margin-top:.25rem;color:var(--muted);font-size:.84rem}
.speaker-grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-top:.9rem}
.speaker-card{position:relative;overflow:hidden;border:1px solid var(--border);border-radius:14px;padding:1rem;background:#FBFBFB;transition:transform .2s, border-color .2s, background .2s, box-shadow .2s}
.speaker-card.agent{background:var(--agent)}
.speaker-card.active{transform:translateY(-1px);box-shadow:0 8px 18px rgba(0,0,0,.06)}
.speaker-card.agent.active{border-color:#C7D8FF;background:#EAF2FF}
.speaker-card.customer.active{border-color:#D6D6D6;background:#F7F7F7}
.speaker-top{display:flex;align-items:center;gap:.8rem;margin-bottom:.8rem}
.speaker-avatar{width:42px;height:42px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:.95rem;font-weight:700;flex-shrink:0}
.speaker-card.agent .speaker-avatar{background:#DCE8FF;color:var(--agent-strong)}
.speaker-card.customer .speaker-avatar{background:#ECECEC;color:var(--target-strong)}
.speaker-label{font-size:.72rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.speaker-name{font-size:.95rem;font-weight:700;line-height:1.2}
.speaker-copy{font-size:.82rem;color:var(--muted);min-height:2.4em}
.speaker-live{margin-top:.45rem;font-size:.78rem;line-height:1.45;color:#4B5563;min-height:1.2em}
.speaker-live.active{color:#1F2937}
.speaker-live:empty::before{content:"";}
.wave{display:flex;align-items:flex-end;gap:4px;height:24px}
.wave span{display:block;width:4px;height:8px;border-radius:999px;background:rgba(37,99,235,.25);transform-origin:center bottom}
.speaker-card.customer .wave span{background:rgba(30,30,30,.2)}
.speaker-card.active .wave span{animation:wave 1s ease-in-out infinite}
.speaker-card.active .wave span:nth-child(2){animation-delay:.12s}
.speaker-card.active .wave span:nth-child(3){animation-delay:.24s}
.speaker-card.active .wave span:nth-child(4){animation-delay:.36s}
.speaker-card.active .wave span:nth-child(5){animation-delay:.48s}
@keyframes wave{0%,100%{transform:scaleY(.45)}50%{transform:scaleY(1.4)}}
.transcript-head,.panel-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:.75rem}
.artifact,.schema-line{font-size:.76rem;color:var(--muted)}
.artifact code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#F5F5F5;padding:.15rem .35rem;border-radius:6px}
.schema-line code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#F5F5F5;padding:.15rem .35rem;border-radius:6px;margin-right:.35rem}
.transcript{display:flex;flex-direction:column;gap:.75rem;max-height:440px;overflow:auto;padding-right:.15rem}
.bubble{max-width:88%;padding:.8rem .9rem;border:1px solid var(--border);border-radius:14px;background:#FAFAFA}
.bubble.agent{align-self:flex-start;background:#F4F8FF;border-color:#DCE8FF}
.bubble.customer{align-self:flex-end;background:#FCFCFC}
.bubble-meta{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:.3rem}
.bubble-who{font-size:.72rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.bubble-time{font-size:.72rem;color:#A0A0A0}
.bubble-text{white-space:pre-wrap;word-break:break-word;line-height:1.5}
.bubble.partial{opacity:.72;border-style:dashed}
.split{display:block}
.timeline{display:flex;flex-direction:column;gap:.55rem;max-height:360px;overflow:auto}
.event{padding:.65rem .75rem;border:1px dashed #E4E4E4;border-radius:10px;background:#FCFCFC}
.event-type{font-size:.72rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.2rem}
pre.summary{margin:0;white-space:pre-wrap;word-break:break-word;background:#FCFCFC;border:1px solid var(--border);border-radius:10px;padding:.9rem;font:inherit;line-height:1.55}
.summary-markdown{background:#FCFCFC;border:1px solid var(--border);border-radius:10px;padding:.95rem 1rem;line-height:1.6}
.summary-markdown h4{margin:.15rem 0 .55rem;font-size:.95rem;letter-spacing:-.01em}
.summary-markdown p{margin:.45rem 0}
.summary-markdown ul{margin:.35rem 0 .7rem;padding-left:1.15rem}
.summary-markdown li{margin:.22rem 0}
.summary-markdown code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#F2F2F2;padding:.08rem .3rem;border-radius:5px}
@media(max-width:980px){.layout,.split,.speaker-grid{grid-template-columns:1fr}.shell{padding:1rem 1rem 2rem}.session-delete{opacity:1;pointer-events:auto}}
</style></head><body>
<div class="topbar">
  <a href="/" class="brand"><strong>PM AGENT</strong><span>OpenClaw</span></a>
  <div class="top-links">
    <a href="/">Home</a>
    <a href="/chat?session=main">Chat</a>
    <a href="/connectors">Connectors</a>
    <a href="/memory">Memory</a>
  </div>
</div>
<div class="shell">
  <div class="hero">
    <div>
      <h1>Voice Sessions</h1>
      <p>Calls start from chat through the voice discovery skill. This workspace is for live listening, transcript review, and structured post-call synthesis.</p>
    </div>
    <div class="status-pill"><span id="globalDot" class="status-dot"></span><span id="globalStatus">Waiting</span></div>
  </div>

  <div class="layout">
    <aside class="stack">
      <section class="card">
        <div class="rail-card-head">
          <h2>Live Feed</h2>
          <a href="/chat?session=main" class="subtle">Start from chat</a>
        </div>
        <p class="subtle rail-note">Voice is driven by the skill. Open an active call here to hear the browser audio path, watch the transcript, and review the summary.</p>
        <div class="control-stack">
          <button id="audioToggle" class="audio-btn off" type="button">Enable Live Audio</button>
          <button id="hangupBtn" class="hangup-btn" type="button" disabled>End Call</button>
        </div>
        <p id="audioStatus" class="subtle" style="margin-top:.65rem">Audio is off. Click once to let this page play the live call stream.</p>
      </section>

      <section class="card">
        <div class="rail-card-head">
          <h2>Recent Sessions</h2>
          <span id="sessionCount" class="subtle"></span>
        </div>
        <div id="sessionList" class="session-list"><div class="empty">Loading sessions…</div></div>
      </section>
    </aside>

    <main class="main-stack">
      <section class="card">
        <div class="session-head">
          <div>
            <div id="sessionTitle" class="session-title">No session selected</div>
            <div id="metaLine" class="meta-line">Choose a recent session or start one from chat.</div>
          </div>
          <div class="status-pill"><span id="sessionDot" class="status-dot"></span><span id="sessionStatus">Idle</span></div>
        </div>

        <div class="speaker-grid">
          <div id="callerCard" class="speaker-card agent">
            <div class="speaker-top">
              <div id="callerAvatar" class="speaker-avatar">A</div>
              <div>
                <div class="speaker-label">Caller</div>
                <div id="callerName" class="speaker-name">Agent</div>
              </div>
            </div>
            <div class="wave" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
            <div id="callerCopy" class="speaker-copy">Waiting for the next call.</div>
            <div id="callerLive" class="speaker-live"></div>
          </div>

          <div id="targetCard" class="speaker-card customer">
            <div class="speaker-top">
              <div id="targetAvatar" class="speaker-avatar">T</div>
              <div>
                <div class="speaker-label">Target</div>
                <div id="targetName" class="speaker-name">Target</div>
              </div>
            </div>
            <div class="wave" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
            <div id="targetCopy" class="speaker-copy">Transcript and status updates will show here.</div>
            <div id="targetLive" class="speaker-live"></div>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="transcript-head">
          <h3>Transcript</h3>
          <div id="artifactLine" class="artifact"></div>
        </div>
        <div id="transcript" class="transcript"><div class="empty">No transcript yet.</div></div>
      </section>

      <section class="card split">
        <div class="panel-head"><h3>Summary</h3><span id="providerLine" class="subtle"></span></div>
        <div id="schemaLine" class="schema-line"></div>
        <div id="summaryWrap"><div class="empty">The summary will appear here after the call ends.</div></div>
      </section>
    </main>
  </div>
</div>

<script>
(function(){
  function freshTrackSchedule(){
    return {
      inbound: { lastStart: 0, lastTimestamp: null, lastVoiceAt: null, lastRms: 0 },
      outbound: { lastStart: 0, lastTimestamp: null, lastVoiceAt: null, lastRms: 0 },
      agentClean: { lastStart: 0, lastTimestamp: null, lastVoiceAt: null, lastRms: 0 }
    };
  }

  function freshMonitorTimeline(){
    return {
      baseTimestamp: null,
      baseAudioTime: 0,
      turnCursor: 0
    };
  }

  var currentSessionId = new URLSearchParams(window.location.search).get('sessionId') || '';
  var pollTimer = null;
  var sessionsTimer = null;
  var liveTranscriptItems = [];
  var transcriptTimers = [];
  var livePartialText = {
    agent: '',
    customer: ''
  };
  var renderState = {
    transcriptKey: '',
    eventsKey: '',
    summaryKey: '',
    schemaKey: '',
    artifactKey: ''
  };
  var hangupRequestInFlight = false;
  var sessionDeleteInFlightId = '';
  var latestSessionList = [];
  var audioState = {
    available: !!((window.AudioContext || window.webkitAudioContext) && window.WebSocket),
    enabled: false,
    socket: null,
    context: null,
    masterInput: null,
    masterGain: null,
    busMode: '',
    graphInit: null,
    liveGraphReady: false,
    basicMonitorFallback: false,
    workletModuleUrl: '',
    monitorKey: '',
    connectedSessionId: '',
    trackSchedule: freshTrackSchedule(),
    timeline: freshMonitorTimeline(),
    monitorMode: 'telephony_live',
    telephonyDelayMs: 1550,
    outboundFallbackGain: 0.08,
    livePlaybackDelayMs: 220,
    trackNodes: { inbound: null, outbound: null },
    trackGains: { inbound: null, outbound: null },
    trackActivity: { inbound: 0, outbound: 0 },
    duckTimer: 0,
    pendingFrames: []
  };

  function monitorUsesLegacyHybrid(){
    return audioState.monitorMode === 'hybrid_clean_agent';
  }

  function esc(value){
    return String(value || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function inlineMarkdown(value){
    var tick = String.fromCharCode(96);
    var codePattern = new RegExp(tick + '([^' + tick + ']+)' + tick, 'g');
    var boldPattern = new RegExp('\\\\*\\\\*([^*]+)\\\\*\\\\*', 'g');
    var emPattern = new RegExp('\\\\*([^*]+)\\\\*', 'g');
    return esc(value || '')
      .replace(codePattern, '<code>$1</code>')
      .replace(boldPattern, '<strong>$1</strong>')
      .replace(emPattern, '<em>$1</em>');
  }

  function renderMarkdownSummary(markdown){
    var lineBreakPattern = new RegExp('\\\\r?\\\\n');
    var lines = String(markdown || '').split(lineBreakPattern);
    var html = '';
    var inList = false;
    function closeList(){
      if (inList) {
        html += '</ul>';
        inList = false;
      }
    }
    lines.forEach(function(line){
      var trimmed = line.trim();
      if (!trimmed) {
        closeList();
        return;
      }
      if (trimmed.indexOf('## ') === 0) {
        closeList();
        html += '<h4>' + inlineMarkdown(trimmed.slice(3)) + '</h4>';
        return;
      }
      if (trimmed.indexOf('- ') === 0) {
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        html += '<li>' + inlineMarkdown(trimmed.slice(2)) + '</li>';
        return;
      }
      closeList();
      html += '<p>' + inlineMarkdown(trimmed) + '</p>';
    });
    closeList();
    return html;
  }

  function statusTone(status){
    status = String(status || '').toLowerCase();
    if (status.includes('error')) return 'danger';
    if (status === 'completed' || status === 'speaking' || status === 'in-progress' || status === 'connected') return 'ok';
    if (status && status !== 'created' && status !== 'idle') return 'warn';
    return '';
  }

  function setStatus(target, dot, status){
    target.textContent = status || 'Idle';
    dot.className = 'status-dot ' + statusTone(status);
  }

  function formatClock(iso){
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (_err) {
      return '';
    }
  }

  function formatSessionLabel(session){
    return session.targetBusiness || session.targetName || session.toNumber || 'Untitled session';
  }

  function normalizedStatus(value){
    return String(value || '').toLowerCase();
  }

  function isTerminalSessionStatus(status){
    var normalized = normalizedStatus(status);
    return normalized.indexOf('completed') >= 0
      || normalized.indexOf('error') >= 0
      || normalized.indexOf('canceled') >= 0
      || normalized.indexOf('cancelled') >= 0
      || normalized.indexOf('failed') >= 0
      || normalized.indexOf('busy') >= 0
      || normalized.indexOf('no-answer') >= 0
      || normalized.indexOf('rejected') >= 0;
  }

  function isOngoingSession(item){
    if (!item) return false;
    var status = normalizedStatus(item.status);
    if (!status || status === 'idle') return false;
    if (isTerminalSessionStatus(status)) return false;
    return !!(item.callSid || item.relaySessionId || item.elevenAgentId || item.monitorKey || status === 'created');
  }

  function preferredSessionId(items){
    if (!items || !items.length) return '';
    var selected = null;
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].id === currentSessionId) {
        selected = items[i];
        break;
      }
    }
    var live = null;
    for (var j = 0; j < items.length; j += 1) {
      if (isOngoingSession(items[j])) {
        live = items[j];
        break;
      }
    }
    if (!selected) return live ? live.id : items[0].id;
    if (live && live.id !== selected.id && isTerminalSessionStatus(selected.status)) return live.id;
    return selected.id;
  }

  function resetRenderState(){
    renderState.transcriptKey = '';
    renderState.eventsKey = '';
    renderState.summaryKey = '';
    renderState.schemaKey = '';
    renderState.artifactKey = '';
    liveTranscriptItems = [];
    transcriptTimers.forEach(function(timer){ clearTimeout(timer); });
    transcriptTimers = [];
    livePartialText.agent = '';
    livePartialText.customer = '';
  }

  function listSignature(items){
    return JSON.stringify((items || []).map(function(item){
      return [item.id || '', item.speaker || '', item.type || '', item.at || '', item.text || '', item.detail || ''];
    }));
  }

  function shouldStickToBottom(root){
    return root.scrollHeight - root.scrollTop - root.clientHeight < 28;
  }

  function setCurrentSessionId(sessionId){
    var nextId = sessionId || '';
    if (nextId === currentSessionId) return;
    if (audioState.connectedSessionId && audioState.connectedSessionId !== nextId) {
      closeMonitorSocket();
      if (audioState.enabled) updateMonitorStatus('Switching live audio to the latest call…');
    }
    audioState.monitorKey = '';
    currentSessionId = nextId;
    resetRenderState();
    var url = new URL(window.location.href);
    if (currentSessionId) url.searchParams.set('sessionId', currentSessionId);
    else url.searchParams.delete('sessionId');
    history.replaceState({}, '', url.toString());
  }

  function canDeleteSession(item){
    return !!(item && isTerminalSessionStatus(item.status));
  }

  function renderSessionList(items){
    var root = document.getElementById('sessionList');
    latestSessionList = items || [];
    document.getElementById('sessionCount').textContent = items && items.length ? String(items.length) : '';
    if (!items || !items.length) {
      root.innerHTML = '<div class="empty">No voice sessions yet. Start one from chat with the voice discovery skill.</div>';
      return;
    }
    root.innerHTML = items.map(function(item){
      var active = item.id === currentSessionId ? ' active' : '';
      var deleteLabel = sessionDeleteInFlightId === item.id ? 'Deleting…' : 'Delete';
      var deleteDisabled = sessionDeleteInFlightId === item.id ? ' disabled' : '';
      var deleteButton = canDeleteSession(item)
        ? '<button class="session-delete" type="button" data-session-delete="' + esc(item.id) + '"' + deleteDisabled + '>' + esc(deleteLabel) + '</button>'
        : '';
      return '<div class="session-item' + active + '">'
        + '<a class="session-item-link" href="/voice/live?sessionId=' + encodeURIComponent(item.id) + '" data-session-id="' + esc(item.id) + '">'
        + '<div class="session-item-title">' + esc(formatSessionLabel(item)) + '</div>'
        + '<div class="session-item-meta">' + esc(item.status || 'idle') + ' · ' + esc(formatClock(item.updatedAt)) + '</div>'
        + '</a>'
        + deleteButton
        + '</div>';
    }).join('');
    root.querySelectorAll('[data-session-id]').forEach(function(node){
      node.addEventListener('click', function(ev){
        ev.preventDefault();
        setCurrentSessionId(node.getAttribute('data-session-id'));
        loadSession();
      });
    });
    root.querySelectorAll('[data-session-delete]').forEach(function(node){
      node.addEventListener('click', function(ev){
        ev.preventDefault();
        ev.stopPropagation();
        deleteSession(node.getAttribute('data-session-delete'));
      });
    });
  }

  function renderTranscript(items){
    var root = document.getElementById('transcript');
    var key = listSignature(items);
    if (key === renderState.transcriptKey) return;
    var stick = shouldStickToBottom(root);
    if (!items || !items.length) {
      root.innerHTML = '<div class="empty">No transcript yet.</div>';
      renderState.transcriptKey = key;
      return;
    }
    root.innerHTML = items.map(function(item){
      var who = item.speaker === 'agent' ? 'Caller' : 'Target';
      var cls = item.speaker === 'agent' ? 'bubble agent' : 'bubble customer';
      return '<div class="' + cls + '">'
        + '<div class="bubble-meta"><span class="bubble-who">' + who + '</span><span class="bubble-time">' + esc(formatClock(item.at)) + '</span></div>'
        + '<div class="bubble-text">' + esc(item.text || '') + '</div>'
        + '</div>';
    }).join('');
    if (stick) root.scrollTop = root.scrollHeight;
    renderState.transcriptKey = key;
  }

  function syncLiveTranscript(items){
    liveTranscriptItems = (items || []).map(function(item){
      return {
        id: item.id || '',
        speaker: item.speaker || '',
        at: item.at || '',
        text: item.text || '',
        partial: false
      };
    });
  }

  function appendLiveTranscriptEntry(speaker, text){
    var normalizedSpeaker = speaker === 'agent' ? 'agent' : 'customer';
    var normalizedText = String(text || '').trim();
    if (!normalizedText) return;
    var last = liveTranscriptItems[liveTranscriptItems.length - 1];
    if (last && last.speaker === normalizedSpeaker && last.text === normalizedText) return;
    liveTranscriptItems = liveTranscriptItems.concat([{
      id: 'live-' + Date.now() + '-' + liveTranscriptItems.length,
      speaker: normalizedSpeaker,
      at: new Date().toISOString(),
      text: normalizedText,
      partial: false
    }]);
    renderTranscript(liveTranscriptItems);
  }

  function updateLiveSpeakerPreview(){
    var callerLive = document.getElementById('callerLive');
    var targetLive = document.getElementById('targetLive');
    var agentText = livePartialText.agent ? ('Hearing now: ' + livePartialText.agent) : '';
    var customerText = livePartialText.customer ? ('Hearing now: ' + livePartialText.customer) : '';
    callerLive.textContent = agentText;
    targetLive.textContent = customerText;
    callerLive.classList.toggle('active', !!agentText);
    targetLive.classList.toggle('active', !!customerText);
    refreshMonitorMix();
  }

  function setLivePartialText(speaker, text){
    var key = speaker === 'agent' ? 'agent' : 'customer';
    livePartialText[key] = String(text || '').trim();
    updateLiveSpeakerPreview();
  }

  function transcriptDisplayDelayMs(timestampMs){
    if (!monitorUsesLegacyHybrid()) return 0;
    if (!audioState.enabled || !audioState.available || !Number.isFinite(timestampMs) || timestampMs <= 0) return 0;
    var ctx = ensureAudioContext();
    if (!ctx) return 0;
    if (audioState.timeline.baseTimestamp == null) return 0;
    var scheduledAt = audioState.timeline.baseAudioTime + Math.max(0, (timestampMs - audioState.timeline.baseTimestamp) / 1000);
    return Math.max(0, ((scheduledAt + 0.04) - ctx.currentTime) * 1000);
  }

  function scheduleTranscriptEntry(speaker, text, timestampMs){
    var normalizedSpeaker = speaker === 'agent' ? 'agent' : 'customer';
    var normalizedText = String(text || '').trim();
    if (!normalizedText) return;
    var delayMs = transcriptDisplayDelayMs(timestampMs);
    if (!delayMs) {
      appendLiveTranscriptEntry(normalizedSpeaker, normalizedText);
      return;
    }
    var timer = setTimeout(function(){
      transcriptTimers = transcriptTimers.filter(function(entry){ return entry !== timer; });
      appendLiveTranscriptEntry(normalizedSpeaker, normalizedText);
    }, delayMs);
    transcriptTimers.push(timer);
  }

  function renderEvents(items){
    var root = document.getElementById('events');
    if (!root) {
      renderState.eventsKey = listSignature(items || []);
      return;
    }
    var visible = (items || []).filter(function(item){
      return ['created','dialing','call_status','twiml_served','media_stream_started','media_stream_stopped','hangup_requested','summary_ready','saved','call_error','provider_error','summary_error','hangup_error','finalize_error'].indexOf(item.type) >= 0;
    });
    var key = listSignature(visible);
    if (key === renderState.eventsKey) return;
    if (!visible.length) {
      root.innerHTML = '<div class="empty">No events yet.</div>';
      renderState.eventsKey = key;
      return;
    }
    function labelForEvent(item){
      var labels = {
        created: 'Prepared',
        dialing: 'Dialing',
        call_status: 'Call Status',
        twiml_served: 'Voice Agent',
        media_stream_started: 'Live Audio',
        media_stream_stopped: 'Live Audio',
        hangup_requested: 'Ending Call',
        summary_ready: 'Summary',
        saved: 'Saved',
        call_error: 'Error',
        provider_error: 'Error',
        summary_error: 'Error',
        hangup_error: 'Error',
        finalize_error: 'Error'
      };
      return labels[item.type] || 'Event';
    }
    function detailForEvent(item){
      if (item.type === 'hangup_requested') {
        var reasons = {
          user_requested: 'Ended from dashboard',
          customer_farewell: 'Customer said goodbye',
          customer_closing: 'Customer started closing the call',
          customer_ack_after_agent_close: 'Customer acknowledged the closing exchange',
          customer_farewell_waiting_for_agent_farewell: 'Waiting briefly for the caller to say goodbye back',
          customer_close_ack: 'Customer acknowledged the closing exchange',
          customer_close_ack_waiting_for_agent_farewell: 'Waiting briefly for the caller to say goodbye back',
          customer_acknowledgment: 'Customer acknowledged the closing exchange',
          customer_ack_waiting_for_agent_farewell: 'Waiting briefly for the caller to say goodbye back',
          agent_farewell: 'Caller finished the goodbye exchange',
          agent_wrap_silence_timeout: 'No reply after the closing line'
        };
        return reasons[item.detail] || 'Call is ending';
      }
      if (item.type === 'media_stream_stopped' && item.detail === 'stop') return 'Live audio stream ended';
      return item.detail || '';
    }
    root.innerHTML = visible.slice().reverse().map(function(item){
      return '<div class="event"><div class="event-type">' + esc(labelForEvent(item)) + '</div><div>' + esc(detailForEvent(item)) + '</div></div>';
    }).join('');
    renderState.eventsKey = key;
  }

  function renderSummary(summary){
    var root = document.getElementById('summaryWrap');
    var key = String(summary || '');
    if (key === renderState.summaryKey) return;
    if (!summary) {
      root.innerHTML = '<div class="empty">The summary will appear here after the call ends.</div>';
      renderState.summaryKey = key;
      return;
    }
    root.innerHTML = '<div class="summary-markdown">' + renderMarkdownSummary(summary) + '</div>';
    renderState.summaryKey = key;
  }

  function renderOutcomeSchema(schema){
    var root = document.getElementById('schemaLine');
    var key = JSON.stringify(schema || []);
    if (key === renderState.schemaKey) return;
    if (!schema || !schema.length) {
      root.innerHTML = '';
      renderState.schemaKey = key;
      return;
    }
    root.innerHTML = 'Outcome fields: ' + schema.map(function(item){
      return '<code>' + esc(item.label || item.key || 'Outcome') + '</code>';
    }).join(' ');
    renderState.schemaKey = key;
  }

  function renderArtifact(artifactPath){
    var root = document.getElementById('artifactLine');
    var key = String(artifactPath || '');
    if (key === renderState.artifactKey) return;
    if (!artifactPath) {
      root.innerHTML = '';
      renderState.artifactKey = key;
      return;
    }
    root.innerHTML = 'Saved to <code>' + esc(artifactPath) + '</code>';
    renderState.artifactKey = key;
  }

  function lastSpeaker(session){
    var events = session.events || [];
    for (var i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].type === 'response') return 'agent';
      if (events[i].type === 'prompt' || events[i].type === 'interrupt') return 'customer';
    }
    var transcript = session.transcript || [];
    return transcript.length ? transcript[transcript.length - 1].speaker : '';
  }

  function setSpeakerState(node, active){
    node.classList.toggle('active', !!active);
  }

  function initials(value, fallback){
    var raw = String(value || fallback || '').trim();
    if (!raw) return '?';
    var whitespacePattern = new RegExp('\\\\s+');
    var bits = raw.split(whitespacePattern).filter(Boolean).slice(0, 2);
    return bits.map(function(bit){ return bit.charAt(0).toUpperCase(); }).join('');
  }

  function updateSpeakerCards(session){
    var callerName = session.assistantName || 'Caller';
    var targetName = session.targetName || session.targetBusiness || session.toNumber || 'Target';
    document.getElementById('callerName').textContent = callerName;
    document.getElementById('targetName').textContent = targetName;
    document.getElementById('callerAvatar').textContent = initials(callerName, 'C');
    document.getElementById('targetAvatar').textContent = initials(targetName, 'T');

    var speaker = lastSpeaker(session);
    var live = !isTerminalSessionStatus(session.status);
    if (!audioState.enabled || monitorUsesLegacyHybrid()) {
      setSpeakerState(document.getElementById('callerCard'), live && speaker === 'agent');
      setSpeakerState(document.getElementById('targetCard'), live && speaker === 'customer');
    } else {
      refreshMonitorMix();
    }

    var callerText = session.persona || 'The caller persona and framing come from the chat skill.';
    var goalText = session.discoveryGoal || 'Waiting for a call objective.';
    document.getElementById('callerCopy').textContent = goalText;
    document.getElementById('targetCopy').textContent = session.targetBusiness || session.targetName
      ? 'Listening to ' + targetName + ' and updating the transcript live.'
      : 'Waiting for a target to answer.';
    updateLiveSpeakerPreview();
  }

  function updateMonitorStatus(message){
    document.getElementById('audioStatus').textContent = message;
  }

  function updateHangupButton(session){
    var btn = document.getElementById('hangupBtn');
    var live = !!(session && currentSessionId && session.callSid && !isTerminalSessionStatus(session.status));
    btn.disabled = !live || hangupRequestInFlight;
    if (hangupRequestInFlight) {
      btn.textContent = 'Ending Call...';
      return;
    }
    btn.textContent = live ? 'End Call' : 'End Call';
  }

  function resetLiveMonitorBuffers(){
    audioState.pendingFrames = [];
    audioState.trackActivity = { inbound: 0, outbound: 0 };
    audioState.trackSchedule = freshTrackSchedule();
    if (audioState.trackNodes.inbound) {
      try { audioState.trackNodes.inbound.port.postMessage({ type: 'reset' }); } catch (_err) {}
    }
    if (audioState.trackNodes.outbound) {
      try { audioState.trackNodes.outbound.port.postMessage({ type: 'reset' }); } catch (_err2) {}
    }
  }

  function stopMonitorMixLoop(){
    if (audioState.duckTimer) {
      clearTimeout(audioState.duckTimer);
      audioState.duckTimer = 0;
    }
  }

  function refreshMonitorMix(){
    var now = Date.now();
    var customerActive = !!livePartialText.customer || audioState.trackActivity.inbound > now;
    var agentActive = !!livePartialText.agent || audioState.trackActivity.outbound > now;
    var inboundGain = 1.0;
    var outboundGain = 0.92;
    if (customerActive && agentActive) {
      inboundGain = 1.08;
      outboundGain = 0.26;
    } else if (customerActive) {
      inboundGain = 1.04;
      outboundGain = 0.58;
    } else if (agentActive) {
      inboundGain = 0.92;
      outboundGain = 0.96;
    }
    var ctx = audioState.context;
    var rampAt = ctx ? ctx.currentTime : 0;
    if (audioState.trackGains.inbound) {
      audioState.trackGains.inbound.gain.cancelScheduledValues(rampAt);
      audioState.trackGains.inbound.gain.linearRampToValueAtTime(inboundGain, rampAt + 0.05);
    }
    if (audioState.trackGains.outbound) {
      audioState.trackGains.outbound.gain.cancelScheduledValues(rampAt);
      audioState.trackGains.outbound.gain.linearRampToValueAtTime(outboundGain, rampAt + 0.05);
    }
    var callerCard = document.getElementById('callerCard');
    var targetCard = document.getElementById('targetCard');
    if (callerCard && targetCard && currentSessionId) {
      setSpeakerState(callerCard, agentActive && !customerActive);
      setSpeakerState(targetCard, customerActive);
    }
  }

  function startMonitorMixLoop(){
    if (audioState.duckTimer) return;
    function tick(){
      audioState.duckTimer = 0;
      refreshMonitorMix();
      if (!audioState.enabled) return;
      audioState.duckTimer = window.setTimeout(tick, 70);
    }
    tick();
  }

  function buildTrackStreamWorkletSource(){
    return [
      "class TrackStreamProcessor extends AudioWorkletProcessor {",
      "  constructor(options) {",
      "    super();",
      "    const opts = (options && options.processorOptions) || {};",
      "    this.inputRate = Number(opts.inputRate || 8000);",
      "    this.minBufferSamples = Math.max(64, Math.round(this.inputRate * ((opts.prebufferMs || 180) / 1000)));",
      "    this.maxBufferSamples = Math.max(this.minBufferSamples * 2, Math.round(this.inputRate * ((opts.maxBufferMs || 1200) / 1000)));",
      "    this.queue = [];",
      "    this.queueSampleCount = 0;",
      "    this.current = null;",
      "    this.currentIndex = 0;",
      "    this.frac = 0;",
      "    this.ready = false;",
      "    this.port.onmessage = (event) => {",
      "      const data = event.data || {};",
      "      if (data.type === 'reset') {",
      "        this.queue = [];",
      "        this.queueSampleCount = 0;",
      "        this.current = null;",
      "        this.currentIndex = 0;",
      "        this.frac = 0;",
      "        this.ready = false;",
      "        return;",
      "      }",
      "      if (data.type !== 'chunk' || !data.samples) return;",
      "      const chunk = new Float32Array(data.samples);",
      "      if (!chunk.length) return;",
      "      this.queue.push(chunk);",
      "      this.queueSampleCount += chunk.length;",
      "      while (this.queueSampleCount > this.maxBufferSamples && this.queue.length > 1) {",
      "        const dropped = this.queue.shift();",
      "        this.queueSampleCount -= dropped.length;",
      "      }",
      "    };",
      "  }",
      "  bufferedSamples() {",
      "    let total = this.queueSampleCount;",
      "    if (this.current) total += Math.max(0, this.current.length - this.currentIndex);",
      "    return total;",
      "  }",
      "  dropExhaustedCurrent() {",
      "    if (this.current && this.currentIndex >= this.current.length) {",
      "      this.current = null;",
      "      this.currentIndex = 0;",
      "    }",
      "  }",
      "  pullChunk() {",
      "    this.dropExhaustedCurrent();",
      "    while (!this.current && this.queue.length) {",
      "      this.current = this.queue.shift();",
      "      this.queueSampleCount -= this.current.length;",
      "      this.currentIndex = 0;",
      "      if (this.current.length > 0) return true;",
      "      this.current = null;",
      "    }",
      "    return !!this.current;",
      "  }",
      "  process(inputs, outputs) {",
      "    const output = outputs[0] && outputs[0][0];",
      "    if (!output) return true;",
      "    if (!this.ready) {",
      "      if (this.bufferedSamples() >= this.minBufferSamples) this.ready = true;",
      "      else { output.fill(0); return true; }",
      "    }",
      "    const ratio = this.inputRate / sampleRate;",
      "    for (let i = 0; i < output.length; i += 1) {",
      "      if (!this.pullChunk()) {",
      "        output[i] = 0;",
      "        this.ready = false;",
      "        this.frac = 0;",
      "        continue;",
      "      }",
      "      const base = this.currentIndex;",
      "      const next = base + 1 < this.current.length",
      "        ? base + 1",
      "        : (this.queue.length && this.queue[0] && this.queue[0].length ? -1 : this.current.length - 1);",
      "      const left = this.current[base];",
      "      const right = next === -1 ? this.queue[0][0] : this.current[next];",
      "      output[i] = left + ((right - left) * this.frac);",
      "      this.frac += ratio;",
      "      while (this.frac >= 1) {",
      "        this.currentIndex += 1;",
      "        this.frac -= 1;",
      "        if (this.currentIndex >= this.current.length) {",
      "          this.current = null;",
      "          this.currentIndex = 0;",
      "          if (!this.pullChunk()) {",
      "            this.frac = 0;",
      "            break;",
      "          }",
      "        }",
      "      }",
      "    }",
      "    return true;",
      "  }",
      "}",
      "registerProcessor('track-stream-processor', TrackStreamProcessor);"
    ].join('\\n');
  }

  async function ensureLiveMonitorGraph(){
    if (monitorUsesLegacyHybrid()) return;
    if (audioState.liveGraphReady) return;
    if (audioState.graphInit) return audioState.graphInit;
    var ctx = ensureAudioContext();
    if (!ctx) return;
    audioState.graphInit = (async function(){
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (_err) {}
      }
      if (!ctx.audioWorklet || typeof window.AudioWorkletNode !== 'function') {
        audioState.basicMonitorFallback = true;
        audioState.liveGraphReady = false;
        audioState.graphInit = null;
        updateMonitorStatus('This browser does not support the low-latency monitor path. Falling back to basic playback.');
        return;
      }
      if (!audioState.workletModuleUrl) {
        audioState.workletModuleUrl = URL.createObjectURL(new Blob([buildTrackStreamWorkletSource()], { type: 'application/javascript' }));
      }
      await ctx.audioWorklet.addModule(audioState.workletModuleUrl);

      function createTrackChain(trackKey){
        var node = new AudioWorkletNode(ctx, 'track-stream-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: {
            inputRate: 8000,
            prebufferMs: trackKey === 'inbound' ? 280 : 220,
            maxBufferMs: 1200
          }
        });
        var inputGain = ctx.createGain();
        inputGain.gain.value = trackKey === 'inbound' ? 1.34 : 1.14;
        var highpass = ctx.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = trackKey === 'inbound' ? 110 : 90;
        highpass.Q.value = 0.7;
        var presence = ctx.createBiquadFilter();
        presence.type = 'peaking';
        presence.frequency.value = trackKey === 'inbound' ? 2200 : 1800;
        presence.Q.value = 0.85;
        presence.gain.value = trackKey === 'inbound' ? 5.2 : 2.2;
        var lowpass = ctx.createBiquadFilter();
        lowpass.type = 'lowpass';
        lowpass.frequency.value = trackKey === 'inbound' ? 3650 : 3450;
        lowpass.Q.value = 0.8;
        var compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = trackKey === 'inbound' ? -24 : -22;
        compressor.knee.value = 10;
        compressor.ratio.value = trackKey === 'inbound' ? 2.6 : 1.8;
        compressor.attack.value = 0.006;
        compressor.release.value = 0.14;
        var gain = ctx.createGain();
        gain.gain.value = trackKey === 'inbound' ? 1.0 : 0.92;
        var destination = gain;
        if (typeof ctx.createStereoPanner === 'function') {
          var pan = ctx.createStereoPanner();
          pan.pan.value = trackKey === 'inbound' ? 0.1 : -0.08;
          gain.connect(pan);
          destination = pan;
        }
        node.connect(inputGain);
        inputGain.connect(highpass);
        highpass.connect(presence);
        presence.connect(lowpass);
        lowpass.connect(compressor);
        compressor.connect(gain);
        destination.connect(audioState.masterInput || ctx.destination);
        audioState.trackNodes[trackKey] = node;
        audioState.trackGains[trackKey] = gain;
      }

      createTrackChain('inbound');
      createTrackChain('outbound');
      audioState.basicMonitorFallback = false;
      audioState.liveGraphReady = true;
      audioState.graphInit = null;
      startMonitorMixLoop();
      var pending = audioState.pendingFrames.slice();
      audioState.pendingFrames = [];
      pending.forEach(function(entry){
        enqueueLiveMonitorFrame(entry.track, entry.samples, entry.rms);
      });
    })().catch(function(err){
      audioState.graphInit = null;
      audioState.liveGraphReady = false;
      updateMonitorStatus('The live monitor could not initialize low-latency playback.');
      throw err;
    });
    return audioState.graphInit;
  }

  function ensureAudioContext(){
    var desiredBusMode = monitorUsesLegacyHybrid() ? 'legacy' : 'live';
    if (audioState.context && audioState.busMode === desiredBusMode) return audioState.context;
    if (audioState.context && audioState.busMode !== desiredBusMode) {
      try { audioState.context.close(); } catch (_err) {}
      audioState.context = null;
      audioState.masterInput = null;
      audioState.masterGain = null;
      audioState.trackNodes = { inbound: null, outbound: null };
      audioState.trackGains = { inbound: null, outbound: null };
      audioState.liveGraphReady = false;
      audioState.basicMonitorFallback = false;
      audioState.graphInit = null;
      stopMonitorMixLoop();
    }
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioState.context = new Ctor();
    audioState.busMode = desiredBusMode;
    audioState.masterInput = audioState.context.createGain();
    audioState.masterGain = audioState.context.createGain();
    if (desiredBusMode === 'legacy') {
      var highpass = audioState.context.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 90;
      highpass.Q.value = 0.7;
      var lowpass = audioState.context.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 3400;
      lowpass.Q.value = 0.7;
      var compressor = audioState.context.createDynamicsCompressor();
      compressor.threshold.value = -30;
      compressor.knee.value = 14;
      compressor.ratio.value = 2.2;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.18;
      audioState.masterGain.gain.value = 0.86;
      audioState.masterInput.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(compressor);
      compressor.connect(audioState.masterGain);
    } else {
      audioState.masterGain.gain.value = 0.94;
      audioState.masterInput.connect(audioState.masterGain);
    }
    audioState.masterGain.connect(audioState.context.destination);
    return audioState.context;
  }

  function closeMonitorSocket(){
    if (audioState.socket) {
      try { audioState.socket.close(); } catch (_err) {}
      audioState.socket = null;
    }
    audioState.connectedSessionId = '';
    audioState.timeline = freshMonitorTimeline();
    resetLiveMonitorBuffers();
    stopMonitorMixLoop();
    refreshMonitorMix();
  }

  function base64ToUint8Array(base64Payload){
    var binary = atob(base64Payload);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function decodeMuLawByte(value){
    value = ~value & 0xFF;
    var sign = value & 0x80;
    var exponent = (value >> 4) & 0x07;
    var mantissa = value & 0x0F;
    var sample = ((mantissa << 4) + 0x08) << exponent;
    sample = exponent ? sample + 0x84 : sample;
    sample -= 0x84;
    return sign ? -sample : sample;
  }

  function decodeMuLawPayload(base64Payload){
    var bytes = base64ToUint8Array(base64Payload);
    var samples = new Float32Array(bytes.length);
    for (var i = 0; i < bytes.length; i += 1) {
      samples[i] = decodeMuLawByte(bytes[i]) / 32768;
    }
    return samples;
  }

  function decodePcm16Payload(base64Payload){
    var bytes = base64ToUint8Array(base64Payload);
    var samples = new Float32Array(Math.floor(bytes.length / 2));
    for (var i = 0; i < samples.length; i += 1) {
      var lo = bytes[i * 2];
      var hi = bytes[i * 2 + 1];
      var sample = lo | (hi << 8);
      if (sample & 0x8000) sample -= 0x10000;
      samples[i] = sample / 32768;
    }
    return samples;
  }

  function frameRms(samples){
    if (!samples || !samples.length) return 0;
    var total = 0;
    for (var i = 0; i < samples.length; i += 1) {
      total += samples[i] * samples[i];
    }
    return Math.sqrt(total / samples.length);
  }

  function softenTelephonyFrame(samples, trackKey){
    if (!samples || !samples.length) return;
    var liveMonitor = !monitorUsesLegacyHybrid();
    var drive = liveMonitor
      ? (trackKey === 'inbound' ? 1.02 : 1.04)
      : 1.08;
    var peak = 0;
    for (var i = 0; i < samples.length; i += 1) {
      var value = samples[i];
      var abs = Math.abs(value);
      if (abs > peak) peak = abs;
      samples[i] = Math.tanh(value * drive);
    }
    if (peak > 0.96) {
      var scale = 0.96 / peak;
      for (var k = 0; k < samples.length; k += 1) {
        samples[k] *= scale;
      }
    }
    if (!liveMonitor) {
      var fadeSamples = Math.min(2, Math.floor(samples.length / 8));
      for (var j = 0; j < fadeSamples; j += 1) {
        var scale = (j + 1) / (fadeSamples + 1);
        samples[j] *= scale;
        samples[samples.length - 1 - j] *= scale;
      }
    }
  }

  function resolveScheduledWindow(ctx, trackState, timestampMs, durationSec){
    if (!Number.isFinite(timestampMs) || timestampMs < 0) {
      timestampMs = trackState.lastTimestamp == null
        ? 0
        : trackState.lastTimestamp + Math.round(durationSec * 1000);
    }
    if (audioState.timeline.baseTimestamp == null || timestampMs < audioState.timeline.baseTimestamp) {
      audioState.timeline.baseTimestamp = timestampMs;
      audioState.timeline.baseAudioTime = ctx.currentTime + (audioState.telephonyDelayMs / 1000);
    }
    var scheduled = audioState.timeline.baseAudioTime + Math.max(0, (timestampMs - audioState.timeline.baseTimestamp) / 1000);
    var earliest = Math.max(ctx.currentTime + 0.05, trackState.lastStart || 0);
    if (audioState.monitorMode === 'hybrid_clean_agent') {
      earliest = Math.max(earliest, audioState.timeline.turnCursor || 0);
    }
    var startAt = Math.max(scheduled, earliest);
    var endAt = startAt + durationSec;
    trackState.lastTimestamp = timestampMs;
    trackState.lastStart = endAt;
    return {
      startAt: startAt,
      endAt: endAt,
      timestampMs: timestampMs
    };
  }

  function applyPlaybackEnvelope(gainNode, startAt, endAt, targetGain){
    gainNode.gain.setValueAtTime(0, startAt);
    gainNode.gain.linearRampToValueAtTime(targetGain, Math.min(startAt + 0.01, endAt));
    if (endAt - startAt > 0.024) {
      gainNode.gain.setValueAtTime(targetGain, endAt - 0.012);
    }
    gainNode.gain.linearRampToValueAtTime(0, endAt);
  }

  function enqueueLiveMonitorFrame(trackKey, samples, rms){
    if (!audioState.enabled || !audioState.available || !samples || !samples.length) return;
    var threshold = trackKey === 'inbound' ? 0.006 : 0.008;
    audioState.trackSchedule[trackKey].lastRms = rms;
    if (rms >= threshold) {
      audioState.trackActivity[trackKey] = Date.now() + (trackKey === 'inbound' ? 300 : 240);
    }
    refreshMonitorMix();
    if (!audioState.liveGraphReady || !audioState.trackNodes[trackKey]) {
      audioState.pendingFrames.push({ track: trackKey, samples: new Float32Array(samples), rms: rms });
      if (audioState.pendingFrames.length > 160) {
        audioState.pendingFrames.splice(0, audioState.pendingFrames.length - 160);
      }
      ensureLiveMonitorGraph().catch(function(){});
      return;
    }
    var transfer = new Float32Array(samples);
    try {
      audioState.trackNodes[trackKey].port.postMessage({ type: 'chunk', samples: transfer }, [transfer.buffer]);
    } catch (_err) {
      try {
        audioState.trackNodes[trackKey].port.postMessage({ type: 'chunk', samples: transfer });
      } catch (_err2) {}
    }
  }

  function scheduleLegacyTelephonyFrame(track, payload, timestampMs){
    if (!audioState.enabled || !audioState.available) return;
    var ctx = ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(function(){});
    var trackKey = track === 'outbound' ? 'outbound' : 'inbound';
    var samples = decodeMuLawPayload(payload);
    if (!samples.length) return;
    softenTelephonyFrame(samples, trackKey);
    var rms = frameRms(samples);

    var buffer = ctx.createBuffer(1, samples.length, 8000);
    buffer.copyToChannel(samples, 0);

    if (trackKey === 'outbound' && audioState.monitorMode === 'hybrid_clean_agent') {
      return;
    }
    var trackState = audioState.trackSchedule[trackKey];
    var timing = resolveScheduledWindow(ctx, trackState, timestampMs, buffer.duration);
    var startAt = timing.startAt;
    var endAt = timing.endAt;
    var voicedThreshold = trackKey === 'inbound' ? 0.006 : 0.012;
    var voiced = rms >= voicedThreshold;
    if (voiced) trackState.lastVoiceAt = timing.timestampMs;
    var tailWindowMs = trackKey === 'inbound' ? 260 : 180;
    var preserveTail = trackState.lastVoiceAt != null && timing.timestampMs - trackState.lastVoiceAt <= tailWindowMs;
    if (!voiced && !preserveTail) {
      trackState.lastStart = endAt;
      return;
    }

    var source = ctx.createBufferSource();
    var gain = ctx.createGain();
    var targetGain = trackKey === 'outbound' ? 0.36 : 0.72;
    applyPlaybackEnvelope(gain, startAt, endAt, targetGain);
    if (audioState.monitorMode === 'hybrid_clean_agent') {
      audioState.timeline.turnCursor = endAt + 0.03;
    }
    var destination = gain;
    if (typeof ctx.createStereoPanner === 'function') {
      var pan = ctx.createStereoPanner();
      pan.pan.value = trackKey === 'outbound' ? -0.12 : 0.12;
      gain.connect(pan);
      destination = pan;
    }
    source.buffer = buffer;
    source.connect(gain);
    destination.connect(audioState.masterInput || ctx.destination);
    source.onended = function(){
      try { source.disconnect(); } catch (_err) {}
      try { gain.disconnect(); } catch (_err2) {}
      if (destination !== gain) {
        try { destination.disconnect(); } catch (_err3) {}
      }
    };
    source.start(startAt);
  }

  function scheduleMediaFrame(track, payload, timestampMs){
    if (!audioState.enabled || !audioState.available) return;
    if (monitorUsesLegacyHybrid()) {
      scheduleLegacyTelephonyFrame(track, payload, timestampMs);
      return;
    }
    if (audioState.basicMonitorFallback) {
      scheduleLegacyTelephonyFrame(track, payload, timestampMs);
      return;
    }
    var trackKey = track === 'outbound' ? 'outbound' : 'inbound';
    var samples = decodeMuLawPayload(payload);
    if (!samples.length) return;
    softenTelephonyFrame(samples, trackKey);
    enqueueLiveMonitorFrame(trackKey, samples, frameRms(samples));
  }

  function scheduleCleanAgentAudio(base64Payload, sampleRate, endTimestampMs, durationMs){
    if (!monitorUsesLegacyHybrid()) return;
    if (!audioState.enabled || !audioState.available || !base64Payload) return;
    var ctx = ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(function(){});

    var samples = decodePcm16Payload(base64Payload);
    if (!samples.length) return;
    var normalizedRate = Number(sampleRate || 0) || 24000;
    var buffer = ctx.createBuffer(1, samples.length, normalizedRate);
    buffer.copyToChannel(samples, 0);

    var inferredDurationMs = Number(durationMs || 0) || Math.round(buffer.duration * 1000);
    var startTimestampMs = Number(endTimestampMs || 0) - inferredDurationMs;
    var trackState = audioState.trackSchedule.agentClean;
    var timing = resolveScheduledWindow(ctx, trackState, startTimestampMs, buffer.duration);
    var startAt = timing.startAt;
    var endAt = timing.endAt;

    var source = ctx.createBufferSource();
    var gain = ctx.createGain();
    applyPlaybackEnvelope(gain, startAt, endAt, 0.82);
    if (audioState.monitorMode === 'hybrid_clean_agent') {
      audioState.timeline.turnCursor = endAt + 0.03;
    }
    var destination = gain;
    if (typeof ctx.createStereoPanner === 'function') {
      var pan = ctx.createStereoPanner();
      pan.pan.value = -0.06;
      gain.connect(pan);
      destination = pan;
    }
    source.buffer = buffer;
    source.connect(gain);
    destination.connect(audioState.masterInput || ctx.destination);
    source.onended = function(){
      try { source.disconnect(); } catch (_err) {}
      try { gain.disconnect(); } catch (_err2) {}
      if (destination !== gain) {
        try { destination.disconnect(); } catch (_err3) {}
      }
    };
    source.start(startAt);
  }

  function connectMonitorAudio(){
    if (!audioState.enabled || !audioState.available || !currentSessionId || !audioState.monitorKey) return;
    if (audioState.socket && audioState.connectedSessionId === currentSessionId) return;

    closeMonitorSocket();
    if (!monitorUsesLegacyHybrid()) {
      Promise.resolve(ensureLiveMonitorGraph()).then(function(){
        if (audioState.enabled) startMonitorMixLoop();
      }).catch(function(){});
    }
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = protocol + '//' + window.location.host + '/voice/live/audio?sessionId='
      + encodeURIComponent(currentSessionId) + '&monitorKey=' + encodeURIComponent(audioState.monitorKey);

    audioState.socket = new WebSocket(wsUrl);
    audioState.connectedSessionId = currentSessionId;

    audioState.socket.onopen = function(){
      updateMonitorStatus(monitorUsesLegacyHybrid()
        ? 'Live browser audio is on. This page is receiving the call audio stream.'
        : 'Live browser audio is on. Low-latency telephony monitor connected.');
    };

    audioState.socket.onmessage = function(event){
      try {
        var msg = JSON.parse(event.data);
        if (msg.type === 'transcript_partial') {
          setLivePartialText(msg.speaker, msg.text || '');
          return;
        }
        if (msg.type === 'transcript') {
          setLivePartialText(msg.speaker, '');
          scheduleTranscriptEntry(msg.speaker, msg.text, Number(msg.timestamp));
          return;
        }
        if (msg.type === 'media') {
          scheduleMediaFrame(msg.track, msg.payload, Number(msg.timestamp || 0));
          return;
        }
        if (msg.type === 'agent_clean_audio') {
          scheduleCleanAgentAudio(msg.audioBase64, Number(msg.sampleRate || 0), Number(msg.endTimestamp || 0), Number(msg.durationMs || 0));
          return;
        }
        if (msg.type === 'media_ready') {
          updateMonitorStatus('Connected to the live audio stream.');
          return;
        }
        if (msg.type === 'media_stopped' || msg.type === 'media_closed') {
          setLivePartialText('agent', '');
          setLivePartialText('customer', '');
          updateMonitorStatus('The live audio stream has ended.');
        }
      } catch (_err) {}
    };

    audioState.socket.onclose = function(){
      if (audioState.enabled) updateMonitorStatus('Audio disconnected. It will reconnect on the next refresh.');
      audioState.socket = null;
      audioState.connectedSessionId = '';
    };
  }

  function renderSession(session){
    setStatus(document.getElementById('globalStatus'), document.getElementById('globalDot'), 'Session loaded');
    setStatus(document.getElementById('sessionStatus'), document.getElementById('sessionDot'), session.status);
    document.getElementById('sessionTitle').textContent = formatSessionLabel(session);
    document.getElementById('metaLine').textContent = [session.assistantName || '', session.toNumber || '', session.provider || ''].filter(Boolean).join(' · ');
    document.getElementById('providerLine').textContent = session.provider === 'elevenlabs-register-call' ? 'ElevenLabs + Twilio' : 'Twilio relay';
    var shouldSyncTranscript = !audioState.enabled
      || !audioState.monitorKey
      || audioState.connectedSessionId !== currentSessionId
      || isTerminalSessionStatus(session.status)
      || !liveTranscriptItems.length;
    if (shouldSyncTranscript) syncLiveTranscript(session.transcript);
    renderTranscript(liveTranscriptItems);
    renderEvents(session.events);
    renderSummary(session.summary);
    renderOutcomeSchema(session.outcomeSchema);
    renderArtifact(session.artifactPath);
    updateSpeakerCards(session);
    updateHangupButton(session);
    audioState.monitorMode = session.monitorMode || 'telephony_live';
    audioState.telephonyDelayMs = Number(session.monitorTelephonyDelayMs || 1550);
    audioState.outboundFallbackGain = Number(session.monitorOutboundFallbackGain || 0.08);
    audioState.monitorKey = session.monitorKey || '';
    if (audioState.enabled) connectMonitorAudio();
  }

  function renderEmptySession(message){
    closeMonitorSocket();
    audioState.monitorMode = 'telephony_live';
    audioState.telephonyDelayMs = 1550;
    audioState.outboundFallbackGain = 0.08;
    audioState.monitorKey = '';
    updateMonitorStatus(audioState.enabled
      ? 'Live browser audio is on. Waiting for the next call.'
      : 'Audio is off. Click once to let this page play the live call stream.');
    setStatus(document.getElementById('globalStatus'), document.getElementById('globalDot'), 'Waiting');
    setStatus(document.getElementById('sessionStatus'), document.getElementById('sessionDot'), 'Idle');
    document.getElementById('sessionTitle').textContent = 'No session selected';
    document.getElementById('metaLine').textContent = message || 'Choose a recent session or start one from chat.';
    document.getElementById('providerLine').textContent = '';
    syncLiveTranscript([]);
    renderTranscript([]);
    renderEvents([]);
    renderSummary('');
    renderOutcomeSchema([]);
    renderArtifact('');
    updateHangupButton(null);
    updateSpeakerCards({ assistantName: 'Caller', targetName: 'Target', status: 'idle', transcript: [], events: [], discoveryGoal: '' });
    updateLiveSpeakerPreview();
  }

  function loadSessionList(){
    return fetch('/api/voice-demo/sessions', { credentials: 'same-origin' })
      .then(function(r){ return r.json(); })
      .then(function(j){
        var items = j.sessions || [];
        var nextSessionId = preferredSessionId(items);
        if (nextSessionId && nextSessionId !== currentSessionId) {
          setCurrentSessionId(nextSessionId);
        } else if (!nextSessionId && currentSessionId) {
          setCurrentSessionId('');
        }
        renderSessionList(items);
        return items;
      });
  }

  function deleteSession(sessionId){
    var targetId = String(sessionId || '').trim();
    if (!targetId || sessionDeleteInFlightId) return Promise.resolve();
    if (!window.confirm('Delete this voice session from the dashboard?')) {
      return Promise.resolve();
    }
    sessionDeleteInFlightId = targetId;
    renderSessionList(latestSessionList);
    return fetch('/api/voice-demo/session/' + encodeURIComponent(targetId), {
      method: 'DELETE',
      credentials: 'same-origin'
    }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok, body: j }; });
    }).then(function(result){
      if (!result.ok || !(result.body && result.body.ok)) {
        throw new Error(result.body && result.body.error ? result.body.error : 'Unable to delete session.');
      }
      return loadSession();
    }).catch(function(err){
      updateMonitorStatus(err.message || 'Unable to delete session.');
    }).finally(function(){
      sessionDeleteInFlightId = '';
      renderSessionList(latestSessionList);
    });
  }

  function loadSession(){
    return loadSessionList().then(function(items){
      if (!currentSessionId) {
        renderEmptySession('No session selected yet.');
        return;
      }
      return fetch('/api/voice-demo/session/' + encodeURIComponent(currentSessionId), { credentials: 'same-origin' })
        .then(function(r){ return r.json(); })
        .then(function(j){
          if (!j.ok) throw new Error(j.error || 'Session not found');
          renderSession(j.session);
        })
        .catch(function(){
          if (items.length && items[0].id !== currentSessionId) {
            setCurrentSessionId(items[0].id);
            return loadSession();
          }
          renderEmptySession('This session is no longer available.');
        });
    }).catch(function(err){
      setStatus(document.getElementById('globalStatus'), document.getElementById('globalDot'), 'Error');
      document.getElementById('metaLine').textContent = err.message || 'Unable to load sessions.';
    });
  }

  function ensurePolling(){
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(loadSession, 1400);
    if (sessionsTimer) clearInterval(sessionsTimer);
    sessionsTimer = setInterval(loadSessionList, 5000);
  }

  var audioToggle = document.getElementById('audioToggle');
  var hangupBtn = document.getElementById('hangupBtn');
  if (!audioState.available) {
    audioToggle.disabled = true;
    updateMonitorStatus('This browser cannot play the live call stream.');
  } else {
    audioToggle.addEventListener('click', function(){
      audioState.enabled = !audioState.enabled;
      audioToggle.classList.toggle('off', !audioState.enabled);
      audioToggle.textContent = audioState.enabled ? 'Disable Live Audio' : 'Enable Live Audio';
      if (!audioState.enabled) {
        closeMonitorSocket();
        updateMonitorStatus('Audio is off. Click once to let this page play the live call stream.');
        return;
      }
      ensureAudioContext();
      connectMonitorAudio();
      updateMonitorStatus('Connecting live audio…');
    });
  }

  hangupBtn.addEventListener('click', function(){
    if (!currentSessionId || hangupRequestInFlight) return;
    hangupRequestInFlight = true;
    updateHangupButton({ status: 'ending', callSid: 'pending' });
    fetch('/api/voice-demo/session/' + encodeURIComponent(currentSessionId) + '/hangup', {
      method: 'POST',
      credentials: 'same-origin'
    }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok, body: j }; });
    }).then(function(result){
      if (!result.ok) {
        throw new Error(result.body && result.body.error ? result.body.error : 'Unable to end call.');
      }
      loadSession();
    }).catch(function(err){
      updateMonitorStatus(err.message || 'Unable to end call.');
    }).finally(function(){
      hangupRequestInFlight = false;
      loadSession();
    });
  });

  renderEmptySession('Choose a recent session or start one from chat.');
  loadSession();
  ensurePolling();
})();
</script>
</body></html>`;
  }

  function registerRoutes(app, authMiddleware, loopbackMiddleware = authMiddleware) {
    app.get("/demo/voice", authMiddleware, (req, res) => {
      const redirectUrl = new URL("/voice/live", "http://localhost");
      for (const [key, value] of Object.entries(req.query || {})) {
        if (value != null) redirectUrl.searchParams.set(key, String(value));
      }
      return res.redirect(302, `${redirectUrl.pathname}${redirectUrl.search}`);
    });

    app.get("/voice/live", authMiddleware, (_req, res) => {
      if (!FEATURE_VOICE_DEMO_ENABLED) {
        return res.status(503).type("text/plain").send("Voice demo feature is disabled.");
      }
      return res.type("html").send(renderVoiceDemoPage());
    });

    app.get("/api/voice-demo/sessions", loopbackMiddleware, (_req, res) => {
      const items = Array.from(sessions.values())
        .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))
        .slice(0, 20)
        .map((session) => snapshotSession(session));
      return res.json({ ok: true, sessions: items });
    });

    app.get("/api/voice-demo/session/:id", loopbackMiddleware, (req, res) => {
      const session = sessions.get(req.params.id);
      if (!session) return res.status(404).json({ ok: false, error: "Session not found" });
      return res.json({ ok: true, session: snapshotSession(session) });
    });

    app.post("/api/voice-demo/session/:id/hangup", loopbackMiddleware, async (req, res) => {
      const session = sessions.get(req.params.id);
      if (!session) return res.status(404).json({ ok: false, error: "Session not found" });
      if (!session.callSid) {
        return res.status(400).json({ ok: false, error: "Call has not started yet" });
      }
      if (String(session.status || "").includes("completed")) {
        return res.json({ ok: true, alreadyCompleted: true, session: snapshotSession(session) });
      }
      try {
        await requestCallHangup(session, "user_requested");
        return res.json({ ok: true, session: snapshotSession(session) });
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
    });

    app.delete("/api/voice-demo/session/:id", loopbackMiddleware, (req, res) => {
      const session = sessions.get(req.params.id);
      if (!session) return res.status(404).json({ ok: false, error: "Session not found" });
      if (!isTerminalSessionStatus(session.status)) {
        return res.status(409).json({ ok: false, error: "Only ended sessions can be deleted" });
      }
      clearScheduledFinalize(session);
      clearScheduledHangup(session);
      closeSpeechTracks(session);
      const clients = monitorClients.get(session.id);
      if (clients) {
        for (const client of clients) {
          try {
            client.close(1000, "session deleted");
          } catch {
            // Ignore close errors for already-closed monitor sockets.
          }
        }
        monitorClients.delete(session.id);
      }
      sessions.delete(session.id);
      return res.json({ ok: true, deletedId: session.id });
    });

    app.post("/api/voice-demo/bootstrap", loopbackMiddleware, async (_req, res) => {
      if (!voiceDemoUsesElevenLabsRegisterCall()) {
        return res.json({ ok: true, provider: VOICE_DEMO_PROVIDER, agentId: "", message: "Relay provider active" });
      }
      try {
        const agentId = await ensureElevenLabsAgent();
        return res.json({ ok: true, provider: VOICE_DEMO_PROVIDER, agentId });
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
    });

    app.post("/api/voice-demo/start", loopbackMiddleware, async (req, res) => {
      if (!voiceDemoConfigured() || !twilioClient) {
        return res.status(503).json({ ok: false, error: "Voice demo is not configured" });
      }

      const session = createSession(req.body || {});
      if (!session.toNumber) {
        sessions.delete(session.id);
        return res.status(400).json({ ok: false, error: "Enter a valid phone number" });
      }

      session.status = "dialing";
      recordEvent(session, "dialing", session.toNumber);

      try {
        if (voiceDemoUsesElevenLabsRegisterCall()) {
          session.elevenAgentId = await ensureElevenLabsAgent();
        }
        const call = await twilioClient.calls.create({
          to: session.toNumber,
          from: TWILIO_PHONE_NUMBER,
          url: buildWebhookUrl(`/twilio/voice/call?sessionId=${encodeURIComponent(session.id)}`),
          statusCallback: buildWebhookUrl(`/twilio/voice/status?sessionId=${encodeURIComponent(session.id)}`),
          statusCallbackMethod: "POST",
          statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        });
        session.callSid = call.sid;
        recordEvent(session, "call_created", call.sid);
        return res.json({
          ok: true,
          sessionId: session.id,
          callSid: call.sid,
          sessionUrl: `/voice/live?sessionId=${encodeURIComponent(session.id)}`,
        });
      } catch (err) {
        session.status = "error";
        session.lastError = err.message;
        recordEvent(session, "call_error", err.message);
        return res.status(500).json({ ok: false, error: err.message });
      }
    });

    app.post("/twilio/voice/call", async (req, res) => {
      if (!webhookRequestIsValid(req)) {
        return res.status(403).type("text/plain").send("Forbidden");
      }

      const session = sessions.get(String(req.query.sessionId || ""));
      if (!session) {
        return res.type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this demo session was not found.</Say></Response>');
      }

      if (String(req.query.ivrResume || "") === "1" && session.ivr?.awaitingResume) {
        session.ivr.awaitingResume = false;
        recordEvent(session, "ivr_resumed", session.ivr.lastDigits || "resume");
      }

      if (voiceDemoUsesElevenLabsRegisterCall()) {
        try {
          const fromNumber = String(req.body.From || TWILIO_PHONE_NUMBER || "").trim();
          const toNumber = String(req.body.To || session.toNumber || "").trim();
          const twiml = await buildElevenLabsRegisterCallTwiml(session, fromNumber, toNumber);
          session.status = "provider_connecting";
          recordEvent(session, "twiml_served", "ElevenLabs register-call starting");
          return res.type("text/xml").send(twiml);
        } catch (err) {
          session.status = "error";
          session.lastError = err.message;
          recordEvent(session, "provider_error", err.message);
          return res.type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, the voice agent is unavailable right now.</Say></Response>');
        }
      }

      const response = new twilio.twiml.VoiceResponse();
      const start = response.start();
      const stream = start.stream({
        url: buildWebSocketUrl("/twilio/media"),
        track: "both_tracks",
      });
      stream.parameter({ name: "sessionId", value: session.id });
      stream.parameter({ name: "mediaKey", value: session.mediaKey });

      const connect = response.connect({
        action: buildWebhookUrl(`/twilio/voice/action?sessionId=${encodeURIComponent(session.id)}`),
        method: "POST",
      });
      const conversationRelay = connect.conversationRelay({
        url: buildWebSocketUrl(`/twilio/conversationrelay?sessionId=${encodeURIComponent(session.id)}&relayKey=${session.relayKey}`),
        welcomeGreeting: session.greeting,
        debug: "speaker-events",
        reportInputDuringAgentSpeech: "speech",
        ttsProvider: "ElevenLabs",
        voice: session.ttsVoice || VOICE_DEMO_TTS_VOICE,
        elevenlabsTextNormalization: VOICE_DEMO_TEXT_NORMALIZATION,
        transcriptionProvider: "Google",
        speechModel: "telephony",
      });
      conversationRelay.language({
        code: "en-US",
      });
      conversationRelay.parameter({ name: "sessionId", value: session.id });
      conversationRelay.parameter({ name: "assistantName", value: session.assistantName });

      session.status = "relay_connecting";
      recordEvent(session, "twiml_served", "ConversationRelay starting");
      return res.type("text/xml").send(response.toString());
    });

    app.post("/twilio/voice/status", async (req, res) => {
      if (!webhookRequestIsValid(req)) {
        return res.status(403).type("text/plain").send("Forbidden");
      }

      const session = sessions.get(String(req.query.sessionId || ""));
      if (session) {
        session.callSid = req.body.CallSid || session.callSid;
        session.status = String(req.body.CallStatus || "").toLowerCase() || session.status;
        recordEvent(session, "call_status", session.status);
        if (session.status === "completed") {
          session.completionAt = nowIso();
          scheduleFinalizeSession(session, "", voiceDemoUsesElevenLabsRegisterCall() ? 1800 : 0);
        }
      }
      return res.status(204).end();
    });

    app.post("/twilio/voice/action", async (req, res) => {
      if (!webhookRequestIsValid(req)) {
        return res.status(403).type("text/plain").send("Forbidden");
      }

      const session = sessions.get(String(req.query.sessionId || ""));
      if (session) {
        session.status = "completed";
        session.completionAt = nowIso();
        recordEvent(session, "call_action", String(req.body.DialCallStatus || req.body.CallStatus || "completed"));
        scheduleFinalizeSession(session, "", voiceDemoUsesElevenLabsRegisterCall() ? 1800 : 0);
      }
      return res.type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    });
  }

  function handleUpgrade(req, socket, head) {
    if (!FEATURE_VOICE_DEMO_ENABLED) return false;

    let parsed;
    try {
      parsed = new URL(req.url, "http://localhost");
    } catch {
      return false;
    }

    if (parsed.pathname === "/twilio/conversationrelay") {
      const sessionId = parsed.searchParams.get("sessionId");
      const relayKey = parsed.searchParams.get("relayKey");
      const session = sessions.get(String(sessionId || ""));
      if (!session || session.relayKey !== relayKey) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return true;
      }

      relayWss.handleUpgrade(req, socket, head, (ws) => {
        relayWss.emit("connection", ws, req);
      });
      return true;
    }

    if (parsed.pathname === "/twilio/media") {
      mediaWss.handleUpgrade(req, socket, head, (ws) => {
        mediaWss.emit("connection", ws, req);
      });
      return true;
    }

    if (parsed.pathname === "/demo/voice/audio" || parsed.pathname === "/voice/live/audio") {
      const sessionId = parsed.searchParams.get("sessionId");
      const monitorKey = parsed.searchParams.get("monitorKey");
      const session = sessions.get(String(sessionId || ""));
      if (!session || session.monitorKey !== monitorKey) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return true;
      }

      monitorWss.handleUpgrade(req, socket, head, (ws) => {
        monitorWss.emit("connection", ws, req);
      });
      return true;
    }

    return false;
  }

  return {
    enabled: FEATURE_VOICE_DEMO_ENABLED,
    configured: voiceDemoConfigured(),
    registerRoutes,
    handleUpgrade,
  };
}
