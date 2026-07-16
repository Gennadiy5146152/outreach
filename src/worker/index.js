import crypto from "node:crypto";
import { simpleParser } from "mailparser";
import { env } from "../config/env.js";
import { pool, query, withClient } from "../db/pool.js";
import { classifyInbound } from "../services/classifier.js";
import { logEvent } from "../services/events.js";
import { createImapClient, sendMail } from "../services/mail.js";
import { getRuntimeSettings } from "../services/runtime.js";
import { htmlToText, renderTemplate } from "../services/template.js";
import { persistValidation, validateEmail } from "../services/validation.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMinutes(min, max) {
  const floor = Number(min || 7);
  const ceil = Math.max(Number(max || 18), floor);
  return floor + Math.floor(Math.random() * (ceil - floor + 1));
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function warmupDraft(from, to) {
  const today = new Date().toLocaleDateString("ru-RU");
  const drafts = [
    {
      subject: `Короткая проверка связи ${today}`,
      body: `Добрый день.\n\nПроверяю, что рабочая почта ${from.email} нормально доходит до ${to.email}.\n\nОтветь, пожалуйста, когда увидишь.\n\nСпасибо.`,
    },
    {
      subject: `Тест входящей переписки ${today}`,
      body: "Привет.\n\nОтправляю короткое служебное письмо, чтобы проверить SMTP, IMAP и цепочку ответов.\n\nЕсли письмо пришло, можно ответить одной строкой.",
    },
    {
      subject: `Рабочая заметка по почте ${today}`,
      body: "Добрый день.\n\nПроверяю рабочую переписку между нашими ящиками. Никаких действий не нужно, только подтверждение получения.\n\nХорошего дня.",
    },
    {
      subject: `Проверка маршрута письма ${today}`,
      body: "Привет.\n\nЭто служебная проверка доставки и чтения входящих через IMAP. Напиши, пожалуйста, дошло ли письмо.\n\nСпасибо.",
    },
  ];
  return pickRandom(drafts);
}

function warmupReplyDraft() {
  return pickRandom([
    "Добрый день.\n\nПисьмо получил, все в порядке.\n\nСпасибо.",
    "Привет.\n\nДа, письмо дошло. Проверка выглядит нормально.",
    "Получил, спасибо. Входящее письмо отображается корректно.",
    "Добрый день.\n\nПодтверждаю получение. Можно продолжать проверку.",
  ]);
}

function fallbackWarmupDialogues() {
  return [
    {
      key: "fallback-check",
      subject: "Короткая проверка связи",
      messages: [
        "Привет.\n\nПроверяю рабочую переписку между ящиками. Если письмо пришло, ответь коротко.\n\nСпасибо.",
        "Привет. Да, письмо дошло, все нормально.",
        "Отлично, спасибо. Тогда оставляю цепочку как рабочую.",
        "Да, можно считать проверку успешной.",
      ],
    },
  ];
}

function normalizeWarmupSubject(subject) {
  return String(subject || "")
    .replace(/^\s*(re|fw|fwd)\s*:\s*/i, "")
    .trim();
}

function warmupMessageBody(dialogue, position) {
  const item = dialogue?.messages?.[position];
  if (typeof item === "string") return item;
  if (item && typeof item.body === "string") return item.body;
  return "";
}

async function loadWarmupDialogues() {
  const row = (await query("SELECT value FROM settings WHERE key = 'warmup_dialogues'")).rows[0];
  const value = row?.value;
  const dialogues = Array.isArray(value?.dialogues) ? value.dialogues : [];
  const usable = dialogues.filter((dialogue) => (
    dialogue &&
    typeof dialogue.key === "string" &&
    typeof dialogue.subject === "string" &&
    Array.isArray(dialogue.messages) &&
    dialogue.messages.length >= 2
  ));
  return usable.length ? usable : fallbackWarmupDialogues();
}

function findWarmupDialogue(dialogues, key) {
  return dialogues.find((dialogue) => dialogue.key === key) || dialogues[0] || fallbackWarmupDialogues()[0];
}

function isWithinWindow(row) {
  const now = new Date();
  const day = now.getDay() || 7;
  const days = row.send_days || [1, 2, 3, 4, 5];
  if (!days.includes(day)) return false;

  const current = now.toTimeString().slice(0, 5);
  const start = String(row.send_window_start || "09:00").slice(0, 5);
  const end = String(row.send_window_end || "18:00").slice(0, 5);
  return current >= start && current <= end;
}

async function lockNextJob() {
  return withClient(async (client) => {
    await client.query("BEGIN");
    const result = await client.query(
      `
        SELECT *
        FROM job_queue
        WHERE status IN ('pending','retrying') AND run_at <= now()
        ORDER BY run_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
    );
    if (!result.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const job = result.rows[0];
    await client.query("UPDATE job_queue SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now() WHERE id = $1", [job.id]);
    await client.query("COMMIT");
    return job;
  });
}

async function finishJob(jobId) {
  await query("UPDATE job_queue SET status = 'done', updated_at = now() WHERE id = $1", [jobId]);
}

async function failJob(job, error) {
  const retry = job.attempts + 1 < job.max_attempts;
  await query(
    `
      UPDATE job_queue
      SET status = $2,
          run_at = now() + (($3 * 5) || ' minutes')::interval,
          last_error = $4,
          updated_at = now()
      WHERE id = $1
    `,
    [job.id, retry ? "retrying" : "failed", job.attempts + 1, error.message],
  );
}

async function enqueueInboxSync(mailboxId, delaySeconds = 30) {
  await query(
    `
      INSERT INTO job_queue(job_type, payload, run_at)
      SELECT 'sync_inbox', jsonb_build_object('mailboxId', $1::text), now() + (($2 || ' seconds')::interval)
      WHERE NOT EXISTS (
        SELECT 1
        FROM job_queue
        WHERE job_type = 'sync_inbox'
          AND status IN ('pending','running','retrying')
          AND payload->>'mailboxId' = $1::text
      )
    `,
    [mailboxId, delaySeconds],
  );
}

async function continueWarmupThread(thread, fromMailbox, toMailbox) {
  const dialogues = await loadWarmupDialogues();
  const dialogue = findWarmupDialogue(dialogues, thread.template_key);
  const nextPosition = Number(thread.next_position || 1);
  const replyText = warmupMessageBody(dialogue, nextPosition);

  if (!replyText) {
    await query(
      "UPDATE warmup_threads SET status = 'completed', completed_at = now(), last_message_at = now() WHERE id = $1",
      [thread.id],
    );
    return;
  }

  const sender = nextPosition % 2 === 0 ? fromMailbox : toMailbox;
  const recipient = nextPosition % 2 === 0 ? toMailbox : fromMailbox;
  const subject = `Re: ${thread.subject || dialogue.subject}`;
  const info = await sendMail(sender, {
    to: recipient.email,
    subject,
    text: replyText,
    html: replyText.replace(/\n/g, "<br>"),
    headers: { "X-Outreach-Warmup": "true" },
  });

  await query(
    `
      INSERT INTO messages(mailbox_id, direction, type, status, subject, body_text, body_html, provider_message_id, message_id_header, sent_at)
      VALUES ($1,'outbound','warmup','sent',$2,$3,$4,$5,$6,now())
    `,
    [sender.id, subject, replyText, replyText.replace(/\n/g, "<br>"), info.response || "", info.messageId || ""],
  );

  const completed = nextPosition + 1 >= dialogue.messages.length;
  await query(
    `
      UPDATE warmup_threads
      SET next_position = $2,
          status = CASE WHEN $3 THEN 'completed' ELSE 'active' END,
          completed_at = CASE WHEN $3 THEN now() ELSE completed_at END,
          last_message_at = now()
      WHERE id = $1
    `,
    [thread.id, nextPosition + 1, completed],
  );
  await query("UPDATE mailboxes SET health_status = 'ok', error_count = 0, updated_at = now() WHERE id = $1", [sender.id]);
  await enqueueInboxSync(recipient.id, 45);
  await logEvent(completed ? "warmup_dialogue_completed" : "warmup_dialogue_continued", {
    mailboxId: sender.id,
    payload: {
      to: recipient.email,
      subject,
      nextPosition,
      templateKey: dialogue.key,
      fallback: "direct_send_after_wait",
    },
  });
}

async function handleJob(job) {
  if (job.job_type === "validate_lead") {
    const lead = (await query("SELECT * FROM leads WHERE id = $1", [job.payload.leadId])).rows[0];
    if (lead) await persistValidation(lead, await validateEmail(lead));
    return;
  }

  if (job.job_type === "sync_inbox") {
    const mailbox = (await query("SELECT * FROM mailboxes WHERE id = $1", [job.payload.mailboxId])).rows[0];
    if (mailbox) await syncInbox(mailbox);
    return;
  }

  if (job.job_type === "warmup_send") {
    await sendWarmup();
    return;
  }

  throw new Error(`Unknown job type: ${job.job_type}`);
}

async function scheduleDueEnrollments() {
  await query(
    `
      INSERT INTO sending_queue(enrollment_id, lead_id, campaign_id, campaign_step_id, mailbox_id, mode, requires_approval, scheduled_at)
      SELECT e.id, e.lead_id, e.campaign_id, s.id, e.mailbox_id,
             CASE WHEN c.manual_approval_required THEN 'manual' ELSE 'auto' END,
             c.manual_approval_required,
             e.next_send_at
      FROM enrollments e
      JOIN campaigns c ON c.id = e.campaign_id
      JOIN campaign_steps s ON s.campaign_id = e.campaign_id AND s.position = e.current_step
      WHERE e.status = 'active'
        AND c.status = 'active'
        AND e.next_send_at IS NOT NULL
        AND e.next_send_at <= now()
        AND NOT EXISTS (
          SELECT 1 FROM sending_queue q
          WHERE q.enrollment_id = e.id
            AND q.campaign_step_id = s.id
            AND q.status IN ('pending','running','retrying','sent')
        )
    `,
  );
}

async function lockNextSend() {
  return withClient(async (client) => {
    await client.query("BEGIN");
    const result = await client.query(
      `
        SELECT q.*, l.email AS lead_email, l.company, l.contact_name, l.position, l.website, l.domain, l.segment, l.city, l.pain,
               l.validation_status, l.suppressed_at,
               COALESCE(c.tracking_enabled, false) AS tracking_enabled,
               COALESCE(c.send_window_start, m.send_window_start) AS send_window_start,
               COALESCE(c.send_window_end, m.send_window_end) AS send_window_end,
               COALESCE(c.send_days, m.send_days) AS send_days,
               COALESCE(c.min_delay_minutes, m.min_delay_minutes) AS min_delay_minutes,
               COALESCE(c.max_delay_minutes, m.max_delay_minutes) AS max_delay_minutes,
               s.name AS step_name, s.position AS step_position, s.subject_template, s.body_template_text, s.body_template_html,
               ods.position AS outreach_step_position, ods.delay_days AS outreach_delay_days,
               m.name AS mailbox_name, m.email AS mailbox_email, m.from_name,
               m.smtp_host, m.smtp_port, m.smtp_secure, m.imap_host, m.imap_port, m.imap_secure,
               m.username, m.password_env_key
        FROM sending_queue q
        JOIN leads l ON l.id = q.lead_id
        LEFT JOIN campaigns c ON c.id = q.campaign_id
        LEFT JOIN campaign_steps s ON s.id = q.campaign_step_id
        LEFT JOIN outreach_draft_steps ods ON ods.id = q.outreach_step_id
        JOIN mailboxes m ON m.id = q.mailbox_id
        WHERE q.status IN ('pending','retrying')
          AND q.scheduled_at <= now()
          AND (q.requires_approval = false OR q.approved_at IS NOT NULL)
        ORDER BY q.scheduled_at ASC
        FOR UPDATE OF q SKIP LOCKED
        LIMIT 1
      `,
    );
    if (!result.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const item = result.rows[0];
    await client.query("UPDATE sending_queue SET status = 'running', attempts = attempts + 1, updated_at = now() WHERE id = $1", [item.id]);
    await client.query("COMMIT");
    return item;
  });
}

async function processSend(item) {
  if (item.validation_status === "invalid" || item.suppressed_at) {
    throw new Error("Lead is invalid or suppressed");
  }

  if (!isWithinWindow(item)) {
    await query(
      "UPDATE sending_queue SET status = 'pending', scheduled_at = now() + interval '30 minutes', updated_at = now() WHERE id = $1",
      [item.id],
    );
    return;
  }

  const mailbox = {
    id: item.mailbox_id,
    name: item.mailbox_name,
    email: item.mailbox_email,
    from_name: item.from_name,
    smtp_host: item.smtp_host,
    smtp_port: item.smtp_port,
    smtp_secure: item.smtp_secure,
    username: item.username,
    password_env_key: item.password_env_key,
  };
  const lead = {
    id: item.lead_id,
    email: item.lead_email,
    company: item.company,
    contact_name: item.contact_name,
    position: item.position,
    website: item.website,
    domain: item.domain,
    segment: item.segment,
    city: item.city,
    pain: item.pain,
  };
  const settings = (await query("SELECT value FROM settings WHERE key = 'sender'")).rows[0]?.value || {};
  const runtime = await getRuntimeSettings();
  const subjectTemplate = item.subject_override || item.subject_template || "";
  const textTemplate = item.body_text_override || item.body_template_text || htmlToText(item.body_template_html) || "";
  const htmlTemplate = item.body_html_override || item.body_template_html || textTemplate.replace(/\n/g, "<br>");
  const subject = renderTemplate(subjectTemplate, lead, mailbox, settings);
  const text = renderTemplate(textTemplate, lead, mailbox, settings);
  const trackingId = crypto.randomUUID();
  const pixel =
    item.tracking_enabled && runtime.publicTrackingUrl
      ? `<img src="${runtime.publicTrackingUrl.replace(/\/$/, "")}/t/open/${trackingId}.gif" width="1" height="1" alt="" style="display:none" />`
      : "";
  const html = `${renderTemplate(htmlTemplate, lead, mailbox, settings)}${pixel}`;
  const to = item.mode === "test" ? item.mailbox_email : item.lead_email;

  const messageInsert = await query(
    `
      INSERT INTO messages(
        lead_id, campaign_id, campaign_step_id, mailbox_id, enrollment_id, outreach_draft_id, outreach_step_id, direction, type,
        status, subject, body_text, body_html, tracking_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,'outbound',$8,'created',$9,$10,$11,$12)
      RETURNING *
    `,
    [
      item.lead_id,
      item.campaign_id,
      item.campaign_step_id,
      item.mailbox_id,
      item.enrollment_id,
      item.outreach_draft_id,
      item.outreach_step_id,
      item.mode === "test" ? "test" : "outreach",
      subject,
      text,
      html,
      trackingId,
    ],
  );
  const message = messageInsert.rows[0];
  const attachments = (
    await query("SELECT * FROM attachments WHERE campaign_step_id = $1 ORDER BY created_at", [item.campaign_step_id])
  ).rows;

  const info = await sendMail(mailbox, {
    to,
    subject,
    text,
    html,
    headers: { "X-Outreach-Message-ID": message.id },
  }, attachments);

  await query(
    `
      UPDATE messages
      SET status = 'sent', provider_message_id = $2, message_id_header = $3, sent_at = now()
      WHERE id = $1
    `,
    [message.id, info.response || "", info.messageId || ""],
  );

  await query(
    `
      UPDATE sending_queue
      SET status = 'sent', sent_message_id = $2, updated_at = now()
      WHERE id = $1
    `,
    [item.id, message.id],
  );
  await query("UPDATE mailboxes SET health_status = 'ok', error_count = 0, updated_at = now() WHERE id = $1", [item.mailbox_id]);

  if (item.outreach_draft_id) {
    await query(
      `
        UPDATE outreach_draft_steps
        SET status = 'sent', sent_message_id = $2, updated_at = now()
        WHERE id = $1
      `,
      [item.outreach_step_id, message.id],
    );
    const nextOutreachStep = (
      await query(
        `
          SELECT *
          FROM outreach_draft_steps
          WHERE draft_id = $1
            AND position = $2
            AND status <> 'blocked'
        `,
        [item.outreach_draft_id, Number(item.outreach_step_position || 1) + 1],
      )
    ).rows[0];

    if (nextOutreachStep && nextOutreachStep.subject && nextOutreachStep.body_text) {
      const delay = randomDelayMinutes(item.min_delay_minutes, item.max_delay_minutes);
      const nextQueue = await query(
        `
          INSERT INTO sending_queue(
            lead_id, mailbox_id, mode, requires_approval, scheduled_at,
            outreach_draft_id, outreach_step_id, subject_override, body_text_override, body_html_override
          )
          VALUES ($1,$2,$3,false,now() + (($4 || ' days')::interval) + (($5 || ' minutes')::interval),$6,$7,$8,$9,$10)
          RETURNING id
        `,
        [
          item.lead_id,
          item.mailbox_id,
          item.mode,
          nextOutreachStep.delay_days,
          delay,
          item.outreach_draft_id,
          nextOutreachStep.id,
          nextOutreachStep.subject,
          nextOutreachStep.body_text,
          nextOutreachStep.body_text.replace(/\n/g, "<br>"),
        ],
      );
      await query(
        "UPDATE outreach_draft_steps SET status = 'queued', queue_id = $2, updated_at = now() WHERE id = $1",
        [nextOutreachStep.id, nextQueue.rows[0].id],
      );
      await query("UPDATE outreach_drafts SET status = 'active_sequence', updated_at = now() WHERE id = $1", [item.outreach_draft_id]);
    } else {
      await query("UPDATE outreach_drafts SET status = 'completed', updated_at = now() WHERE id = $1", [item.outreach_draft_id]);
    }
  }

  if (item.outreach_draft_id) {
    await query("UPDATE leads SET status = 'sent', updated_at = now() WHERE id = $1 AND status NOT IN ('replied','meeting','won','lost')", [item.lead_id]);
    await logEvent("email_sent", {
      leadId: item.lead_id,
      mailboxId: item.mailbox_id,
      messageId: message.id,
      payload: { mode: item.mode, to, dryRun: runtime.dryRun, outreachDraftId: item.outreach_draft_id },
    });
    return;
  }

  const nextStep = (
    await query(
      `
        SELECT *
        FROM campaign_steps
        WHERE campaign_id = $1 AND position = $2
      `,
      [item.campaign_id, Number(item.step_position) + 1],
    )
  ).rows[0];

  if (nextStep) {
    const delay = randomDelayMinutes(item.min_delay_minutes, item.max_delay_minutes);
    await query(
      `
        UPDATE enrollments
        SET current_step = $2, next_send_at = now() + (($3 || ' days')::interval) + (($4 || ' minutes')::interval)
        WHERE id = $1
      `,
      [item.enrollment_id, nextStep.position, nextStep.delay_days, delay],
    );
  } else {
    await query("UPDATE enrollments SET status = 'completed', stopped_at = now(), stop_reason = 'sequence_completed' WHERE id = $1", [item.enrollment_id]);
  }

  await query("UPDATE leads SET status = 'sent', updated_at = now() WHERE id = $1 AND status NOT IN ('replied','meeting','won','lost')", [item.lead_id]);
  await logEvent("email_sent", {
    leadId: item.lead_id,
    campaignId: item.campaign_id,
    mailboxId: item.mailbox_id,
    messageId: message.id,
    payload: { mode: item.mode, to, dryRun: runtime.dryRun },
  });
}

async function failSend(item, error) {
  const retry = item.attempts + 1 < item.max_attempts;
  await query(
    `
      UPDATE sending_queue
      SET status = $2,
          scheduled_at = now() + (($3 * 10) || ' minutes')::interval,
          last_error = $4,
          updated_at = now()
      WHERE id = $1
    `,
    [item.id, retry ? "retrying" : "failed", item.attempts + 1, error.message],
  );
  await query("UPDATE mailboxes SET error_count = error_count + 1, health_status = 'error' WHERE id = $1", [item.mailbox_id]);
  await logEvent("mailbox_error", {
    leadId: item.lead_id,
    campaignId: item.campaign_id,
    mailboxId: item.mailbox_id,
    payload: { queueId: item.id, error: error.message },
  });
}

async function recoverInterruptedQueues({ staleOnly = false } = {}) {
  const staleJobFilter = staleOnly ? "AND locked_at < now() - interval '15 minutes'" : "";
  const staleSendFilter = staleOnly ? "AND updated_at < now() - interval '15 minutes'" : "";
  const [jobs, sends] = await Promise.all([
    query(
      `
        UPDATE job_queue
        SET status = CASE WHEN attempts < max_attempts THEN 'retrying' ELSE 'failed' END,
            run_at = now(),
            last_error = CASE
              WHEN attempts < max_attempts THEN 'Восстановлено после перезапуска worker'
              ELSE 'Задача не завершилась до перезапуска worker и исчерпала попытки'
            END,
            updated_at = now()
        WHERE status = 'running'
          ${staleJobFilter}
        RETURNING status
      `,
    ),
    query(
      `
        UPDATE sending_queue
        SET status = CASE WHEN attempts < max_attempts THEN 'retrying' ELSE 'failed' END,
            scheduled_at = now(),
            last_error = CASE
              WHEN attempts < max_attempts THEN 'Восстановлено после перезапуска worker'
              ELSE 'Отправка не завершилась до перезапуска worker и исчерпала попытки'
            END,
            updated_at = now()
        WHERE status = 'running'
          ${staleSendFilter}
        RETURNING status
      `,
    ),
  ]);

  const recoveredJobs = jobs.rows.filter((row) => row.status === "retrying").length;
  const failedJobs = jobs.rows.filter((row) => row.status === "failed").length;
  const recoveredSends = sends.rows.filter((row) => row.status === "retrying").length;
  const failedSends = sends.rows.filter((row) => row.status === "failed").length;
  if (recoveredJobs || failedJobs || recoveredSends || failedSends) {
    await logEvent("queue_recovered", {
      payload: {
        reason: staleOnly ? "stale_running" : "worker_startup",
        recoveredJobs,
        failedJobs,
        recoveredSends,
        failedSends,
      },
    });
  }
}

async function syncInbox(mailbox) {
  const runtime = await getRuntimeSettings();
  if (runtime.dryRun) return;

  const client = await createImapClient(mailbox);
  try {
    await client.connect();
    const lock = await client.mailboxOpen("INBOX");
    const state = (
      await query("SELECT * FROM imap_sync_state WHERE mailbox_id = $1 AND folder = 'INBOX'", [mailbox.id])
    ).rows[0];
    const fromUid = Number(state?.last_uid || 0) + 1;
    let maxUid = Number(state?.last_uid || 0);

    for await (const msg of client.fetch(`${fromUid}:*`, { uid: true, envelope: true, source: true, headers: true })) {
      if (!msg.uid || msg.uid <= maxUid) continue;
      maxUid = Math.max(maxUid, msg.uid);
      const parsed = await simpleParser(msg.source);
      const fromEmail = parsed.from?.value?.[0]?.address?.toLowerCase() || "";
      const subject = parsed.subject || "";
      const bodyText = parsed.text || "";
      const headers = Object.fromEntries([...parsed.headers.entries()].map(([key, value]) => [key, String(value)]));
      const warmupPeer = await findWarmupPeer(fromEmail);
      const isWarmup = Boolean(warmupPeer) && (headers["x-outreach-warmup"] === "true" || /рабочая заметка|warmup|проверка связи|проверка маршрута|тест входящей/i.test(subject));
      const classification = classifyInbound({ subject, body: bodyText, headers });
      const linked = await findLinkedOutbound(parsed, fromEmail);

      const inserted = await query(
        `
          INSERT INTO messages(
            lead_id, campaign_id, mailbox_id, outreach_draft_id, outreach_step_id, direction, type, status, subject, body_text, body_html,
            message_id_header, in_reply_to, references_header, raw_headers, received_at,
            reply_classification, reply_classification_source
          )
          VALUES ($1,$2,$3,$4,$5,'inbound',$6,'received',$7,$8,$9,$10,$11,$12,$13,$14,$15,'auto')
          RETURNING *
        `,
        [
          isWarmup ? null : linked?.lead_id || null,
          isWarmup ? null : linked?.campaign_id || null,
          mailbox.id,
          isWarmup ? null : linked?.outreach_draft_id || null,
          isWarmup ? null : linked?.outreach_step_id || null,
          isWarmup ? "warmup" : classification === "bounce" ? "bounce" : "reply",
          subject,
          bodyText,
          parsed.html || "",
          parsed.messageId || "",
          parsed.inReplyTo || "",
          (parsed.references || []).join(" "),
          headers,
          parsed.date || new Date(),
          classification,
        ],
      );

      if (isWarmup) {
        await handleWarmupInbound(mailbox, warmupPeer, inserted.rows[0], subject);
      } else {
        await applyInboundEffects(inserted.rows[0], classification);
      }
    }

    await query(
      `
        INSERT INTO imap_sync_state(mailbox_id, folder, last_uid, updated_at)
        VALUES ($1,'INBOX',$2,now())
        ON CONFLICT (mailbox_id) DO UPDATE SET last_uid = EXCLUDED.last_uid, updated_at = now()
      `,
      [mailbox.id, Math.max(maxUid, lock.uidNext ? Number(lock.uidNext) - 1 : maxUid)],
    );
    await query("UPDATE mailboxes SET last_inbox_sync_at = now(), health_status = 'ok', updated_at = now() WHERE id = $1", [mailbox.id]);
  } finally {
    await client.logout().catch(() => {});
  }
}

async function findWarmupPeer(email) {
  if (!email) return null;
  return (await query("SELECT * FROM mailboxes WHERE lower(email) = $1 AND warmup_enabled = true AND is_active = true", [email])).rows[0] || null;
}

async function handleWarmupInbound(mailbox, fromMailbox, message, subject) {
  await logEvent("warmup_reply_received", {
    mailboxId: mailbox.id,
    messageId: message.id,
    payload: { from: fromMailbox.email, subject },
  });

  const baseSubject = normalizeWarmupSubject(subject);
  const thread = (
    await query(
      `
        SELECT *
        FROM warmup_threads
        WHERE status = 'active'
          AND (
            (from_mailbox_id = $1 AND to_mailbox_id = $2)
            OR (from_mailbox_id = $2 AND to_mailbox_id = $1)
          )
          AND ($3 = '' OR subject = $3 OR subject IS NULL)
        ORDER BY last_message_at DESC NULLS LAST, created_at DESC
        LIMIT 1
      `,
      [fromMailbox.id, mailbox.id, baseSubject],
    )
  ).rows[0];
  if (!thread && /^\s*re\s*:/i.test(subject)) return;

  const dialogues = await loadWarmupDialogues();
  const dialogue = thread ? findWarmupDialogue(dialogues, thread.template_key) : null;
  const nextPosition = thread ? Number(thread.next_position || 1) : null;
  const expectedSenderId = thread
    ? (nextPosition % 2 === 0 ? thread.from_mailbox_id : thread.to_mailbox_id)
    : mailbox.id;

  if (thread && expectedSenderId !== mailbox.id) {
    await logEvent("warmup_dialogue_skipped", {
      mailboxId: mailbox.id,
      messageId: message.id,
      payload: { reason: "not_expected_sender", subject: baseSubject, nextPosition },
    });
    return;
  }

  let replyText = thread && dialogue ? warmupMessageBody(dialogue, nextPosition) : warmupReplyDraft();
  if (!replyText) {
    await query(
      "UPDATE warmup_threads SET status = 'completed', completed_at = now(), last_message_at = now() WHERE id = $1",
      [thread.id],
    );
    await logEvent("warmup_dialogue_completed", {
      mailboxId: mailbox.id,
      messageId: message.id,
      payload: { subject: baseSubject, templateKey: thread.template_key },
    });
    return;
  }

  const references = [message.references_header, message.in_reply_to, message.message_id_header].filter(Boolean).join(" ");
  const info = await sendMail(mailbox, {
    to: fromMailbox.email,
    subject: `Re: ${baseSubject || subject}`,
    text: replyText,
    html: replyText.replace(/\n/g, "<br>"),
    headers: { "X-Outreach-Warmup": "true" },
    inReplyTo: message.message_id_header || undefined,
    references: references || undefined,
  });

  await query(
    `
      INSERT INTO messages(mailbox_id, direction, type, status, subject, body_text, body_html, provider_message_id, message_id_header, sent_at)
      VALUES ($1,'outbound','warmup','sent',$2,$3,$4,$5,$6,now())
    `,
    [mailbox.id, `Re: ${baseSubject || subject}`, replyText, replyText.replace(/\n/g, "<br>"), info.response || "", info.messageId || ""],
  );
  if (thread) {
    const completed = nextPosition + 1 >= dialogue.messages.length;
    await query(
      `
        UPDATE warmup_threads
        SET next_position = $2,
            status = CASE WHEN $3 THEN 'completed' ELSE 'active' END,
            completed_at = CASE WHEN $3 THEN now() ELSE completed_at END,
            last_message_at = now()
        WHERE id = $1
      `,
      [thread.id, nextPosition + 1, completed],
    );
  }
  await query("UPDATE mailboxes SET health_status = 'ok', error_count = 0, updated_at = now() WHERE id = $1", [mailbox.id]);
  await enqueueInboxSync(fromMailbox.id, 45);
  await logEvent("warmup_sync_queued", {
    mailboxId: fromMailbox.id,
    messageId: message.id,
    payload: { reason: "reply_sent", from: mailbox.email },
  });
}

async function findLinkedOutbound(parsed, fromEmail) {
  const ids = [parsed.inReplyTo, ...(parsed.references || [])].filter(Boolean);
  if (ids.length) {
    const byHeader = await query("SELECT * FROM messages WHERE message_id_header = ANY($1::text[]) ORDER BY sent_at DESC LIMIT 1", [ids]);
    if (byHeader.rowCount) return byHeader.rows[0];
  }
  if (fromEmail) {
    const byLead = await query(
      `
        SELECT msg.*
        FROM messages msg
        JOIN leads l ON l.id = msg.lead_id
        WHERE l.email = $1 AND msg.direction = 'outbound'
        ORDER BY msg.sent_at DESC NULLS LAST, msg.created_at DESC
        LIMIT 1
      `,
      [fromEmail],
    );
    if (byLead.rowCount) return byLead.rows[0];
  }
  return null;
}

async function applyInboundEffects(message, classification) {
  if (!message.lead_id) return;
  const eventType =
    classification === "bounce"
      ? "email_bounced"
      : classification === "auto_reply"
        ? "auto_reply_received"
        : classification === "unsubscribe"
          ? "unsubscribe_detected"
          : "email_replied";

  if (classification === "bounce") {
    await query("UPDATE leads SET status = 'invalid', validation_status = 'invalid', validation_reason = 'bounce', updated_at = now() WHERE id = $1", [message.lead_id]);
    await query("UPDATE enrollments SET status = 'bounced', stopped_at = now(), stop_reason = 'bounce' WHERE lead_id = $1 AND status = 'active'", [message.lead_id]);
    const cancelled = await query(
      `
        UPDATE sending_queue
        SET status = 'cancelled',
            last_error = 'Отменено после недоставки',
            updated_at = now()
        WHERE lead_id = $1
          AND outreach_draft_id IS NOT NULL
          AND status IN ('pending','retrying')
        RETURNING outreach_step_id
      `,
      [message.lead_id],
    );
    const stepIds = cancelled.rows.map((row) => row.outreach_step_id).filter(Boolean);
    if (stepIds.length) {
      await query("UPDATE outreach_draft_steps SET status = 'cancelled', updated_at = now() WHERE id = ANY($1::uuid[])", [stepIds]);
    }
    const updatedConversation = await query(
      `
        UPDATE outreach_conversations
        SET status = 'bounced',
            classification = 'bounce',
            next_action = 'sequence_stopped_after_bounce',
            last_message_at = now(),
            updated_at = now()
        WHERE lead_id = $1
        RETURNING id, status, next_action
      `,
      [message.lead_id],
    );
    message.conversation_id = updatedConversation.rows[0]?.id || null;
    message.cancelled_queue = cancelled.rowCount;
  } else if (classification === "unsubscribe") {
    const lead = (await query("SELECT email, domain FROM leads WHERE id = $1", [message.lead_id])).rows[0];
    await query(
      "INSERT INTO suppressions(email, domain, reason, source) VALUES ($1,$2,'unsubscribe','imap') ON CONFLICT DO NOTHING",
      [lead?.email, lead?.domain],
    );
    await query("UPDATE leads SET status = 'suppressed', suppressed_at = now(), suppression_reason = 'unsubscribe', updated_at = now() WHERE id = $1", [message.lead_id]);
    await query("UPDATE enrollments SET status = 'unsubscribed', stopped_at = now(), stop_reason = 'unsubscribe' WHERE lead_id = $1 AND status = 'active'", [message.lead_id]);
    const cancelled = await query(
      `
        UPDATE sending_queue
        SET status = 'cancelled',
            last_error = 'Отменено после отписки',
            updated_at = now()
        WHERE lead_id = $1
          AND outreach_draft_id IS NOT NULL
          AND status IN ('pending','retrying')
        RETURNING outreach_step_id
      `,
      [message.lead_id],
    );
    const stepIds = cancelled.rows.map((row) => row.outreach_step_id).filter(Boolean);
    if (stepIds.length) {
      await query("UPDATE outreach_draft_steps SET status = 'cancelled', updated_at = now() WHERE id = ANY($1::uuid[])", [stepIds]);
    }
    const updatedConversation = await query(
      `
        UPDATE outreach_conversations
        SET status = 'unsubscribed',
            classification = 'unsubscribe',
            next_action = 'sequence_stopped_after_unsubscribe',
            last_message_at = now(),
            updated_at = now()
        WHERE lead_id = $1
        RETURNING id, status, next_action
      `,
      [message.lead_id],
    );
    message.conversation_id = updatedConversation.rows[0]?.id || null;
    message.cancelled_queue = cancelled.rowCount;
  } else if (classification === "auto_reply") {
    const updatedConversation = await query(
      `
        UPDATE outreach_conversations
        SET status = 'manual_reply_needed',
            classification = 'auto_reply',
            next_action = 'decide_followup_after_auto_reply',
            last_message_at = now(),
            updated_at = now()
        WHERE lead_id = $1
        RETURNING id, status, next_action
      `,
      [message.lead_id],
    );
    message.conversation_id = updatedConversation.rows[0]?.id || null;
  } else if (classification !== "auto_reply") {
    await query("UPDATE leads SET status = 'replied', updated_at = now() WHERE id = $1", [message.lead_id]);
    await query("UPDATE enrollments SET status = 'replied', stopped_at = now(), stop_reason = 'reply' WHERE lead_id = $1 AND status = 'active'", [message.lead_id]);
    const held = await query(
      `
        UPDATE sending_queue
        SET requires_approval = true,
            approved_at = NULL,
            updated_at = now()
        WHERE lead_id = $1
          AND outreach_draft_id IS NOT NULL
          AND status IN ('pending','retrying')
        RETURNING outreach_step_id
      `,
      [message.lead_id],
    );
    const heldStepIds = held.rows.map((row) => row.outreach_step_id).filter(Boolean);
    if (heldStepIds.length) {
      await query(
        "UPDATE outreach_draft_steps SET status = 'needs_approval', updated_at = now() WHERE id = ANY($1::uuid[])",
        [heldStepIds],
      );
    }
    const updatedConversation = await query(
      `
        UPDATE outreach_conversations
        SET status = 'waiting_reply_review',
            classification = $2,
            next_action = 'approve_or_pause_followup',
            last_message_at = now(),
            updated_at = now()
        WHERE lead_id = $1
        RETURNING id, status, next_action
      `,
      [message.lead_id, classification],
    );
    message.conversation_id = updatedConversation.rows[0]?.id || null;
  }

  await logEvent(eventType, {
    leadId: message.lead_id,
    campaignId: message.campaign_id,
    mailboxId: message.mailbox_id,
    messageId: message.id,
    payload: {
      conversationId: message.conversation_id,
      classification,
      reason: classification === "auto_reply" ? "auto_reply" : classification === "bounce" ? "bounce" : classification === "unsubscribe" ? "unsubscribe" : "reply_received",
      nextStatus: classification === "auto_reply" ? "manual_reply_needed" : classification === "bounce" ? "bounced" : classification === "unsubscribe" ? "unsubscribed" : "waiting_reply_review",
      nextAction: classification === "auto_reply" ? "decide_followup_after_auto_reply" : classification === "bounce" ? "sequence_stopped_after_bounce" : classification === "unsubscribe" ? "sequence_stopped_after_unsubscribe" : "approve_or_pause_followup",
      cancelledQueue: message.cancelled_queue,
    },
  });
}

async function scheduleMaintenance() {
  await recoverInterruptedQueues({ staleOnly: true });

  await query(
    `
      UPDATE warmup_threads
      SET status = 'stale', completed_at = now()
      WHERE status = 'active'
        AND last_message_at < now() - interval '30 minutes'
    `,
  );

  await query(
    `
      INSERT INTO job_queue(job_type, payload, run_at)
      SELECT 'sync_inbox', jsonb_build_object('mailboxId', id), now()
      FROM mailboxes m
      WHERE is_active = true
        AND (last_inbox_sync_at IS NULL OR last_inbox_sync_at < now() - (($1 || ' minutes')::interval))
        AND NOT EXISTS (
          SELECT 1 FROM job_queue j
          WHERE j.job_type = 'sync_inbox'
            AND j.status IN ('pending','running','retrying')
            AND j.payload->>'mailboxId' = m.id::text
        )
    `,
    [env.inboxSyncIntervalMinutes],
  );

  await query(
    `
      INSERT INTO job_queue(job_type, payload, run_at)
      SELECT 'warmup_send', '{}'::jsonb, now()
      WHERE (SELECT count(*) FROM mailboxes WHERE warmup_enabled = true AND is_active = true) >= 2
        AND NOT EXISTS (SELECT 1 FROM job_queue WHERE job_type = 'warmup_send' AND status IN ('pending','running','retrying'))
        AND NOT EXISTS (
          SELECT 1 FROM events
          WHERE event_type = 'warmup_sent'
            AND created_at > now() - ((
              SELECT GREATEST(1, MIN(min_delay_minutes))::text
              FROM mailboxes
              WHERE warmup_enabled = true AND is_active = true
            ) || ' minutes')::interval
        )
    `,
  );
}

async function sendWarmup() {
  const runtime = await getRuntimeSettings();
  const mailboxes = (await query(`
    SELECT m.*
    FROM mailboxes m
    WHERE m.warmup_enabled = true
      AND m.is_active = true
      AND (
        SELECT count(*)
        FROM messages msg
        WHERE msg.mailbox_id = m.id
          AND msg.direction = 'outbound'
          AND msg.type = 'warmup'
          AND msg.sent_at >= current_date
      ) < m.daily_warmup_limit
    ORDER BY random()
    LIMIT 2
  `)).rows;
  if (mailboxes.length < 2) return;
  const [from, to] = mailboxes;
  const activeThread = (
    await query(
      `
        SELECT *
        FROM warmup_threads
        WHERE status = 'active'
          AND (
            (from_mailbox_id = $1 AND to_mailbox_id = $2)
            OR (from_mailbox_id = $2 AND to_mailbox_id = $1)
          )
          AND last_message_at > now() - interval '30 minutes'
        ORDER BY last_message_at DESC NULLS LAST, created_at DESC
        LIMIT 1
      `,
      [from.id, to.id],
    )
  ).rows[0];
  if (activeThread) {
    const nextPosition = Number(activeThread.next_position || 1);
    const receiverId = nextPosition % 2 === 0 ? activeThread.from_mailbox_id : activeThread.to_mailbox_id;
    const minDelayMinutes = Math.max(1, Math.min(Number(from.min_delay_minutes || 1), Number(to.min_delay_minutes || 1)));
    const waitedMs = Date.now() - new Date(activeThread.last_message_at || activeThread.created_at).getTime();
    if (waitedMs >= minDelayMinutes * 60 * 1000) {
      await continueWarmupThread(activeThread, from, to);
      return;
    }
    await enqueueInboxSync(receiverId, 15);
    await logEvent("warmup_sync_queued", {
      mailboxId: receiverId,
      payload: {
        reason: "active_thread_continue",
        subject: activeThread.subject,
        nextPosition,
        waitSecondsLeft: Math.ceil((minDelayMinutes * 60 * 1000 - waitedMs) / 1000),
      },
    });
    return;
  }

  const dialogues = await loadWarmupDialogues();
  const dialogue = pickRandom(dialogues);
  const fallbackDraft = warmupDraft(from, to);
  const subject = dialogue?.subject || fallbackDraft.subject;
  const body = warmupMessageBody(dialogue, 0) || fallbackDraft.body;
  const info = await sendMail(from, {
    to: to.email,
    subject,
    text: body,
    html: body.replace(/\n/g, "<br>"),
    headers: { "X-Outreach-Warmup": "true" },
  });
  await query(
    `
      INSERT INTO messages(mailbox_id, direction, type, status, subject, body_text, body_html, provider_message_id, message_id_header, sent_at)
      VALUES ($1,'outbound','warmup','sent',$2,$3,$4,$5,$6,now())
    `,
    [from.id, subject, body, body.replace(/\n/g, "<br>"), info.response || "", info.messageId || ""],
  );
  await query(
    `
      INSERT INTO warmup_threads(from_mailbox_id, to_mailbox_id, template_key, subject, next_position, last_message_at)
      VALUES ($1,$2,$3,$4,1,now())
    `,
    [from.id, to.id, dialogue?.key || "fallback-check", normalizeWarmupSubject(subject)],
  );
  await query("UPDATE mailboxes SET health_status = 'ok', error_count = 0, updated_at = now() WHERE id = $1", [from.id]);
  await enqueueInboxSync(to.id, 45);
  await logEvent("warmup_sent", { mailboxId: from.id, payload: { to: to.email, subject, dryRun: runtime.dryRun, templateKey: dialogue?.key || "fallback-check" } });
  await logEvent("warmup_sync_queued", {
    mailboxId: to.id,
    payload: { reason: "warmup_sent", from: from.email, subject },
  });
}

async function tick() {
  await scheduleDueEnrollments();
  await scheduleMaintenance();

  const sendItem = await lockNextSend();
  if (sendItem) {
    try {
      await processSend(sendItem);
    } catch (error) {
      console.error(error);
      await failSend(sendItem, error);
    }
  }

  const job = await lockNextJob();
  if (job) {
    try {
      await handleJob(job);
      await finishJob(job.id);
    } catch (error) {
      console.error(error);
      await failJob(job, error);
    }
  }
}

let stopping = false;

process.on("SIGTERM", async () => {
  stopping = true;
  await pool.end();
});

console.log("Outreach worker started");
await recoverInterruptedQueues();
while (!stopping) {
  await tick();
  await sleep(env.workerPollMs);
}
