import { OUTREACH_DELIVERY_LOCK, lockOutreachQueueMutation } from "./outreach-control.js";
import { cancelOutreachForScope } from "./outreach-stop.js";

const channelHosts = { telegram: "t.me", max: "max.ru", vk: "vk.com" };
const emailChannels = new Set(["email_general", "email_personal"]);
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function problem(code, status = 400) {
  return Object.assign(new Error(code), { status });
}

function uuid(value) {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw problem("channel_id_invalid");
  return value;
}

function field(value, max, error, required = true) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max || (required && !text)) throw problem(error);
  return text;
}

function safeUrl(value, error) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw problem(error);
    return url;
  } catch {
    throw problem(error);
  }
}

export function channelContactInput(input = {}) {
  const channel = input.channel;
  const isEmail = emailChannels.has(channel);
  if (!isEmail && !Object.hasOwn(channelHosts, channel)) throw problem("channel_type_invalid");
  let address = field(input.address, 500, "channel_address_invalid");
  if (isEmail) {
    address = address.toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) throw problem("channel_address_invalid");
  } else {
    if (channel === "telegram" && address.startsWith("@")) address = `https://t.me/${address.slice(1)}`;
    const url = safeUrl(address, "channel_address_invalid");
    const hostname = url.hostname.toLowerCase();
    const directPaths = {
      telegram: /^\/[a-z][a-z0-9_]{3,31}\/?$/i,
      max: /^\/(?:u\/)?[a-z0-9_-]+\/?$/i,
      vk: /^\/[a-z0-9_.-]+\/?$/i,
    };
    if (url.protocol !== "https:" || hostname !== channelHosts[channel] || url.port || !directPaths[channel].test(url.pathname)) {
      throw problem("channel_address_invalid");
    }
    const normalizedPath = url.pathname.replace(/\/$/, "");
    address = `${url.origin}${channel === "max" ? normalizedPath : normalizedPath.toLowerCase()}`;
  }
  const source = safeUrl(field(input.source_url, 1500, "channel_source_required"), "channel_source_invalid");
  return {
    channel,
    address,
    name: field(input.name, 200, "channel_name_invalid", false),
    role: field(input.role, 200, "channel_role_invalid", false),
    sourceUrl: source.href,
  };
}

export function channelTaskInput(input = {}, now = new Date()) {
  const body = field(input.body, 4000, "channel_message_invalid");
  const time = field(input.scheduled_at, 40, "channel_schedule_invalid");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(time)) {
    throw problem("channel_schedule_invalid");
  }
  const date = new Date(time);
  if (!Number.isFinite(date.getTime()) || date <= now) throw problem("channel_schedule_invalid");
  return { body, scheduledAt: date.toISOString() };
}

const companyIdentity = (alias) => `COALESCE(NULLIF(lower(btrim(${alias}.company)), ''), ${alias}.id::text)`;

const taskRows = `
  SELECT task.id, task.draft_id, task.company_key, task.scheduled_at, task.status, task.sent_at, task.completed_at, task.body,
    contact.channel, contact.address, contact.name, contact.role, lead.company, lead.id AS lead_id,
    (task.status = 'scheduled' AND task.scheduled_at <= now()) AS due
  FROM outreach_channel_tasks task
  JOIN outreach_channel_contacts contact ON contact.id = task.contact_id
  JOIN leads lead ON lead.id = contact.lead_id
`;

async function checkCompany(client, companyKey) {
  const { rows: [result] } = await client.query(`
    WITH related AS (
      SELECT id, email, domain, status, suppressed_at FROM leads candidate
      WHERE ${companyIdentity("candidate")} = $1
    )
    SELECT EXISTS (
      SELECT 1 FROM related lead
      WHERE lead.status = 'suppressed' OR lead.suppressed_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM suppressions s WHERE lower(s.email) = lower(lead.email)
          OR (s.domain IS NOT NULL AND lower(s.domain) = lower(lead.domain)))
    ) OR EXISTS (
      SELECT 1 FROM outreach_channel_tasks
      WHERE company_key = $1 AND status = 'declined'
    ) AS suppressed,
    EXISTS (
      SELECT 1 FROM messages m JOIN related ON related.id = m.lead_id
      WHERE m.direction = 'inbound' AND m.type = 'reply'
        AND COALESCE(m.received_at, m.created_at) >= now() - interval '30 days'
        AND COALESCE(m.reply_classification, '') NOT IN ('bounce', 'auto_reply', 'out_of_office')
    ) OR EXISTS (
      SELECT 1 FROM outreach_channel_tasks
      WHERE company_key = $1 AND status = 'replied' AND completed_at >= now() - interval '30 days'
    ) AS replied,
    EXISTS (
      SELECT 1 FROM messages m JOIN related ON related.id = m.lead_id
      WHERE m.direction = 'inbound' AND m.type = 'reply'
        AND COALESCE(m.received_at, m.created_at) >= now() - interval '30 days'
        AND m.reply_classification IN ('negative_reply', 'unsubscribe', 'not_target')
    ) AS declined,
    EXISTS (
      SELECT 1 FROM sending_queue q JOIN related ON related.id = q.lead_id
      WHERE q.status IN ('pending', 'retrying', 'running') AND q.mode <> 'test'
    ) AS active_email,
    EXISTS (
      SELECT 1 FROM outreach_channel_tasks
      WHERE company_key = $1 AND sent_at >= now() - interval '30 days'
    ) AS recent_messenger
  `, [companyKey]);
  return result;
}

async function transaction(withClient, action) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function cancelScheduledChannelTasksForEmailReply(query, leadId, classification) {
  if (["bounce", "auto_reply", "out_of_office"].includes(classification)) return 0;
  const { rowCount } = await query(`
    UPDATE outreach_channel_tasks task SET status = 'cancelled', completed_at = now()
    FROM outreach_channel_contacts contact, leads anchor, leads respondent
    WHERE task.contact_id = contact.id AND contact.lead_id = anchor.id
      AND respondent.id = $1 AND ${companyIdentity("anchor")} = ${companyIdentity("respondent")}
      AND task.status IN ('waiting','scheduled')
      AND (task.draft_id IS NULL OR $2 IN ('negative_reply','unsubscribe','not_target'))
  `, [leadId, classification]);
  return rowCount;
}

export function createOutreachChannelTasks({ query, withClient }) {
  return {
    async getCompany(leadId) {
      const id = uuid(leadId);
      const { rows: [lead] } = await query(`
        SELECT id, company, email, website, notes, ${companyIdentity("l")} AS company_key
        FROM leads l WHERE id = $1
      `, [id]);
      if (!lead) throw problem("channel_lead_not_found", 404);
      const [contacts, emails, researchedEmails] = await Promise.all([
        query(`
          SELECT contact.* FROM outreach_channel_contacts contact
          JOIN leads l ON l.id = contact.lead_id
          WHERE ${companyIdentity("l")} = $1 ORDER BY contact.channel, contact.checked_at DESC
        `, [lead.company_key]),
        query(`
          SELECT email, contact_name, position, source FROM leads l
          WHERE ${companyIdentity("l")} = $1 ORDER BY (id = $2) DESC, email LIMIT 100
        `, [lead.company_key, id]),
        query(`
          SELECT DISTINCT ON (c.normalized_email)
            c.email, c.name AS contact_name, c.role AS position, source.canonical_url AS source
          FROM company_contacts c
          JOIN company_research_sources source ON source.id = c.source_id
          JOIN company_research_runs run ON run.id = c.research_run_id
          JOIN leads l ON l.id = run.lead_id
          WHERE ${companyIdentity("l")} = $1 AND c.email_status = 'confirmed' AND c.email IS NOT NULL
          ORDER BY c.normalized_email, c.updated_at DESC LIMIT 100
        `, [lead.company_key]),
      ]);
      const knownEmails = new Map(emails.rows.map((row) => [row.email.toLowerCase(), row]));
      for (const row of researchedEmails.rows) {
        const key = row.email.toLowerCase();
        const existing = knownEmails.get(key);
        if (!existing?.contact_name) knownEmails.set(key, row);
      }
      return { lead, contacts: contacts.rows, emails: [...knownEmails.values()] };
    },

    async saveContact(leadId, input) {
      const id = uuid(leadId);
      const contact = channelContactInput(input);
      const { rows: [saved] } = await query(`
        INSERT INTO outreach_channel_contacts (lead_id, channel, address, name, role, source_url)
        SELECT id, $2, $3, $4, $5, $6 FROM leads WHERE id = $1
        ON CONFLICT (lead_id, channel, address) DO UPDATE
          SET name = EXCLUDED.name, role = EXCLUDED.role, source_url = EXCLUDED.source_url, checked_at = now()
        RETURNING *
      `, [id, contact.channel, contact.address, contact.name, contact.role, contact.sourceUrl]);
      if (!saved) throw problem("channel_lead_not_found", 404);
      return saved;
    },

    async listTasks({ status } = {}) {
      const statuses = ["waiting", "scheduled", "sent", "cancelled", "replied", "declined"];
      if (status && !statuses.includes(status)) throw problem("channel_status_invalid");
      const { rows } = await query(`
        ${taskRows}
        WHERE task.status <> 'draft'
          AND ($1::text IS NULL OR task.status = $1 OR ($1 = 'scheduled' AND task.status = 'waiting'))
        ORDER BY (task.status = 'scheduled') DESC,
          CASE WHEN task.status = 'scheduled' THEN task.scheduled_at END,
          task.completed_at DESC NULLS LAST, task.id
        LIMIT 100
      `, [status || null]);
      return rows;
    },

    async schedule(input = {}) {
      const contactId = uuid(input.contact_id);
      const task = channelTaskInput(input);
      return transaction(withClient, async (client) => {
        await lockOutreachQueueMutation(client);
        const { rows: [contact] } = await client.query(`
          SELECT c.channel, ${companyIdentity("l")} AS company_key
          FROM outreach_channel_contacts c JOIN leads l ON l.id = c.lead_id WHERE c.id = $1
        `, [contactId]);
        if (!contact) throw problem("channel_contact_not_found", 404);
        if (emailChannels.has(contact.channel)) throw problem("channel_use_email_queue");
        const check = await checkCompany(client, contact.company_key);
        if (check.suppressed || check.replied || check.recent_messenger) throw problem("channel_company_unavailable", 409);
        const { rows: [saved] } = await client.query(`
          INSERT INTO outreach_channel_tasks(contact_id, company_key, body, scheduled_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (company_key) WHERE status IN ('waiting','scheduled') DO NOTHING
          RETURNING *
        `, [contactId, contact.company_key, task.body, task.scheduledAt]);
        if (!saved) throw problem("channel_company_already_scheduled", 409);
        return saved;
      });
    },

    async getReady(taskId) {
      const { rows: [task] } = await query(`${taskRows} WHERE task.id = $1`, [uuid(taskId)]);
      if (!task) throw problem("channel_task_not_found", 404);
      if (!task.due) throw problem("channel_task_not_due", 409);
      const check = await checkCompany({ query }, task.company_key);
      if (check.suppressed || check.declined || (!task.draft_id && check.replied) || check.recent_messenger) throw problem("channel_company_unavailable", 409);
      if (check.active_email) throw problem("channel_email_still_active", 409);
      return task;
    },

    async finish(taskId, status) {
      const id = uuid(taskId);
      if (!["sent", "cancelled", "replied", "declined"].includes(status)) throw problem("channel_status_invalid");
      return transaction(withClient, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [OUTREACH_DELIVERY_LOCK]);
        const { rows: [task] } = await client.query(`
          UPDATE outreach_channel_tasks task
          SET status = $2, completed_at = now(), sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE task.sent_at END
          FROM outreach_channel_contacts contact
          WHERE task.id = $1 AND contact.id = task.contact_id
            AND ((task.status = 'scheduled' AND ($2 <> 'sent' OR task.scheduled_at <= now()))
              OR (task.status = 'waiting' AND $2 IN ('cancelled','declined'))
              OR (task.status = 'sent' AND $2 IN ('replied','declined')))
          RETURNING task.*, contact.lead_id
        `, [id, status]);
        if (!task) throw problem("channel_task_status_changed", 409);
        if (status === "replied" || status === "declined") {
          await client.query(`
            UPDATE outreach_channel_tasks SET status = 'cancelled', completed_at = now()
            WHERE company_key = $1 AND status = 'scheduled'
          `, [task.company_key]);
          await cancelOutreachForScope(client, {
            leadId: task.lead_id,
            scope: "same_company",
            reason: status === "declined" ? "Отказ в мессенджере" : "Ответ в мессенджере",
          });
        }
        return task;
      });
    },
  };
}
