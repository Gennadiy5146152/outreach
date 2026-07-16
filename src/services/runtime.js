import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { normalizeOutreachStopScope } from "./outreach-stop.js";

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export async function getRuntimeSettings() {
  const rows = (
    await query("SELECT key, value FROM settings WHERE key IN ('runtime','tracking','attachments','outreach')")
  ).rows;
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value || {}]));
  const runtime = settings.runtime || {};

  return {
    dryRun: runtime.dryRun ?? runtime.mailDryRun ?? env.mailDryRun,
    publicTrackingUrl: runtime.publicTrackingUrl ?? settings.tracking?.publicTrackingUrl ?? env.publicTrackingUrl,
    maxAttachmentMb: toNumber(runtime.maxAttachmentMb ?? settings.attachments?.maxAttachmentMb, env.maxAttachmentMb),
    outreachStopScope: normalizeOutreachStopScope(runtime.outreachStopScope ?? settings.outreach?.stopScope),
  };
}

export async function saveRuntimeSettings({ dryRun, publicTrackingUrl, maxAttachmentMb, outreachStopScope }) {
  const runtime = {
    dryRun: Boolean(dryRun),
    publicTrackingUrl: String(publicTrackingUrl || "").trim(),
    maxAttachmentMb: toNumber(maxAttachmentMb, env.maxAttachmentMb),
    outreachStopScope: normalizeOutreachStopScope(outreachStopScope),
  };

  await query(
    `
      INSERT INTO settings(key, value, updated_at)
      VALUES ('runtime', $1, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `,
    [runtime],
  );
  await query(
    `
      INSERT INTO settings(key, value, updated_at)
      VALUES ('tracking', $1, now()), ('attachments', $2, now()), ('outreach', $3, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `,
    [
      { publicTrackingUrl: runtime.publicTrackingUrl },
      { maxAttachmentMb: runtime.maxAttachmentMb },
      { stopScope: runtime.outreachStopScope },
    ],
  );

  return runtime;
}
