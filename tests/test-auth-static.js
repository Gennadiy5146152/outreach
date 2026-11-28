import fs from "node:fs";

const server = fs.readFileSync("src/server.js", "utf8");
const auth = fs.readFileSync("src/http/auth.js", "utf8");
const env = fs.readFileSync("src/config/env.js", "utf8");
const login = fs.readFileSync("public/login.html", "utf8")+fs.readFileSync("public/cabinet-auth.js", "utf8");

for (const expected of [
  "AUTH_COOKIE",
  "requireAuth",
  "app.post(\"/api/auth/login\"",
  "app.post(\"/api/auth/logout\"",
  "HttpOnly; SameSite=Lax",
  "startsWith(\"/t/open/\")",
]) {
  if (!`${server}\n${auth}`.includes(expected)) throw new Error(`auth server code missing ${expected}`);
}

if (server.indexOf("app.use(requireAuth)") > server.indexOf("app.use(express.static")) {
  throw new Error("static files must be registered after auth middleware");
}

for (const expected of ["authUser", "authPassword", "authSessionSecret"]) {
  if (!env.includes(expected)) throw new Error(`env config missing ${expected}`);
}

if (!login.includes("/api/auth/login")) {
  throw new Error("login page should post to auth endpoint");
}

for (const forbidden of ["AUTH_USER", "AUTH_PASSWORD", "AUTH_SESSION_SECRET", ".env"]) {
  if (login.includes(forbidden)) {
    throw new Error(`login page should not expose technical auth setup: ${forbidden}`);
  }
}



// Cabinet users do not have an administrator cookie. Every transitive browser
// module must be served by the account-page routes before the global admin gate.
const publicRouteBlock=server.slice(server.indexOf('// Private account pages'),server.indexOf('app.get("/cabinet-admin"'));
const files=new Set();
function visit(file){
 if(files.has(file))return;files.add(file);
 const source=fs.readFileSync('public/'+file,'utf8');
 for(const match of source.matchAll(/\bimport\s+[^;]*?from\s*['"]\.\/([^'"]+)['"]/g))visit(match[1]);
}
visit('cabinet.js');visit('cabinet-auth.js');
for(const file of files)if(!publicRouteBlock.includes(JSON.stringify(file)))throw new Error(`Cabinet browser dependency requires public account route: ${file}`);

console.log("OK: auth and transitive cabinet browser routes passed");
