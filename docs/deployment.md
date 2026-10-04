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

Use a direct PostgreSQL endpoint or a pool in **session mode** for the application and pg-boss. Each Store transaction/read snapshot keeps one checked-out connection through completion; statement pooling cannot support those multi-statement transactions. Transaction pooling has not been validated with the complete migration, queue and session behavior and is not a supported substitute here. PgBouncer documents the differing feature support for [session, transaction and statement pooling](https://www.pgbouncer.org/features.html). The application's transaction-level advisory locks do not by themselves require session pooling; the session-mode requirement covers the complete stack.

The web build sets `API_BASE=http://api:4100` and `NEXT_PUBLIC_SITE_URL=${PUBLIC_URL}` as build arguments because Next.js rewrites and public metadata are recorded during the build. Caddy also routes `/api/*` directly to the API. Changing either address requires rebuilding the web image. Caddy uses automatic HTTPS and its standard [reverse proxy forwarding behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy); application authentication and webhook secrets remain required.

The API defaults to an empty `TRUSTED_PROXY_CIDRS`, so a direct connection does not trust forwarded client addresses. Production Compose sets this variable only on the API to Docker's private IPv4 ranges (`10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`) so Caddy's dynamic container address can supply the client IP used for rate limits. This setting assumes the API has **no published host port** and only trusted services can access its private Docker network. On another platform, restrict the value to the actual reverse proxy IPs/CIDRs; keep it empty for direct access. Do not expose the API port publicly while trusting broad private ranges.

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

## Repeatable isolated Docker smoke

Run the same script locally and in CI, using Node 22.12 or later and a local Linux Docker engine with Compose v2 or later. On Windows, start Docker Desktop in Linux container mode. The script refuses remote Docker endpoints. From the repository root:

```sh
pnpm docker:smoke
# Or without a host pnpm installation:
node deploy/smoke.mjs
```

To validate the engine and generated Compose inputs without building an image or creating a container/network/volume:

```sh
node deploy/smoke.mjs --prepare-only
```

Each invocation creates a random project name, fake credentials and a results directory at `work/deploy-smoke/<project>/`. Child commands receive explicit arguments and an overridden fake environment; no `SMOKE_DIR` export or shell wrapper is required. The script builds the actual production server and web Dockerfiles against the frozen lockfile. Image downloads and builds need Internet access; the runtime's `backend` and `egress` networks are both internal, and no service publishes a host port. It starts PostgreSQL, the one-shot migration, API, web and fetch worker. Caddy, control-worker and delivery-worker remain absent.

Checks cover migration versions, database-backed API readiness, all five pg-boss queues and actual completion of a harmless fetch job for a nonexistent source, the production homepage and same-origin API rewrite, sitemap metadata, anonymous API rejection, disabled demo login, rejected unsigned webhook, read-only/nonroot application processes, and absence of Telegram/OIDC secrets in the fetch worker. Database assertions confirm that the run created no users, deliveries, payments or accepted webhook facts. The smoke API leaves `TRUSTED_PROXY_CIDRS` empty because its probes connect directly. Telegram login, webhook registration, real message delivery, subscriptions, payments, Caddy certificate issuance and public deployment are outside this smoke.

The script writes `results.json`, `commands.log` and `runtime.log`, then its `finally` removes only the current project and its labeled image tags. It checks ownership labels before deleting resources and verifies that the project leaves no containers, networks or volumes. Shared base images and Docker build caches remain available. Never run a global Docker prune as smoke cleanup. If a process is forcibly killed or Docker disappears before cleanup, retry using that exact run's record:

```sh
node deploy/smoke.mjs --cleanup-record work/deploy-smoke/<project>/results.json
```

The Docker smoke workflow invokes this same portable script, retries project-scoped cleanup in an `always()` step, and retains only result/log artifacts. The generated fake environment is not uploaded. Current local verification evidence is recorded in [verification.md](verification.md); a successful smoke establishes the checks above, not a completed external production deployment.
