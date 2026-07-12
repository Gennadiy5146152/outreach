import dns from "node:dns/promises";
import { env } from "../config/env.js";
import { query } from "../db/pool.js";

async function hasTxt(domain, predicate) {
  try {
    const records = await dns.resolveTxt(domain);
    return records.flat().some((value) => predicate(value.toLowerCase()));
  } catch {
    return false;
  }
}

export async function checkSendingDomain(mailbox) {
  const domain = mailbox.email.split("@")[1]?.toLowerCase();
  const details = { selectors: [] };
  let mxStatus = "fail";
  let spfStatus = "fail";
  let dmarcStatus = "fail";
  let dkimStatus = "unknown";

  try {
    const mx = await dns.resolveMx(domain);
    mxStatus = mx.length ? "pass" : "fail";
    details.mx = mx;
  } catch (error) {
    details.mxError = error.message;
  }

  spfStatus = (await hasTxt(domain, (value) => value.startsWith("v=spf1"))) ? "pass" : "fail";
  dmarcStatus = (await hasTxt(`_dmarc.${domain}`, (value) => value.startsWith("v=dmarc1"))) ? "pass" : "fail";

  for (const selector of env.dkimSelectors) {
    const name = `${selector}._domainkey.${domain}`;
    const found = await hasTxt(name, (value) => value.includes("v=dkim1") || value.includes("p="));
    details.selectors.push({ selector, found });
    if (found) dkimStatus = "pass";
  }
  if (dkimStatus !== "pass") dkimStatus = "fail";

  await query(
    `
      INSERT INTO sending_domain_checks(mailbox_id, domain, mx_status, spf_status, dkim_status, dmarc_status, details)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `,
    [mailbox.id, domain, mxStatus, spfStatus, dkimStatus, dmarcStatus, details],
  );

  return { domain, mxStatus, spfStatus, dkimStatus, dmarcStatus, details };
}
