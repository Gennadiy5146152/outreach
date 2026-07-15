import crypto from "node:crypto";
import fs from "node:fs/promises";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { secret } from "../config/env.js";
import { getRuntimeSettings } from "./runtime.js";

function mailboxPassword(mailbox) {
  return secret(mailbox.password_env_key || "");
}

export function smtpTransport(mailbox) {
  return nodemailer.createTransport({
    host: mailbox.smtp_host,
    port: mailbox.smtp_port,
    secure: mailbox.smtp_secure,
    auth: {
      user: mailbox.username || mailbox.email,
      pass: mailboxPassword(mailbox),
    },
  });
}

export async function verifySmtp(mailbox) {
  const runtime = await getRuntimeSettings();
  if (runtime.dryRun) return { ok: true, dryRun: true };
  const transport = smtpTransport(mailbox);
  await transport.verify();
  return { ok: true, dryRun: false };
}

export async function sendMail(mailbox, message, attachments = []) {
  const from = mailbox.from_name ? `"${mailbox.from_name}" <${mailbox.email}>` : mailbox.email;
  const preparedAttachments = [];

  for (const attachment of attachments) {
    preparedAttachments.push({
      filename: attachment.file_name,
      content: await fs.readFile(attachment.storage_path),
      contentType: attachment.mime_type,
    });
  }

  const runtime = await getRuntimeSettings();
  if (runtime.dryRun) {
    console.log(`[DRY-RUN] ${from} -> ${message.to}: ${message.subject}`);
    return {
      messageId: `<dry-run-${crypto.randomUUID()}@outreach.local>`,
      response: "dry-run",
    };
  }

  const transport = smtpTransport(mailbox);
  return transport.sendMail({
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    attachments: preparedAttachments,
    headers: message.headers || {},
  });
}

export async function createImapClient(mailbox) {
  return new ImapFlow({
    host: mailbox.imap_host,
    port: mailbox.imap_port,
    secure: mailbox.imap_secure,
    auth: {
      user: mailbox.username || mailbox.email,
      pass: mailboxPassword(mailbox),
    },
    logger: false,
  });
}

export async function verifyImap(mailbox) {
  const runtime = await getRuntimeSettings();
  if (runtime.dryRun) return { ok: true, dryRun: true };
  const client = await createImapClient(mailbox);
  try {
    await client.connect();
    await client.mailboxOpen("INBOX");
    return { ok: true, dryRun: false };
  } finally {
    await client.logout().catch(() => {});
  }
}
