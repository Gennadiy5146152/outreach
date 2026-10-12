# Production deployment

Every push to `main` is validated by `.github/workflows/deploy.yml`. After the
checks and Docker build pass, GitHub Actions requests deployment of the exact
commit SHA through a restricted SSH key.

The deployment restarts only `web`. It never starts `worker`, never restores a
database dump automatically, and never copies application secrets to GitHub.

## Server layout

| Purpose | Path |
| --- | --- |
| Git checkout and server `.env` | `/root/outreach` |
| Attachment storage | `/root/outreach/storage` |
| Mailbox secrets written by the web UI | `/root/outreach/storage/runtime.env` |
| Root-owned deploy entry point | `/usr/local/sbin/outreach-deploy` |
| Current and previous SHA markers | `/var/lib/outreach-deploy` |
| Compressed PostgreSQL backups | `/var/backups/outreach` |
| Deployment lock | `/var/lock/outreach-deploy.lock` |

The Compose project name is fixed as `outreach-desk`, so the production stack
continues to use the existing `outreach-desk_postgres_data` volume.
The main `.env` remains root-managed. Passwords added or changed in the web UI
are written to the persistent `runtime.env`, which is loaded after `.env` on
every container start and is never copied into the image.

## One-time server bootstrap

Install the reviewed script from the checkout without displaying `.env`:

```bash
install -o root -g root -m 0755 \
  /root/outreach/deploy/outreach-deploy.sh \
  /usr/local/sbin/outreach-deploy
install -d -o root -g root -m 0700 \
  /var/lib/outreach-deploy \
  /var/backups/outreach
touch /var/lock/outreach-deploy.lock
chown root:root /var/lock/outreach-deploy.lock
chmod 0600 /var/lock/outreach-deploy.lock
```

Generate a dedicated Ed25519 key outside the repository. Add only its public
key to `/root/.ssh/authorized_keys` in this form:

```text
restrict,command="/usr/local/sbin/outreach-deploy" ssh-ed25519 AAAA... outreach-github-actions
```

`restrict` disables PTY allocation, forwarding, X11, agent use, and arbitrary
commands. The forced command accepts only `deploy <40-or-64-character SHA>` and
then verifies that the commit is reachable from `origin/main`.

## GitHub Actions secrets

Configure these repository secrets:

| Secret | Value |
| --- | --- |
| `OUTREACH_DEPLOY_HOST` | Production SSH host |
| `OUTREACH_DEPLOY_USER` | Restricted key account, currently `root` |
| `OUTREACH_DEPLOY_KEY` | Dedicated private Ed25519 key |
| `OUTREACH_DEPLOY_KNOWN_HOSTS` | Already trusted OpenSSH known-hosts line |

Use `gh secret set NAME < file` or stdin so private material is not passed as a
command-line argument. Do not put `.env`, database, authentication, MCP, or
mailbox secrets in GitHub Actions.

## Normal operation

A push to `main` runs:

1. `npm ci` and `npm run check`;
2. a production Docker image build in GitHub Actions;
3. the restricted server command for the event SHA;
4. a server-side PostgreSQL backup;
5. server image build, migrations, web restart, and `/api/health` check.

Only a successful health check updates
`/var/lib/outreach-deploy/current-sha`. Backups retain the seven newest files;
the two newest tagged Outreach images are retained for application rollback.

Inspect runs and server logs with:

```bash
gh run list --workflow deploy.yml
gh run view RUN_ID --log
docker logs --tail 200 outreach-desk-web-1
curl -fsS http://127.0.0.1:3000/api/health
```

Run the workflow manually from the `main` branch when recovery requires it:

```bash
gh workflow run deploy.yml --ref main
```

## Application rollback

Choose a known-good commit that is still reachable from `origin/main`, then
run the same guarded transaction locally on the server:

```bash
/usr/local/sbin/outreach-deploy deploy COMMIT_SHA
```

The command creates another database backup before switching the application.
It does not reverse schema migrations. Prefer forward-compatible migrations.

## Deliberate database restore

Database restoration is intentionally manual because it replaces current
data. First preserve the current database with a new dump, stop application
writers, and confirm the target backup path. A typical recovery sequence is:

```bash
docker stop outreach-desk-web-1
docker stop outreach-desk-worker-1 2>/dev/null || true
docker exec outreach-desk-postgres-1 \
  sh -ceu 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip -c > /var/backups/outreach/before-manual-restore.sql.gz
gunzip -c /var/backups/outreach/SELECTED_BACKUP.sql.gz \
  | docker exec -i outreach-desk-postgres-1 \
      sh -ceu 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'
```

Only perform this after reviewing the SQL recovery requirements for the
specific incident. A plain `psql` import does not remove conflicting current
objects automatically.

## Worker activation requires separate approval

Automatic deployment deliberately leaves `worker` stopped. Starting it can
send queued emails when real sending is enabled. After explicit approval and a
queue review, activate it separately:

```bash
cd /root/outreach
OUTREACH_IMAGE_TAG="$(cat /var/lib/outreach-deploy/current-sha)" \
OUTREACH_ENV_FILE=/root/outreach/.env \
OUTREACH_STORAGE_DIR=/root/outreach/storage \
docker compose \
  -p outreach-desk \
  --env-file /root/outreach/.env \
  -f docker-compose.prod.yml \
  --profile worker \
  up -d --no-deps worker
```

Stop it without changing the deployment configuration:

```bash
docker stop outreach-desk-worker-1
```
