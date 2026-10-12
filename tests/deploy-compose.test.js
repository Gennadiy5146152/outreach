import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function productionConfig() {
  const output = execFileSync(
    "docker",
    ["compose", "--profile", "worker", "-f", "docker-compose.prod.yml", "config", "--format", "json"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        OUTREACH_ENV_FILE: ".env.example",
        OUTREACH_STORAGE_DIR: path.join(root, "storage"),
        OUTREACH_IMAGE_TAG: "test-sha",
      },
    },
  );
  return JSON.parse(output);
}

test("production compose preserves runtime identity", () => {
  const config = productionConfig();
  assert.equal(config.name, "outreach-desk");
  assert.ok(config.services.postgres);
  assert.equal(config.volumes.postgres_data.name, "outreach-desk_postgres_data");

  const storage = config.services.web.volumes.find((volume) => volume.target === "/app/storage");
  assert.deepEqual(storage, {
    type: "bind",
    source: path.join(root, "storage"),
    target: "/app/storage",
  });
});

test("worker requires an explicit profile", () => {
  const config = productionConfig();
  assert.deepEqual(config.services.worker.profiles, ["worker"]);
});

test("application services use one immutable image", () => {
  const config = productionConfig();
  const appServices = ["migrate", "web", "worker"].map((name) => config.services[name]);
  assert.deepEqual(
    appServices.map((service) => service.image),
    ["outreach-desk-app:test-sha", "outreach-desk-app:test-sha", "outreach-desk-app:test-sha"],
  );

  for (const service of appServices) {
    const sourceMount = service.volumes?.find((volume) => volume.target === "/app" && volume.source !== path.join(root, "storage"));
    assert.equal(sourceMount, undefined);
  }
});

test("Docker build excludes runtime data", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const ignored = new Set(
    fs.readFileSync(path.join(root, ".dockerignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );

  assert.match(dockerfile, /RUN npm ci --omit=dev/);
  assert.match(dockerfile, /USER node/);
  for (const entry of [".git", ".env*", "node_modules", "storage", "tests", "docs"]) {
    assert.ok(ignored.has(entry), `expected ${entry} in .dockerignore`);
  }
});
