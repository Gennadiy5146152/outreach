import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "deploy", "outreach-deploy.sh");
const sha40 = "0123456789abcdef0123456789abcdef01234567";
const sha64 = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";

function runBash(source, args = []) {
  return spawnSync("bash", ["-c", source, "deploy-test", script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, OUTREACH_DEPLOY_LIBRARY_ONLY: "1" },
  });
}

test("parse_requested_sha accepts only an exact deploy command", () => {
  for (const [command, expected] of [
    [`deploy ${sha40}`, sha40],
    [`deploy ${sha64}`, sha64.toLowerCase()],
  ]) {
    const result = runBash('source "$1"; parse_requested_sha "$2"', [command]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
});

test("parse_requested_sha rejects command injection and malformed input", () => {
  for (const command of [
    "",
    "deploy",
    "deploy abc",
    `deploy ${sha40} extra`,
    `deploy ${sha40}; id`,
    "deploy $(id)",
    "deploy /tmp/revision",
    "deploy --help",
  ]) {
    const result = runBash('source "$1" || exit 91; parse_requested_sha "$2"', [command]);
    assert.notEqual(result.status, 0, `unexpectedly accepted: ${command}`);
    assert.notEqual(result.status, 91, "deploy script could not be loaded");
    assert.notEqual(result.status, 127, "parser function is missing");
    assert.equal(result.stdout, "");
  }
});

test("verify_main_ancestry rejects a commit outside origin main", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-git-test-"));
  const remote = path.join(temp, "origin.git");
  const checkout = path.join(temp, "checkout");
  const git = (args, cwd = checkout) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  fs.mkdirSync(checkout);
  git(["init", "--bare", remote], temp);
  git(["init", "-b", "main"]);
  git(["config", "user.email", "deploy-test@example.invalid"]);
  git(["config", "user.name", "Deploy Test"]);
  fs.writeFileSync(path.join(checkout, "main.txt"), "main\n");
  git(["add", "main.txt"]);
  git(["commit", "-m", "main commit"]);
  git(["remote", "add", "origin", remote]);
  git(["push", "-u", "origin", "main"]);
  const mainSha = git(["rev-parse", "HEAD"]);

  git(["checkout", "--orphan", "side"]);
  git(["rm", "-rf", "."]);
  fs.writeFileSync(path.join(checkout, "side.txt"), "side\n");
  git(["add", "side.txt"]);
  git(["commit", "-m", "side commit"]);
  const sideSha = git(["rev-parse", "HEAD"]);

  const harness = 'source "$1"; OUTREACH_DIR="$2"; verify_main_ancestry "$3"';
  const valid = runBash(harness, [checkout, mainSha]);
  assert.equal(valid.status, 0, valid.stderr);

  const invalid = runBash(harness, [checkout, sideSha]);
  assert.notEqual(invalid.status, 0);
  assert.notEqual(invalid.status, 127, "ancestry verifier is missing");
  assert.match(invalid.stderr, /not reachable from origin\/main/);
});

test("deployment verifies and backs up before stopping web", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-deploy-test-"));
  const trace = path.join(temp, "trace");
  const harness = `
    source "$1"
    trace="$2"
    record() { printf '%s\\n' "$1" >> "$trace"; }
    acquire_lock() { record lock; }
    verify_preconditions() { record preflight; }
    verify_main_ancestry() { record ancestry; }
    current_deployed_sha() { record previous >&2; printf '%s\\n' "fedcba9876543210fedcba9876543210fedcba98"; }
    backup_database() { record backup; }
    prepare_storage_permissions() { record permissions; }
    stop_web() { record stop; }
    checkout_commit() { record checkout; }
    build_commit() { record build; }
    run_migrations() { record migrate; }
    start_web() { record start; }
    wait_for_health() { record health; }
    wait_for_personalizer() { record personalizer; }
    record_deployed_sha() { record marker; }
    prune_artifacts() { record prune; }
    rollback_application() { record rollback; }
    deploy_sha "$3"
  `;
  const result = runBash(harness, [trace, sha40]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(trace, "utf8").trim().split("\n"), [
    "lock",
    "preflight",
    "ancestry",
    "previous",
    "backup",
    "permissions",
    "stop",
    "checkout",
    "build",
    "migrate",
    "start",
    "health",
    "personalizer",
    "marker",
    "prune",
  ]);
});

test("failed health check rolls back application without restoring database", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-deploy-test-"));
  const trace = path.join(temp, "trace");
  const harness = `
    source "$1"
    trace="$2"
    record() { printf '%s\\n' "$1" >> "$trace"; }
    acquire_lock() { record lock; }
    verify_preconditions() { record preflight; }
    verify_main_ancestry() { record ancestry; }
    current_deployed_sha() { printf '%s\\n' "fedcba9876543210fedcba9876543210fedcba98"; }
    backup_database() { record backup; }
    prepare_storage_permissions() { record permissions; }
    stop_web() { record stop; }
    checkout_commit() { record checkout; }
    build_commit() { record build; }
    run_migrations() { record migrate; }
    start_web() { record start; }
    wait_for_health() { record health; return 1; }
    record_deployed_sha() { record marker; }
    prune_artifacts() { record prune; }
    rollback_application() { record rollback; }
    deploy_sha "$3"
  `;
  const result = runBash(harness, [trace, sha40]);
  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readFileSync(trace, "utf8").trim().split("\n"), [
    "lock",
    "preflight",
    "ancestry",
    "backup",
    "permissions",
    "stop",
    "checkout",
    "build",
    "migrate",
    "start",
    "health",
    "rollback",
    "prune",
  ]);
  assert.doesNotMatch(fs.readFileSync(trace, "utf8"), /restore/i);
});

test("rollback_application propagates checkout failure and never writes a marker", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-rollback-test-"));
  const trace = path.join(temp, "trace");
  const harness = `
    source "$1"
    trace="$2"
    git() { printf 'checkout\\n' >> "$trace"; return 1; }
    record_deployed_sha() { printf 'marker\\n' >> "$trace"; }
    wait_for_health() { printf 'health\\n' >> "$trace"; return 1; }
    set +e
    rollback_application "$3"
    rollback_status=$?
    set -e
    printf '%s\\n' "$rollback_status"
  `;
  const result = runBash(harness, [trace, sha40]);
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(Number(result.stdout.trim().split("\n").at(-1)), 0);
  assert.deepEqual(fs.readFileSync(trace, "utf8").trim().split("\n"), ["checkout"]);
});

test("wait_for_health accepts a running legacy container with healthy HTTP", () => {
  const harness = `
    source "$1"
    docker() {
      if [[ "$*" == *'.State.Health'* ]]; then printf '\\n'; else printf 'running\\n'; fi
    }
    curl() { return 0; }
    sleep() { return 0; }
    wait_for_health
  `;
  const result = runBash(harness);
  assert.equal(result.status, 0, result.stderr);
});

test("automatic application start includes personalizer but never the mail worker", () => {
  const result = runBash(`
    source "$1"
    OUTREACH_COMPOSE_FILE="$3"
    compose() { printf '%s\n' "$*"; }
    start_web "$2"
  `, [sha40, path.join(root, "docker-compose.prod.yml")]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /up -d --no-deps web personalizer/);
  assert.doesNotMatch(result.stdout, /\bworker\b/);
});

test("application rollback can start a compose revision from before personalizer existed", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-compose-test-"));
  const composeFile = path.join(temp, "docker-compose.prod.yml");
  fs.writeFileSync(composeFile, "services:\n  web:\n    image: example\n");
  const result = runBash(`
    source "$1"
    OUTREACH_COMPOSE_FILE="$3"
    compose() { printf '%s\n' "$*"; }
    start_web "$2"
  `, [sha40, composeFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /up -d --no-deps web$/m);
  assert.doesNotMatch(result.stdout, /personalizer/);
});

test("personalizer health check requires its container to remain running", () => {
  const healthy = runBash(`
    source "$1"
    docker() { printf 'true\n'; }
    sleep() { return 0; }
    wait_for_personalizer
  `);
  assert.equal(healthy.status, 0, healthy.stderr);

  const stopped = runBash(`
    source "$1"
    docker() { printf 'false\n'; }
    sleep() { return 0; }
    wait_for_personalizer
  `);
  assert.notEqual(stopped.status, 0);
  assert.match(stopped.stderr, /personalizer health check failed/);
});

test("termination after web stop invokes rollback and retention", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-signal-test-"));
  const trace = path.join(temp, "trace");
  const harness = `
    source "$1"
    trace="$2"
    record() { printf '%s\\n' "$1" >> "$trace"; }
    acquire_lock() { record lock; }
    verify_preconditions() { record preflight; }
    verify_main_ancestry() { record ancestry; }
    current_deployed_sha() { printf '%s\\n' "fedcba9876543210fedcba9876543210fedcba98"; }
    backup_database() { record backup; }
    prepare_storage_permissions() { record permissions; }
    stop_web() { record stop; }
    checkout_commit() { record checkout; kill -TERM "$$"; }
    rollback_application() { record rollback; }
    prune_artifacts() { record prune; }
    deploy_sha "$3"
  `;
  const result = runBash(harness, [trace, sha40]);
  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readFileSync(trace, "utf8").trim().split("\n"), [
    "lock",
    "preflight",
    "ancestry",
    "backup",
    "permissions",
    "stop",
    "checkout",
    "rollback",
    "prune",
  ]);
});

test("failed database backup removes its incomplete temporary file", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-backup-test-"));
  const harness = `
    source "$1"
    OUTREACH_BACKUP_DIR="$2"
    docker() { return 1; }
    set +e
    backup_database
    backup_status=$?
    set -e
    printf '%s\\n' "$backup_status"
  `;
  const result = runBash(harness, [temp]);
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(Number(result.stdout.trim().split("\n").at(-1)), 0);
  assert.deepEqual(fs.readdirSync(temp), []);
});

test("prune_artifacts leaves unrelated files alone when no backups exist", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-prune-test-"));
  const backups = path.join(temp, "backups");
  fs.mkdirSync(backups);
  for (let index = 0; index < 10; index += 1) {
    fs.writeFileSync(path.join(temp, `unrelated-${index}`), "keep");
  }

  const harness = `
    source "$1"
    cd "$2"
    OUTREACH_BACKUP_DIR="$3"
    docker() { return 0; }
    prune_artifacts
  `;
  const result = runBash(harness, [temp, backups]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readdirSync(temp).filter((entry) => entry.startsWith("unrelated-")).length,
    10,
  );
});
