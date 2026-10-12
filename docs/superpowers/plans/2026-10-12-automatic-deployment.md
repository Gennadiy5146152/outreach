# Outreach Automatic Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy every tested push to `main` to the existing Outreach server through a restricted SSH command, with database backup, application rollback, and no automatic worker startup.

**Architecture:** GitHub Actions validates the Node application and Docker image, then requests deployment of an exact commit SHA over a forced-command SSH key. A root-owned server script verifies the SHA against `origin/main`, backs up PostgreSQL, builds and starts an immutable production web container, checks health, and rolls the application back on failure while preserving the existing database volume, `.env`, and attachment directory.

**Tech Stack:** GitHub Actions, Bash, Docker 24, Docker Compose v2, Node.js 22, PostgreSQL 16, OpenSSH, Node built-in test runner

**Spec:** `docs/superpowers/specs/2026-10-12-automatic-deployment-design.md`

## Global Constraints

- Trigger deployment only for tested pushes to `main`; allow manual recovery dispatch.
- Keep server secrets exclusively in `/root/outreach/.env` and never print them.
- Preserve Compose project name `outreach-desk`, its PostgreSQL volume, and `/root/outreach/storage`.
- Accept 10–30 seconds of web downtime while keeping PostgreSQL running.
- Never start the worker during automatic deployment.
- Never automatically restore a database dump.
- Retain bounded backups and Outreach images because the server filesystem is already 87% full.
- Do not change the current application or PostgreSQL port exposure in this change.

## Review Focus

- Malformed or shell-injection-shaped SSH commands must be rejected before any Git or Docker command runs; Task 2 tests valid and hostile command forms.
- A syntactically valid SHA not reachable from `origin/main` must fail without stopping web; Task 2's fake-command integration test pins operation order.
- A migration or health-check failure after web stops must return to the previous commit and healthy web service; Task 2 tests rollback invocation and failure reporting.
- A deployment must never start worker implicitly, including Compose dependency expansion; Tasks 1 and 2 statically assert the worker profile and exact web-only startup command.
- First deployment from the legacy bind-mounted container must preserve database volume, attachment identity, and provide a legacy rollback path; Tasks 2 and 4 verify these preconditions and the transition.

---

### Task 1: Production container runtime

**Files:**
- Create: `.dockerignore`
- Create: `docker-compose.prod.yml`
- Create: `tests/deploy-compose.test.js`
- Modify: `Dockerfile`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing `.env` keys, Docker volume `outreach-desk_postgres_data`, and host directory `/root/outreach/storage`.
- Produces: image `outreach-desk-app:${OUTREACH_IMAGE_TAG}`, Compose services `postgres`, `migrate`, `web`, and profile-gated `worker`.

- [ ] **Step 1: Write the failing production-Compose tests**

Add Node tests named `production compose preserves runtime identity`, `worker requires an explicit profile`, `application services use one immutable image`, and `Docker build excludes runtime data`. Assert project name `outreach-desk`, existing volume semantics, absolute configurable `.env`/storage paths with current-server defaults, no application source bind mount, `worker` profile `worker`, and locked dependency installation in the Dockerfile.

- [ ] **Step 2: Run the deployment Compose tests and verify failure**

Run: `node --test tests/deploy-compose.test.js`

Expected: FAIL because `docker-compose.prod.yml` and `.dockerignore` do not exist and the Dockerfile uses `npm install`.

- [ ] **Step 3: Implement the immutable application image**

Update `Dockerfile` to install locked production dependencies with `npm ci --omit=dev`, copy application files, run as the bundled non-root Node user, and start `src/server.js`. Add `.dockerignore` entries for Git metadata, `.env*`, `node_modules`, storage, tests, and documentation. The server transition must change the storage tree to UID/GID `1000:1000` before starting this image; the legacy root-run container remains able to read it during rollback.

- [ ] **Step 4: Implement `docker-compose.prod.yml`**

Define the four produced services, reuse `outreach-desk-app:${OUTREACH_IMAGE_TAG:-local}` for application services, preserve the database volume/project identity, mount `${OUTREACH_STORAGE_DIR:-/root/outreach/storage}` at `/app/storage`, load `${OUTREACH_ENV_FILE:-/root/outreach/.env}`, give web a Node-based `/api/health` healthcheck, and put only worker behind `profiles: [worker]`.

- [ ] **Step 5: Register and run the tests**

Add `node --test tests/deploy-compose.test.js` to `npm run check`, then run `node --test tests/deploy-compose.test.js && OUTREACH_ENV_FILE=.env.example OUTREACH_STORAGE_DIR="$PWD/storage" docker compose -f docker-compose.prod.yml config --quiet`.

Expected: all tests PASS and Compose exits 0 without printing resolved secret values.

- [ ] **Step 6: Commit the runtime**

```bash
git add Dockerfile .dockerignore docker-compose.prod.yml tests/deploy-compose.test.js package.json
git commit -m "feat: add production outreach runtime"
```

### Task 2: Restricted server deployment transaction

**Files:**
- Create: `deploy/outreach-deploy.sh`
- Create: `tests/deploy-script.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: either arguments `deploy <sha>` or forced-SSH value `SSH_ORIGINAL_COMMAND="deploy <sha>"`; configurable test paths `OUTREACH_DIR`, `OUTREACH_BACKUP_DIR`, `OUTREACH_STATE_DIR`, and `OUTREACH_LOCK_FILE`.
- Produces: exit status, timestamped `.sql.gz` backup, current/previous SHA markers, `outreach-desk-app:<sha>`, and a healthy `web` service.

- [ ] **Step 1: Write failing parser and orchestration tests**

Add Node tests that source the script in library-only mode and assert `parse_requested_sha` accepts only `deploy` plus a lowercase/uppercase 40- or 64-character hexadecimal SHA. Reject empty input, extra arguments, separators, command substitutions, paths, and option-like values. Add a fake-command integration test asserting fetch/reachability checks and backup occur before web stop, startup targets only `web`, and failed health invokes rollback without database restore.

- [ ] **Step 2: Run the deployment-script tests and verify failure**

Run: `node --test tests/deploy-script.test.js`

Expected: FAIL because `deploy/outreach-deploy.sh` does not exist.

- [ ] **Step 3: Implement input, locking, and preflight functions**

Implement Bash functions `parse_requested_sha(command_text)`, `acquire_lock()`, `verify_preconditions(sha)`, `verify_main_ancestry(sha)`, and `prepare_storage_permissions()`. Reset `PATH`, use `set -Eeuo pipefail`, refuse tracked server changes, validate storage/environment/volume presence, set the storage tree to UID/GID `1000:1000` for the non-root image, and do not source or echo `.env`.

- [ ] **Step 4: Implement backup and deployment functions**

Implement `backup_database()`, `build_commit(sha)`, `run_migrations(sha)`, `start_web(sha)`, and `wait_for_health()`. Use the running PostgreSQL container's internal `POSTGRES_USER`/`POSTGRES_DB` for a compressed dump; use `OUTREACH_IMAGE_TAG=<sha>` and exact web-only Compose commands.

- [ ] **Step 5: Implement rollback and retention functions**

Implement `rollback_application(previous_sha)`, including the first-transition legacy Compose fallback, and `prune_artifacts()`. Never restore PostgreSQL automatically; retain the seven newest backups and two newest Outreach application images.

- [ ] **Step 6: Wire `main()` and rerun tests**

Support direct invocation and forced SSH, log timestamps without secrets, preserve `.env.save`, write the current marker only after successful health, and report both deployment and rollback failures.

Run: `node --test tests/deploy-script.test.js && bash -n deploy/outreach-deploy.sh`

Expected: all tests PASS and Bash syntax check exits 0.

- [ ] **Step 7: Register and commit the deploy transaction**

Add `node --test tests/deploy-script.test.js` to `npm run check`, rerun both new test files, then commit.

```bash
git add deploy/outreach-deploy.sh tests/deploy-script.test.js package.json
git commit -m "feat: add guarded server deployment"
```

### Task 3: GitHub Actions deployment workflow

**Files:**
- Create: `.github/workflows/deploy.yml`
- Create: `tests/deploy-workflow.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: GitHub event SHA and secrets `OUTREACH_DEPLOY_HOST`, `OUTREACH_DEPLOY_USER`, `OUTREACH_DEPLOY_KEY`, `OUTREACH_DEPLOY_KNOWN_HOSTS`.
- Produces: one serialized request `deploy <github.sha>` to the forced SSH command after checks and image validation pass.

- [ ] **Step 1: Write the failing workflow policy tests**

Add tests named `workflow deploys only main and manual dispatch`, `workflow validates before deploy`, `workflow pins host verification`, `workflow grants read-only contents`, and `workflow serializes production deployments`. Assert no `StrictHostKeyChecking=no`, no application secrets, checkout/setup-node official actions, `npm ci`, `npm run check`, `docker build`, exact SHA request, timeouts, minimal permissions, and concurrency.

- [ ] **Step 2: Run the workflow tests and verify failure**

Run: `node --test tests/deploy-workflow.test.js`

Expected: FAIL because `.github/workflows/deploy.yml` does not exist.

- [ ] **Step 3: Implement the validate job**

Create the workflow with push-to-main and manual triggers, `contents: read`, Node 22 cache, `npm ci`, `npm run check`, and a production Docker build tagged with the event SHA.

- [ ] **Step 4: Implement the deploy job**

Make it depend on validation, materialize the private key and known-hosts secrets into mode-restricted temporary files, call OpenSSH with `IdentitiesOnly=yes` and strict host checking, request only `deploy ${GITHUB_SHA}`, and remove key material in an `always()` cleanup step.

- [ ] **Step 5: Register, verify, and commit the workflow**

Add the workflow test to `npm run check` and run `node --test tests/deploy-workflow.test.js && npm run check`.

Expected: workflow policy tests and the full repository suite PASS.

```bash
git add .github/workflows/deploy.yml tests/deploy-workflow.test.js package.json
git commit -m "ci: deploy tested main commits"
```

### Task 4: Bootstrap and operations documentation

**Files:**
- Create: `deploy/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the deploy script/workflow from Tasks 2–3 and existing authenticated local SSH/GitHub CLI sessions.
- Produces: installed `/usr/local/sbin/outreach-deploy`, a forced-command authorized key, four GitHub Actions secrets, and operator recovery instructions.

- [ ] **Step 1: Document bootstrap and recovery**

Document server paths, exact installation ownership/modes, secret names, forced-key options, normal logs, manual workflow dispatch, application rollback, deliberate database restore, retention, and the separate command required to activate the worker profile.

- [ ] **Step 2: Link deployment documentation from the main README**

Add a concise production deployment section that points to `deploy/README.md`, states that pushes to `main` deploy automatically after checks, and warns that worker activation is not automatic.

- [ ] **Step 3: Run documentation/static verification and commit**

Run: `git diff --check && npm run check`

Expected: no whitespace errors and the full repository suite PASS.

```bash
git add deploy/README.md README.md docs/superpowers/specs/2026-10-12-automatic-deployment-design.md docs/superpowers/plans/2026-10-12-automatic-deployment.md
git commit -m "docs: describe outreach deployment operations"
```

- [ ] **Step 4: Install the server entry point**

Copy the reviewed script to `/usr/local/sbin/outreach-deploy` as root with owner `root:root` and mode `0755`; create root-owned state, backup, and lock locations without changing `.env` or storage.

- [ ] **Step 5: Create and restrict the deploy key**

Generate an ephemeral Ed25519 key pair locally, append its public key to root's `authorized_keys` with `restrict,command="/usr/local/sbin/outreach-deploy"`, and verify an arbitrary command is rejected.

- [ ] **Step 6: Configure GitHub Actions secrets**

Use authenticated `gh secret set` with stdin for all four secret values. Obtain the known-hosts value from the already trusted local SSH host entry; never display the private key or add it to the repository.

### Task 5: Production transition and end-to-end verification

**Files:**
- Modify only generated Git/GitHub/server state; no additional source file is expected.

**Interfaces:**
- Consumes: completed commits, installed forced command, GitHub secrets, current healthy server.
- Produces: pushed `main`, successful GitHub Actions run, deployed SHA marker, healthy immutable web container, preserved data identities, and removed local ephemeral key material.

- [ ] **Step 1: Record production identities before transition**

Record, without secret values, the PostgreSQL volume name, attachment source path, current commit, health response, absence of worker, and current disk usage.

- [ ] **Step 2: Verify locally before push**

Run: `npm ci && npm run check && docker build -t outreach-desk-app:verification . && OUTREACH_IMAGE_TAG=verification OUTREACH_ENV_FILE=.env.example OUTREACH_STORAGE_DIR="$PWD/storage" docker compose -f docker-compose.prod.yml config --quiet && git diff --check`

Expected: every command exits 0.

- [ ] **Step 3: Push the implementation to `origin/main`**

Run: `git push origin main`

Expected: GitHub accepts the commits and starts the deploy workflow.

- [ ] **Step 4: Observe the workflow to completion**

Use `gh run watch --exit-status` for the triggered deploy run.

Expected: validation and deploy jobs succeed; no secret material appears in logs.

- [ ] **Step 5: Verify production after transition**

Confirm the deployed marker equals remote `main`, `/api/health` succeeds, web and PostgreSQL are healthy, the PostgreSQL volume and attachment source match Step 1, worker is absent, a non-empty compressed backup exists, and disk usage remains safe.

- [ ] **Step 6: Verify automatic deployment with a harmless commit**

Push a documentation-only marker update to `main`, observe the next workflow through success, and confirm the production marker advances to that exact SHA.

- [ ] **Step 7: Remove ephemeral key material and report**

Delete the local temporary deploy private/public key files after GitHub secret installation and successful end-to-end verification. Report the two deployed SHAs, workflow URLs, health evidence, backup path, and any deferred hardening items without revealing secrets.
