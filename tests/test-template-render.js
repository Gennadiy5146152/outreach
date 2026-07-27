import assert from "node:assert/strict";
import { renderTemplate } from "../src/services/template.js";

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

console.log("OK: template render test passed");
