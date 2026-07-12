const baseUrl = process.env.SMOKE_BASE_URL || "http://localhost:3000";

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${response.statusText}`);
  return response.json();
}

const health = await getJson("/api/health");
if (!health.ok) throw new Error("health check failed");

const dashboard = await getJson("/api/dashboard");
for (const key of ["leads", "messages", "queue", "opens", "replies", "rates"]) {
  if (!(key in dashboard)) throw new Error(`dashboard missing ${key}`);
}

await getJson("/api/sending/progress");
await getJson("/api/warmup");
await getJson("/api/suppressions");
await getJson("/api/settings");
await getJson("/api/env-check");

console.log("smoke ok");
