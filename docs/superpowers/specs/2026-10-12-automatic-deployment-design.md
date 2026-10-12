# Outreach automatic deployment design

## Status

Approved in conversation on 2026-10-12.

## Goal

Automatically deploy every tested commit pushed to `main` in
`Gennadiy5146152/outreach` to the existing server at `213.171.10.147`, while
preserving the current PostgreSQL data, server-side secrets, and attachment
storage. A short application interruption of roughly 10–30 seconds is
acceptable.

## Current state

- The application is checked out at `/root/outreach` on the server.
- Docker 24 and Docker Compose v2.35 are installed.
- Compose project `outreach-desk` currently runs `web` and `postgres`.
- PostgreSQL data is stored in the existing named volume owned by the Compose
  project.
- Application secrets are stored in `/root/outreach/.env`.
- Attachments are stored below `/root/outreach/storage` and mounted at
  `/app/storage`.
- The application is currently exposed on port 3000, and PostgreSQL on port
  55432. Network exposure is deliberately unchanged by this deployment work.
- The server filesystem is 87% full, so deployment artifacts and backups need
  explicit retention.
- The outreach worker is not currently running. Deployments must preserve that
  state to prevent automatic email delivery without a separate approval.

## Selected approach

Use GitHub Actions for validation and orchestration, plus a dedicated SSH key
that is restricted on the server to one root-owned deployment command. The
server builds and starts the exact commit requested by the workflow.

This approach was selected over GitHub Container Registry because it requires
less registry and credential setup for the current single server. It was
selected over a self-hosted runner because a runner would add a long-lived,
high-privilege service to a resource-constrained server.

## Repository changes

The repository will contain:

- `.github/workflows/deploy.yml` for tests and deployment from `main`;
- `docker-compose.prod.yml` for immutable application containers;
- a production-ready `Dockerfile` and `.dockerignore`;
- `deploy/outreach-deploy.sh`, installed root-owned on the server;
- deployment documentation covering bootstrap, secrets, rollback, and worker
  activation.

The production Compose file will use the existing project name
`outreach-desk`, existing PostgreSQL volume, `/root/outreach/.env`, and the
existing attachment storage path. It will not bind-mount application source or
install npm packages when a container starts.

The default production deployment includes PostgreSQL, the one-shot migration
service, and web. The worker is behind an explicit Compose profile and is not
started by the deployment script.

## GitHub workflow

The workflow triggers on pushes to `main` and supports manual dispatch for
recovery. It will:

1. Check out the triggering commit.
2. Install the locked dependency graph with `npm ci`.
3. Run `npm run check`.
4. Build the production image as an additional validation step.
5. After all checks pass, open the restricted SSH connection and request a
   deployment of the triggering commit SHA.
6. Fail unless the server-side command completes successfully.

The workflow will use a concurrency group so a newer run cancels a queued older
run without allowing two server deployments at once. It will have explicit
timeouts and minimal repository permissions.

Required GitHub Actions secrets are limited to SSH transport data:

- `OUTREACH_DEPLOY_HOST`
- `OUTREACH_DEPLOY_USER`
- `OUTREACH_DEPLOY_KEY`
- `OUTREACH_DEPLOY_KNOWN_HOSTS`

Application, database, authentication, MCP, and mailbox credentials remain
only in the server-side `.env`.

## Restricted SSH access

A new key pair will be generated only for GitHub Actions. Its public key entry
in the target account's `authorized_keys` will use a forced command and disable
PTY allocation, agent forwarding, port forwarding, X11 forwarding, and user
commands.

The forced command will call the root-owned deploy entry point. The entry point
accepts only a command shaped as `deploy <40-or-64-character-hex-SHA>`. It must
reject malformed input and ignore arbitrary shell text. The private key is
stored only as a GitHub Actions secret.

## Server deployment transaction

The root-owned deployment script will:

1. Acquire an exclusive `flock`; a concurrent deployment fails cleanly.
2. Validate the requested SHA as hexadecimal input.
3. Fetch `origin main` and confirm the requested commit is an ancestor of the
   fetched `origin/main`.
4. Record the currently deployed commit for rollback.
5. Verify that `.env`, attachment storage, and the existing PostgreSQL volume
   are present.
6. Create a timestamped compressed PostgreSQL dump and verify that it is
   non-empty.
7. Stop only the web container, leaving PostgreSQL running.
8. Switch the checkout to the exact requested commit without deleting untracked
   environment backup files.
9. Build the production image tagged with the requested SHA.
10. Run migrations as a one-shot service.
11. Start web from the newly built image.
12. Wait for the container health check and request `/api/health` locally.
13. Record the deployed SHA only after successful health verification.
14. Prune only obsolete Outreach images and old deployment backups, retaining
    enough artifacts for a rollback while respecting current disk pressure.

The script never starts the worker.

## Failure and rollback behavior

Any failure produces a non-zero exit code so GitHub marks the deployment as
failed. If failure occurs after the previous web container has been stopped,
the script rebuilds or starts the previously recorded application commit and
repeats the health check.

Database rollback is not automatic. Migrations are expected to be
forward-compatible and transactional where PostgreSQL permits. The pre-deploy
dump is retained for deliberate manual recovery because restoring it
automatically could erase valid data created during the deployment window.

If rollback also fails, PostgreSQL remains running and the script reports both
the original and rollback errors in the GitHub Actions log.

## Data and secret safety

- `.env` is never committed, copied to Actions, or printed.
- Deployment output must not run commands that dump container environments.
- The existing Compose project name is fixed so Docker does not create a new,
  empty PostgreSQL volume.
- The attachment directory is mounted into the same container path after the
  production Compose transition.
- The existing untracked `.env.save` remains untouched.
- The first production transition records volume and storage identity before
  stopping web and verifies both after startup.

## Verification and acceptance

Before enabling automatic deployments:

1. Validate Compose configuration without printing environment values.
2. Run the complete repository check suite locally and in GitHub Actions.
3. Create and validate a PostgreSQL backup.
4. Deploy the currently running commit through the new script.
5. Confirm `/api/health`, web container health, PostgreSQL health, attachment
   mount, and the deployed commit marker.
6. Confirm that no worker container is running.
7. Push a harmless repository change to `main` and confirm the workflow deploys
   it automatically.
8. Confirm old backups/images are retained according to policy and disk usage
   does not increase without bounds.

The deployment is accepted when a push to `main` reaches a healthy web service
without exposing application secrets, changing the PostgreSQL volume, losing
attachments, or starting the worker.

## Deferred work

The following are explicitly outside this change:

- moving Outreach behind the existing Traefik instance and adding a domain;
- closing the publicly bound PostgreSQL port;
- moving deployment away from the root account to a dedicated system user;
- enabling the worker or sending any email;
- automatic database restoration;
- server-wide Docker cleanup unrelated to Outreach.

These can be handled separately after the deployment path is stable.
