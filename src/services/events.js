import { query } from "../db/pool.js";

export async function logEvent(eventType, fields = {}) {
  const {
    leadId = null,
    campaignId = null,
    mailboxId = null,
    messageId = null,
    payload = {},
  } = fields;

  await query(
    `
      INSERT INTO events(event_type, lead_id, campaign_id, mailbox_id, message_id, payload)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [eventType, leadId, campaignId, mailboxId, messageId, payload],
  );
}
