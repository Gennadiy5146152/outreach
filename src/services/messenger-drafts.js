import { channelContactInput } from "./outreach-channel-tasks.js";

const channels = new Set(["telegram", "max", "vk"]);
const statuses = new Set(["ready", "review", "sent"]);
const audiences = new Set(["business", "partnership", "excluded"]);
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const statusSql = "CASE WHEN sent_at IS NOT NULL THEN 'sent' WHEN review_reason <> '' THEN 'review' ELSE 'ready' END";

function error(code, status = 400) {
  return Object.assign(new Error(code), { status });
}

function text(value, max, required = false) {
  if (value == null && !required) return "";
  if (typeof value !== "string" || value.length > max || value.includes("\0") || (required && !value.trim())) {
    throw error("messenger_draft_invalid");
  }
  return value;
}

function optionalUrl(value) {
  const link = text(value, 1500).trim();
  if (!link) return "";
  let url;
  try {
    url = new URL(link);
  } catch {
    throw error("messenger_draft_invalid");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw error("messenger_draft_invalid");
  return url.href;
}

function normalizeRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw error("messenger_draft_invalid");
  const channel = row.channel ?? "telegram";
  if (!channels.has(channel)) throw error("channel_type_invalid");
  const contact = channelContactInput({
    channel,
    address: row.address ?? row.telegram,
    source_url: row.source_url ?? row.source,
    name: text(row.name, 200, true),
    role: text(row.role, 200),
  });
  const status = row.status ?? "ready";
  if (status !== "ready" && status !== "review") throw error("messenger_status_invalid");
  return {
    channel,
    address: contact.address,
    name: contact.name,
    role: contact.role,
    source_url: contact.sourceUrl,
    company: text(row.company, 300, true).trim(),
    region: text(row.region, 300).trim(),
    website: optionalUrl(row.website),
    fact: text(row.fact, 4000),
    fact_url: optionalUrl(row.fact_url),
    case_url: optionalUrl(row.case_url),
    case_reason: text(row.case_reason, 4000),
    opportunity: text(row.opportunity, 4000),
    partnership: row.partnership === true,
    technology_product: row.technology_product === true,
    review_reason: status === "review" ? text(row.review_reason, 4000, true).trim() : "",
    body: text(row.body ?? row.draft, 4000, true),
  };
}

export function createMessengerDrafts({ query }) {
  async function get(id) {
    if (typeof id !== "string" || !uuidPattern.test(id)) throw error("channel_id_invalid");
    const { rows: [row] } = await query(
      `SELECT *, ${statusSql} AS status FROM outreach_messenger_drafts WHERE id = $1`, [id],
    );
    if (!row) throw error("messenger_draft_not_found", 404);
    return row;
  }

  return {
    get,

    async importBatch({ collection, rows } = {}) {
      const name = text(collection, 200, true).trim();
      if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw error("messenger_batch_invalid");
      const input = rows.map(normalizeRow);
      if (new Set(input.map(({ channel, address }) => `${channel}:${address}`)).size !== input.length) {
        throw error("messenger_batch_duplicates");
      }
      const { rowCount } = await query(`
        INSERT INTO outreach_messenger_drafts (
          collection, channel, address, name, role, source_url, company, region, website,
          fact, fact_url, case_url, case_reason, opportunity, partnership, technology_product, review_reason, body
        )
        SELECT $1, channel, address, name, role, source_url, company, region, website,
          fact, fact_url, case_url, case_reason, opportunity, partnership, technology_product, review_reason, body
        FROM jsonb_to_recordset($2::jsonb) AS input(
          channel text, address text, name text, role text, source_url text, company text,
          region text, website text, fact text, fact_url text, case_url text, case_reason text,
          opportunity text, partnership boolean, technology_product boolean, review_reason text, body text
        )
        ON CONFLICT (collection, channel, address) DO NOTHING
      `, [name, JSON.stringify(input)]);
      return { inserted: rowCount, existing: input.length - rowCount };
    },

    async list({ status, search, page, pageSize, audience } = {}) {
      const filter = text(status, 20).trim();
      if (filter && !statuses.has(filter)) throw error("messenger_status_invalid");
      const term = text(search, 200).trim().replace(/^@/, "");
      const audienceFilter = text(audience, 20);
      if (audienceFilter && !audiences.has(audienceFilter)) throw error("messenger_audience_invalid");
      const pageNumber = Number(page ?? 1);
      const limit = Number(pageSize ?? 50);
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 10000) {
        throw error("messenger_page_invalid");
      }
      if (![25, 50, 100].includes(limit)) throw error("messenger_page_invalid");
      const { rows: [result] } = await query(`
        WITH filtered AS (
          SELECT id, collection, channel, address, name, company, sent_at, partnership, technology_product,
            updated_at, ${statusSql} AS status
          FROM outreach_messenger_drafts
          WHERE ($1 = '' OR $1 = ${statusSql})
            AND ($2 = '' OR strpos(lower(concat_ws(' ', name, company, address, collection,
              CASE WHEN partnership THEN 'сотрудничество' END)), lower($2)) > 0)
            AND CASE $5
              WHEN 'business' THEN NOT partnership AND NOT technology_product
              WHEN 'partnership' THEN partnership
              WHEN 'excluded' THEN NOT partnership AND technology_product
              ELSE true
            END
        ), page AS (
          SELECT * FROM filtered ORDER BY updated_at DESC, id LIMIT $3 OFFSET $4
        )
        SELECT (SELECT count(*)::int FROM filtered) AS total,
          COALESCE(jsonb_agg(page ORDER BY updated_at DESC, id), '[]'::jsonb) AS items
        FROM page
      `, [filter, term, limit, (pageNumber - 1) * limit, audienceFilter]);
      return { ...result, page: pageNumber, pageSize: limit };
    },

    async update(id, { body, reviewed } = {}) {
      const draft = await get(id);
      if (draft.sent_at) throw error("messenger_draft_sent", 409);
      const { rows: [saved] } = await query(`
        UPDATE outreach_messenger_drafts
        SET body = $2, review_reason = CASE WHEN $3 THEN '' ELSE review_reason END, updated_at = now()
        WHERE id = $1 AND sent_at IS NULL
        RETURNING *, ${statusSql} AS status
      `, [id, text(body, 4000, true), reviewed === true]);
      if (!saved) throw error("messenger_draft_sent", 409);
      return saved;
    },

    async recordSent(id, { body } = {}) {
      const actual = text(body, 4000, true);
      if (typeof id !== "string" || !uuidPattern.test(id)) throw error("channel_id_invalid");
      const { rows: [saved] } = await query(`
        UPDATE outreach_messenger_drafts SET sent_at = now(), sent_body = $2, updated_at = now()
        WHERE id = $1 AND sent_at IS NULL
        RETURNING *, ${statusSql} AS status
      `, [id, actual]);
      if (saved) return saved;
      const current = await get(id);
      if (current.sent_body === actual) return current;
      throw error("messenger_draft_sent", 409);
    },
  };
}
