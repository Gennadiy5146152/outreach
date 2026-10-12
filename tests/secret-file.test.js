import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("saveSecretToDotenv writes the configured persistent secret file", async () => {
  const { saveSecretToDotenv } = await import("../src/services/secret-file.js");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "outreach-secret-file-"));
  const secretFile = path.join(temp, "runtime.env");

  await fs.writeFile(secretFile, "EXISTING=value\n");
  const key = await saveSecretToDotenv("MAILBOX_TEAM_EXAMPLE_PASSWORD", 'pa"ss\\word', {
    filePath: secretFile,
  });

  assert.equal(key, "MAILBOX_TEAM_EXAMPLE_PASSWORD");
  assert.equal(
    await fs.readFile(secretFile, "utf8"),
    'EXISTING=value\nMAILBOX_TEAM_EXAMPLE_PASSWORD="pa\\"ss\\\\word"\n',
  );
  assert.equal(process.env.MAILBOX_TEAM_EXAMPLE_PASSWORD, 'pa"ss\\word');
});
