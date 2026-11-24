import { smtpTransport } from "../services/mail.js";
import { fail } from "./security.js";

export function createAuthMailer({ query, env }) {
  return async function sendAuthEmail({ to, kind, url }) {
    const {
      rows: [mailbox],
    } = await query(
      "SELECT email,smtp_host,smtp_port,smtp_secure,username,password_env_key FROM mailboxes WHERE lower(email)=$1",
      [String(env.cabinetAuthMailboxEmail || "").toLowerCase()],
    );
    if (!mailbox) throw fail("email_auth_not_configured", 503);
    const reset = ["reset", "admin_reset"].includes(kind);
    const title = reset
      ? "Восстановление пароля Outreach Desk"
      : "Подтверждение почты Outreach Desk";
    const action = reset ? "Задать новый пароль" : "Подтвердить почту";
    const intro = reset
      ? "Вы запросили восстановление пароля. Перейдите по ссылке, чтобы задать новый пароль."
      : "Подтвердите адрес электронной почты для личного кабинета Outreach Desk.";
    const ttl = kind === "register" ? "1 час" : "30 минут";
    const escape = (s) =>
      s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll('"', "&quot;");
    const transport = smtpTransport(mailbox);
    try {
      await transport.sendMail({
        from: { name: "Outreach Desk", address: mailbox.email },
        to,
        subject: title,
        text: `${intro}\n\n${action}: ${url}\n\nСсылка действует ${ttl} и используется один раз.\n\nЕсли вы не запрашивали это письмо, просто проигнорируйте его.`,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.7;max-width:540px;color:#1e293b"><h2>${title}</h2><p>${intro}</p><p><a href="${escape(url)}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:#245da4;color:white;text-decoration:none">${action}</a></p><p>Ссылка действует ${ttl} и используется один раз.</p><p>Если вы не запрашивали это письмо, просто проигнорируйте его.</p></div>`,
        headers: {
          "Auto-Submitted": "auto-generated",
          "X-Auto-Response-Suppress": "All",
        },
      });
    } finally {
      transport.close();
    }
  };
}
