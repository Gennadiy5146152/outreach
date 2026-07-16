import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { readSheet } from "read-excel-file/node";
import { env } from "./config/env.js";
import { pool, query, withClient } from "./db/pool.js";
import { inferOutreachMapping, parseCsv, rowsToObjects, rowsToOutreachRows } from "./services/csv.js";
import { parseEmail } from "./services/validation.js";
import { checkSendingDomain } from "./services/domain-check.js";
import { sendMail, verifyImap, verifySmtp } from "./services/mail.js";
import { logEvent } from "./services/events.js";
import { campaignPreflight } from "./services/preflight.js";
import { getRuntimeSettings, saveRuntimeSettings } from "./services/runtime.js";
import { cancelOutreachForScope } from "./services/outreach-stop.js";
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

const REPLY_CLASSIFICATIONS = new Set([
  "positive_reply",
  "neutral_reply",
  "negative_reply",
  "auto_reply",
  "unsubscribe",
  "not_target",
  "bounce",
  "unknown",
]);

const STOPPING_REPLY_CLASSIFICATIONS = new Set([
  "positive_reply",
  "negative_reply",
  "unsubscribe",
  "not_target",
  "bounce",
]);

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

async function checkMailboxConnection(mailbox) {
  const [smtp, imap] = await Promise.all([
    withTimeout(verifySmtp(mailbox), 15000, "SMTP")
      .then((result) => ({ ...result, ok: true }))
      .catch((error) => ({ ok: false, error: error.message, code: error.code, command: error.command })),
    withTimeout(verifyImap(mailbox), 15000, "IMAP")
      .then((result) => ({ ...result, ok: true }))
      .catch((error) => ({ ok: false, error: error.message, code: error.code })),
  ]);
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

  return { ok: smtp.ok && imap.ok, smtp, imap, domain };
}

async function campaignLaunchPlan(campaignId) {
  const result = await query(
    `
      SELECT
        count(*)::int AS enrollments,
        count(*) FILTER (WHERE e.status = 'active')::int AS active_enrollments,
        count(*) FILTER (WHERE e.status = 'paused')::int AS paused_enrollments,
        count(*) FILTER (WHERE e.status = 'active' AND s.id IS NOT NULL)::int AS ready_enrollments,
        count(*) FILTER (WHERE e.status = 'active' AND s.id IS NULL)::int AS missing_step_enrollments
      FROM enrollments e
      LEFT JOIN campaign_steps s ON s.campaign_id = e.campaign_id AND s.position = e.current_step
      WHERE e.campaign_id = $1
    `,
    [campaignId],
  );
  return result.rows[0] || {
    enrollments: 0,
    active_enrollments: 0,
    paused_enrollments: 0,
    ready_enrollments: 0,
    missing_step_enrollments: 0,
  };
}

function parseOptionalDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function parseOutreachRawFile(file) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  if (extension === ".csv") {
    return { fileType: "csv", rows: parseCsv(file.buffer.toString("utf8")) };
  }
  if (extension === ".xlsx") {
    return { fileType: "xlsx", rows: await readSheet(file.buffer) };
  }
  const error = new Error("unsupported_file_type");
  error.status = 400;
  throw error;
}

async function parseOutreachImportFile(file, mapping = {}) {
  const parsed = await parseOutreachRawFile(file);
  return { fileType: parsed.fileType, rows: rowsToOutreachRows(parsed.rows, mapping) };
}

function parseMapping(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    const error = new Error("invalid_mapping_json");
    error.status = 400;
    throw error;
  }
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function optionalDateFilter(value) {
  const date = parseOptionalDate(value);
  return date ? date.toISOString() : "";
}

function outreachStepsFromRow(row) {
  const items = [
    {
      position: 1,
      subject: row.subject || "",
      body: row.body || "",
      delayDays: 0,
    },
    {
      position: 2,
      subject: row.followup_1_subject || row.subject || "",
      body: row.followup_1_body || "",
      delayDays: Number(row.followup_1_delay_days || 3),
    },
    {
      position: 3,
      subject: row.followup_2_subject || row.subject || "",
      body: row.followup_2_body || "",
      delayDays: Number(row.followup_2_delay_days || 4),
    },
    {
      position: 4,
      subject: row.followup_3_subject || row.subject || "",
      body: row.followup_3_body || "",
      delayDays: Number(row.followup_3_delay_days || 5),
    },
  ];

  return items
    .filter((item) => item.position === 1 || item.body)
    .map((item) => ({
      ...item,
      subject: cleanText(item.subject),
      body: cleanText(item.body),
      delayDays: Number.isFinite(item.delayDays) && item.delayDays >= 0 ? item.delayDays : 0,
    }));
}

function unresolvedPersonalizationMarkers(value) {
  const text = String(value || "");
  const markers = [
    ...text.matchAll(/\{\{\s*[^{}]+\s*}}/g),
    ...text.matchAll(/\[\[\s*[^\[\]]+\s*]]/g),
    ...text.matchAll(/<<\s*[^<>]+\s*>>/g),
  ].map((match) => match[0].trim());
  const rawMarkers = markers.length
    ? []
    : [...text.matchAll(/\b(first_name|last_name|company_name|contact_name|client_name|имя_клиента|название_компании)\b/gi)]
      .map((match) => match[0].trim());
  return [...new Set([...markers, ...rawMarkers])].slice(0, 5);
}

function personalizationGuardErrors({ subject, body }, prefix = "") {
  const errors = [];
  const subjectMarkers = unresolvedPersonalizationMarkers(subject);
  const bodyMarkers = unresolvedPersonalizationMarkers(body);
  if (subjectMarkers.length) errors.push(`${prefix}в теме остались незаполненные переменные: ${subjectMarkers.join(", ")}`);
  if (bodyMarkers.length) errors.push(`${prefix}в тексте остались незаполненные переменные: ${bodyMarkers.join(", ")}`);
  return errors;
}

function outreachDraftStatus({ email, subject, body, steps = [] }) {
  const parsed = parseEmail(email);
  const errors = [];
  if (!email || !parsed.syntaxValid) errors.push("Некорректный email");
  if (!subject) errors.push("Нет темы письма");
  if (!body) errors.push("Нет текста письма");
  errors.push(...personalizationGuardErrors({ subject, body }).map((error) => error[0].toUpperCase() + error.slice(1)));
  for (const step of steps.filter((item) => Number(item.position) > 1)) {
    errors.push(...personalizationGuardErrors(
      { subject: step.subject, body: step.body || step.body_text },
      `Follow-up ${Number(step.position) - 1}: `,
    ));
  }
  return { parsed, errors, status: errors.length ? "blocked" : "ready" };
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
      outreachStopScope: runtime.outreachStopScope,
    },
    settings: Object.fromEntries(settings.rows.map((item) => [item.key, item.value])),
  });
}));

app.put("/api/runtime-settings", asyncHandler(async (req, res) => {
  const mailDryRun = toBool(req.body.mailDryRun);
  const publicTrackingUrl = String(req.body.publicTrackingUrl || "").trim();
  const maxAttachmentMb = Number(req.body.maxAttachmentMb || env.maxAttachmentMb);
  const outreachStopScope = cleanText(req.body.outreachStopScope);

  if (!Number.isFinite(maxAttachmentMb) || maxAttachmentMb < 1 || maxAttachmentMb > 200) {
    return res.status(400).json({ error: "max_attachment_mb_must_be_between_1_and_200" });
  }

  const runtime = await saveRuntimeSettings({
    dryRun: mailDryRun,
    publicTrackingUrl,
    maxAttachmentMb,
    outreachStopScope,
  });

  res.json({
    runtime: {
      dryRun: runtime.dryRun,
      publicTrackingUrl: runtime.publicTrackingUrl,
      attachmentDir: env.attachmentDir,
      maxAttachmentMb: runtime.maxAttachmentMb,
      outreachStopScope: runtime.outreachStopScope,
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
  const [leadStats, messageStats, queueStats, opens, replies, outreachStats, stepPerformance] = await Promise.all([
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
        count(*) FILTER (WHERE direction = 'outbound' AND type = 'outreach' AND status = 'sent')::int AS sent,
        count(*) FILTER (WHERE direction = 'inbound' AND type = 'bounce')::int AS bounced
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
        count(o.*)::int AS raw,
        count(DISTINCT o.message_id)::int AS unique
      FROM open_events o
      JOIN messages msg ON msg.id = o.message_id
      WHERE msg.type = 'outreach'
    `),
    query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE reply_classification = 'positive_reply')::int AS positive
      FROM messages
      WHERE direction = 'inbound'
        AND type = 'reply'
        AND campaign_id IS NOT NULL
    `),
    query(`
      SELECT
        (SELECT COALESCE(sum(rows_total), 0)::int FROM outreach_imports) AS imported_rows,
        (SELECT COALESCE(sum(rows_ready), 0)::int FROM outreach_imports) AS imported_ready,
        (SELECT COALESCE(sum(rows_blocked), 0)::int FROM outreach_imports) AS imported_blocked,
        (SELECT count(*)::int FROM outreach_drafts) AS drafts_total,
        (SELECT count(*)::int FROM outreach_drafts WHERE status = 'ready') AS drafts_ready,
        (SELECT count(*)::int FROM outreach_drafts WHERE status = 'blocked') AS drafts_blocked,
        (SELECT count(*)::int FROM outreach_drafts WHERE status IN ('queued','active_sequence')) AS drafts_active,
        (SELECT count(*)::int FROM outreach_conversations WHERE status IN ('waiting_reply_review','manual_reply_needed')) AS review_needed,
        (SELECT count(*)::int FROM outreach_conversations WHERE status IN ('active_sequence','waiting_reply_review','manual_reply_needed','paused','completed','positive','negative','not_target','unsubscribed','bounced')) AS dialogs_total,
        (
          SELECT count(DISTINCT oc.id)::int
          FROM outreach_conversations oc
          JOIN messages msg ON msg.lead_id = oc.lead_id
          WHERE msg.direction = 'inbound'
            AND msg.type IN ('reply','bounce')
            AND msg.outreach_draft_id IS NOT NULL
        ) AS replied_dialogs,
        (SELECT count(*)::int FROM outreach_conversations WHERE classification = 'positive_reply') AS positive_replies,
        (SELECT count(*)::int FROM outreach_conversations WHERE classification = 'negative_reply') AS negative_replies,
        (SELECT count(*)::int FROM outreach_conversations WHERE classification = 'auto_reply') AS auto_replies,
        (SELECT count(*)::int FROM outreach_conversations WHERE classification = 'bounce' OR status = 'bounced') AS bounces,
        (SELECT count(*)::int FROM outreach_conversations WHERE classification = 'unsubscribe' OR status = 'unsubscribed') AS unsubscribes,
        (
          SELECT COALESCE(round(avg(EXTRACT(EPOCH FROM (first_reply_at - first_sent_at)) / 3600.0))::int, 0)
          FROM (
            SELECT
              min(sent_at) FILTER (WHERE direction = 'outbound') AS first_sent_at,
              min(received_at) FILTER (WHERE direction = 'inbound') AS first_reply_at
            FROM messages
            WHERE type <> 'warmup'
              AND outreach_draft_id IS NOT NULL
            GROUP BY lead_id
          ) reply_times
          WHERE first_sent_at IS NOT NULL
            AND first_reply_at IS NOT NULL
        ) AS avg_hours_to_reply,
        (SELECT count(*)::int FROM messages WHERE direction = 'outbound' AND type = 'outreach' AND outreach_step_id IS NOT NULL AND status = 'sent') AS sent_total,
        (
          SELECT count(*)::int
          FROM messages msg
          JOIN outreach_draft_steps ods ON ods.id = msg.outreach_step_id
          WHERE msg.direction = 'outbound'
            AND msg.type = 'outreach'
            AND msg.status = 'sent'
            AND ods.position = 1
        ) AS sent_first,
        (
          SELECT count(*)::int
          FROM messages msg
          JOIN outreach_draft_steps ods ON ods.id = msg.outreach_step_id
          WHERE msg.direction = 'outbound'
            AND msg.type = 'outreach'
            AND msg.status = 'sent'
            AND ods.position > 1
        ) AS sent_followups
    `),
    query(`
      WITH step_sends AS (
        SELECT
          ods.position,
          count(*)::int AS sent,
          count(DISTINCT msg.lead_id)::int AS contacts,
          min(msg.sent_at) AS first_sent_at,
          max(msg.sent_at) AS last_sent_at
        FROM messages msg
        JOIN outreach_draft_steps ods ON ods.id = msg.outreach_step_id
        WHERE msg.direction = 'outbound'
          AND msg.type = 'outreach'
          AND msg.status = 'sent'
        GROUP BY ods.position
      ),
      step_opens AS (
        SELECT
          ods.position,
          count(DISTINCT o.message_id)::int AS unique_opens
        FROM open_events o
        JOIN messages msg ON msg.id = o.message_id
        JOIN outreach_draft_steps ods ON ods.id = msg.outreach_step_id
        WHERE msg.type = 'outreach'
        GROUP BY ods.position
      ),
      step_replies AS (
        SELECT
          ods.position,
          count(DISTINCT msg.lead_id) FILTER (WHERE msg.type = 'reply')::int AS replied_dialogs,
          count(DISTINCT msg.lead_id) FILTER (WHERE msg.reply_classification = 'positive_reply')::int AS positive_replies,
          count(DISTINCT msg.lead_id) FILTER (WHERE msg.reply_classification = 'negative_reply')::int AS negative_replies,
          count(DISTINCT msg.lead_id) FILTER (WHERE msg.reply_classification = 'auto_reply')::int AS auto_replies,
          count(DISTINCT msg.lead_id) FILTER (WHERE msg.reply_classification = 'unsubscribe')::int AS unsubscribes,
          count(DISTINCT msg.lead_id) FILTER (WHERE msg.type = 'bounce' OR msg.reply_classification = 'bounce')::int AS bounces,
          count(DISTINCT msg.lead_id) FILTER (
            WHERE msg.type = 'bounce'
               OR msg.reply_classification IN ('positive_reply','negative_reply','unsubscribe','not_target','bounce')
          )::int AS stopped_after_step
        FROM messages msg
        JOIN outreach_draft_steps ods ON ods.id = msg.outreach_step_id
        WHERE msg.direction = 'inbound'
          AND msg.type IN ('reply','bounce')
        GROUP BY ods.position
      ),
      reply_times AS (
        SELECT
          outbound.position,
          COALESCE(round(avg(EXTRACT(EPOCH FROM (inbound.first_reply_at - outbound.first_sent_at)) / 3600.0))::int, 0) AS avg_hours_to_reply
        FROM (
          SELECT msg.lead_id, msg.outreach_step_id, ods.position, min(msg.sent_at) AS first_sent_at
          FROM messages msg
          JOIN outreach_draft_steps ods ON ods.id = msg.outreach_step_id
          WHERE msg.direction = 'outbound'
            AND msg.type = 'outreach'
            AND msg.status = 'sent'
          GROUP BY msg.lead_id, msg.outreach_step_id, ods.position
        ) outbound
        JOIN (
          SELECT lead_id, outreach_step_id, min(received_at) AS first_reply_at
          FROM messages
          WHERE direction = 'inbound'
            AND type IN ('reply','bounce')
            AND outreach_step_id IS NOT NULL
          GROUP BY lead_id, outreach_step_id
        ) inbound ON inbound.lead_id = outbound.lead_id
          AND inbound.outreach_step_id = outbound.outreach_step_id
        WHERE inbound.first_reply_at IS NOT NULL
          AND outbound.first_sent_at IS NOT NULL
        GROUP BY outbound.position
      )
      SELECT
        step_sends.position,
        step_sends.sent,
        step_sends.contacts,
        COALESCE(step_opens.unique_opens, 0)::int AS unique_opens,
        COALESCE(step_replies.replied_dialogs, 0)::int AS replied_dialogs,
        COALESCE(step_replies.positive_replies, 0)::int AS positive_replies,
        COALESCE(step_replies.negative_replies, 0)::int AS negative_replies,
        COALESCE(step_replies.auto_replies, 0)::int AS auto_replies,
        COALESCE(step_replies.unsubscribes, 0)::int AS unsubscribes,
        COALESCE(step_replies.bounces, 0)::int AS bounces,
        COALESCE(step_replies.stopped_after_step, 0)::int AS stopped_after_step,
        COALESCE(reply_times.avg_hours_to_reply, 0)::int AS avg_hours_to_reply,
        CASE WHEN step_sends.contacts > 0 THEN round((COALESCE(step_opens.unique_opens, 0)::numeric / step_sends.contacts) * 100)::int ELSE 0 END AS open_rate,
        CASE WHEN step_sends.contacts > 0 THEN round((COALESCE(step_replies.replied_dialogs, 0)::numeric / step_sends.contacts) * 100)::int ELSE 0 END AS reply_rate,
        CASE WHEN step_sends.contacts > 0 THEN round((COALESCE(step_replies.positive_replies, 0)::numeric / step_sends.contacts) * 100)::int ELSE 0 END AS positive_rate,
        step_sends.first_sent_at,
        step_sends.last_sent_at
      FROM step_sends
      LEFT JOIN step_opens ON step_opens.position = step_sends.position
      LEFT JOIN step_replies ON step_replies.position = step_sends.position
      LEFT JOIN reply_times ON reply_times.position = step_sends.position
      ORDER BY step_sends.position
    `),
  ]);
  const sent = messageStats.rows[0].sent || 0;
  const outreach = outreachStats.rows[0];
  const sentFirst = Number(outreach.sent_first || 0);
  const repliedDialogs = Number(outreach.replied_dialogs || 0);
  const positiveReplies = Number(outreach.positive_replies || 0);
  res.json({
    leads: leadStats.rows[0],
    messages: messageStats.rows[0],
    queue: queueStats.rows[0],
    opens: opens.rows[0],
    replies: replies.rows[0],
    outreach,
    stepPerformance: stepPerformance.rows,
    rates: {
      openRate: sent ? Math.round((opens.rows[0].unique / sent) * 100) : 0,
      replyRate: sent ? Math.round((replies.rows[0].total / sent) * 100) : 0,
      outreachReplyRate: sentFirst ? Math.round((repliedDialogs / sentFirst) * 100) : 0,
      positiveReplyRate: sentFirst ? Math.round((positiveReplies / sentFirst) * 100) : 0,
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

app.get("/api/outreach/imports", asyncHandler(async (_req, res) => {
  const result = await query(`
    SELECT *
    FROM outreach_imports
    ORDER BY created_at DESC
    LIMIT 100
  `);
  res.json(result.rows);
}));

app.get("/api/outreach/imports/:id/errors.csv", asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "invalid_import" });
  const item = (await query("SELECT * FROM outreach_imports WHERE id = $1", [req.params.id])).rows[0];
  if (!item) return res.status(404).json({ error: "not_found" });
  const report = Array.isArray(item.error_report) ? item.error_report : [];
  const header = ["row", "email", "errors"];
  const body = report.map((row) => [
    row.row,
    row.email,
    Array.isArray(row.errors) ? row.errors.join("; ") : row.errors,
  ].map(csvCell).join(","));
  const safeName = String(item.file_name || "outreach-import").replace(/[^\w.-]+/g, "_");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}-errors.csv"`);
  res.send([header.join(","), ...body].join("\n"));
}));

app.get("/api/outreach/drafts", asyncHandler(async (req, res) => {
  const status = req.query.status || "";
  const importId = req.query.import_id || "";
  const result = await query(
    `
      SELECT d.*, i.file_name, m.email AS mailbox_email,
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', ods.id,
                   'position', ods.position,
                   'subject', ods.subject,
                   'body_text', ods.body_text,
                   'delay_days', ods.delay_days,
                   'status', ods.status,
                   'queue_id', ods.queue_id
                 )
                 ORDER BY ods.position
               ) FILTER (WHERE ods.id IS NOT NULL),
               '[]'::json
             ) AS steps
      FROM outreach_drafts d
      LEFT JOIN outreach_imports i ON i.id = d.import_id
      LEFT JOIN mailboxes m ON m.id = d.mailbox_id
      LEFT JOIN outreach_draft_steps ods ON ods.draft_id = d.id
      WHERE ($1 = '' OR d.status = $1)
        AND ($2 = '' OR d.import_id = $2::uuid)
      GROUP BY d.id, i.file_name, m.email
      ORDER BY d.created_at DESC
      LIMIT 500
    `,
    [status, importId],
  );
  res.json(result.rows);
}));

app.post("/api/outreach/imports/preview", csvUpload.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file_required" });
  const { fileType, rows } = await parseOutreachRawFile(req.file);
  const [header = [], ...data] = rows;
  const manualMapping = parseMapping(req.body.mapping);
  const mapping = Object.keys(manualMapping).length ? manualMapping : inferOutreachMapping(rows);
  const mappedRows = rowsToOutreachRows(rows, mapping);
  const errors = mappedRows.slice(0, 50).map((row) => {
    const check = outreachDraftStatus({
      email: row.email,
      subject: row.subject,
      body: row.body,
      steps: outreachStepsFromRow(row),
    });
    return {
      row: row.source_row_number,
      email: row.email,
      status: check.status,
      errors: check.errors,
    };
  });
  res.json({
    fileName: req.file.originalname,
    fileType,
    columns: header.map((item, index) => ({ index, name: String(item || "").trim() || `Колонка ${index + 1}` })),
    mapping,
    rowsTotal: data.filter((row) => row.some((value) => String(value || "").trim())).length,
    preview: mappedRows.slice(0, 10),
    errors,
  });
}));

app.patch("/api/outreach/drafts/:id", asyncHandler(async (req, res) => {
  const email = cleanText(req.body.to_email);
  const company = cleanText(req.body.company);
  const contactName = cleanText(req.body.contact_name);
  const segment = cleanText(req.body.segment);
  const subject = cleanText(req.body.subject);
  const bodyText = cleanText(req.body.body_text);
  const mailboxId = req.body.mailbox_id && isUuid(req.body.mailbox_id) ? req.body.mailbox_id : null;
  const sendAfter = parseOptionalDate(req.body.send_after);
  const check = outreachDraftStatus({ email, subject, body: bodyText });
  if (mailboxId) {
    const mailbox = await query("SELECT id FROM mailboxes WHERE id = $1 AND is_active = true", [mailboxId]);
    if (!mailbox.rowCount) return res.status(400).json({ error: "mailbox_not_found" });
  }

  const result = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const updated = await client.query(
        `
          UPDATE outreach_drafts
          SET to_email = $2,
              company = $3,
              contact_name = $4,
              segment = $5,
              subject = $6,
              body_text = $7,
              mailbox_id = $8,
              send_after = $9,
              status = $10,
              error_reason = $11,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [req.params.id, email, company, contactName, segment, subject, bodyText, mailboxId, sendAfter, check.status, check.errors.join("; ")],
      );
      if (!updated.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `
          INSERT INTO outreach_draft_steps(draft_id, position, subject, body_text, delay_days, status)
          VALUES ($1,1,$2,$3,0,$4)
          ON CONFLICT (draft_id, position) DO UPDATE SET
            subject = EXCLUDED.subject,
            body_text = EXCLUDED.body_text,
            status = EXCLUDED.status,
            updated_at = now()
        `,
        [req.params.id, subject, bodyText, check.status === "ready" ? "draft" : "blocked"],
      );
      await client.query("COMMIT");
      return updated.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  if (!result) return res.status(404).json({ error: "not_found" });
  res.json(result);
}));

app.put("/api/outreach/drafts/:id/steps/:position", asyncHandler(async (req, res) => {
  const position = Number(req.params.position);
  if (!isUuid(req.params.id) || !Number.isInteger(position) || position < 2 || position > 4) {
    return res.status(400).json({ error: "invalid_step" });
  }
  const subject = cleanText(req.body.subject);
  const bodyText = cleanText(req.body.body_text);
  const delayDays = Number(req.body.delay_days || 0);
  if (!Number.isFinite(delayDays) || delayDays < 0) return res.status(400).json({ error: "invalid_delay_days" });
  const guardErrors = personalizationGuardErrors({ subject, body: bodyText }, `Follow-up ${position - 1}: `);
  const nextStepStatus = guardErrors.length ? "blocked" : "draft";

  const result = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const draft = (await client.query("SELECT * FROM outreach_drafts WHERE id = $1", [req.params.id])).rows[0];
      if (!draft) {
        await client.query("ROLLBACK");
        return null;
      }
      const existing = (await client.query(
        "SELECT * FROM outreach_draft_steps WHERE draft_id = $1 AND position = $2",
        [draft.id, position],
      )).rows[0];
      if (existing?.status === "sent") {
        const error = new Error("sent_step_cannot_be_edited");
        error.status = 409;
        throw error;
      }

      if (!bodyText) {
        if (existing) {
          await client.query(
            `
              UPDATE sending_queue
              SET status = 'cancelled',
                  last_error = 'Follow-up шаг очищен в черновике',
                  updated_at = now()
              WHERE outreach_step_id = $1
                AND status IN ('pending','retrying')
            `,
            [existing.id],
          );
          await client.query("DELETE FROM outreach_draft_steps WHERE id = $1", [existing.id]);
        }
        await client.query("COMMIT");
        return { removed: true, draftId: draft.id, position };
      }

      const step = await client.query(
        `
          INSERT INTO outreach_draft_steps(draft_id, position, subject, body_text, delay_days, status)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (draft_id, position) DO UPDATE SET
            subject = EXCLUDED.subject,
            body_text = EXCLUDED.body_text,
            delay_days = EXCLUDED.delay_days,
            status = CASE
              WHEN EXCLUDED.status = 'blocked' THEN 'blocked'
              WHEN outreach_draft_steps.status IN ('queued','needs_approval') THEN outreach_draft_steps.status
              ELSE EXCLUDED.status
            END,
            updated_at = now()
          RETURNING *
        `,
        [draft.id, position, subject || draft.subject, bodyText, delayDays, nextStepStatus],
      );
      if (guardErrors.length) {
        await client.query(
          `
            UPDATE sending_queue
            SET status = 'cancelled',
                last_error = $2,
                updated_at = now()
            WHERE outreach_step_id = $1
              AND status IN ('pending','retrying')
          `,
          [step.rows[0].id, guardErrors.join("; ")],
        );
      } else {
        await client.query(
          `
            UPDATE sending_queue
            SET subject_override = $2,
                body_text_override = $3,
                body_html_override = $4,
                updated_at = now()
            WHERE outreach_step_id = $1
              AND status IN ('pending','retrying')
          `,
          [step.rows[0].id, subject || draft.subject, bodyText, bodyText.replace(/\n/g, "<br>")],
        );
      }
      await client.query("COMMIT");
      return { ...step.rows[0], guard_errors: guardErrors };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  if (!result) return res.status(404).json({ error: "not_found" });
  res.json(result);
}));

app.post("/api/outreach/drafts/:id/cancel", asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "invalid_draft" });
  const result = await query(
    `
      WITH draft AS (
        UPDATE outreach_drafts
        SET status = 'cancelled',
            error_reason = 'Отменено пользователем',
            updated_at = now()
        WHERE id = $1
        RETURNING *
      ),
      cancelled_queue AS (
        UPDATE sending_queue
        SET status = 'cancelled',
            last_error = 'Черновик отменен пользователем',
            updated_at = now()
        WHERE outreach_draft_id = $1
          AND status IN ('pending','retrying')
        RETURNING outreach_step_id
      ),
      cancelled_steps AS (
        UPDATE outreach_draft_steps
        SET status = 'cancelled',
            updated_at = now()
        WHERE draft_id = $1
          AND status <> 'sent'
        RETURNING id
      )
      SELECT
        (SELECT row_to_json(draft) FROM draft) AS draft,
        (SELECT count(*)::int FROM cancelled_queue) AS cancelled_queue,
        (SELECT count(*)::int FROM cancelled_steps) AS cancelled_steps
    `,
    [req.params.id],
  );
  if (!result.rows[0]?.draft) return res.status(404).json({ error: "not_found" });
  await logEvent("outreach_draft_cancelled", {
    leadId: result.rows[0].draft.lead_id,
    payload: { draftId: req.params.id, cancelledQueue: result.rows[0].cancelled_queue },
  });
  res.json(result.rows[0]);
}));

app.post("/api/outreach/drafts/preflight", asyncHandler(async (req, res) => {
  const draftIds = parseArray(req.body.draft_ids).filter(isUuid);
  if (!draftIds.length) return res.status(400).json({ error: "draft_ids_required" });
  const runtime = await getRuntimeSettings();
  const [drafts, readyMailboxes, draftSteps] = await Promise.all([
    query(
      `
        SELECT d.id, d.to_email, d.company, d.contact_name, d.subject, d.body_text,
               d.send_after, d.status, d.error_reason, d.mailbox_id,
               m.email AS mailbox_email, m.is_active AS mailbox_active,
               m.smtp_verified_at, m.imap_verified_at,
               first_step.id AS first_step_id,
               first_step.subject AS first_step_subject,
               first_step.body_text AS first_step_body_text,
               COALESCE(followups.followup_count, 0)::int AS followup_count,
               EXISTS (
                 SELECT 1
                 FROM sending_queue q
                 WHERE q.outreach_draft_id = d.id
                   AND q.outreach_step_id = first_step.id
                   AND q.status IN ('pending','running','retrying','sent')
               ) AS first_step_already_queued
        FROM outreach_drafts d
        LEFT JOIN mailboxes m ON m.id = d.mailbox_id
        LEFT JOIN outreach_draft_steps first_step ON first_step.draft_id = d.id AND first_step.position = 1
        LEFT JOIN LATERAL (
          SELECT count(*) AS followup_count
          FROM outreach_draft_steps s
          WHERE s.draft_id = d.id AND s.position > 1
        ) followups ON true
        WHERE d.id = ANY($1::uuid[])
        ORDER BY d.created_at ASC
      `,
      [draftIds],
    ),
    query(`
      SELECT id, email
      FROM mailboxes
      WHERE is_active = true
        AND smtp_verified_at IS NOT NULL
        AND imap_verified_at IS NOT NULL
      ORDER BY updated_at DESC, created_at ASC
    `),
    query(
      `
        SELECT draft_id, position, subject, body_text, status
        FROM outreach_draft_steps
        WHERE draft_id = ANY($1::uuid[])
        ORDER BY draft_id, position
      `,
      [draftIds],
    ),
  ]);
  const rows = drafts.rows;
  const stepsByDraft = new Map();
  for (const step of draftSteps.rows) {
    const list = stepsByDraft.get(step.draft_id) || [];
    list.push(step);
    stepsByDraft.set(step.draft_id, list);
  }
  const foundIds = new Set(rows.map((row) => row.id));
  const errors = [];
  const warnings = [];
  const fallbackMailboxRows = readyMailboxes.rows;
  const fallbackMailboxes = fallbackMailboxRows.length;
  const itemIssues = new Map();
  const draftStatusText = {
    ready: "готово",
    blocked: "нужно исправить",
    queued: "в очереди",
    active_sequence: "цепочка идет",
    cancelled: "отменено",
    completed: "завершено",
  };

  for (const draftId of draftIds) {
    if (!foundIds.has(draftId)) errors.push(`Черновик ${draftId} не найден.`);
  }

  for (const [index, draft] of rows.entries()) {
    const label = `${draft.company || "Без компании"} · ${draft.to_email}`;
    const rowErrors = [];
    const rowWarnings = [];
    const stepGuardErrors = (stepsByDraft.get(draft.id) || [])
      .flatMap((step) => personalizationGuardErrors(
        { subject: step.subject, body: step.body_text },
        Number(step.position) > 1 ? `Follow-up ${Number(step.position) - 1}: ` : "",
      ));
    if (draft.status !== "ready") rowErrors.push(`статус “${draftStatusText[draft.status] || draft.status}”, запускать можно только готовые черновики`);
    if (!draft.first_step_id) rowErrors.push("нет первого письма");
    if (draft.first_step_already_queued) rowErrors.push("первое письмо уже есть в очереди или уже отправлено");
    rowErrors.push(...stepGuardErrors);
    if (draft.mailbox_id) {
      if (!draft.mailbox_active) rowErrors.push("выбранный mailbox выключен");
      if (!draft.smtp_verified_at) rowErrors.push("у выбранного mailbox не проверен SMTP");
      if (!draft.imap_verified_at) rowErrors.push("у выбранного mailbox не проверен IMAP для ответов");
    } else if (!fallbackMailboxes) {
      rowErrors.push("mailbox не выбран, и нет активного mailbox с проверенными SMTP/IMAP");
    }
    if (!draft.followup_count) rowWarnings.push("follow-up шаги не заполнены, будет отправлено только первое письмо");
    rowErrors.forEach((error) => errors.push(`${label}: ${error}.`));
    rowWarnings.forEach((warning) => warnings.push(`${label}: ${warning}.`));
    itemIssues.set(draft.id, {
      mailbox: draft.mailbox_email || fallbackMailboxRows[index % Math.max(fallbackMailboxRows.length, 1)]?.email || "",
      errors: rowErrors,
      warnings: rowWarnings,
    });
  }

  if (runtime.dryRun) warnings.push("Сейчас включен dry-run: письма попадут в очередь и будут показаны как отправленные без реальной отправки наружу.");

  res.json({
    ok: errors.length === 0,
    errors,
    warnings,
    items: rows.map((row) => {
      const issues = itemIssues.get(row.id) || { mailbox: row.mailbox_email || "", errors: [], warnings: [] };
      return {
        id: row.id,
        email: row.to_email,
        company: row.company,
        contact_name: row.contact_name,
        subject: row.first_step_subject || row.subject,
        body_preview: String(row.first_step_body_text || row.body_text || "").slice(0, 180),
        mailbox: issues.mailbox,
        scheduled_at: row.send_after || null,
        status: issues.errors.length ? "blocked" : "ready",
        errors: issues.errors,
        warnings: issues.warnings,
        followup_count: row.followup_count,
        first_step_already_queued: row.first_step_already_queued,
      };
    }),
    stats: {
      selected: draftIds.length,
      found: rows.length,
      ready: rows.filter((row) => row.status === "ready").length,
      blocked: rows.filter((row) => row.status === "blocked").length,
      withMailbox: rows.filter((row) => row.mailbox_id).length,
      fallbackMailboxes,
      withFollowups: rows.filter((row) => Number(row.followup_count || 0) > 0).length,
    },
  });
}));

app.post("/api/outreach/drafts/start", asyncHandler(async (req, res) => {
  const draftIds = parseArray(req.body.draft_ids).filter(isUuid);
  const mode = req.body.mode === "manual" ? "manual" : "auto";
  if (!draftIds.length) return res.status(400).json({ error: "draft_ids_required" });

  const summary = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const drafts = (await client.query(
        `
          SELECT d.*, s.id AS step_id, s.subject AS step_subject, s.body_text AS step_body_text
          FROM outreach_drafts d
          JOIN outreach_draft_steps s ON s.draft_id = d.id AND s.position = 1
          WHERE d.id = ANY($1::uuid[])
          ORDER BY d.created_at ASC
        `,
        [draftIds],
      )).rows;
      const fallbackMailboxes = (await client.query(
        `
          SELECT id, email
          FROM mailboxes
          WHERE is_active = true AND smtp_verified_at IS NOT NULL
          ORDER BY updated_at DESC, created_at ASC
        `,
      )).rows;
      const errors = [];
      const queued = [];

      for (const [index, draft] of drafts.entries()) {
        if (draft.status !== "ready") {
          errors.push({ id: draft.id, email: draft.to_email, error: "Черновик не готов: сначала исправь ошибки." });
          continue;
        }
        const guardErrors = personalizationGuardErrors({ subject: draft.step_subject, body: draft.step_body_text });
        if (guardErrors.length) {
          errors.push({ id: draft.id, email: draft.to_email, error: guardErrors.join("; ") });
          continue;
        }
        const mailboxId = draft.mailbox_id || fallbackMailboxes[index % Math.max(fallbackMailboxes.length, 1)]?.id;
        if (!mailboxId) {
          errors.push({ id: draft.id, email: draft.to_email, error: "Нет активного SMTP-проверенного mailbox для отправки." });
          continue;
        }

        const lead = await client.query(
          `
            INSERT INTO leads(company, email, contact_name, domain, segment, source)
            VALUES ($1,$2,$3,$4,$5,'outreach_import')
            ON CONFLICT (email) DO UPDATE SET
              company = COALESCE(NULLIF(EXCLUDED.company, ''), leads.company),
              contact_name = COALESCE(NULLIF(EXCLUDED.contact_name, ''), leads.contact_name),
              segment = COALESCE(NULLIF(EXCLUDED.segment, ''), leads.segment),
              updated_at = now()
            RETURNING id
          `,
          [draft.company || draft.to_email, draft.to_email, draft.contact_name, parseEmail(draft.to_email).domain, draft.segment],
        );
        const leadId = draft.lead_id || lead.rows[0].id;
        const scheduledAt = draft.send_after
          ? new Date(draft.send_after)
          : new Date(Date.now() + index * 7 * 60 * 1000);
        const queue = await client.query(
          `
            INSERT INTO sending_queue(
              lead_id, mailbox_id, mode, requires_approval, scheduled_at,
              outreach_draft_id, outreach_step_id, subject_override, body_text_override, body_html_override
            )
            SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
            WHERE NOT EXISTS (
              SELECT 1 FROM sending_queue
              WHERE outreach_draft_id = $6
                AND outreach_step_id = $7
                AND status IN ('pending','running','retrying','sent')
            )
            RETURNING id
          `,
          [
            leadId,
            mailboxId,
            mode,
            mode === "manual",
            scheduledAt,
            draft.id,
            draft.step_id,
            draft.step_subject,
            draft.step_body_text,
            draft.step_body_text.replace(/\n/g, "<br>"),
          ],
        );
        if (!queue.rowCount) {
          errors.push({ id: draft.id, email: draft.to_email, error: "Первый шаг уже есть в очереди или уже отправлен." });
          continue;
        }
        await client.query("UPDATE outreach_drafts SET lead_id = $2, mailbox_id = $3, status = 'queued', updated_at = now() WHERE id = $1", [draft.id, leadId, mailboxId]);
        await client.query("UPDATE outreach_draft_steps SET status = 'queued', queue_id = $2, updated_at = now() WHERE id = $1", [draft.step_id, queue.rows[0].id]);
        queued.push({ id: draft.id, email: draft.to_email, queueId: queue.rows[0].id });
      }

      await client.query("COMMIT");
      await logEvent("outreach_drafts_queued", { payload: { mode, queued: queued.length, errors: errors.length } });
      return { queued: queued.length, errors, items: queued, mode };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  res.json(summary);
}));

app.get("/api/outreach/conversations", asyncHandler(async (req, res) => {
  const status = req.query.status || "";
  const classification = req.query.classification || "";
  const onlyReview = toBool(req.query.review);
  const result = await query(
    `
      SELECT oc.*,
             l.company,
             l.contact_name,
             l.segment,
             latest.subject AS latest_subject,
             latest.body_text AS latest_body_text,
             latest.received_at AS latest_received_at,
             latest.sent_at AS latest_sent_at,
             latest.direction AS latest_direction,
             latest.reply_classification AS latest_reply_classification,
             COALESCE(stats.messages_total, 0)::int AS messages_total,
             COALESCE(stats.outbound_total, 0)::int AS outbound_total,
             COALESCE(stats.inbound_total, 0)::int AS inbound_total,
             COALESCE(queue.pending_total, 0)::int AS pending_total,
             COALESCE(queue.approval_total, 0)::int AS approval_total
      FROM outreach_conversations oc
      LEFT JOIN leads l ON l.id = oc.lead_id
      LEFT JOIN LATERAL (
        SELECT msg.*
        FROM messages msg
        WHERE msg.lead_id = oc.lead_id
          AND msg.type <> 'warmup'
        ORDER BY COALESCE(msg.received_at, msg.sent_at, msg.created_at) DESC
        LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT
          count(*) AS messages_total,
          count(*) FILTER (WHERE direction = 'outbound') AS outbound_total,
          count(*) FILTER (WHERE direction = 'inbound') AS inbound_total
        FROM messages msg
        WHERE msg.lead_id = oc.lead_id
          AND msg.type <> 'warmup'
      ) stats ON true
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE status IN ('pending','retrying')) AS pending_total,
          count(*) FILTER (WHERE status IN ('pending','retrying') AND requires_approval = true AND approved_at IS NULL) AS approval_total
        FROM sending_queue q
        WHERE q.lead_id = oc.lead_id
          AND q.outreach_draft_id IS NOT NULL
      ) queue ON true
      WHERE ($1 = '' OR oc.status = $1)
        AND ($2 = '' OR oc.classification = $2)
        AND ($3 = false OR oc.status IN ('waiting_reply_review','manual_reply_needed'))
      ORDER BY COALESCE(oc.last_message_at, oc.updated_at, oc.created_at) DESC
      LIMIT 300
    `,
    [status, classification, onlyReview],
  );
  res.json(result.rows);
}));

async function outreachConversationExportRows(req) {
  const status = req.query.status || "";
  const classification = req.query.classification || "";
  const onlyReview = toBool(req.query.review);
  const onlyReplied = toBool(req.query.replied);
  const segment = req.query.segment || "";
  const mailboxId = isUuid(req.query.mailbox_id) ? req.query.mailbox_id : "";
  const dateFrom = optionalDateFilter(req.query.date_from);
  const dateTo = optionalDateFilter(req.query.date_to);
  const conversations = (await query(
    `
      SELECT oc.*,
             l.company,
             l.contact_name,
             l.position,
             l.website,
             l.segment,
             l.city,
             l.notes,
             stats.messages_total,
             stats.outbound_total,
             stats.inbound_total,
             stats.first_sent_at,
             stats.first_reply_at,
             stats.last_message_at AS calculated_last_message_at
      FROM outreach_conversations oc
      LEFT JOIN leads l ON l.id = oc.lead_id
      LEFT JOIN LATERAL (
        SELECT
          count(*)::int AS messages_total,
          count(*) FILTER (WHERE direction = 'outbound')::int AS outbound_total,
          count(*) FILTER (WHERE direction = 'inbound')::int AS inbound_total,
          min(sent_at) FILTER (WHERE direction = 'outbound') AS first_sent_at,
          min(received_at) FILTER (WHERE direction = 'inbound') AS first_reply_at,
          max(COALESCE(received_at, sent_at, created_at)) AS last_message_at
        FROM messages msg
        WHERE msg.lead_id = oc.lead_id
          AND msg.type <> 'warmup'
          AND ($6 = '' OR msg.mailbox_id = $6::uuid)
      ) stats ON true
      WHERE ($1 = '' OR oc.status = $1)
        AND ($2 = '' OR oc.classification = $2)
        AND ($3 = false OR oc.status IN ('waiting_reply_review','manual_reply_needed'))
        AND ($4 = '' OR l.segment = $4)
        AND ($5 = false OR COALESCE(stats.inbound_total, 0) > 0)
        AND ($7 = '' OR COALESCE(stats.last_message_at, oc.last_message_at, oc.updated_at, oc.created_at) >= $7::timestamptz)
        AND ($8 = '' OR COALESCE(stats.last_message_at, oc.last_message_at, oc.updated_at, oc.created_at) <= $8::timestamptz)
        AND ($6 = '' OR COALESCE(stats.messages_total, 0) > 0)
      ORDER BY COALESCE(oc.last_message_at, oc.updated_at, oc.created_at) DESC
      LIMIT 1000
    `,
    [status, classification, onlyReview, segment, onlyReplied, mailboxId, dateFrom, dateTo],
  )).rows;
  const leadIds = conversations.map((item) => item.lead_id).filter(Boolean);
  const messages = leadIds.length
    ? (await query(
      `
        SELECT msg.*, m.email AS mailbox_email
        FROM messages msg
        LEFT JOIN mailboxes m ON m.id = msg.mailbox_id
        WHERE msg.lead_id = ANY($1::uuid[])
          AND msg.type <> 'warmup'
          AND ($2 = '' OR msg.mailbox_id = $2::uuid)
        ORDER BY COALESCE(msg.received_at, msg.sent_at, msg.created_at) ASC
      `,
      [leadIds, mailboxId],
    )).rows
    : [];
  const byLead = new Map();
  for (const message of messages) {
    const list = byLead.get(message.lead_id) || [];
    list.push(message);
    byLead.set(message.lead_id, list);
  }
  return conversations.map((conversation) => ({
    lead: {
      email: conversation.email,
      company: conversation.company,
      contact: conversation.contact_name,
      position: conversation.position,
      website: conversation.website,
      segment: conversation.segment,
      city: conversation.city,
      notes: conversation.notes,
    },
    conversation: {
      id: conversation.id,
      status: conversation.status,
      classification: conversation.classification,
      next_action: conversation.next_action,
      import_id: conversation.import_id,
      campaign_id: conversation.campaign_id,
      messages_total: conversation.messages_total || 0,
      outbound_total: conversation.outbound_total || 0,
      inbound_total: conversation.inbound_total || 0,
      first_sent_at: conversation.first_sent_at,
      first_reply_at: conversation.first_reply_at,
      last_message_at: conversation.calculated_last_message_at || conversation.last_message_at,
      ai_summary: conversation.ai_summary,
    },
    messages: (byLead.get(conversation.lead_id) || []).map((message) => ({
      direction: message.direction,
      type: message.type,
      status: message.status,
      subject: message.subject,
      body: message.body_text,
      mailbox: message.mailbox_email,
      sent_at: message.sent_at,
      received_at: message.received_at,
      classification: message.reply_classification,
      threading_mode: message.threading_mode,
      parent_message_id: message.parent_message_id,
      in_reply_to: message.in_reply_to,
    })),
  }));
}

app.get("/api/outreach/conversations/export.jsonl", asyncHandler(async (req, res) => {
  const rows = await outreachConversationExportRows(req);
  const lines = rows.map((row) => JSON.stringify(row));
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"outreach-conversations.jsonl\"");
  res.send(`${lines.join("\n")}${lines.length ? "\n" : ""}`);
}));

app.get("/api/outreach/conversations/export.json", asyncHandler(async (req, res) => {
  const rows = await outreachConversationExportRows(req);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"outreach-conversations.json\"");
  res.send(JSON.stringify(rows, null, 2));
}));

app.get("/api/outreach/conversations/export.csv", asyncHandler(async (req, res) => {
  const rows = await outreachConversationExportRows(req);
  const header = [
    "email",
    "company",
    "contact",
    "segment",
    "status",
    "classification",
    "messages_total",
    "outbound_total",
    "inbound_total",
    "first_sent_at",
    "first_reply_at",
    "last_message_at",
    "messages_json",
  ];
  const body = rows.map((row) => [
    row.lead.email,
    row.lead.company,
    row.lead.contact,
    row.lead.segment,
    row.conversation.status,
    row.conversation.classification,
    row.conversation.messages_total,
    row.conversation.outbound_total,
    row.conversation.inbound_total,
    row.conversation.first_sent_at,
    row.conversation.first_reply_at,
    row.conversation.last_message_at,
    JSON.stringify(row.messages),
  ].map(csvCell).join(","));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"outreach-conversations.csv\"");
  res.send([header.join(","), ...body].join("\n"));
}));

app.get("/api/outreach/conversations/:id", asyncHandler(async (req, res) => {
  const conversation = (await query(
    `
      SELECT oc.*, l.company, l.contact_name, l.position, l.website, l.segment, l.notes
      FROM outreach_conversations oc
      LEFT JOIN leads l ON l.id = oc.lead_id
      WHERE oc.id = $1
    `,
    [req.params.id],
  )).rows[0];
  if (!conversation) return res.status(404).json({ error: "not_found" });

  const [messages, drafts, queue, events] = await Promise.all([
    query(
      `
        SELECT msg.*, m.email AS mailbox_email
        FROM messages msg
        LEFT JOIN mailboxes m ON m.id = msg.mailbox_id
        WHERE msg.lead_id = $1
          AND msg.type <> 'warmup'
        ORDER BY COALESCE(msg.received_at, msg.sent_at, msg.created_at) ASC
      `,
      [conversation.lead_id],
    ),
    query(
      `
        SELECT d.*, COALESCE(
          json_agg(json_build_object(
            'id', s.id,
            'position', s.position,
            'subject', s.subject,
            'body_text', s.body_text,
            'delay_days', s.delay_days,
            'status', s.status
          ) ORDER BY s.position) FILTER (WHERE s.id IS NOT NULL),
          '[]'::json
        ) AS steps
        FROM outreach_drafts d
        LEFT JOIN outreach_draft_steps s ON s.draft_id = d.id
        WHERE d.conversation_id = $1
        GROUP BY d.id
        ORDER BY d.created_at
      `,
      [conversation.id],
    ),
    query(
      `
        SELECT q.*, ods.position AS outreach_step_position, ods.subject AS outreach_subject
        FROM sending_queue q
        LEFT JOIN outreach_draft_steps ods ON ods.id = q.outreach_step_id
        WHERE q.lead_id = $1
          AND q.outreach_draft_id IS NOT NULL
        ORDER BY q.scheduled_at ASC
      `,
      [conversation.lead_id],
    ),
    query(
      `
        SELECT *
        FROM events
        WHERE lead_id = $1
          AND (
            payload->>'conversationId' = $2
            OR event_type IN (
              'email_replied',
              'positive_reply_received',
              'neutral_reply_received',
              'negative_reply_received',
              'auto_reply_received',
              'unsubscribe_received',
              'unsubscribe_detected',
              'not_target_received',
              'email_bounced',
              'reply_classified',
              'outreach_conversation_stopped',
              'outreach_conversation_continued',
              'manual_reply_sent'
            )
          )
        ORDER BY created_at DESC
        LIMIT 50
      `,
      [conversation.lead_id, conversation.id],
    ),
  ]);

  res.json({ conversation, messages: messages.rows, drafts: drafts.rows, queue: queue.rows, events: events.rows });
}));

app.patch("/api/outreach/conversations/:id/classification", asyncHandler(async (req, res) => {
  const classification = cleanText(req.body.classification);
  if (!REPLY_CLASSIFICATIONS.has(classification)) {
    return res.status(400).json({ error: "classification_invalid" });
  }
  const conversation = (await query(
    `
      SELECT oc.*, l.email AS lead_email, l.domain AS lead_domain
      FROM outreach_conversations oc
      LEFT JOIN leads l ON l.id = oc.lead_id
      WHERE oc.id = $1
    `,
    [req.params.id],
  )).rows[0];
  if (!conversation) return res.status(404).json({ error: "not_found" });

  const nextStatus = {
    positive_reply: "positive",
    negative_reply: "negative",
    auto_reply: "manual_reply_needed",
    unsubscribe: "unsubscribed",
    not_target: "not_target",
    bounce: "bounced",
  }[classification] || "waiting_reply_review";
  const nextAction = {
    positive_reply: "reply_manually_or_stop",
    negative_reply: "sequence_stopped_after_negative_reply",
    auto_reply: "decide_followup_after_auto_reply",
    unsubscribe: "sequence_stopped_after_unsubscribe",
    not_target: "sequence_stopped_not_target",
    bounce: "sequence_stopped_after_bounce",
  }[classification] || "approve_or_pause_followup";
  const runtime = await getRuntimeSettings();
  const stopScope = runtime.outreachStopScope;

  const result = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const updatedConversation = await client.query(
        `
          UPDATE outreach_conversations
          SET classification = $2,
              status = $3,
              next_action = $4,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [conversation.id, classification, nextStatus, nextAction],
      );
      const updatedMessage = await client.query(
        `
          UPDATE messages
          SET reply_classification = $2,
              reply_classification_source = 'manual'
          WHERE id = (
            SELECT id
            FROM messages
            WHERE lead_id = $1
              AND direction = 'inbound'
              AND type <> 'warmup'
            ORDER BY COALESCE(received_at, created_at) DESC
            LIMIT 1
          )
          RETURNING *
        `,
        [conversation.lead_id, classification],
      );
      let cancelledQueue = 0;
      let affectedLeads = 1;
      if (STOPPING_REPLY_CLASSIFICATIONS.has(classification)) {
        const scoped = await cancelOutreachForScope(client, {
          leadId: conversation.lead_id,
          scope: stopScope,
          reason: "Отменено после ручной классификации ответа",
        });
        cancelledQueue = scoped.cancelledQueue;
        affectedLeads = scoped.affectedLeads;
      }
      if (classification === "unsubscribe") {
        await client.query(
          "INSERT INTO suppressions(email, domain, reason, source) VALUES ($1,$2,'unsubscribe','manual') ON CONFLICT DO NOTHING",
          [conversation.email || conversation.lead_email, conversation.lead_domain],
        );
      }
      await client.query("COMMIT");
      return { conversation: updatedConversation.rows[0], message: updatedMessage.rows[0] || null, cancelledQueue, affectedLeads, stopScope };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  await logEvent("reply_classified", {
    leadId: conversation.lead_id,
    messageId: result.message?.id,
    payload: {
      conversationId: conversation.id,
      classification,
      source: "manual",
      previousStatus: conversation.status,
      nextStatus,
      nextAction,
      cancelledQueue: result.cancelledQueue,
      affectedLeads: result.affectedLeads,
      stopScope,
      reason: STOPPING_REPLY_CLASSIFICATIONS.has(classification) ? classification : "manual_classification",
    },
  });
  res.json(result);
}));

app.post("/api/outreach/conversations/:id/stop", asyncHandler(async (req, res) => {
  const conversation = (await query("SELECT * FROM outreach_conversations WHERE id = $1", [req.params.id])).rows[0];
  if (!conversation) return res.status(404).json({ error: "not_found" });
  const result = await query(
    `
      WITH cancelled_queue AS (
        UPDATE sending_queue
        SET status = 'cancelled',
            last_error = 'Отменено после ответа получателя',
            updated_at = now()
        WHERE lead_id = $1
          AND outreach_draft_id IS NOT NULL
          AND status IN ('pending','retrying')
        RETURNING outreach_step_id
      ),
      cancelled_steps AS (
        UPDATE outreach_draft_steps
        SET status = 'cancelled',
            updated_at = now()
        WHERE id IN (SELECT outreach_step_id FROM cancelled_queue WHERE outreach_step_id IS NOT NULL)
        RETURNING id
      ),
      updated_conversation AS (
        UPDATE outreach_conversations
        SET status = 'paused',
            next_action = 'stopped_by_user',
            updated_at = now()
        WHERE id = $2
        RETURNING *
      )
      SELECT
        (SELECT row_to_json(updated_conversation) FROM updated_conversation) AS conversation,
        (SELECT count(*)::int FROM cancelled_queue) AS cancelled_queue,
        (SELECT count(*)::int FROM cancelled_steps) AS cancelled_steps
    `,
    [conversation.lead_id, conversation.id],
  );
  await logEvent("outreach_conversation_stopped", {
    leadId: conversation.lead_id,
    payload: {
      conversationId: conversation.id,
      reason: "manual_stop",
      previousStatus: conversation.status,
      nextStatus: "paused",
      nextAction: "stopped_by_user",
      cancelledQueue: result.rows[0].cancelled_queue,
      cancelledSteps: result.rows[0].cancelled_steps,
    },
  });
  res.json(result.rows[0]);
}));

app.post("/api/outreach/conversations/:id/continue", asyncHandler(async (req, res) => {
  const conversation = (await query("SELECT * FROM outreach_conversations WHERE id = $1", [req.params.id])).rows[0];
  if (!conversation) return res.status(404).json({ error: "not_found" });
  const result = await query(
    `
      WITH approved_queue AS (
        UPDATE sending_queue
        SET requires_approval = false,
            approved_at = now(),
            updated_at = now()
        WHERE lead_id = $1
          AND outreach_draft_id IS NOT NULL
          AND status IN ('pending','retrying')
        RETURNING outreach_step_id
      ),
      approved_steps AS (
        UPDATE outreach_draft_steps
        SET status = 'queued',
            updated_at = now()
        WHERE id IN (SELECT outreach_step_id FROM approved_queue WHERE outreach_step_id IS NOT NULL)
        RETURNING id
      ),
      updated_conversation AS (
        UPDATE outreach_conversations
        SET status = 'active_sequence',
            next_action = 'followup_allowed',
            updated_at = now()
        WHERE id = $2
        RETURNING *
      )
      SELECT
        (SELECT row_to_json(updated_conversation) FROM updated_conversation) AS conversation,
        (SELECT count(*)::int FROM approved_queue) AS approved_queue,
        (SELECT count(*)::int FROM approved_steps) AS approved_steps
    `,
    [conversation.lead_id, conversation.id],
  );
  await logEvent("outreach_conversation_continued", {
    leadId: conversation.lead_id,
    payload: {
      conversationId: conversation.id,
      reason: "manual_continue",
      previousStatus: conversation.status,
      nextStatus: "active_sequence",
      nextAction: "followup_allowed",
      approvedQueue: result.rows[0].approved_queue,
      approvedSteps: result.rows[0].approved_steps,
    },
  });
  res.json(result.rows[0]);
}));

app.post("/api/outreach/conversations/:id/delay", asyncHandler(async (req, res) => {
  const conversation = (await query("SELECT * FROM outreach_conversations WHERE id = $1", [req.params.id])).rows[0];
  if (!conversation) return res.status(404).json({ error: "not_found" });
  const delayDays = Number(req.body.delay_days || 0);
  if (!Number.isInteger(delayDays) || delayDays < 1 || delayDays > 60) {
    return res.status(400).json({ error: "delay_days_invalid" });
  }
  const result = await query(
    `
      WITH delayed_queue AS (
        UPDATE sending_queue
        SET scheduled_at = now() + ($2::int * interval '1 day'),
            requires_approval = true,
            approved_at = NULL,
            last_error = NULL,
            updated_at = now()
        WHERE lead_id = $1
          AND outreach_draft_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM outreach_draft_steps ods
            WHERE ods.id = sending_queue.outreach_step_id
              AND ods.position > 1
          )
          AND status IN ('pending','retrying')
        RETURNING outreach_step_id, scheduled_at
      ),
      delayed_steps AS (
        UPDATE outreach_draft_steps
        SET status = 'queued',
            updated_at = now()
        WHERE id IN (SELECT outreach_step_id FROM delayed_queue WHERE outreach_step_id IS NOT NULL)
        RETURNING id
      ),
      updated_conversation AS (
        UPDATE outreach_conversations
        SET status = 'manual_reply_needed',
            next_action = 'followup_postponed_needs_approval',
            updated_at = now()
        WHERE id = $3
          AND EXISTS (SELECT 1 FROM delayed_queue)
        RETURNING *
      )
      SELECT
        (SELECT row_to_json(updated_conversation) FROM updated_conversation) AS conversation,
        (SELECT count(*)::int FROM delayed_queue) AS delayed_queue,
        (SELECT count(*)::int FROM delayed_steps) AS delayed_steps,
        (SELECT min(scheduled_at) FROM delayed_queue) AS next_scheduled_at
    `,
    [conversation.lead_id, delayDays, conversation.id],
  );
  await logEvent("outreach_followup_delayed", {
    leadId: conversation.lead_id,
    payload: {
      conversationId: conversation.id,
      reason: "manual_delay",
      delayDays,
      previousStatus: conversation.status,
      nextStatus: "manual_reply_needed",
      nextAction: "followup_postponed_needs_approval",
      delayedQueue: result.rows[0].delayed_queue,
      nextScheduledAt: result.rows[0].next_scheduled_at,
    },
  });
  res.json(result.rows[0]);
}));

app.post("/api/outreach/conversations/:id/reply", asyncHandler(async (req, res) => {
  const subject = cleanText(req.body.subject);
  const bodyText = cleanText(req.body.body_text);
  const mailboxId = cleanText(req.body.mailbox_id);
  const stopSequence = req.body.stop_sequence !== false && req.body.stop_sequence !== "false";
  if (!subject) return res.status(400).json({ error: "subject_required" });
  if (!bodyText) return res.status(400).json({ error: "body_required" });
  if (!isUuid(mailboxId)) return res.status(400).json({ error: "mailbox_required" });

  const conversation = (await query(
    `
      SELECT oc.*, l.email AS lead_email
      FROM outreach_conversations oc
      LEFT JOIN leads l ON l.id = oc.lead_id
      WHERE oc.id = $1
    `,
    [req.params.id],
  )).rows[0];
  if (!conversation) return res.status(404).json({ error: "not_found" });
  const to = conversation.email || conversation.lead_email;
  const parsed = parseEmail(to);
  if (!parsed.syntaxValid) return res.status(400).json({ error: "recipient_email_invalid" });

  const mailbox = (await query(
    `
      SELECT *
      FROM mailboxes
      WHERE id = $1
        AND is_active = true
        AND smtp_verified_at IS NOT NULL
    `,
    [mailboxId],
  )).rows[0];
  if (!mailbox) return res.status(400).json({ error: "mailbox_smtp_not_ready" });

  const previous = (await query(
    `
      SELECT *
      FROM messages
      WHERE lead_id = $1
        AND type <> 'warmup'
      ORDER BY COALESCE(received_at, sent_at, created_at) DESC
      LIMIT 1
    `,
    [conversation.lead_id],
  )).rows[0];
  const references = [
    previous?.references_header,
    previous?.in_reply_to,
    previous?.message_id_header,
  ].filter(Boolean).join(" ");
  const runtime = await getRuntimeSettings();
  const html = bodyText.replace(/\n/g, "<br>");
  const info = await sendMail(mailbox, {
    to: parsed.normalized,
    subject,
    text: bodyText,
    html,
    headers: { "X-Outreach-Manual-Reply": "true" },
    inReplyTo: previous?.message_id_header || undefined,
    references: references || undefined,
  });

  const result = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const inserted = await client.query(
        `
          INSERT INTO messages(
            lead_id, campaign_id, mailbox_id, outreach_draft_id, direction, type, status,
            subject, body_text, body_html, provider_message_id, message_id_header,
            in_reply_to, references_header, threading_mode, parent_message_id, sent_at
          )
          VALUES ($1,$2,$3,$4,'outbound','manual_reply','sent',$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
          RETURNING *
        `,
        [
          conversation.lead_id,
          conversation.campaign_id,
          mailbox.id,
          null,
          subject,
          bodyText,
          html,
          info.response || "",
          info.messageId || "",
          previous?.message_id_header || "",
          references,
          previous?.message_id_header ? "reply_to_previous" : "new_thread",
          previous?.id || null,
        ],
      );

      let cancelledQueue = 0;
      if (stopSequence) {
        const cancelled = await client.query(
          `
            UPDATE sending_queue
            SET status = 'cancelled',
                last_error = 'Отменено после ручного ответа',
                updated_at = now()
            WHERE lead_id = $1
              AND outreach_draft_id IS NOT NULL
              AND status IN ('pending','retrying')
            RETURNING outreach_step_id
          `,
          [conversation.lead_id],
        );
        cancelledQueue = cancelled.rowCount;
        const stepIds = cancelled.rows.map((row) => row.outreach_step_id).filter(Boolean);
        if (stepIds.length) {
          await client.query(
            "UPDATE outreach_draft_steps SET status = 'cancelled', updated_at = now() WHERE id = ANY($1::uuid[])",
            [stepIds],
          );
        }
      }

      const updatedConversation = await client.query(
        `
          UPDATE outreach_conversations
          SET status = $2,
              next_action = $3,
              last_message_at = now(),
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [
          conversation.id,
          stopSequence ? "paused" : "active_sequence",
          stopSequence ? "manual_reply_sent_sequence_stopped" : "manual_reply_sent_followup_allowed",
        ],
      );
      await client.query("COMMIT");
      return { message: inserted.rows[0], conversation: updatedConversation.rows[0], cancelledQueue };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  await logEvent("manual_reply_sent", {
    leadId: conversation.lead_id,
    mailboxId: mailbox.id,
    messageId: result.message.id,
    payload: {
      conversationId: conversation.id,
      to: parsed.normalized,
      dryRun: runtime.dryRun,
      reason: stopSequence ? "manual_reply_stop_sequence" : "manual_reply_continue_sequence",
      previousStatus: conversation.status,
      nextStatus: result.conversation.status,
      nextAction: result.conversation.next_action,
      cancelledQueue: result.cancelledQueue,
    },
  });
  res.status(201).json({ ...result, dryRun: runtime.dryRun });
}));

app.post("/api/outreach/imports", csvUpload.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file_required" });
  const mapping = parseMapping(req.body.mapping);
  const { fileType, rows } = await parseOutreachImportFile(req.file, mapping);
  const seenEmails = new Set();

  const summary = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const importResult = await client.query(
        `
          INSERT INTO outreach_imports(file_name, file_type, status, rows_total)
          VALUES ($1,$2,'running',$3)
          RETURNING *
        `,
        [req.file.originalname, fileType, rows.length],
      );
      const importRow = importResult.rows[0];
      const errors = [];
      let rowsReady = 0;
      let rowsBlocked = 0;

      for (const row of rows) {
        const parsed = parseEmail(row.email);
        const normalizedEmail = parsed.syntaxValid ? parsed.normalized : String(row.email || "").trim().toLowerCase();
        const steps = outreachStepsFromRow(row);
        const check = outreachDraftStatus({
          email: row.email,
          subject: row.subject,
          body: row.body,
          steps,
        });
        const rowErrors = [...check.errors];
        if (normalizedEmail && seenEmails.has(normalizedEmail)) rowErrors.push("Дубль email в этом файле");
        if (normalizedEmail) seenEmails.add(normalizedEmail);

        const mailbox = row.mailbox
          ? (await client.query(
            "SELECT id FROM mailboxes WHERE lower(email) = lower($1) OR lower(name) = lower($1) LIMIT 1",
            [row.mailbox],
          )).rows[0]
          : null;
        if (row.mailbox && !mailbox) rowErrors.push("Mailbox из файла не найден");

        let leadId = null;
        if (parsed.syntaxValid) {
          const lead = await client.query(
            `
              INSERT INTO leads(company, email, contact_name, position, website, domain, segment, city, pain, source, notes)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
              ON CONFLICT (email) DO UPDATE SET
                company = COALESCE(NULLIF(EXCLUDED.company, ''), leads.company),
                contact_name = COALESCE(NULLIF(EXCLUDED.contact_name, ''), leads.contact_name),
                position = COALESCE(NULLIF(EXCLUDED.position, ''), leads.position),
                website = COALESCE(NULLIF(EXCLUDED.website, ''), leads.website),
                segment = COALESCE(NULLIF(EXCLUDED.segment, ''), leads.segment),
                city = COALESCE(NULLIF(EXCLUDED.city, ''), leads.city),
                pain = COALESCE(NULLIF(EXCLUDED.pain, ''), leads.pain),
                notes = COALESCE(NULLIF(EXCLUDED.notes, ''), leads.notes),
                updated_at = now()
              RETURNING id
            `,
            [
              row.company || parsed.domain || parsed.normalized,
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
          leadId = lead.rows[0].id;
          await client.query("INSERT INTO job_queue(job_type, payload) VALUES ('validate_lead', $1)", [{ leadId }]);
        }

        const conversation = parsed.syntaxValid
          ? (await client.query(
            `
              INSERT INTO outreach_conversations(lead_id, email, import_id, status, last_message_at)
              VALUES ($1,$2,$3,'active_sequence',now())
              RETURNING id
            `,
            [leadId, parsed.normalized, importRow.id],
          )).rows[0]
          : null;

        const status = rowErrors.length ? "blocked" : "ready";
        if (status === "ready") rowsReady += 1;
        else rowsBlocked += 1;
        if (rowErrors.length) {
          errors.push({ row: row.source_row_number, email: row.email, errors: rowErrors });
        }

        const draftInsert = await client.query(
          `
            INSERT INTO outreach_drafts(
              import_id, source_row_number, lead_id, conversation_id, mailbox_id, to_email,
              company, contact_name, segment, subject, body_text, send_after, status, error_reason, raw_row
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
            RETURNING id
          `,
          [
            importRow.id,
            row.source_row_number,
            leadId,
            conversation?.id || null,
            mailbox?.id || null,
            normalizedEmail || row.email || "",
            row.company,
            row.contact_name,
            cleanText(row.segment),
            row.subject || "",
            row.body || "",
            parseOptionalDate(row.send_after),
            status,
            rowErrors.join("; "),
            row,
          ],
        );
        for (const step of steps) {
          await client.query(
            `
              INSERT INTO outreach_draft_steps(draft_id, position, subject, body_text, delay_days, status)
              VALUES ($1,$2,$3,$4,$5,$6)
            `,
            [draftInsert.rows[0].id, step.position, step.subject, step.body, step.delayDays, status === "ready" ? "draft" : "blocked"],
          );
        }
      }

      const updated = await client.query(
        `
          UPDATE outreach_imports
          SET status = 'completed',
              rows_ready = $2,
              rows_blocked = $3,
              rows_skipped = 0,
              error_report = $4,
              completed_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [importRow.id, rowsReady, rowsBlocked, JSON.stringify(errors)],
      );
      await client.query("COMMIT");
      await logEvent("outreach_import_created", {
        payload: {
          importId: importRow.id,
          fileName: req.file.originalname,
          rows: rows.length,
          ready: rowsReady,
          blocked: rowsBlocked,
        },
      });
      return updated.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  res.status(201).json(summary);
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
  res.json(await checkMailboxConnection(mailbox));
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
      toBool(req.body.manual_approval_required ?? false),
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
      toBool(req.body.manual_approval_required ?? false),
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

app.post("/api/campaigns/:id/enrollments/keep-selected", asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "campaign_required" });
  const enrollmentIds = parseArray(req.body.enrollment_ids);
  if (!enrollmentIds.length || enrollmentIds.some((id) => !isUuid(id))) {
    return res.status(400).json({ error: "valid_enrollment_ids_required" });
  }

  const result = await query(
    `
      WITH paused AS (
        UPDATE enrollments
        SET status = 'paused',
            stopped_at = now(),
            stop_reason = 'paused_by_user'
        WHERE campaign_id = $1
          AND status = 'active'
          AND NOT (id = ANY($2::uuid[]))
        RETURNING id
      ),
      cancelled AS (
        UPDATE sending_queue
        SET status = 'cancelled',
            last_error = 'Отменено: лид выключен из кампании',
            updated_at = now()
        WHERE enrollment_id IN (SELECT id FROM paused)
          AND status IN ('pending','retrying')
        RETURNING id
      )
      SELECT
        (SELECT count(*)::int FROM paused) AS paused,
        (SELECT count(*)::int FROM cancelled) AS cancelled_queue
    `,
    [req.params.id, enrollmentIds],
  );
  res.json({ kept: enrollmentIds.length, ...result.rows[0] });
}));

app.post("/api/enrollments/:id/pause", asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "enrollment_required" });
  const result = await query(
    `
      WITH paused AS (
        UPDATE enrollments
        SET status = 'paused',
            stopped_at = now(),
            stop_reason = 'paused_by_user'
        WHERE id = $1
          AND status = 'active'
        RETURNING *
      ),
      cancelled AS (
        UPDATE sending_queue
        SET status = 'cancelled',
            last_error = 'Отменено: лид выключен из кампании',
            updated_at = now()
        WHERE enrollment_id = $1
          AND status IN ('pending','retrying')
        RETURNING id
      )
      SELECT
        (SELECT row_to_json(paused) FROM paused) AS enrollment,
        (SELECT count(*)::int FROM cancelled) AS cancelled_queue
    `,
    [req.params.id],
  );
  if (!result.rows[0]?.enrollment) return res.status(404).json({ error: "active_enrollment_not_found" });
  res.json(result.rows[0]);
}));

app.post("/api/enrollments/:id/resume", asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "enrollment_required" });
  const result = await query(
    `
      UPDATE enrollments
      SET status = 'active',
          stopped_at = NULL,
          stop_reason = NULL,
          next_send_at = COALESCE(next_send_at, now())
      WHERE id = $1
        AND status = 'paused'
      RETURNING *
    `,
    [req.params.id],
  );
  if (!result.rows[0]) return res.status(404).json({ error: "paused_enrollment_not_found" });
  res.json(result.rows[0]);
}));

app.get("/api/campaigns/:id/available-leads", asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "campaign_required" });
  const result = await query(
    `
      WITH campaign_segments AS (
        SELECT btrim(item.value) AS segment
        FROM campaigns c
        CROSS JOIN regexp_split_to_table(COALESCE(c.segment, ''), ',') AS item(value)
        WHERE c.id = $1 AND btrim(item.value) <> ''
      )
      SELECT l.*
      FROM leads l
      WHERE l.validation_status IN ('valid', 'risky')
        AND NOT EXISTS (
          SELECT 1 FROM enrollments e
          WHERE e.campaign_id = $1 AND e.lead_id = l.id
        )
        AND (
          NOT EXISTS (SELECT 1 FROM campaign_segments)
          OR l.segment IN (SELECT segment FROM campaign_segments)
        )
      ORDER BY l.created_at DESC
      LIMIT 500
    `,
    [req.params.id],
  );
  res.json(result.rows);
}));

app.get("/api/campaigns/:id/preflight", asyncHandler(async (req, res) => {
  res.json(await campaignPreflight(req.params.id));
}));

app.post("/api/campaigns/:id/preflight/fix", asyncHandler(async (req, res) => {
  const campaign = (await query("SELECT * FROM campaigns WHERE id = $1", [req.params.id])).rows[0];
  if (!campaign) return res.status(404).json({ error: "not_found" });

  const runtime = await getRuntimeSettings();
  const fixes = [];

  if (campaign.tracking_enabled && !runtime.publicTrackingUrl) {
    await query("UPDATE campaigns SET tracking_enabled = false, updated_at = now() WHERE id = $1", [campaign.id]);
    fixes.push({
      type: "tracking_disabled",
      status: "fixed",
      message: "Отключил отслеживание открытий, потому что Tracking URL не задан.",
    });
  }

  const mailboxes = (
    await query(
      `
        SELECT DISTINCT m.*
        FROM mailboxes m
        JOIN enrollments e ON e.mailbox_id = m.id
        WHERE e.campaign_id = $1
          AND e.status = 'active'
          AND m.is_active = true
          AND (m.smtp_verified_at IS NULL OR m.imap_verified_at IS NULL)
        ORDER BY m.email
      `,
      [campaign.id],
    )
  ).rows;

  const mailboxFixes = await Promise.all(mailboxes.map(async (mailbox) => {
    const result = await checkMailboxConnection(mailbox);
    return {
      type: result.ok ? "mailbox_checked" : "mailbox_check_failed",
      status: result.ok ? "fixed" : "needs_user",
      mailbox: mailbox.email,
      message: result.ok
        ? `Проверил SMTP/IMAP для ${mailbox.email}.`
        : `${mailbox.email}: SMTP ${result.smtp.ok ? "ok" : result.smtp.error || "ошибка"}, IMAP ${result.imap.ok ? "ok" : result.imap.error || "ошибка"}.`,
      details: result,
    };
  }));
  fixes.push(...mailboxFixes);

  const preflight = await campaignPreflight(campaign.id);
  res.json({ ok: preflight.ok, fixes, preflight });
}));

app.post("/api/campaigns/:id/start", asyncHandler(async (req, res) => {
  const mode = req.body.mode || "manual";
  const preflight = await campaignPreflight(req.params.id);
  if (!preflight.ok && !toBool(req.body.force)) return res.status(400).json(preflight);

  const launchPlan = await campaignLaunchPlan(req.params.id);
  const campaign = (await query("SELECT manual_approval_required FROM campaigns WHERE id = $1", [req.params.id])).rows[0];
  if (!campaign) return res.status(404).json({ error: "not_found" });
  const requiresApproval = mode === "manual" || (mode === "auto" && campaign.manual_approval_required);
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
  res.json({ queued: result.rowCount, mode, requiresApproval, launchPlan, preflight });
}));

app.post("/api/sending/:id/approve", asyncHandler(async (req, res) => {
  const result = await query(
    "UPDATE sending_queue SET approved_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
    [req.params.id],
  );
  if (result.rows[0]?.outreach_step_id) {
    await query("UPDATE outreach_draft_steps SET status = 'queued', updated_at = now() WHERE id = $1", [result.rows[0].outreach_step_id]);
  }
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
    SELECT q.*, l.company, l.email,
           COALESCE(c.name, 'Персональный импорт') AS campaign_name,
           m.email AS mailbox_email,
           COALESCE(s.name, 'Шаг ' || ods.position::text) AS step_name
    FROM sending_queue q
    JOIN leads l ON l.id = q.lead_id
    LEFT JOIN campaigns c ON c.id = q.campaign_id
    LEFT JOIN mailboxes m ON m.id = q.mailbox_id
    LEFT JOIN campaign_steps s ON s.id = q.campaign_step_id
    LEFT JOIN outreach_draft_steps ods ON ods.id = q.outreach_step_id
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
  const message = result.rows[0];
  if (message?.lead_id) {
    await query(
      `
        UPDATE outreach_conversations
        SET classification = $2,
            status = CASE
              WHEN $2 = 'positive_reply' THEN 'positive'
              WHEN $2 = 'negative_reply' THEN 'negative'
              WHEN $2 = 'not_target' THEN 'not_target'
              WHEN $2 = 'unsubscribe' THEN 'unsubscribed'
              ELSE status
            END,
            updated_at = now()
        WHERE lead_id = $1
      `,
      [message.lead_id, req.body.classification],
    );
  }
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
