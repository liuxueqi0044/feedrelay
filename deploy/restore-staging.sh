#!/usr/bin/env bash
set -euo pipefail
umask 077

task_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
task_archive=${1:?Usage: bash deploy/restore-staging.sh /absolute/path/backup.dump.age}
: "${AGE_IDENTITY_FILE:?Set the path to the age private identity on the recovery machine}"
: "${STAGING_POSTGRES_PASSWORD:?Set a fresh staging-only database password}"
for task_program in docker age sha256sum mktemp; do
  command -v "$task_program" >/dev/null || { printf 'Required command missing: %s\n' "$task_program" >&2; exit 1; }
done
[[ -f "$task_archive" && -f "$task_archive.sha256" ]] || { printf 'Encrypted backup or checksum was not found.\n' >&2; exit 1; }
[[ -f "$AGE_IDENTITY_FILE" ]] || { printf 'The decryption identity was not found.\n' >&2; exit 1; }
task_archive_dir=$(cd -- "$(dirname -- "$task_archive")" && pwd)
task_archive_name=$(basename -- "$task_archive")
# Checksum records contain only the backup basename, never an arbitrary restore path.
(cd -- "$task_archive_dir" && sha256sum --check --strict -- "$task_archive_name.sha256")
task_temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/feedrelay-restore.XXXXXX")
task_dump="$task_temp_dir/database.dump"
trap 'rm -f -- "$task_dump"; rmdir -- "$task_temp_dir"' EXIT
age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$task_dump" "$task_archive_dir/$task_archive_name"
task_compose=(docker compose --project-name feedrelay-restore-staging -f "$task_script_dir/compose.restore.yml")
"${task_compose[@]}" up -d --wait --wait-timeout 120 postgres
"${task_compose[@]}" exec -T postgres pg_restore --list < "$task_dump" > /dev/null
# The project, compose file and database are fixed staging targets. Production is never selected.
"${task_compose[@]}" exec -T postgres sh -eu -c '
  test "$POSTGRES_DB" = feedrelay_restore_staging
  exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges --exit-on-error --single-transaction
' < "$task_dump"
"${task_compose[@]}" exec -T postgres sh -eu -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "SELECT current_database(), count(*) AS feedrelay_tables FROM information_schema.tables WHERE table_schema = '\''public'\'' AND table_name LIKE '\''fr_%'\'';"'
printf 'Restore completed in isolated project feedrelay-restore-staging. Verify application invariants before any production recovery.\n'
