#!/usr/bin/env bash
set -euo pipefail
umask 077

task_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
task_env_file=${PRODUCTION_ENV_FILE:-.env}
task_backup_dir=${BACKUP_DIR:-./backups}
: "${AGE_RECIPIENT:?Set the age public recipient; keep its private identity off the application host}"
for task_program in docker age sha256sum mktemp; do
  command -v "$task_program" >/dev/null || { printf 'Required command missing: %s\n' "$task_program" >&2; exit 1; }
done
[[ -f "$task_env_file" ]] || { printf 'Production environment file was not found.\n' >&2; exit 1; }
mkdir -p -- "$task_backup_dir"
task_backup_dir=$(cd -- "$task_backup_dir" && pwd)
task_temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/feedrelay-backup.XXXXXX")
task_dump="$task_temp_dir/database.dump"
trap 'rm -f -- "$task_dump"; rmdir -- "$task_temp_dir"' EXIT
task_name="feedrelay-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}.dump.age"
task_output="$task_backup_dir/$task_name"
task_compose=(docker compose --project-name feedrelay --env-file "$task_env_file" -f "$task_script_dir/compose.production.yml")

# Neither command prints database credentials or dump contents.
"${task_compose[@]}" exec -T postgres sh -eu -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-acl' > "$task_dump"
"${task_compose[@]}" exec -T postgres pg_restore --list < "$task_dump" > /dev/null
age --recipient "$AGE_RECIPIENT" --output "$task_output" "$task_dump"
(cd -- "$task_backup_dir" && sha256sum -- "$task_name" > "$task_name.sha256")
printf 'Encrypted backup created: %s\n' "$task_output"
printf 'Copy the encrypted backup and checksum off-host, and verify the remote copy before calling this backup complete.\n'
