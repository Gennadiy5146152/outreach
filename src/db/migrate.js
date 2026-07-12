import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, withClient } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.resolve(__dirname, "../../db/migrations");

async function migrate() {
  const files = (await fs.readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();

  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      for (const file of files) {
        const exists = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [file]);
        if (exists.rowCount) continue;
        const sql = await fs.readFile(path.join(migrationDir, file), "utf8");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(id) VALUES ($1)", [file]);
        console.log(`Applied migration ${file}`);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

migrate()
  .then(async () => {
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exit(1);
  });
