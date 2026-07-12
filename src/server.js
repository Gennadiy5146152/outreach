import express from "express";
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
import { asyncHandler, emailDomain, parseArray, toBool } from "./http/utils.js";

await fs.mkdir(env.attachmentDir, { recursive: true });

const app = express();
const csvUpload = multer({ storage: multer.memoryStorage() });
const attachmentUpload = multer({
  dest: env.attachmentDir,
  limits: { fileSize: env.maxAttachmentMb * 1024 * 1024 },
});

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.get("/api/health", asyncHandler(async (_req, res) => {
  const db = await query("SELECT now() AS now");
  res.json({ ok: true, now: db.rows[0].now, dryRun: env.mailDryRun });
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
  const result = await query(
    `
      SELECT *
      FROM leads
      WHERE ($1 = '%%' OR lower(company || ' ' || email || ' ' || coalesce(segment,'') || ' ' || coalesce(contact_name,'')) LIKE $1)
        AND ($2 = '' OR status = $2)
        AND ($3 = '' OR validation_status = $3)
      ORDER BY created_at DESC
      LIMIT 500
    `,
    [search, status, validation],
  );
  res.json(result.rows);
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
      req.body.segment || "",
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
      req.body.segment,
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
        row.segment,
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

app.post("/api/mailboxes", asyncHandler(async (req, res) => {
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
      req.body.password_env_key,
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

  const smtp = await verifySmtp(mailbox);
  const imap = await verifyImap(mailbox);
  const domain = await checkSendingDomain(mailbox);
  await query(
    `
      UPDATE mailboxes
      SET smtp_verified_at = now(), imap_verified_at = now(), health_status = 'ok', updated_at = now()
      WHERE id = $1
    `,
    [mailbox.id],
  );
  res.json({ smtp, imap, domain });
}));

app.get("/api/campaigns", asyncHandler(async (_req, res) => {
  const campaigns = (await query("SELECT * FROM campaigns ORDER BY created_at DESC")).rows;
  const steps = (await query("SELECT * FROM campaign_steps ORDER BY campaign_id, position")).rows;
  res.json(campaigns.map((campaign) => ({ ...campaign, steps: steps.filter((step) => step.campaign_id === campaign.id) })));
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
      req.body.segment || "",
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

app.post("/api/steps/:id/attachments", attachmentUpload.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file_required" });
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
  res.status(500).json({ error: error.message || "internal_error" });
});

const server = app.listen(env.appPort, () => {
  console.log(`Outreach Desk running on http://localhost:${env.appPort}`);
});

process.on("SIGTERM", async () => {
  server.close();
  await pool.end();
});
