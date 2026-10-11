import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const server = await readFile(new URL("../../src/server.js", import.meta.url), "utf8");

test("MCP review endpoints expose exact authoritative state", () => {
  for (const route of [
    'app.get("/api/outreach/drafts/:id/review"',
    'app.get("/api/campaigns/:id/review"',
    'app.get("/api/sending/:id/review"',
    'app.get("/api/outreach/conversations/:id/classification-impact"',
    'app.get("/api/suppressions/impact"',
  ]) assert.equal(server.includes(route), true, route);
});

test("email suppression no longer implicitly expands to its domain", () => {
  assert.equal(server.includes("email?.split(\"@\")[1]"), false);
  assert.match(server, /const domain = req\.body\.domain \? String\(req\.body\.domain\).* : null;/);
});

test("MCP pagination queries receive rows and pagination metadata", () => {
  for (const route of ["/api/leads", "/api/outreach/drafts", "/api/outreach/runs", "/api/events"]) {
    const start = server.indexOf(`app.get(\"${route}\"`);
    assert.notEqual(start, -1, route);
    const block = server.slice(start, server.indexOf("}));", start) + 4);
    assert.match(block, /paginationMeta\(pagination,/i, route);
    assert.match(block, /\{\s*rows(?:\s*[:,])/i, route);
  }
});
