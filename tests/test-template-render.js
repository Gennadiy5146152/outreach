import assert from "node:assert/strict";
import { markdownToHtml, renderTemplate, renderTemplateHtml } from "../src/services/template.js";

const withoutContact = renderTemplate("{{contact}}\n\nПишу про {{company}}.", {
  company: "Ромашка",
  contact_name: "",
});

assert.equal(withoutContact, "Добрый день!\n\nПишу про Ромашка.");

const withContact = renderTemplate("{{contact}}, добрый день!\n\nПишу про {{company}}.", {
  company: "Ромашка",
  contact_name: "Иван",
});

assert.equal(withContact, "Иван, добрый день!\n\nПишу про Ромашка.");

assert.equal(
  markdownToHtml("Важно: **жирный текст**, *курсив* и [ссылка](https://example.com).\nНовая строка."),
  'Важно: <strong>жирный текст</strong>, <em>курсив</em> и <a href="https://example.com">ссылка</a>.<br>Новая строка.',
);

assert.equal(
  markdownToHtml("Не HTML: <script>alert(1)</script>"),
  "Не HTML: &lt;script&gt;alert(1)&lt;/script&gt;",
);

assert.equal(
  renderTemplateHtml("<strong>{{company}}</strong>", { company: "<CRM>" }),
  "<strong>&lt;CRM&gt;</strong>",
);

console.log("OK: template render test passed");
