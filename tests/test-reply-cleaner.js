import { cleanReplyText } from "../src/services/template.js";

const english = cleanReplyText(`Да, интересно. Давайте обсудим на неделе.

On Mon, Jul 15, 2026 at 10:00 AM Gennadiy wrote:
> Привет, отправлял предложение.
> Старый текст письма.`);

if (english !== "Да, интересно. Давайте обсудим на неделе.") {
  throw new Error(`English quoted reply should be trimmed, got: ${english}`);
}

const russian = cleanReplyText(`Получил, спасибо.

От: Gennadiy <g@example.com>
Кому: client@example.com
Тема: Re: Предложение

История письма`);

if (russian !== "Получил, спасибо.") {
  throw new Error(`Russian quoted reply should be trimmed, got: ${russian}`);
}

const originalMessage = cleanReplyText(`Ок, вернусь с ответом завтра.

-----Original Message-----
From: sender@example.com`);

if (originalMessage !== "Ок, вернусь с ответом завтра.") {
  throw new Error(`Original message block should be trimmed, got: ${originalMessage}`);
}

console.log("OK: reply cleaner test passed");
