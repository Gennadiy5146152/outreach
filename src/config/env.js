import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

const root = process.cwd();

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  appPort: Number(process.env.APP_PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || "postgres://outreach:outreach@localhost:5432/outreach",
  publicTrackingUrl: process.env.PUBLIC_TRACKING_URL || "",
  mailDryRun: String(process.env.MAIL_DRY_RUN || "true").toLowerCase() !== "false",
  attachmentDir: path.resolve(root, process.env.ATTACHMENT_DIR || "storage/attachments"),
  maxAttachmentMb: Number(process.env.MAX_ATTACHMENT_MB || 50),
  dkimSelectors: (process.env.DKIM_SELECTORS || "mail,default,selector1,yandex")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  workerPollMs: Number(process.env.WORKER_POLL_MS || 5000),
  inboxSyncIntervalMinutes: Number(process.env.INBOX_SYNC_INTERVAL_MINUTES || 5),
  validationBatchSize: Number(process.env.VALIDATION_BATCH_SIZE || 100),
};

export function secret(name) {
  return process.env[name] || "";
}
