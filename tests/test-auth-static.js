import fs from "node:fs";

const server = fs.readFileSync("src/server.js", "utf8");
const env = fs.readFileSync("src/config/env.js", "utf8");
const login = fs.readFileSync("public/login.html", "utf8");

for (const expected of [
  "AUTH_COOKIE",
  "requireAuth",
  "app.post(\"/api/auth/login\"",
  "app.post(\"/api/auth/logout\"",
  "HttpOnly; SameSite=Lax",
  "startsWith(\"/t/open/\")",
]) {
  if (!server.includes(expected)) throw new Error(`auth server code missing ${expected}`);
}

if (server.indexOf("app.use(requireAuth)") > server.indexOf("app.use(express.static")) {
  throw new Error("static files must be registered after auth middleware");
}

for (const expected of ["authUser", "authPassword", "authSessionSecret"]) {
  if (!env.includes(expected)) throw new Error(`env config missing ${expected}`);
}

if (!login.includes("/api/auth/login") || !login.includes("AUTH_USER")) {
  throw new Error("login page should post to auth endpoint and explain env setup");
}

console.log("OK: auth static test passed");
