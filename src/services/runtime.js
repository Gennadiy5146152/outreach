import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { normalizeOutreachStopScope } from "./outreach-stop.js";

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeTimeZone(value) {
  const timeZone = String(value || "").trim() || env.appTimeZone;
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return env.appTimeZone;
  }
}

export function isValidTimeZone(value) {
  const timeZone = String(value || "").trim();
  if (!timeZone) return true;
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
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
    timeZone: normalizeTimeZone(runtime.timeZone),
  };
}

export async function saveRuntimeSettings({ dryRun, publicTrackingUrl, maxAttachmentMb, outreachStopScope, timeZone }) {
  const runtime = {
    dryRun: Boolean(dryRun),
    publicTrackingUrl: String(publicTrackingUrl || "").trim(),
    maxAttachmentMb: toNumber(maxAttachmentMb, env.maxAttachmentMb),
    outreachStopScope: normalizeOutreachStopScope(outreachStopScope),
    timeZone: normalizeTimeZone(timeZone),
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
