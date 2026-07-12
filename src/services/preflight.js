import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { findMissingRequiredVariables } from "./template.js";

export async function campaignPreflight(campaignId) {
  const campaign = (await query("SELECT * FROM campaigns WHERE id = $1", [campaignId])).rows[0];
  if (!campaign) throw new Error("Campaign not found");

  const enrollments = (
    await query(
      `
        SELECT e.*, l.email, l.company, l.validation_status, l.suppressed_at, m.email AS mailbox_email,
               m.smtp_verified_at, m.imap_verified_at, m.is_active AS mailbox_active,
               s.subject_template, s.body_template_text, s.body_template_html
        FROM enrollments e
        JOIN leads l ON l.id = e.lead_id
        LEFT JOIN mailboxes m ON m.id = e.mailbox_id
        LEFT JOIN campaign_steps s ON s.campaign_id = e.campaign_id AND s.position = e.current_step
        WHERE e.campaign_id = $1 AND e.status = 'active'
      `,
      [campaignId],
    )
  ).rows;

  const domainChecks = (
    await query(
      `
        SELECT DISTINCT ON (mailbox_id) *
        FROM sending_domain_checks
        WHERE mailbox_id IN (SELECT DISTINCT mailbox_id FROM enrollments WHERE campaign_id = $1 AND mailbox_id IS NOT NULL)
        ORDER BY mailbox_id, checked_at DESC
      `,
      [campaignId],
    )
  ).rows;
  const domainByMailbox = new Map(domainChecks.map((item) => [item.mailbox_id, item]));

  const errors = [];
  const warnings = [];
  const stats = {
    enrollments: enrollments.length,
    valid: 0,
    risky: 0,
    invalid: 0,
    suppressed: 0,
    mailboxes: new Set(),
  };

  if (!enrollments.length) errors.push("Нет лидов для отправки.");

  for (const item of enrollments) {
    if (item.validation_status === "valid") stats.valid += 1;
    if (item.validation_status === "risky") stats.risky += 1;
    if (item.validation_status === "invalid") stats.invalid += 1;
    if (item.suppressed_at) stats.suppressed += 1;
    if (item.mailbox_id) stats.mailboxes.add(item.mailbox_id);

    if (!item.mailbox_id || !item.mailbox_active) errors.push(`Нет активного mailbox для ${item.email}.`);
    if (!item.smtp_verified_at || !item.imap_verified_at) errors.push(`SMTP/IMAP не проверены для ${item.mailbox_email || item.email}.`);
    if (item.validation_status === "invalid") errors.push(`${item.email}: email invalid.`);
    if (item.suppressed_at) errors.push(`${item.email}: адрес в suppression.`);

    const domain = domainByMailbox.get(item.mailbox_id);
    if (!domain) {
      errors.push(`${item.mailbox_email}: нет проверки MX/SPF/DKIM/DMARC.`);
    } else {
      for (const key of ["mx_status", "spf_status", "dkim_status", "dmarc_status"]) {
        if (domain[key] !== "pass") errors.push(`${item.mailbox_email}: ${key} = ${domain[key]}.`);
      }
    }

    const missing = [
      ...findMissingRequiredVariables(item.subject_template, item),
      ...findMissingRequiredVariables(item.body_template_text, item),
      ...findMissingRequiredVariables(item.body_template_html, item),
    ];
    if (missing.length) errors.push(`${item.email}: пустые переменные ${[...new Set(missing)].join(", ")}.`);
  }

  if (campaign.tracking_enabled && !env.publicTrackingUrl) {
    errors.push("PUBLIC_TRACKING_URL не задан при включенном open tracking.");
  }
  if (campaign.daily_limit === null) warnings.push("Дневной лимит кампании отключен, будут применяться задержки и рабочее окно.");

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    stats: { ...stats, mailboxes: stats.mailboxes.size },
  };
}
