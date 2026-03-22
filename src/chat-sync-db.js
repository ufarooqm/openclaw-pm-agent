// PM Agent chat session persistence — Supabase + pgvector.
// Simplified from powerus chat-sync-db.js (no WhatsApp/channel detection).

function dbUrl() {
  return (
    process.env.SUPABASE_POOLER_URL?.trim() ||
    process.env.SUPABASE_DATABASE_URL?.trim() ||
    ""
  );
}

let poolPromise = null;
let schemaPromise = null;

async function getPool() {
  if (poolPromise) return poolPromise;

  poolPromise = (async () => {
    const url = dbUrl();
    if (!url) return null;

    const pg = await import("pg");
    const { Pool } = pg;

    const pool = new Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on("error", (err) => {
      console.error("[chat-sync-db] pool error:", err);
    });

    return pool;
  })();

  return poolPromise;
}

// ---------------------------------------------------------------------------
// Public: configuration check
// ---------------------------------------------------------------------------

export function chatSyncDbConfigured() {
  return Boolean(dbUrl());
}

// ---------------------------------------------------------------------------
// Public: ensure schema (idempotent)
// ---------------------------------------------------------------------------

export async function chatSyncEnsureSchema() {
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    const pool = await getPool();
    if (!pool) throw new Error("Chat Sync DB not configured (missing SUPABASE_POOLER_URL)");

    await pool.query(`create extension if not exists vector`);

    const ddl = `
      create table if not exists "chat_sessions" (
        id uuid primary key default gen_random_uuid(),
        session_file text unique not null,
        started_at timestamptz,
        model text,
        message_count int default 0,
        total_tokens int default 0,
        total_cost numeric default 0,
        file_size int default 0,
        last_message_at timestamptz,
        synced_at timestamptz not null default now(),
        created_at timestamptz not null default now()
      );

      create table if not exists "chat_messages" (
        id uuid primary key default gen_random_uuid(),
        session_id uuid not null references "chat_sessions"(id) on delete cascade,
        role text not null,
        sender_name text,
        content text,
        tool_name text,
        model text,
        tokens_used int,
        cost numeric,
        created_at timestamptz not null
      );

      -- Add missing columns if they don't exist
      do $$ begin
        alter table "chat_sessions" add column file_size int default 0;
      exception when duplicate_column then null;
      end $$;

      do $$ begin
        alter table "chat_sessions" add column last_message_at timestamptz;
      exception when duplicate_column then null;
      end $$;

      do $$ begin
        alter table "chat_messages" add column embedding vector(1536);
      exception when duplicate_column then null;
      end $$;

      -- chat_sessions indexes
      create index if not exists chat_sessions_started_at_idx
        on "chat_sessions"(started_at desc);

      -- chat_messages indexes
      create index if not exists chat_messages_session_created_idx
        on "chat_messages"(session_id, created_at desc);

      create index if not exists chat_messages_sender_name_idx
        on "chat_messages"(sender_name);

      create index if not exists chat_messages_created_at_idx
        on "chat_messages"(created_at desc);

      -- GIN index for full-text search on message content
      create index if not exists chat_messages_content_fts_idx
        on "chat_messages" using gin (to_tsvector('english', coalesce(content, '')));

      -- HNSW index for vector similarity search (cosine distance)
      create index if not exists chat_messages_embedding_idx
        on "chat_messages" using hnsw (embedding vector_cosine_ops);
    `;

    await pool.query(ddl);
    console.log("[chat-sync-db] schema ensured");
  })();

  return schemaPromise;
}

// ---------------------------------------------------------------------------
// Internal query helper
// ---------------------------------------------------------------------------

async function q(text, params) {
  const pool = await getPool();
  if (!pool) throw new Error("Chat Sync DB not configured");
  await chatSyncEnsureSchema();
  return pool.query(text, params);
}

// ---------------------------------------------------------------------------
// Embedding helpers (OpenAI text-embedding-3-small, 1536 dims)
// ---------------------------------------------------------------------------

function openaiKey() {
  return process.env.OPENAI_API_KEY?.trim() || "";
}

async function embedTexts(texts) {
  const key = openaiKey();
  if (!key) return texts.map(() => null);

  const indexedInputs = texts
    .map((t, i) => ({ i, text: (t || "").trim() }))
    .filter((x) => x.text.length > 0);

  if (indexedInputs.length === 0) return texts.map(() => null);

  const BATCH = 2048;
  const results = new Array(texts.length).fill(null);

  for (let b = 0; b < indexedInputs.length; b += BATCH) {
    const batch = indexedInputs.slice(b, b + BATCH);
    try {
      const resp = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: batch.map((x) => x.text.substring(0, 8000)),
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.error(`[chat-sync-db] embedding API error ${resp.status}: ${errText.substring(0, 200)}`);
        continue;
      }

      const json = await resp.json();
      for (const item of json.data) {
        const originalIdx = batch[item.index].i;
        results[originalIdx] = item.embedding;
      }
    } catch (err) {
      console.error("[chat-sync-db] embedding fetch error:", err.message);
    }
  }

  return results;
}

async function embedQuery(text) {
  const results = await embedTexts([text]);
  return results[0];
}

function pgVector(vec) {
  return `[${vec.join(",")}]`;
}

// ---------------------------------------------------------------------------
// Public: embed messages after insert
// ---------------------------------------------------------------------------

export async function chatSyncEmbedMessages(messageIds) {
  if (!messageIds || messageIds.length === 0) return { embedded: 0 };
  if (!openaiKey()) return { embedded: 0, skipped: "no OPENAI_API_KEY" };

  const placeholders = messageIds.map((_, i) => `$${i + 1}`);
  const res = await q(
    `select id, content from "chat_messages"
     where id = any(array[${placeholders.join(",")}]::uuid[])
       and content is not null and content != ''
       and embedding is null`,
    messageIds,
  );

  if (res.rows.length === 0) return { embedded: 0 };

  const texts = res.rows.map((r) => r.content);
  const embeddings = await embedTexts(texts);

  let embedded = 0;
  for (let i = 0; i < res.rows.length; i++) {
    if (!embeddings[i]) continue;
    await q(
      `update "chat_messages" set embedding = $1::vector where id = $2`,
      [pgVector(embeddings[i]), res.rows[i].id],
    );
    embedded++;
  }

  return { embedded };
}

// ---------------------------------------------------------------------------
// Public: upsert a session record
// ---------------------------------------------------------------------------

export async function chatSyncUpsertSession({
  sessionFile,
  startedAt,
  model,
  messageCount,
  totalTokens,
  totalCost,
  fileSize,
  lastMessageAt,
}) {
  const sf = String(sessionFile || "").trim();
  if (!sf) throw new Error("Missing session_file");

  const res = await q(
    `insert into "chat_sessions" (
        session_file, started_at, model,
        message_count, total_tokens, total_cost,
        file_size, last_message_at, synced_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,now())
     on conflict (session_file)
     do update set
        started_at = excluded.started_at,
        model = excluded.model,
        message_count = excluded.message_count,
        total_tokens = excluded.total_tokens,
        total_cost = excluded.total_cost,
        file_size = excluded.file_size,
        last_message_at = excluded.last_message_at,
        synced_at = now()
     returning id`,
    [
      sf,
      startedAt || null,
      model || null,
      messageCount ?? 0,
      totalTokens ?? 0,
      totalCost ?? 0,
      fileSize ?? 0,
      lastMessageAt || null,
    ],
  );

  return res.rows[0].id;
}

// ---------------------------------------------------------------------------
// Public: get file sizes for incremental sync
// ---------------------------------------------------------------------------

export async function chatSyncGetFileSizes() {
  const res = await q(
    `select session_file, file_size from "chat_sessions"`,
    [],
  );
  const map = new Map();
  for (const row of res.rows) {
    map.set(row.session_file, row.file_size);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public: delete messages for a session (for re-sync)
// ---------------------------------------------------------------------------

export async function chatSyncDeleteMessagesBySession(sessionId) {
  if (!sessionId) throw new Error("Missing sessionId");
  const res = await q(`delete from "chat_messages" where session_id=$1`, [sessionId]);
  return { deleted: res.rowCount };
}

export async function chatSyncDeleteSession(sessionId) {
  if (!sessionId) throw new Error("Missing sessionId");
  await q(`delete from "chat_messages" where session_id=$1`, [sessionId]);
  await q(`delete from "chat_sessions" where id=$1`, [sessionId]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Public: bulk insert messages
// ---------------------------------------------------------------------------

export async function chatSyncInsertMessages(sessionId, messages) {
  if (!sessionId) throw new Error("Missing sessionId");
  if (!messages || messages.length === 0) return { inserted: 0 };

  const valuePlaceholders = [];
  const params = [];
  let idx = 1;

  for (const msg of messages) {
    valuePlaceholders.push(
      `($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`,
    );
    params.push(
      sessionId,
      msg.role || "user",
      msg.senderName || null,
      msg.content || null,
      msg.toolName || null,
      msg.model || null,
      msg.tokensUsed ?? null,
      msg.cost ?? null,
      msg.createdAt || new Date().toISOString(),
    );
  }

  const sql = `insert into "chat_messages" (
    session_id, role, sender_name,
    content, tool_name, model, tokens_used, cost, created_at
  ) values ${valuePlaceholders.join(",\n")}
  returning id`;

  const result = await q(sql, params);
  const insertedIds = result.rows.map((r) => r.id);
  return { inserted: messages.length, ids: insertedIds };
}

// ---------------------------------------------------------------------------
// Public: stats
// ---------------------------------------------------------------------------

export async function chatSyncStats() {
  const res = await q(
    `select
       (select count(1)::int from "chat_sessions") as total_sessions,
       (select count(1)::int from "chat_messages") as total_messages,
       (select max(synced_at) from "chat_sessions") as last_sync_at,
       (select min(started_at) from "chat_sessions") as oldest_session,
       (select max(started_at) from "chat_sessions") as newest_session`,
    [],
  );

  const row = res.rows[0];
  return {
    totalSessions: row.total_sessions,
    totalMessages: row.total_messages,
    lastSyncAt: row.last_sync_at,
    oldestSession: row.oldest_session,
    newestSession: row.newest_session,
  };
}

// ---------------------------------------------------------------------------
// Public: list sessions
// ---------------------------------------------------------------------------

export async function chatSyncListSessions({ search, dateFrom, dateTo, limit, offset } = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (search) {
    conditions.push(`session_file ilike $${idx++}`);
    params.push(`%${search}%`);
  }
  if (dateFrom) {
    conditions.push(`coalesce(last_message_at, started_at) >= $${idx++}::timestamptz`);
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push(`started_at < ($${idx++}::date + interval '1 day')`);
    params.push(dateTo);
  }

  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const lim = Math.min(Number(limit) || 50, 200);
  const off = Number(offset) || 0;

  params.push(lim, off);

  const res = await q(
    `select id, session_file, started_at, model, message_count,
            total_tokens, total_cost, last_message_at
     from "chat_sessions"
     ${where}
     order by started_at desc nulls last
     limit $${idx++} offset $${idx++}`,
    params,
  );

  const countRes = await q(
    `select count(1)::int as total from "chat_sessions" ${where}`,
    params.slice(0, params.length - 2),
  );

  return { sessions: res.rows, total: countRes.rows[0].total };
}

// ---------------------------------------------------------------------------
// Public: get messages for a session
// ---------------------------------------------------------------------------

export async function chatSyncGetMessages({ sessionId, rolesFilter } = {}) {
  const params = [sessionId];
  let idx = 2;

  let roleClause = "";
  if (rolesFilter && rolesFilter.length) {
    const placeholders = rolesFilter.map(() => `$${idx++}`);
    roleClause = `and role in (${placeholders.join(",")})`;
    params.push(...rolesFilter);
  }

  const res = await q(
    `select id, role, sender_name, content, tool_name,
            model, tokens_used, cost, created_at
     from "chat_messages"
     where session_id = $1 ${roleClause}
     order by created_at asc`,
    params,
  );

  return res.rows;
}

// ---------------------------------------------------------------------------
// Public: search messages across all sessions (3-tier fallback)
// ---------------------------------------------------------------------------

export async function chatSyncSearchMessages({ query, sender, dateFrom, dateTo, limit } = {}) {
  if (!query) throw new Error("query is required");
  const lim = Math.min(Number(limit) || 20, 50);

  const allowedRoles = ["user", "assistant"];

  function buildFilters(startIdx) {
    const conds = [];
    const params = [];
    let idx = startIdx;

    const rolePlaceholders = allowedRoles.map(() => `$${idx++}`);
    conds.push(`m.role in (${rolePlaceholders.join(",")})`);
    params.push(...allowedRoles);

    if (dateFrom) { conds.push(`m.created_at >= $${idx++}::timestamptz`); params.push(dateFrom); }
    if (dateTo) { conds.push(`m.created_at < ($${idx++}::date + interval '1 day')`); params.push(dateTo); }
    if (sender) { conds.push(`m.sender_name ilike $${idx++}`); params.push(`%${sender}%`); }
    return { conds, params, nextIdx: idx };
  }

  const selectCols = `m.id, m.role, m.sender_name, m.content, m.tool_name,
            m.created_at, s.id as session_id, s.started_at as session_started_at`;

  // Strategy 1: Vector similarity search
  const queryEmbedding = await embedQuery(query);
  if (queryEmbedding) {
    const filters = buildFilters(3);
    const allConds = [`m.embedding is not null`, ...filters.conds];
    const allParams = [pgVector(queryEmbedding), lim, ...filters.params];

    const res = await q(
      `select ${selectCols},
              1 - (m.embedding <=> $1::vector) as similarity
       from "chat_messages" m
       join "chat_sessions" s on s.id = m.session_id
       where ${allConds.join(" and ")}
       order by m.embedding <=> $1::vector
       limit $2`,
      allParams,
    );

    const good = res.rows.filter((r) => r.similarity > 0.25);
    if (good.length > 0) return good;
  }

  // Strategy 2: Full-text search with ts_rank
  const ftsFilters = buildFilters(2);
  const ftsConds = [
    `to_tsvector('english', coalesce(m.content, '')) @@ plainto_tsquery('english', $1)`,
    ...ftsFilters.conds,
  ];
  const ftsParams = [query, ...ftsFilters.params, lim];

  let res = await q(
    `select ${selectCols},
            ts_rank(to_tsvector('english', coalesce(m.content, '')), plainto_tsquery('english', $1)) as rank
     from "chat_messages" m
     join "chat_sessions" s on s.id = m.session_id
     where ${ftsConds.join(" and ")}
     order by rank desc, m.created_at desc
     limit $${ftsFilters.nextIdx}`,
    ftsParams,
  );

  if (res.rows.length > 0) return res.rows;

  // Strategy 3: ILIKE fallback
  const words = query.split(/\s+/).filter(Boolean);
  const ilikeConds = [];
  const ilikeParams = [];
  let fi = 1;
  for (const w of words) {
    ilikeConds.push(`m.content ilike $${fi++}`);
    ilikeParams.push(`%${w}%`);
  }
  const ilikeFilters = buildFilters(fi);
  ilikeConds.push(...ilikeFilters.conds);
  ilikeParams.push(...ilikeFilters.params, lim);

  res = await q(
    `select ${selectCols}
     from "chat_messages" m
     join "chat_sessions" s on s.id = m.session_id
     where ${ilikeConds.join(" and ")}
     order by m.created_at desc
     limit $${ilikeFilters.nextIdx}`,
    ilikeParams,
  );

  return res.rows;
}

// ---------------------------------------------------------------------------
// User preferences (persisted across deploys)
// ---------------------------------------------------------------------------

let userPrefsSchemaReady = false;

async function ensureUserPrefsSchema() {
  if (userPrefsSchemaReady) return;
  const pool = await getPool();
  if (!pool) return;
  await pool.query(`
    create table if not exists "user_prefs" (
      key text primary key,
      value jsonb not null default '{}'::jsonb,
      updated_at timestamptz default now()
    )
  `);
  userPrefsSchemaReady = true;
}

export async function getUserPrefs() {
  try {
    await ensureUserPrefsSchema();
    const pool = await getPool();
    if (!pool) return {};
    const res = await pool.query(`select value from "user_prefs" where key = 'main' limit 1`);
    return res.rows[0]?.value || {};
  } catch (err) {
    console.error("[user-prefs] get error:", err.message);
    return {};
  }
}

export async function setUserPrefs(obj) {
  await ensureUserPrefsSchema();
  const pool = await getPool();
  if (!pool) throw new Error("DB not configured");
  await pool.query(
    `insert into "user_prefs" (key, value, updated_at) values ('main', $1::jsonb, now())
     on conflict (key) do update set value = $1::jsonb, updated_at = now()`,
    [JSON.stringify(obj)],
  );
}
