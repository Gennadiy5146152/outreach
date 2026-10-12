import fs from "node:fs/promises";
import path from "node:path";

function formatDotenvValue(value) {
  return `"${String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`;
}

export async function saveSecretToDotenv(key, value, { filePath } = {}) {
  const normalizedKey = String(key || "").trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(normalizedKey)) {
    throw new Error("invalid_password_env_key");
  }

  const resolvedPath = path.resolve(
    filePath || process.env.OUTREACH_SECRETS_FILE || path.resolve(process.cwd(), ".env"),
  );
  const line = `${normalizedKey}=${formatDotenvValue(value)}`;
  let current = "";
  try {
    current = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const lines = current ? current.split(/\r?\n/) : [];
  while (lines.at(-1) === "") lines.pop();
  const index = lines.findIndex((item) => item.trim().startsWith(`${normalizedKey}=`));
  if (index >= 0) lines[index] = line;
  else lines.push(line);

  const body = lines.join("\n");
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, `${body}\n`, { mode: 0o600 });
  await fs.chmod(resolvedPath, 0o600);
  process.env[normalizedKey] = String(value || "");
  return normalizedKey;
}
