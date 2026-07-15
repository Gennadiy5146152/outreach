import fs from "node:fs";

const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  ".env-item strong",
  "overflow-wrap: anywhere",
  ".env-grid section",
  ".env-item .pill",
  ".env-template",
]) {
  if (!css.includes(expected)) {
    throw new Error(`ENV layout should include ${expected}`);
  }
}

console.log("OK: env layout static test passed");
