# Backup and recovery runbook

The isolated synthetic PostgreSQL logical dump/restore drill below has passed locally. Recovery time and recovery point objectives for production remain planning targets. Encryption/decryption, live off-host backup, retention, Telegram reconciliation and production worker recovery have not been verified. Log the achieved times and retained recovery points after every drill.

## Local logical recovery acceptance

Run the repeatable drill from the repository root with Node.js and the Docker Linux engine. Supply a locally built server image; the script does not build images or read production environment files. For example:

```sh
docker build --file deploy/server.Dockerfile --tag feedrelay-server:recovery-drill .
node deploy/recovery-smoke.mjs --server-image feedrelay-server:recovery-drill
```

The script creates a random project name, an internal Docker network, two PostgreSQL containers, two data volumes and its own server image alias. It publishes no host ports. It runs the actual migrations, `PostgresStore` and `BillingService` against synthetic records, without creating a Telegram client or starting the application/worker processes. Synthetic billing receipts are local database fixtures and make no payment or invoice requests. The custom-format archive stays in process memory, is catalog-checked, and is restored into the second database using `pg_restore --exit-on-error --single-transaction`. Cleanup checks ownership labels and removes only resources created by that run, including its image alias; it preserves the supplied server image and shared PostgreSQL image.

On **2026-10-04 at 01:03:12 UTC**, project `feedrelay-recovery-20261004010303-39ceef83de2a60db` passed using Docker Engine **29.8.0**:

| Evidence | Observed result |
| --- | --- |
| PostgreSQL image | `postgres:16-bookworm`, digest `sha256:efedf3595f1d6f415c08568ba171029bf54052e754cc9f030e3f2412b21f3d67` |
| Server image | Local runtime image ID `sha256:2b4bee489891c194135d270f8df4c0c76b717cf2486b850d088a431141bb7d1d` |
| Migrations | Versions 1, 2 and 3 restored |
| Custom archive | 70,631 bytes; SHA-256 `7e8860463a85bb98b435b2ad90fe37447617108ebfc9d94c39cd2261059f38a0`; not retained |
| Record verification | All 31 business envelopes and per-table row counts matched; source and restored digest `2ce061d85600d1cf637a802dafc1b9af540e0e5a428fde57e28dbaae3af8d5cc` |
| Isolation | Internal network, zero published ports, no real database or Telegram access |
| Cleanup | All run-owned containers, volumes, network and image alias removed |

The fixture retained one user, workspace, source, source binding, destination and route; two items and aliases; two deliveries and attempts; two pending outbox events; one audit record; one checkout and subscription; two payments and grants; one refund; three billing events; one usage period; two reservations; and one ledger entry. The route cursor/baseline, source sequence, filters, retained Unicode article content and workspace ownership matched after restore.

The sent delivery kept its Telegram message identifier and exactly one committed usage ledger entry. The unknown delivery kept its uncertainty, attempt count and capped-retry counter, with its unknown reservation still consuming reserved quota and no fabricated message identifier. Paid grants still matched known synthetic charge identities, checkout payloads and exact 30-day receipt periods. The refunded renewal remained revoked, so restored entitlements showed Starter with used **1**, reserved **1**, and paid-through **2026-11-02T00:00:00Z**, without extending access over the refunded period.

Thirteen negative insert probes passed both before and after restore: Telegram identity, source URL, active binding, active destination chat, item sequence, active route, logical delivery, logical usage ledger, payment charge, paid-grant charge and delivery-period reservation uniqueness, plus record ID and workspace envelope checks. These are database uniqueness/CHECK constraints and application relationship assertions; the current JSON business envelope schema does not define foreign keys.

| Timed phase | Seconds |
| --- | ---: |
| Image inspection/alias | 1.597 |
| Isolated database startup | 3.789 |
| Source migration, fixture and verification | 1.267 |
| Custom dump | 0.329 |
| Archive catalog check | 0.287 |
| Single-transaction restore | 0.478 |
| Restored business verification | 0.971 |
| Owned resource cleanup | 3.533 |
| Entire drill | 12.252 |

The timed drill excludes server image building and uses a tiny synthetic database. It establishes logical restore correctness for that fixture, not a production RTO/RPO. `age` was unavailable on the local operator host, so encryption/decryption was not tested. Off-host transfer, scheduling, immutable retention, roles/secrets restoration, pg-boss queue recovery, the production freeze/rebaseline command, and Telegram billing/send reconciliation remain unverified. The `backup.sh` and `restore-staging.sh` procedures below still need their own encrypted, off-host operator drill.

## Encrypted logical backups

Install `age` on the Linux operator machine and create the decryption identity on a separate recovery machine. Supply only its public recipient to the application host. The backup script makes a consistent PostgreSQL custom-format archive, checks that its catalog can be read, encrypts it, writes a SHA-256 checksum and removes its temporary plaintext. Use an encrypted temporary filesystem for `TMPDIR` if recovering local plaintext remnants is a concern. The tooling and encryption options follow the official [pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html) and [age](https://github.com/FiloSottile/age#usage) documentation.

```sh
export PRODUCTION_ENV_FILE=/secure/feedrelay-production.env
export BACKUP_DIR=/secure/feedrelay-backups
export AGE_RECIPIENT=age1_REPLACE_WITH_YOUR_PUBLIC_RECIPIENT
bash deploy/backup.sh
```

The placeholder recipient above is not usable. Supply your real public recipient. Keep the private identity, production bot token and database credentials out of the backup directory and source tree.

Schedule the script with the operator's scheduler, then copy both `.dump.age` and `.dump.age.sha256` to encrypted off-host storage using a separate account with least privilege. Verify that the remote object exists and that its checksum matches. Retain historical versions or immutable snapshots so an application-host compromise cannot delete every recovery point. Alert when the newest verified remote backup is older than the chosen backup interval. A successful local script run is not an off-host backup.

A nightly verified remote logical dump targets an RPO of 24 hours and a provisional RTO of 4 hours for a small database. These are untested objectives, and actual loss can exceed them if the schedule or off-host transfer fails. The script does not configure a scheduler, remote storage, immutable retention or continuous WAL archiving. PostgreSQL role definitions and infrastructure secrets are also outside the database archive; retain the production environment, deployment release and key recovery procedure separately under secure access controls.

For a lower RPO, configure physical base backups plus continuous WAL archiving or a managed PostgreSQL service with point-in-time recovery. Target an RPO of 5 minutes only after continuous archive freshness and restore tests prove it. A logical `pg_dump` archive cannot restore an arbitrary timestamp. WAL retention, encryption keys, off-host permissions and base backup/WAL compatibility must be monitored together. Consult PostgreSQL's [continuous archiving and PITR documentation](https://www.postgresql.org/docs/16/continuous-archiving.html).

## Isolated staging restore

Retrieve a verified archive from off-host storage to the recovery machine. Keep production workers stopped during any real recovery investigation. The supplied staging script always selects the fixed `feedrelay-restore-staging` Compose project and `feedrelay_restore_staging` database; it creates no application service, public port, webhook or Telegram client. It overwrites only that isolated staging database.

```sh
export AGE_IDENTITY_FILE=/secure/recovery/age-identity.txt
export STAGING_POSTGRES_PASSWORD=REPLACE_WITH_A_FRESH_RANDOM_STAGING_PASSWORD
bash deploy/restore-staging.sh /secure/recovery/feedrelay-TIMESTAMP.dump.age
docker compose -p feedrelay-restore-staging -f deploy/compose.restore.yml ps
```

Use an actual archive path and a fresh password. The script checks the checksum, decrypts into a private temporary directory, verifies the archive catalog and runs `pg_restore` as one transaction with errors treated as fatal. Original role ownership and grants are replaced with the staging role. The restore options follow the official [pg_restore documentation](https://www.postgresql.org/docs/16/app-pgrestore.html).

Inspect the restored row counts and application invariants before considering the drill successful. Verify workspace ownership, source bindings and route cursors; that each sent logical delivery has one quota ledger entry; that ambiguous sends remain unknown/reviewable; and that every active paid grant corresponds to a known Telegram charge and an unrefunded exact period. Record archive timestamp, image digest, migration version, restore duration and the oldest available recovery point. A catalog check alone does not prove that business state is correct.

Stop the staging database after inspection with `docker compose -p feedrelay-restore-staging -f deploy/compose.restore.yml down`. Do not use `down --volumes` against the production Compose project. Retain staging data until the drill findings have been recorded.

## Production state recovery

1. Freeze worker execution and public mutation endpoints. Save the incident timeline, latest encrypted backup, current database evidence and deployed image digests. Keep the old database or volume for investigation instead of overwriting it in place.
2. Restore the chosen snapshot into a fresh database and inspect it using the staging procedure. Recreate application credentials and network access independently from the archive. Run the matching application migrations against the replacement database.
3. Point the production services at the replacement database while workers remain stopped. Run the recovery command before enabling send processing:

   ```sh
   docker compose --env-file /secure/feedrelay-production.env -f deploy/compose.production.yml run --rm --no-deps control-worker pnpm --filter @feedrelay/server recover
   ```

   The default recovery procedure freezes uncertain routes/deliveries and establishes a fresh feed baseline. It should not blindly replay every restored queue entry. Record the downtime window, route baseline changes and deliveries requiring review. Review its results before starting workers.
4. Reconcile billing against Telegram Stars transaction history. A restored snapshot may omit a charge or refund that Telegram has already processed. Missing or ambiguous mappings must stay in `billingEvents` for review; never extend a subscription from the arrival time or infer an exact paid interval from an amount alone. Pause paid checkout until subscription occupancy, refund tombstones and charge identity have been reconciled.
5. Treat sends that may have succeeded after the snapshot as unknown. Telegram does not supply a general read-history API for bot messages that resolves every uncertain send. Preserve reservations and follow the capped unknown retry/manual-review policy. Do not erase quota ledgers to make counters appear consistent.
6. Start the API and web, verify login and a free test route, then resume control, fetch and delivery workers gradually. Monitor duplicates, missing deliveries, quota deferrals and billing events. Keep the old database isolated until the incident is closed.

The operator must choose any catch-up behavior after recovery. The default fresh baseline favors avoiding replay duplicates; it can skip articles published during downtime. A recovery report must state that tradeoff and list affected routes. Store billing and delivery evidence long enough to audit this window rather than applying content-retention deletion to financial records.
