# FeedRelay cloud handoff

## Goal and current state

Continue and finish the user's Telegram RSS/Atom delivery product. The user prefers English/overseas customers, stable conventional utility behavior, and a modular implementation. Engineering difficulty is secondary; acquiring initial customers is the main business concern. The user is shutting down their Windows computer and wants cloud Codex to continue independent work. Preserve the completed implementation rather than restarting the project.

This is a pnpm 10.32.1 / Node 22.12+ TypeScript monorepo. `packages/core`, `packages/sources`, `packages/billing`, `apps/server` (Fastify/PostgreSQL/Drizzle/pg-boss) and `apps/web` (Next.js) implement the modular architecture. Read README.md, docs/architecture.md, docs/verification.md and docs/deployment.md first. Respect apps/web/AGENTS.md and the installed Next documentation before modifying web code.

## Verified checkpoint

On 2026-10-04, `pnpm test` passed all 146 tests in 7 files, and `pnpm typecheck` passed all workspace packages. The real embedded PostgreSQL integration suite includes pg-boss and a complete feed-to-delivery/usage pipeline. Tests use simulated Telegram transport and authenticated receipt fixtures; no real messages or payments have been performed.

Browser demo verified login, sample source, simulated private chat destination, route baseline, publishing a new article, Sent delivery and usage 1. A 390px layout check found page overflow; final min-width/table wrapper constraints are saved but need rechecking. Next production build previously passed before that final CSS patch.

The final regression fixes include safe parameterized PostgreSQL multi-value filters, fresh recovery snapshots before route resumption, deleted-route lifecycle rejection, quota preservation for uncertain sends, and verified cancellation of late subscription reactivations on deleted workspaces. Do not remove these boundaries to make tests pass.

## Tasks to finish, in priority order

1. Install with the frozen lockfile. Re-run typecheck and tests on Linux. Embedded PostgreSQL must run as a non-root user; do not claim a skipped integration suite passed. CI is in .github/workflows/ci.yml.
2. Run `pnpm build`, fix any actual remaining issues, and verify the 390px dashboard layout plus the desktop demo flow. Website metadata must use the configured production site URL.
3. Build server and web Docker images using deploy/compose.production.yml. Read the smoke handoff section of docs/deployment.md. The first build failed because it captured an in-progress Processor syntax edit; this has since been repaired and typechecked. No smoke containers, networks or volumes were created.
4. If Docker is available in the cloud sandbox, run an isolated Compose smoke with a unique project name, fake credentials, billing disabled, and outbound networks blocked. Test postgres, migrate, api/web readiness and fetch-worker startup. Do not run bot:setup or connect to Telegram. Clean only resources created by this smoke. If Docker is unavailable, document that exact limitation and complete builds/tests available in the environment.
5. Inspect the implementation against the architecture and correct material gaps within first-version scope. Keep README and docs/verification.md honest about real Telegram/OIDC/Stars integration and capacity tests still awaiting external credentials.
6. Produce a concise change report with exact test results and remaining external acceptance steps. Save a reviewable commit or draft PR when the environment supports it. Do not merge, deploy publicly, enable billing, send messages or perform financial transactions.

## Environment and boundaries

Use MODE=demo for local UI verification: server4100, web3000, loopback only. Demo uses persistent JSON and simulated Telegram and does not accept payments. Production uses PostgreSQL; BOT_ID must be numeric. Never copy real tokens, `.env`, `.data`, user sessions, Docker logs, node_modules or build outputs into commits.

The repository deliberately excludes local runtime data and scratch smoke files. Recreate fake smoke inputs from docs/deployment.md. Do not depend on the Windows absolute paths in previous conversations. Official package registries may be required for dependency audit: `pnpm audit --registry=https://registry.npmjs.org`.

The user's Windows Docker was repaired by preserving/renaming stale socket-only runtime directories. Do not reset Docker, unregister any WSL distribution, or reproduce host diagnostics in the cloud. The Windows host can be offline; cloud work must use its own published environment.

The first version supports public unauthenticated feeds, private chats and channels, single text messages with original links. Groups, private feeds, arbitrary webpage scraping, AI summaries and media albums are intentionally outside this version. Telegram cannot atomically commit a send with the database: unknown receipt states can cause duplicates after an acknowledged retry. Keep this explicit.
