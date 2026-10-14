import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const js = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

assert.match(html, /data-view="personalization"/);
assert.match(html, /id="personalizationView"/);
assert.match(html, /Подготовить 30 черновиков/);
assert.match(html, /id="personalizationPreviewSummary"/);
assert.match(html, /data-personalization-filter="qualified"/);
assert.match(html, /data-personalization-filter="review"/);
assert.match(html, /data-personalization-filter="excluded"/);
assert.match(html, /data-personalization-filter="failed"/);
assert.match(html, /data-personalization-filter="ready"/);

assert.match(js, /\/api\/personalization\/pilots\/preview/);
assert.match(js, /\/api\/personalization\/pilots/);
assert.match(js, /window\.confirm/);
assert.match(js, /preview\.leads\.length/);
assert.match(js, /rel="noopener noreferrer"/);
assert.match(js, /fact_evidence/);
assert.match(js, /fit_reason/);
assert.match(js, /contact_confidence/);
assert.match(html, /data-retry-personalization/);
assert.match(js, /data-open-personalized-draft/);
assert.match(js, /esc\(item\.fact_evidence/);
assert.doesNotMatch(js, /innerHTML\s*=\s*item\.fact_evidence/);

console.log("OK: personalization review UI static contract passed");
