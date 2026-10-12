import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(root, ".github", "workflows", "deploy.yml");

function workflow() {
  return fs.readFileSync(workflowPath, "utf8");
}

test("workflow deploys only main and manual dispatch", () => {
  const source = workflow();
  assert.match(source, /push:\s*\n\s+branches:\s*\[main\]/);
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /if:\s*github\.ref == 'refs\/heads\/main'/);
});

test("workflow validates before deploy", () => {
  const source = workflow();
  assert.match(source, /uses:\s*actions\/checkout@v4/);
  assert.match(source, /uses:\s*actions\/setup-node@v4/);
  assert.match(source, /node-version:\s*22/);
  assert.match(source, /run:\s*npm ci/);
  assert.match(source, /run:\s*npm run check/);
  assert.match(source, /docker build -t "?outreach-desk-app:\$\{GITHUB_SHA\}"? \./);
  assert.match(source, /deploy:\s*\n(?:.|\n)*?needs:\s*validate/);
});

test("workflow pins host verification", () => {
  const source = workflow();
  assert.match(source, /OUTREACH_DEPLOY_KEY/);
  assert.match(source, /OUTREACH_DEPLOY_KNOWN_HOSTS/);
  assert.match(source, /StrictHostKeyChecking=yes/);
  assert.match(source, /UserKnownHostsFile=/);
  assert.match(source, /IdentitiesOnly=yes/);
  assert.doesNotMatch(source, /StrictHostKeyChecking=no/);
  assert.match(source, /"deploy \$\{GITHUB_SHA\}"/);
  assert.match(source, /if:\s*always\(\)/);
  assert.match(source, /rm -rf -- "\$\{RUNNER_TEMP\}\/outreach-ssh"/);
});

test("workflow grants read-only contents without application secrets", () => {
  const source = workflow();
  assert.match(source, /permissions:\s*\n\s+contents:\s*read/);
  for (const forbidden of [
    "AUTH_PASSWORD",
    "AUTH_SESSION_SECRET",
    "POSTGRES_PASSWORD",
    "MCP_API_TOKEN",
    "MAILBOX_",
  ]) {
    assert.doesNotMatch(source, new RegExp(forbidden));
  }
});

test("workflow serializes production deployments", () => {
  const source = workflow();
  assert.match(source, /concurrency:\s*\n\s+group:\s*outreach-production/);
  assert.match(source, /cancel-in-progress:\s*false/);
  assert.match(source, /validate:\s*\n\s+runs-on:[\s\S]*?timeout-minutes:\s*15/);
  assert.match(source, /deploy:\s*\n[\s\S]*?timeout-minutes:\s*10/);
});
