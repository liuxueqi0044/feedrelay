# Deployment and local operation

The local memory demo runs with Node 22.12 or later and pnpm 10.32.1:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The demo binds the browser to `127.0.0.1:3000` and the API to `127.0.0.1:4100`. It requires no Telegram credentials and cannot accept real payments. Do not expose these development ports through a public tunnel. Stop it with Ctrl+C; the demo JSON file persists local state.

`deploy/compose.development.yml` also offers a Linux host-network demo profile. Docker Desktop requires host networking to be explicitly enabled; native `pnpm dev` is the normal Windows/macOS route:

```sh
docker compose -f deploy/compose.development.yml --profile demo up --build demo
```

For a separate local PostgreSQL integration database, supply `DEV_POSTGRES_PASSWORD` in your shell and run:

```sh
docker compose -f deploy/compose.development.yml --profile database up -d postgres
```

That database publishes only `127.0.0.1:5432`. An unset password deliberately prevents PostgreSQL from initializing. The memory demo does not use this database.

## Production host

Use a Linux host with Docker Engine and Compose v2. Install from the official vendor instructions, configure the host firewall for SSH, HTTP and HTTPS, and point the domain's DNS at this host. Only Caddy publishes ports; PostgreSQL, Next.js, and the API remain inside Docker networks.

Create a production environment file outside source control, readable only by the operator. In addition to the main application's environment settings, Compose requires `DOMAIN`, `ACME_EMAIL`, `POSTGRES_PASSWORD`, `DATABASE_URL`, and Telegram OIDC credentials. `PUBLIC_URL` must be `https://` plus the public hostname, and `DOMAIN` contains only the hostname. `DATABASE_URL` must use `postgres` as its host, the same `POSTGRES_DB`/`POSTGRES_USER` used by the database, and a URL-encoded password. The defaults for database name and user are both `feedrelay`.

The bot token and OIDC secret are runtime settings. Never pass them as Docker build arguments. Dockerfile-specific ignore files exclude environment files, dependency folders, keys, dumps and local data from the build context. These exclusions follow Docker's documented [Dockerfile-specific ignore behavior](https://docs.docker.com/build/concepts/context/#filename-and-location).

The production services are:

| Service | Responsibility | Telegram bot token |
| --- | --- | --- |
| api | HTTPS application/API, authentication, webhook ingestion | Yes |
| control-worker | Scheduling, permissions, inbox, reconciliation | Yes |
| fetch-worker | Untrusted feed fetching and parsing | **Absent** |
| delivery-worker | Telegram sends and delivery retries | Yes |
| migrate | One-shot database migrations | **Absent** |
| web | Next.js browser application | **Absent** |
| postgres | Persistent database and job state | **Absent** |
| caddy | HTTPS termination and same-origin routing | **Absent** |

The fetch worker uses an explicit environment allowlist. Do not add a shared `env_file` to its service. All application roles still share one application database role in this MVP; the process boundary limits accidental credential exposure but does not isolate a compromised fetch process from database contents.

The web build sets `API_BASE=http://api:4100` and `NEXT_PUBLIC_SITE_URL=${PUBLIC_URL}` as build arguments because Next.js rewrites and public metadata are recorded during the build. Caddy also routes `/api/*` directly to the API. Changing either address requires rebuilding the web image. Caddy uses automatic HTTPS and its standard [reverse proxy forwarding behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy); application authentication and webhook secrets remain required.

Run commands from the repository root, replacing the environment file path below:

```sh
docker compose --env-file /secure/feedrelay-production.env -f deploy/compose.production.yml config --quiet
docker compose --env-file /secure/feedrelay-production.env -f deploy/compose.production.yml build --pull
docker compose --env-file /secure/feedrelay-production.env -f deploy/compose.production.yml up -d postgres
docker compose --env-file /secure/feedrelay-production.env -f deploy/compose.production.yml run --rm migrate
docker compose --env-file /secure/feedrelay-production.env -f deploy/compose.production.yml up -d
docker compose --env-file /secure/feedrelay-production.env -f deploy/compose.production.yml ps
```

API and workers wait for successful migrations. The runtime runs the server with `tsx` from the shared monorepo and uses a frozen pnpm lockfile. Application images run as the unprivileged `node` user with a read-only filesystem; the web cache and temporary files have dedicated writable mounts. Dependency packages and application TypeScript are included at runtime. Record the image digests and tested commit for every release; the supplied Node, PostgreSQL and Caddy tags intentionally receive patch updates when pulled, so a deployment must resolve and record their digests.

Configure Telegram's allowed public website and login redirect according to the application authentication routes, then register the webhook using the application's `bot:setup` command:

```sh
docker compose --env-file /secure/feedrelay-production.env -f deploy/compose.production.yml run --rm --no-deps api pnpm --filter @feedrelay/server bot:setup
```

Use a dedicated production bot. Keep billing disabled until the operator has published the actual terms, configured the support contact, and verified the deployment through the free workflow. No external payment is performed by the build or automated tests.

## Release and rollback

Back up the database before a release. Build and test the commit, record its image digests, then stop workers before applying migrations that change their data contract. Run the one-shot migration, start the API and web, and start workers after health checks and a free test delivery succeed. Monitor worker failures, overdue jobs, feed-fetch error rates, unknown deliveries, rejected precheckouts, and billing events requiring review. The API's `/health/live` is a liveness endpoint; `/healthz` also checks database access. Neither proves a Telegram send or a recovery drill succeeded.

An application image rollback is safe only when its database schema remains compatible. Do not automatically reverse migrations or restore an old database over a running production instance. Use the [recovery runbook](recovery.md) for database loss or incompatible state. Keep at least one previous application image and its digest available.

This repository contains deployable configuration, not a completed production deployment. Compose validation and automated package tests do not establish successful HTTPS issuance, OIDC registration, Telegram permissions, payment processing, or restore times on an operator's host.

## Docker verification handoff — 2026-10-04

Docker Desktop's Linux engine (Docker 29.8.0, Compose 5.5.1) was available. Production Compose configuration validation passed using fake credentials under the unique project `feedrelay-smoke-20261004-15eeabb4`. The actual isolated image build used:

```sh
docker compose -p feedrelay-smoke-20261004-15eeabb4 --env-file work/deploy-smoke/smoke.env -f deploy/compose.production.yml -f work/deploy-smoke/override.yml config --quiet
docker compose -p feedrelay-smoke-20261004-15eeabb4 --env-file work/deploy-smoke/smoke.env -f deploy/compose.production.yml -f work/deploy-smoke/override.yml build api web
```

Frozen dependency installs succeeded in Linux. The server image build then failed during `tsc --noEmit` with syntax errors in `apps/server/src/services/processor.ts` at lines 154, 167, 168, and 169. The web bundle compiled successfully, but its image build was canceled when the server build failed. Neither runtime image was completed. This was a snapshot of files being edited concurrently; rerun against the finalized source after resolving or confirming those syntax errors. No smoke containers, networks, or volumes were created, and no Telegram, OIDC, webhook setup, or payment action was performed. The engine's downloaded build cache was retained.

To continue on a Linux/cloud executor, recreate the temporary `work/deploy-smoke` inputs if they are absent. Use only fake credentials: `PUBLIC_URL=https://smoke.feedrelay.invalid`, a `DATABASE_URL` pointing to Compose host `postgres`, a matching throwaway PostgreSQL password, fake bot/OIDC credentials, a webhook secret of at least 32 characters, and `BILLING_ENABLED=false`. Set `FEEDRELAY_TAG` to the unique smoke project name, `DOMAIN=smoke.feedrelay.invalid`, and `ACME_EMAIL=smoke@example.invalid`. The smoke override must make both `backend` and `egress` networks `internal: true` to prevent external service contact.

After a successful rebuild, finish the isolated smoke check without starting Caddy, control-worker, or delivery-worker:

```sh
docker compose -p feedrelay-smoke-20261004-15eeabb4 --env-file work/deploy-smoke/smoke.env -f deploy/compose.production.yml -f work/deploy-smoke/override.yml up -d postgres api web fetch-worker
docker compose -p feedrelay-smoke-20261004-15eeabb4 --env-file work/deploy-smoke/smoke.env -f deploy/compose.production.yml -f work/deploy-smoke/override.yml ps -a
docker compose -p feedrelay-smoke-20261004-15eeabb4 --env-file work/deploy-smoke/smoke.env -f deploy/compose.production.yml -f work/deploy-smoke/override.yml logs --no-color migrate api web fetch-worker
```

Verify successful one-shot migration completion, API `/healthz` and `/api/config`, the web homepage and its same-origin `/api/config` rewrite, and the absence of `BOT_TOKEN` in the fetch-worker environment. Readiness can be checked with Node `fetch` from within the appropriate containers without publishing a host port. Do not call `bot:setup`, authenticate against Telegram, create deliveries, or buy an invoice during this smoke check. When finished, `docker compose` with exactly this smoke project and these files may run `down --volumes --remove-orphans`; never prune unrelated containers, networks, or volumes.
