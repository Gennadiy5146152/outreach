const baseUrl = process.env.SMOKE_BASE_URL || "http://localhost:3000";
let cookie = "";

async function request(path, options = {}) {
  const headers = {
    ...(cookie ? { Cookie: cookie } : {}),
    ...(options.headers || {}),
  };
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}

async function getJson(path) {
  const response = await request(path);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${response.statusText}`);
  return response.json();
}

const health = await getJson("/api/health");
if (!health.ok) throw new Error("health check failed");

const authStatusResponse = await request("/api/auth/status");
const authStatus = await authStatusResponse.json().catch(() => ({}));
if (authStatus.configured && !authStatus.authenticated) {
  const username = process.env.SMOKE_AUTH_USER;
  const password = process.env.SMOKE_AUTH_PASSWORD;
  if (!username || !password) throw new Error("auth enabled; set SMOKE_AUTH_USER and SMOKE_AUTH_PASSWORD");
  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!login.ok) throw new Error(`auth login failed: ${login.status} ${login.statusText}`);
  cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
}

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
