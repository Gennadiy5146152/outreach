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

const mailRu = cleanReplyText(`Добрый день!
ок

--
С уважением,
Cтудия Коротковых
+7 901 690 65 94

> > Суббота, 18 июля 2026, 15:57 +03:00 от Геннадий Коротков <team@korotkov.dev>:
> Иван, добрый день!
> Подскажите, пожалуйста, когда ориентировочно будет закрыта задолженность`);

if (mailRu !== "Добрый день!\nок") {
  throw new Error(`Mail.ru quoted reply should be trimmed, got: ${mailRu}`);
}

const inlineSignature = cleanReplyText("Добрый день! ок -- С уважением, Cтудия Коротковых +7 901 690 65 94 > > Суббота, 18 июля 2026, 15:57 +03:00 от Геннадий Коротков <team@korotkov.dev>:");

if (inlineSignature !== "Добрый день! ок") {
  throw new Error(`Inline signature should be trimmed, got: ${inlineSignature}`);
}

console.log("OK: reply cleaner test passed");
