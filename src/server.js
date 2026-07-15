import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { env } from "./config/env.js";
import { pool, query, withClient } from "./db/pool.js";
import { parseCsv, rowsToObjects } from "./services/csv.js";
import { parseEmail } from "./services/validation.js";
import { checkSendingDomain } from "./services/domain-check.js";
import { verifyImap, verifySmtp } from "./services/mail.js";
import { logEvent } from "./services/events.js";
import { campaignPreflight } from "./services/preflight.js";
import { getRuntimeSettings, saveRuntimeSettings } from "./services/runtime.js";
import { asyncHandler, parseArray, toBool } from "./http/utils.js";

await fs.mkdir(env.attachmentDir, { recursive: true });

const app = express();
const csvUpload = multer({ storage: multer.memoryStorage() });
const attachmentUpload = multer({
  dest: env.attachmentDir,
  limits: { fileSize: 200 * 1024 * 1024 },
});

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const DOTENV_PATH = path.resolve(process.cwd(), ".env");
const AUTH_COOKIE = "outreach_session";
const AUTH_TTL_MS = 1000 * 60 * 60 * 12;

function authConfigured() {
  return Boolean(env.authUser && env.authPassword && env.authSessionSecret);
}

function cleanText(value) {
  return String(value || "").trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header = "") {
  return Object.fromEntries(
    String(header || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", env.authSessionSecret)
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

function verifyAuthToken(token) {
  if (!authConfigured() || !token || !token.includes(".")) return false;
  const [body, signature] = String(token).split(".");
  const expected = crypto
    .createHmac("sha256", env.authSessionSecret)
    .update(body)
    .digest("base64url");
  if (!timingSafeEqualText(signature, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload.user === env.authUser && Number(payload.exp) > Date.now();
  } catch {
    return false;
  }
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifyAuthToken(cookies[AUTH_COOKIE]);
}

function setAuthCookie(res) {
  const secure = env.authCookieSecure ? "; Secure" : "";
  const token = signPayload({ user: env.authUser, exp: Date.now() + AUTH_TTL_MS });
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(AUTH_TTL_MS / 1000)}${secure}`,
  );
}

function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function wantsHtml(req) {
  return String(req.headers.accept || "").includes("text/html");
}

function publicPath(req) {
  return req.path === "/login.html"
    || req.path === "/styles.css"
    || req.path === "/api/auth/status"
    || req.path === "/api/auth/login"
    || req.path === "/api/auth/logout"
    || req.path === "/api/health"
    || req.path.startsWith("/t/open/");
}

function requireAuth(req, res, next) {
  if (publicPath(req)) return next();
  if (!authConfigured()) {
    return wantsHtml(req)
      ? res.redirect("/login.html")
      : res.status(503).json({ error: "auth_not_configured" });
  }
  if (isAuthenticated(req)) return next();
  return wantsHtml(req)
    ? res.redirect("/login.html")
    : res.status(401).json({ error: "auth_required" });
}

function mailboxPasswordEnvKey(email) {
  const mailboxKey = String(email || "mailbox")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase() || "MAILBOX";
  return `MAILBOX_${mailboxKey}_PASSWORD`;
}

function formatDotenvValue(value) {
  return `"${String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`;
}

async function saveSecretToDotenv(key, value) {
  const normalizedKey = String(key || "").trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(normalizedKey)) {
    throw new Error("invalid_password_env_key");
  }

  const line = `${normalizedKey}=${formatDotenvValue(value)}`;
  let current = "";
  try {
    current = await fs.readFile(DOTENV_PATH, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const lines = current ? current.split(/\r?\n/) : [];
  const index = lines.findIndex((item) => item.trim().startsWith(`${normalizedKey}=`));
  if (index >= 0) lines[index] = line;
  else lines.push(line);

  const body = lines.filter((item, idx) => item || idx < lines.length - 1).join("\n");
  await fs.writeFile(DOTENV_PATH, `${body}\n`);
  process.env[normalizedKey] = String(value || "");
  return normalizedKey;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timeout after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

function optionalPositiveInteger(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    const error = new Error(`${fieldName}_must_be_positive_integer`);
    error.status = 400;
    throw error;
  }
  return parsed;
}

function optionalSendDays(value) {
  if (value === undefined) return null;
  const days = parseArray(value)
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  if (!days.length) {
    const error = new Error("send_days_must_include_at_least_one_day");
    error.status = 400;
    throw error;
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

app.get("/api/auth/status", (req, res) => {
  res.json({
    configured: authConfigured(),
    authenticated: isAuthenticated(req),
  });
});

app.post("/api/auth/login", (req, res) => {
  if (!authConfigured()) {
    return res.status(503).json({ error: "auth_not_configured" });
  }
  const username = String(req.body.username || "");
  const password = String(req.body.password || "");
  if (!timingSafeEqualText(username, env.authUser) || !timingSafeEqualText(password, env.authPassword)) {
    clearAuthCookie(res);
    return res.status(401).json({ error: "invalid_credentials" });
  }
  setAuthCookie(res);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.use(requireAuth);
app.use(express.static("public"));

app.get("/api/health", asyncHandler(async (_req, res) => {
  const [db, runtime] = await Promise.all([query("SELECT now() AS now"), getRuntimeSettings()]);
  res.json({
    ok: true,
    now: db.rows[0].now,
    dryRun: runtime.dryRun,
    publicTrackingUrl: runtime.publicTrackingUrl,
    maxAttachmentMb: runtime.maxAttachmentMb,
  });
}));

app.get("/api/settings", asyncHandler(async (_req, res) => {
  const [settings, runtime] = await Promise.all([
    query("SELECT key, value FROM settings ORDER BY key"),
    getRuntimeSettings(),
  ]);
  res.json({
    runtime: {
      dryRun: runtime.dryRun,
      publicTrackingUrl: runtime.publicTrackingUrl,
      attachmentDir: env.attachmentDir,
      maxAttachmentMb: runtime.maxAttachmentMb,
    },
    settings: Object.fromEntries(settings.rows.map((item) => [item.key, item.value])),
  });
}));

app.put("/api/runtime-settings", asyncHandler(async (req, res) => {
  const mailDryRun = toBool(req.body.mailDryRun);
  const publicTrackingUrl = String(req.body.publicTrackingUrl || "").trim();
  const maxAttachmentMb = Number(req.body.maxAttachmentMb || env.maxAttachmentMb);

  if (!Number.isFinite(maxAttachmentMb) || maxAttachmentMb < 1 || maxAttachmentMb > 200) {
    return res.status(400).json({ error: "max_attachment_mb_must_be_between_1_and_200" });
  }

  const runtime = await saveRuntimeSettings({
    dryRun: mailDryRun,
    publicTrackingUrl,
    maxAttachmentMb,
  });

  res.json({
    runtime: {
      dryRun: runtime.dryRun,
      publicTrackingUrl: runtime.publicTrackingUrl,
      attachmentDir: env.attachmentDir,
      maxAttachmentMb: runtime.maxAttachmentMb,
    },
    restartRequired: [],
    message: "Настройки сохранены в БД и применяются без пересоздания контейнеров.",
  });
}));

app.get("/api/env-check", asyncHandler(async (_req, res) => {
  const mailboxes = (await query("SELECT id, name, email, password_env_key FROM mailboxes ORDER BY created_at")).rows;
  const mailboxSecrets = mailboxes.map((mailbox) => ({
    mailboxId: mailbox.id,
    name: mailbox.name,
    email: mailbox.email,
    key: mailbox.password_env_key,
    configured: Boolean(process.env[mailbox.password_env_key]),
  }));
  const expectedMailboxKeys = mailboxes.length ? mailboxSecrets : [];

  res.json({
    required: [
      { key: "AUTH_USER", configured: Boolean(env.authUser), value: env.authUser ? "set" : "", secret: false },
      { key: "AUTH_PASSWORD", configured: Boolean(env.authPassword), value: "", secret: true },
      { key: "AUTH_SESSION_SECRET", configured: Boolean(env.authSessionSecret), value: "", secret: true },
      { key: "POSTGRES_PORT", configured: process.env.POSTGRES_PORT !== undefined, value: process.env.POSTGRES_PORT || "55432", secret: false },
    ],
    recommended: [],
    mailboxSecrets: expectedMailboxKeys,
    template: [
      "# Пароли mailbox создаются автоматически, когда вы вводите пароль в форме Почта.",
      "# Пример: MAILBOX_NAME_DOMAIN_RU_PASSWORD=...",
      "",
      "AUTH_USER=admin",
      "AUTH_PASSWORD=change-me",
      "AUTH_SESSION_SECRET=replace-with-long-random-string",
      "AUTH_COOKIE_SECURE=false",
      "",
      "# Postgres на хосте опубликован на 55432, чтобы не конфликтовать с локальным 5432.",
      "POSTGRES_PORT=55432",
    ].join("\n"),
  });
}));

app.put("/api/settings/:key", asyncHandler(async (req, res) => {
  const result = await query(
    `
      INSERT INTO settings(key, value, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      RETURNING *
    `,
    [req.params.key, req.body.value || {}],
  );
  res.json(result.rows[0]);
}));

app.get("/api/dashboard", asyncHandler(async (_req, res) => {
  const [leadStats, messageStats, queueStats, opens, replies] = await Promise.all([
    query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE validation_status = 'valid')::int AS valid,
        count(*) FILTER (WHERE validation_status = 'risky')::int AS risky,
        count(*) FILTER (WHERE validation_status = 'invalid')::int AS invalid,
        count(*) FILTER (WHERE status IN ('new','validated','enrolled','sent','opened'))::int AS active
      FROM leads
    `),
    query(`
      SELECT
        count(*) FILTER (WHERE direction = 'outbound' AND status = 'sent')::int AS sent,
        count(*) FILTER (WHERE status = 'bounced')::int AS bounced
      FROM messages
    `),
    query(`
      SELECT
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status = 'sent')::int AS sent
      FROM sending_queue
    `),
    query(`
      SELECT
        count(*)::int AS raw,
        count(DISTINCT message_id)::int AS unique
      FROM open_events
    `),
    query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE reply_classification = 'positive_reply')::int AS positive
      FROM messages
      WHERE direction = 'inbound'
    `),
  ]);
  const sent = messageStats.rows[0].sent || 0;
  res.json({
    leads: leadStats.rows[0],
    messages: messageStats.rows[0],
    queue: queueStats.rows[0],
    opens: opens.rows[0],
    replies: replies.rows[0],
    rates: {
      openRate: sent ? Math.round((opens.rows[0].unique / sent) * 100) : 0,
      replyRate: sent ? Math.round((replies.rows[0].total / sent) * 100) : 0,
    },
  });
}));

app.get("/api/leads", asyncHandler(async (req, res) => {
  const search = `%${String(req.query.search || "").toLowerCase()}%`;
  const status = req.query.status || "";
  const validation = req.query.validation || "";
  const segment = cleanText(req.query.segment);
  const result = await query(
    `
      SELECT *
      FROM leads
      WHERE ($1 = '%%' OR lower(company || ' ' || email || ' ' || coalesce(segment,'') || ' ' || coalesce(contact_name,'')) LIKE $1)
        AND ($2 = '' OR status = $2)
        AND ($3 = '' OR validation_status = $3)
        AND ($4 = '' OR segment = $4)
      ORDER BY created_at DESC
      LIMIT 500
    `,
    [search, status, validation, segment],
  );
  res.json(result.rows);
}));

app.get("/api/segments", asyncHandler(async (_req, res) => {
  const result = await query(`
    SELECT segment
    FROM (
      SELECT btrim(segment) AS segment FROM leads WHERE segment IS NOT NULL AND btrim(segment) <> ''
      UNION
      SELECT btrim(item.value) AS segment
      FROM campaigns
      CROSS JOIN regexp_split_to_table(segment, ',') AS item(value)
      WHERE segment IS NOT NULL AND btrim(item.value) <> ''
    ) saved_segments
    GROUP BY segment
    ORDER BY lower(segment)
    LIMIT 200
  `);
  res.json(result.rows.map((row) => row.segment));
}));

app.get("/api/leads/:id/detail", asyncHandler(async (req, res) => {
  const lead = (await query("SELECT * FROM leads WHERE id = $1", [req.params.id])).rows[0];
  if (!lead) return res.status(404).json({ error: "not_found" });
  const [messages, events, enrollments, validations, opens] = await Promise.all([
    query(
      `
        SELECT msg.*, c.name AS campaign_name, m.email AS mailbox_email, s.name AS step_name
        FROM messages msg
        LEFT JOIN campaigns c ON c.id = msg.campaign_id
        LEFT JOIN mailboxes m ON m.id = msg.mailbox_id
        LEFT JOIN campaign_steps s ON s.id = msg.campaign_step_id
        WHERE msg.lead_id = $1
        ORDER BY COALESCE(msg.sent_at, msg.received_at, msg.created_at) DESC
      `,
      [req.params.id],
    ),
    query("SELECT * FROM events WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 200", [req.params.id]),
    query(
      `
        SELECT e.*, c.name AS campaign_name, m.email AS mailbox_email
        FROM enrollments e
        LEFT JOIN campaigns c ON c.id = e.campaign_id
        LEFT JOIN mailboxes m ON m.id = e.mailbox_id
        WHERE e.lead_id = $1
        ORDER BY e.started_at DESC
      `,
      [req.params.id],
    ),
    query("SELECT * FROM email_validation_results WHERE lead_id = $1 ORDER BY checked_at DESC", [req.params.id]),
    query("SELECT * FROM open_events WHERE lead_id = $1 ORDER BY created_at DESC", [req.params.id]),
  ]);
  res.json({
    lead,
    messages: messages.rows,
    events: events.rows,
    enrollments: enrollments.rows,
    validations: validations.rows,
    opens: opens.rows,
  });
}));

app.post("/api/leads", asyncHandler(async (req, res) => {
  const parsed = parseEmail(req.body.email);
  if (!parsed.syntaxValid) return res.status(400).json({ error: "invalid_email" });
  const result = await query(
    `
      INSERT INTO leads(company, email, contact_name, position, website, domain, segment, city, pain, source, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (email) DO UPDATE SET
        company = EXCLUDED.company,
        contact_name = EXCLUDED.contact_name,
        position = EXCLUDED.position,
        website = EXCLUDED.website,
        segment = EXCLUDED.segment,
        city = EXCLUDED.city,
        pain = EXCLUDED.pain,
        notes = EXCLUDED.notes,
        updated_at = now()
      RETURNING *
    `,
    [
      req.body.company,
      parsed.normalized,
      req.body.contact_name || "",
      req.body.position || "",
      req.body.website || "",
      parsed.domain,
      cleanText(req.body.segment),
      req.body.city || "",
      req.body.pain || "",
      req.body.source || "manual",
      req.body.notes || "",
    ],
  );
  await query("INSERT INTO job_queue(job_type, payload) VALUES ('validate_lead', $1)", [{ leadId: result.rows[0].id }]);
  await logEvent("lead_created", { leadId: result.rows[0].id, payload: { source: "manual" } });
  res.status(201).json(result.rows[0]);
}));

app.patch("/api/leads/:id", asyncHandler(async (req, res) => {
  const result = await query(
    `
      UPDATE leads
      SET company = COALESCE($2, company),
          contact_name = COALESCE($3, contact_name),
          position = COALESCE($4, position),
          website = COALESCE($5, website),
          segment = COALESCE($6, segment),
          city = COALESCE($7, city),
          pain = COALESCE($8, pain),
          notes = COALESCE($9, notes),
          status = COALESCE($10, status),
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [
      req.params.id,
      req.body.company,
      req.body.contact_name,
      req.body.position,
      req.body.website,
      req.body.segment === undefined ? undefined : cleanText(req.body.segment),
      req.body.city,
      req.body.pain,
      req.body.notes,
      req.body.status,
    ],
  );
  res.json(result.rows[0]);
}));

app.post("/api/leads/import", csvUpload.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file_required" });
  const rows = rowsToObjects(parseCsv(req.file.buffer.toString("utf8")));
  let imported = 0;
  let skipped = 0;
  let duplicates = 0;

  for (const row of rows) {
    const parsed = parseEmail(row.email);
    if (!row.company || !parsed.syntaxValid) {
      skipped += 1;
      continue;
    }
    const insert = await query(
      `
        INSERT INTO leads(company, email, contact_name, position, website, domain, segment, city, pain, source, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (email) DO NOTHING
        RETURNING id
      `,
      [
        row.company,
        parsed.normalized,
        row.contact_name,
        row.position,
        row.website,
        parsed.domain,
        cleanText(row.segment),
        row.city,
        row.pain,
        row.source || req.file.originalname,
        row.notes,
      ],
    );
    if (!insert.rowCount) {
      duplicates += 1;
      continue;
    }
    imported += 1;
    await query("INSERT INTO job_queue(job_type, payload) VALUES ('validate_lead', $1)", [{ leadId: insert.rows[0].id }]);
  }

  res.json({ imported, skipped, duplicates });
}));

app.post("/api/validation/run", asyncHandler(async (_req, res) => {
  const result = await query(`
    INSERT INTO job_queue(job_type, payload)
    SELECT 'validate_lead', jsonb_build_object('leadId', id)
    FROM leads
    WHERE validation_status IN ('unknown', 'risky')
    RETURNING id
  `);
  res.json({ queued: result.rowCount });
}));

app.get("/api/mailboxes", asyncHandler(async (_req, res) => {
  const result = await query(`
    SELECT m.*,
      dc.mx_status, dc.spf_status, dc.dkim_status, dc.dmarc_status, dc.checked_at AS domain_checked_at
    FROM mailboxes m
    LEFT JOIN LATERAL (
      SELECT * FROM sending_domain_checks d
      WHERE d.mailbox_id = m.id
      ORDER BY d.checked_at DESC
      LIMIT 1
    ) dc ON true
    ORDER BY m.created_at DESC
  `);
  res.json(result.rows);
}));

app.patch("/api/mailboxes/:id", asyncHandler(async (req, res) => {
  const current = (await query("SELECT * FROM mailboxes WHERE id = $1", [req.params.id])).rows[0];
  if (!current) return res.status(404).json({ error: "not_found" });
  const dailyWarmupLimit = optionalPositiveInteger(req.body.daily_warmup_limit, "daily_warmup_limit");
  const dailySendLimit = optionalPositiveInteger(req.body.daily_send_limit, "daily_send_limit");
  const minDelayMinutes = optionalPositiveInteger(req.body.min_delay_minutes, "min_delay_minutes");
  const maxDelayMinutes = optionalPositiveInteger(req.body.max_delay_minutes, "max_delay_minutes");
  const sendDays = optionalSendDays(req.body.send_days);
  if (minDelayMinutes !== null && maxDelayMinutes !== null && minDelayMinutes > maxDelayMinutes) {
    return res.status(400).json({ error: "min_delay_must_be_less_or_equal_max_delay" });
  }
  const password = String(req.body.password || "");
  const passwordEnvKey = password
    ? await saveSecretToDotenv(current.password_env_key || mailboxPasswordEnvKey(current.email), password)
    : null;
  const result = await query(
    `
      UPDATE mailboxes
      SET is_active = COALESCE($2, is_active),
          warmup_enabled = COALESCE($3, warmup_enabled),
          daily_warmup_limit = COALESCE($4, daily_warmup_limit),
          min_delay_minutes = COALESCE($5, min_delay_minutes),
          max_delay_minutes = COALESCE($6, max_delay_minutes),
          send_window_start = COALESCE($7, send_window_start),
          send_window_end = COALESCE($8, send_window_end),
          smtp_host = COALESCE($9, smtp_host),
          smtp_port = COALESCE($10, smtp_port),
          smtp_secure = COALESCE($11, smtp_secure),
          imap_host = COALESCE($12, imap_host),
          imap_port = COALESCE($13, imap_port),
          imap_secure = COALESCE($14, imap_secure),
          username = COALESCE($15, username),
          from_name = COALESCE($16, from_name),
          provider = COALESCE($17, provider),
          password_env_key = COALESCE($18, password_env_key),
          daily_send_limit = CASE WHEN $19 THEN $20 ELSE daily_send_limit END,
          send_days = COALESCE($21, send_days),
          smtp_verified_at = CASE WHEN $9 IS NOT NULL OR $10 IS NOT NULL OR $11 IS NOT NULL THEN NULL ELSE smtp_verified_at END,
          imap_verified_at = CASE WHEN $12 IS NOT NULL OR $13 IS NOT NULL OR $14 IS NOT NULL THEN NULL ELSE imap_verified_at END,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [
      req.params.id,
      req.body.is_active === undefined ? null : toBool(req.body.is_active),
      req.body.warmup_enabled === undefined ? null : toBool(req.body.warmup_enabled),
      dailyWarmupLimit,
      minDelayMinutes,
      maxDelayMinutes,
      req.body.send_window_start || null,
      req.body.send_window_end || null,
      req.body.smtp_host || null,
      req.body.smtp_port ? Number(req.body.smtp_port) : null,
      req.body.smtp_secure === undefined ? null : toBool(req.body.smtp_secure),
      req.body.imap_host || null,
      req.body.imap_port ? Number(req.body.imap_port) : null,
      req.body.imap_secure === undefined ? null : toBool(req.body.imap_secure),
      req.body.username || null,
      req.body.from_name || null,
      req.body.provider || null,
      passwordEnvKey,
      req.body.daily_send_limit !== undefined,
      dailySendLimit,
      sendDays,
    ],
  );
  res.json(result.rows[0]);
}));

app.post("/api/mailboxes", asyncHandler(async (req, res) => {
  const password = String(req.body.password || "");
  const requestedEnvKey = String(req.body.password_env_key || "").trim();
  const passwordEnvKey = password
    ? await saveSecretToDotenv(requestedEnvKey || mailboxPasswordEnvKey(req.body.email), password)
    : requestedEnvKey;

  if (!passwordEnvKey) {
    return res.status(400).json({ error: "mailbox_password_required" });
  }

  const result = await query(
    `
      INSERT INTO mailboxes(
        name, email, provider, smtp_host, smtp_port, smtp_secure,
        imap_host, imap_port, imap_secure, username, password_env_key, from_name,
        daily_send_limit, daily_warmup_limit, min_delay_minutes, max_delay_minutes,
        send_window_start, send_window_end, send_days, warmup_enabled
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      RETURNING *
    `,
    [
      req.body.name,
      req.body.email,
      req.body.provider || "custom",
      req.body.smtp_host,
      Number(req.body.smtp_port || 465),
      req.body.smtp_secure === undefined ? true : toBool(req.body.smtp_secure),
      req.body.imap_host,
      Number(req.body.imap_port || 993),
      req.body.imap_secure === undefined ? true : toBool(req.body.imap_secure),
      req.body.username || req.body.email,
      passwordEnvKey,
      req.body.from_name || req.body.name,
      req.body.daily_send_limit ? Number(req.body.daily_send_limit) : null,
      Number(req.body.daily_warmup_limit || 5),
      Number(req.body.min_delay_minutes || 7),
      Number(req.body.max_delay_minutes || 18),
      req.body.send_window_start || "09:00",
      req.body.send_window_end || "18:00",
      parseArray(req.body.send_days).map(Number).filter(Boolean).length
        ? parseArray(req.body.send_days).map(Number)
        : [1, 2, 3, 4, 5],
      toBool(req.body.warmup_enabled),
    ],
  );
  res.status(201).json(result.rows[0]);
}));

app.post("/api/mailboxes/:id/check", asyncHandler(async (req, res) => {
  const mailbox = (await query("SELECT * FROM mailboxes WHERE id = $1", [req.params.id])).rows[0];
  if (!mailbox) return res.status(404).json({ error: "not_found" });

  const smtp = await withTimeout(verifySmtp(mailbox), 15000, "SMTP")
    .then((result) => ({ ...result, ok: true }))
    .catch((error) => ({ ok: false, error: error.message, code: error.code, command: error.command }));
  const imap = await withTimeout(verifyImap(mailbox), 15000, "IMAP")
    .then((result) => ({ ...result, ok: true }))
    .catch((error) => ({ ok: false, error: error.message, code: error.code }));
  const domain = await checkSendingDomain(mailbox)
    .catch((error) => ({ ok: false, error: error.message }));

  await query(
    `
      UPDATE mailboxes
      SET smtp_verified_at = CASE WHEN $2 THEN now() ELSE NULL END,
          imap_verified_at = CASE WHEN $3 THEN now() ELSE NULL END,
          health_status = CASE WHEN $2 AND $3 THEN 'ok' ELSE 'error' END,
          error_count = CASE WHEN $2 AND $3 THEN error_count ELSE error_count + 1 END,
          updated_at = now()
      WHERE id = $1
    `,
    [mailbox.id, smtp.ok, imap.ok],
  );
  res.json({ ok: smtp.ok && imap.ok, smtp, imap, domain });
}));

app.post("/api/mailboxes/:id/sync", asyncHandler(async (req, res) => {
  await query("INSERT INTO job_queue(job_type, payload) VALUES ('sync_inbox', $1)", [{ mailboxId: req.params.id }]);
  res.json({ queued: true });
}));

app.get("/api/suppressions", asyncHandler(async (_req, res) => {
  const result = await query("SELECT * FROM suppressions ORDER BY created_at DESC LIMIT 500");
  res.json(result.rows);
}));

app.post("/api/suppressions", asyncHandler(async (req, res) => {
  const email = req.body.email ? String(req.body.email).trim().toLowerCase() : null;
  const domain = req.body.domain ? String(req.body.domain).trim().toLowerCase() : email?.split("@")[1] || null;
  const result = await query(
    `
      INSERT INTO suppressions(email, domain, reason, source)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT DO NOTHING
      RETURNING *
    `,
    [email, domain, req.body.reason || "manual", req.body.source || "manual"],
  );
  if (email) {
    await query(
      "UPDATE leads SET status = 'suppressed', suppressed_at = now(), suppression_reason = $2 WHERE lower(email) = $1",
      [email, req.body.reason || "manual"],
    );
  }
  if (domain) {
    await query(
      "UPDATE leads SET status = 'suppressed', suppressed_at = now(), suppression_reason = $2 WHERE lower(domain) = $1",
      [domain, req.body.reason || "manual"],
    );
  }
  res.status(201).json(result.rows[0] || { email, domain, reason: req.body.reason || "manual" });
}));

app.delete("/api/suppressions/:id", asyncHandler(async (req, res) => {
  await query("DELETE FROM suppressions WHERE id = $1", [req.params.id]);
  res.json({ deleted: true });
}));

app.get("/api/campaigns", asyncHandler(async (_req, res) => {
  const campaigns = (await query("SELECT * FROM campaigns ORDER BY created_at DESC")).rows;
  const steps = (await query("SELECT * FROM campaign_steps ORDER BY campaign_id, position")).rows;
  const attachments = (await query("SELECT * FROM attachments WHERE campaign_step_id IS NOT NULL ORDER BY created_at")).rows;
  res.json(campaigns.map((campaign) => ({
    ...campaign,
    steps: steps
      .filter((step) => step.campaign_id === campaign.id)
      .map((step) => ({ ...step, attachments: attachments.filter((item) => item.campaign_step_id === step.id) })),
  })));
}));

app.post("/api/campaigns", asyncHandler(async (req, res) => {
  const result = await query(
    `
      INSERT INTO campaigns(name, description, segment, tracking_enabled, manual_approval_required, daily_limit, send_window_start, send_window_end, send_days)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `,
    [
      req.body.name,
      req.body.description || "",
      cleanText(req.body.segment),
      toBool(req.body.tracking_enabled ?? true),
      toBool(req.body.manual_approval_required ?? true),
      req.body.daily_limit ? Number(req.body.daily_limit) : null,
      req.body.send_window_start || "09:00",
      req.body.send_window_end || "18:00",
      parseArray(req.body.send_days).map(Number).filter(Boolean).length
        ? parseArray(req.body.send_days).map(Number)
        : [1, 2, 3, 4, 5],
    ],
  );
  res.status(201).json(result.rows[0]);
}));

app.patch("/api/campaigns/:id", asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "campaign_required" });
  const result = await query(
    `
      UPDATE campaigns
      SET name = $2,
          description = $3,
          segment = $4,
          tracking_enabled = $5,
          manual_approval_required = $6,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [
      req.params.id,
      req.body.name,
      req.body.description || "",
      cleanText(req.body.segment),
      toBool(req.body.tracking_enabled ?? true),
      toBool(req.body.manual_approval_required ?? true),
    ],
  );
  if (!result.rows[0]) return res.status(404).json({ error: "campaign_not_found" });
  res.json(result.rows[0]);
}));

app.post("/api/campaigns/:id/steps", asyncHandler(async (req, res) => {
  const max = await query("SELECT COALESCE(max(position), 0) + 1 AS next FROM campaign_steps WHERE campaign_id = $1", [req.params.id]);
  const html = req.body.body_template_html || req.body.body_template_text || "";
  const result = await query(
    `
      INSERT INTO campaign_steps(campaign_id, position, name, delay_days, subject_template, body_template_text, body_template_html, editor_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `,
    [
      req.params.id,
      Number(req.body.position || max.rows[0].next),
      req.body.name,
      Number(req.body.delay_days || 0),
      req.body.subject_template,
      req.body.body_template_text || html.replace(/<[^>]+>/g, ""),
      html,
      { html },
    ],
  );
  res.status(201).json(result.rows[0]);
}));

app.patch("/api/steps/:id", asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "campaign_step_required" });
  const html = req.body.body_template_html || req.body.body_template_text || "";
  const result = await query(
    `
      UPDATE campaign_steps
      SET name = $2,
          delay_days = $3,
          subject_template = $4,
          body_template_text = $5,
          body_template_html = $6,
          editor_json = $7,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [
      req.params.id,
      req.body.name,
      Number(req.body.delay_days || 0),
      req.body.subject_template,
      req.body.body_template_text || html.replace(/<[^>]+>/g, ""),
      html,
      { html },
    ],
  );
  if (!result.rows[0]) return res.status(404).json({ error: "campaign_step_not_found" });
  res.json(result.rows[0]);
}));

app.post("/api/steps/:id/attachments", attachmentUpload.single("file"), asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) {
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: "campaign_step_required" });
  }
  if (!req.file) return res.status(400).json({ error: "file_required" });
  const step = (await query("SELECT id FROM campaign_steps WHERE id = $1", [req.params.id])).rows[0];
  if (!step) {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(404).json({ error: "campaign_step_not_found" });
  }
  const runtime = await getRuntimeSettings();
  if (req.file.size > runtime.maxAttachmentMb * 1024 * 1024) {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: `attachment_too_large_max_${runtime.maxAttachmentMb}_mb` });
  }
  const result = await query(
    `
      INSERT INTO attachments(campaign_step_id, file_name, mime_type, size_bytes, storage_path)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
    `,
    [req.params.id, req.file.originalname, req.file.mimetype, req.file.size, path.resolve(req.file.path)],
  );
  res.status(201).json(result.rows[0]);
}));

app.get("/api/steps/:id/attachments", asyncHandler(async (req, res) => {
  const result = await query("SELECT * FROM attachments WHERE campaign_step_id = $1 ORDER BY created_at DESC", [req.params.id]);
  res.json(result.rows);
}));

app.delete("/api/attachments/:id", asyncHandler(async (req, res) => {
  const attachment = (await query("DELETE FROM attachments WHERE id = $1 RETURNING *", [req.params.id])).rows[0];
  if (attachment?.storage_path) await fs.unlink(attachment.storage_path).catch(() => {});
  res.json({ deleted: Boolean(attachment) });
}));

app.post("/api/campaigns/:id/enroll", asyncHandler(async (req, res) => {
  const leadIds = parseArray(req.body.lead_ids);
  const mailboxIds = parseArray(req.body.mailbox_ids);
  if (!leadIds.length || !mailboxIds.length) return res.status(400).json({ error: "lead_ids_and_mailbox_ids_required" });

  let count = 0;
  for (let index = 0; index < leadIds.length; index += 1) {
    const mailboxId = mailboxIds[index % mailboxIds.length];
    const insert = await query(
      `
        INSERT INTO enrollments(lead_id, campaign_id, mailbox_id, status, current_step, next_send_at)
        VALUES ($1,$2,$3,'active',1,now())
        ON CONFLICT (lead_id, campaign_id) DO NOTHING
        RETURNING id
      `,
      [leadIds[index], req.params.id, mailboxId],
    );
    if (insert.rowCount) count += 1;
  }
  await query("UPDATE leads SET status = 'enrolled' WHERE id = ANY($1::uuid[])", [leadIds]);
  res.json({ enrolled: count });
}));

app.get("/api/campaigns/:id/leads", asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "campaign_required" });
  const result = await query(
    `
      SELECT
        e.id AS enrollment_id,
        e.status AS enrollment_status,
        e.current_step,
        e.next_send_at,
        e.started_at,
        l.id AS lead_id,
        l.company,
        l.email,
        l.contact_name,
        l.segment,
        l.status AS lead_status,
        l.validation_status,
        l.validation_reason,
        m.email AS mailbox_email
      FROM enrollments e
      JOIN leads l ON l.id = e.lead_id
      LEFT JOIN mailboxes m ON m.id = e.mailbox_id
      WHERE e.campaign_id = $1
      ORDER BY e.started_at DESC
      LIMIT 500
    `,
    [req.params.id],
  );
  res.json(result.rows);
}));

app.get("/api/campaigns/:id/preflight", asyncHandler(async (req, res) => {
  res.json(await campaignPreflight(req.params.id));
}));

app.post("/api/campaigns/:id/start", asyncHandler(async (req, res) => {
  const mode = req.body.mode || "manual";
  const preflight = await campaignPreflight(req.params.id);
  if (!preflight.ok && !toBool(req.body.force)) return res.status(400).json(preflight);

  const requiresApproval = mode === "manual";
  const result = await query(
    `
      INSERT INTO sending_queue(enrollment_id, lead_id, campaign_id, campaign_step_id, mailbox_id, mode, requires_approval, scheduled_at)
      SELECT e.id, e.lead_id, e.campaign_id, s.id, e.mailbox_id, $2, $3,
             now() + ((row_number() OVER (ORDER BY e.started_at) - 1) * interval '7 minutes')
      FROM enrollments e
      JOIN campaign_steps s ON s.campaign_id = e.campaign_id AND s.position = e.current_step
      WHERE e.campaign_id = $1 AND e.status = 'active'
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    [req.params.id, mode, requiresApproval],
  );
  await query("UPDATE campaigns SET status = 'active', test_mode = $2 WHERE id = $1", [req.params.id, mode === "test"]);
  res.json({ queued: result.rowCount, mode, preflight });
}));

app.post("/api/sending/:id/approve", asyncHandler(async (req, res) => {
  const result = await query(
    "UPDATE sending_queue SET approved_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
    [req.params.id],
  );
  res.json(result.rows[0]);
}));

app.post("/api/campaigns/:id/approve-pending", asyncHandler(async (req, res) => {
  const result = await query(
    "UPDATE sending_queue SET approved_at = now(), updated_at = now() WHERE campaign_id = $1 AND status = 'pending' RETURNING id",
    [req.params.id],
  );
  res.json({ approved: result.rowCount });
}));

app.get("/api/sending", asyncHandler(async (_req, res) => {
  const result = await query(`
    SELECT q.*, l.company, l.email, c.name AS campaign_name, m.email AS mailbox_email, s.name AS step_name
    FROM sending_queue q
    JOIN leads l ON l.id = q.lead_id
    JOIN campaigns c ON c.id = q.campaign_id
    LEFT JOIN mailboxes m ON m.id = q.mailbox_id
    LEFT JOIN campaign_steps s ON s.id = q.campaign_step_id
    ORDER BY q.scheduled_at ASC
    LIMIT 300
  `);
  res.json(result.rows);
}));

app.get("/api/sending/progress", asyncHandler(async (_req, res) => {
  const result = await query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'sent')::int AS sent,
      count(*) FILTER (WHERE status = 'failed')::int AS failed,
      count(*) FILTER (WHERE status IN ('pending','retrying','running'))::int AS active,
      min(scheduled_at) FILTER (WHERE status IN ('pending','retrying')) AS next_scheduled_at,
      avg(EXTRACT(EPOCH FROM (scheduled_at - lag_scheduled_at)) / 60.0) FILTER (WHERE lag_scheduled_at IS NOT NULL) AS avg_gap_minutes
    FROM (
      SELECT q.*, lag(scheduled_at) OVER (ORDER BY scheduled_at) AS lag_scheduled_at
      FROM sending_queue q
    ) q
  `);
  const row = result.rows[0];
  const avgGap = Math.max(Number(row.avg_gap_minutes || 12), 7);
  res.json({
    ...row,
    percent: row.total ? Math.round((row.sent / row.total) * 100) : 0,
    etaMinutes: Math.round(Number(row.active || 0) * avgGap),
  });
}));

app.get("/api/inbox", asyncHandler(async (_req, res) => {
  const result = await query(`
    SELECT msg.*, l.company, l.email AS lead_email, m.email AS mailbox_email
    FROM messages msg
    LEFT JOIN leads l ON l.id = msg.lead_id
    LEFT JOIN mailboxes m ON m.id = msg.mailbox_id
    WHERE msg.direction = 'inbound'
    ORDER BY msg.received_at DESC NULLS LAST, msg.created_at DESC
    LIMIT 200
  `);
  res.json(result.rows);
}));

app.post("/api/inbox/sync", asyncHandler(async (_req, res) => {
  const result = await query(`
    INSERT INTO job_queue(job_type, payload)
    SELECT 'sync_inbox', jsonb_build_object('mailboxId', id)
    FROM mailboxes
    WHERE is_active = true
    RETURNING id
  `);
  res.json({ queued: result.rowCount });
}));

app.patch("/api/inbox/:id/classification", asyncHandler(async (req, res) => {
  const result = await query(
    `
      UPDATE messages
      SET reply_classification = $2, reply_classification_source = 'manual'
      WHERE id = $1
      RETURNING *
    `,
    [req.params.id, req.body.classification],
  );
  await logEvent("reply_classified", { messageId: req.params.id, payload: { classification: req.body.classification, source: "manual" } });
  res.json(result.rows[0]);
}));

app.get("/api/events", asyncHandler(async (_req, res) => {
  const result = await query("SELECT * FROM events ORDER BY created_at DESC LIMIT 200");
  res.json(result.rows);
}));

app.get("/api/warmup", asyncHandler(async (req, res) => {
  const pageSize = Math.min(Math.max(Number(req.query.pageSize || 20), 5), 100);
  const page = Math.max(Number(req.query.page || 1), 1);
  const offset = (page - 1) * pageSize;
  const [mailboxes, stats, totalEvents, events] = await Promise.all([
    query("SELECT id, name, email, warmup_enabled, daily_warmup_limit, health_status FROM mailboxes ORDER BY created_at DESC"),
    query(`
      SELECT
        count(*) FILTER (WHERE event_type = 'warmup_sent')::int AS sent,
        count(*) FILTER (WHERE event_type = 'warmup_reply_received')::int AS replies,
        count(*) FILTER (WHERE event_type = 'mailbox_error')::int AS errors
      FROM events
      WHERE created_at > now() - interval '30 days'
    `),
    query("SELECT count(*)::int AS total FROM events WHERE event_type LIKE 'warmup_%'"),
    query("SELECT * FROM events WHERE event_type LIKE 'warmup_%' ORDER BY created_at DESC LIMIT $1 OFFSET $2", [pageSize, offset]),
  ]);
  res.json({
    mailboxes: mailboxes.rows,
    stats: stats.rows[0],
    events: events.rows,
    pagination: {
      page,
      pageSize,
      total: totalEvents.rows[0].total,
      totalPages: Math.max(Math.ceil(totalEvents.rows[0].total / pageSize), 1),
    },
  });
}));

app.post("/api/warmup/send-now", asyncHandler(async (_req, res) => {
  await query("INSERT INTO job_queue(job_type, payload) VALUES ('warmup_send', '{}'::jsonb)");
  res.json({ queued: true });
}));

app.get("/api/export/leads.csv", asyncHandler(async (_req, res) => {
  const rows = (await query("SELECT * FROM leads ORDER BY created_at DESC")).rows;
  const header = ["company", "contact_name", "position", "email", "website", "segment", "city", "status", "validation_status", "pain", "notes"];
  const body = rows.map((row) => header.map((key) => `"${String(row[key] || "").replaceAll('"', '""')}"`).join(","));
  res.type("text/csv").send([header.join(","), ...body].join("\n"));
}));

app.get("/t/open/:trackingId.gif", asyncHandler(async (req, res) => {
  const message = (await query("SELECT * FROM messages WHERE tracking_id = $1", [req.params.trackingId])).rows[0];
  if (message) {
    const existing = await query("SELECT 1 FROM open_events WHERE tracking_id = $1 LIMIT 1", [req.params.trackingId]);
    const ua = req.get("user-agent") || "";
    const proxyLike = /googleimageproxy|apple|icloud|proxy/i.test(ua);
    await query(
      `
        INSERT INTO open_events(tracking_id, message_id, lead_id, campaign_id, mailbox_id, ip, user_agent, is_first_open, is_proxy_like)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        req.params.trackingId,
        message.id,
        message.lead_id,
        message.campaign_id,
        message.mailbox_id,
        req.ip,
        ua,
        existing.rowCount === 0,
        proxyLike,
      ],
    );
    await query("UPDATE leads SET status = 'opened', updated_at = now() WHERE id = $1 AND status IN ('sent','enrolled')", [message.lead_id]);
    await logEvent("email_opened", { leadId: message.lead_id, campaignId: message.campaign_id, mailboxId: message.mailbox_id, messageId: message.id, payload: { proxyLike } });
  }
  const pixel = Buffer.from("R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.send(pixel);
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || "internal_error" });
});

const server = app.listen(env.appPort, () => {
  console.log(`Outreach Desk running on http://localhost:${env.appPort}`);
});

process.on("SIGTERM", async () => {
  server.close();
  await pool.end();
});
