import dns from "node:dns/promises";
import { query } from "../db/pool.js";
import { logEvent } from "./events.js";

const rolePrefixes = new Set([
  "admin",
  "billing",
  "contact",
  "hello",
  "hr",
  "info",
  "office",
  "sales",
  "support",
  "team",
]);

const disposableDomains = new Set([
  "10minutemail.com",
  "guerrillamail.com",
  "mailinator.com",
  "tempmail.com",
  "yopmail.com",
]);

const providerHints = [
  ["yandex", "Яндекс"],
  ["google", "Google"],
  ["gmail", "Google"],
  ["outlook", "Microsoft"],
  ["protection.outlook", "Microsoft"],
  ["mail.ru", "Mail.ru"],
];

export function parseEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  const match = normalized.match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/);
  if (!match) return { normalized, local: "", domain: "", syntaxValid: false };
  return { normalized, local: match[1], domain: match[2], syntaxValid: true };
}

export async function validateEmail(lead) {
  const parsed = parseEmail(lead.email);
  const result = {
    email: parsed.normalized,
    status: "invalid",
    reason: "invalid_syntax",
    syntaxValid: parsed.syntaxValid,
    domainExists: false,
    mxExists: false,
    provider: null,
    isDisposable: false,
    isRoleBased: false,
    isCatchAll: null,
  };

  if (!parsed.syntaxValid) return result;

  result.isDisposable = disposableDomains.has(parsed.domain);
  result.isRoleBased = rolePrefixes.has(parsed.local);

  try {
    await dns.resolve(parsed.domain);
    result.domainExists = true;
  } catch {
    result.domainExists = false;
  }

  try {
    const mx = await dns.resolveMx(parsed.domain);
    result.mxExists = mx.length > 0;
    const mxText = mx.map((item) => item.exchange).join(" ").toLowerCase();
    result.provider = providerHints.find(([needle]) => mxText.includes(needle))?.[1] || "custom";
  } catch {
    result.mxExists = false;
  }

  if (!result.domainExists || !result.mxExists) {
    result.status = "invalid";
    result.reason = !result.domainExists ? "domain_not_found" : "mx_not_found";
  } else if (result.isDisposable || result.isRoleBased) {
    result.status = "risky";
    result.reason = result.isDisposable ? "disposable_domain" : "role_based";
  } else {
    result.status = "valid";
    result.reason = "safe_checks_passed";
  }

  return result;
}

export async function persistValidation(lead, result) {
  await query(
    `
      INSERT INTO email_validation_results(
        lead_id, email, status, reason, syntax_valid, domain_exists, mx_exists,
        provider, is_disposable, is_role_based, is_catch_all
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `,
    [
      lead.id,
      result.email,
      result.status,
      result.reason,
      result.syntaxValid,
      result.domainExists,
      result.mxExists,
      result.provider,
      result.isDisposable,
      result.isRoleBased,
      result.isCatchAll,
    ],
  );

  await query(
    `
      UPDATE leads
      SET validation_status = $2,
          validation_reason = $3,
          last_validated_at = now(),
          domain = COALESCE(NULLIF(domain, ''), $4),
          status = CASE
            WHEN $2 = 'valid' AND status = 'new' THEN 'validated'
            WHEN $2 = 'invalid' THEN 'invalid'
            ELSE status
          END,
          updated_at = now()
      WHERE id = $1
    `,
    [lead.id, result.status, result.reason, parseEmail(lead.email).domain],
  );

  await logEvent("email_validated", {
    leadId: lead.id,
    payload: result,
  });
}
