#!/bin/sh
# Run only from the trusted host scheduler, never from an HTTP request.
set -eu
umask 077
: "${PRACTIQ_PROJECT_DIR:?}" "${PRACTIQ_STORAGE_DIR:?}" "${PRACTIQ_BACKUP_ROOT:?}"
: "${PRACTIQ_BACKUP_IMAGE_ARCHIVE:?}" "${PRACTIQ_BACKUP_IMAGE_ID:?}"
: "${PRACTIQ_BACKUP_PYTHON:?}" "${PRACTIQ_BACKUP_METRICS:?}"
cd "$PRACTIQ_PROJECT_DIR/server"
"$PRACTIQ_BACKUP_PYTHON" -c 'import sys; from pathlib import Path; from scripts.service_backup import metrics; metrics(Path(sys.argv[1]), success=False)' "$PRACTIQ_BACKUP_METRICS"
# Fail before stopping writers when the off-host destination is not mounted.
mountpoint -q "$PRACTIQ_BACKUP_ROOT"
case "$(findmnt -n -o FSTYPE --target "$PRACTIQ_BACKUP_ROOT")" in
    nfs|nfs4|cifs|fuse.sshfs) ;;
    *) echo 'Backup requires an operator-mounted off-host filesystem' >&2; exit 1 ;;
esac
compose() { docker compose --env-file "$PRACTIQ_PROJECT_DIR/.env" -f "$PRACTIQ_PROJECT_DIR/server/deploy/service.compose.yml" "$@"; }
container=$(compose ps --all -q ai)
test -n "$container"
test "$(docker inspect --format '{{.Image}}' "$container")" = "$PRACTIQ_BACKUP_IMAGE_ID"
export AI_MAINTENANCE_MODE=true AI_STORAGE_DIR="$PRACTIQ_STORAGE_DIR"
"$PRACTIQ_BACKUP_PYTHON" -m dotenv -f "$PRACTIQ_PROJECT_DIR/.env" run --no-override -- \
    "$PRACTIQ_BACKUP_PYTHON" -c '
import sys
from pathlib import Path
from scripts.service_backup import check_deployment
check_deployment(sys.argv[1], sys.argv[2], Path(sys.argv[3]))
' "$container" "$PRACTIQ_BACKUP_IMAGE_ID" "$PRACTIQ_PROJECT_DIR"
ai_running=$(docker inspect --format '{{.State.Running}}' "$container")
finish() {
    status=$?
    trap - EXIT HUP INT TERM
    if test "$ai_running" = true; then compose start --wait --wait-timeout 90 ai || status=1; fi
    if test "$status" -ne 0; then
        "$PRACTIQ_BACKUP_PYTHON" -c 'import sys; from pathlib import Path; from scripts.service_backup import metrics; metrics(Path(sys.argv[1]), success=False)' "$PRACTIQ_BACKUP_METRICS" || status=1
    fi
    exit "$status"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
if test "$ai_running" = true; then compose stop ai; fi
set -- backup --bundle "$PRACTIQ_BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)" \
    --config "$PRACTIQ_PROJECT_DIR/.env" --image "$PRACTIQ_BACKUP_IMAGE_ID" \
    --image-archive "$PRACTIQ_BACKUP_IMAGE_ARCHIVE" --metrics "$PRACTIQ_BACKUP_METRICS"
"$PRACTIQ_BACKUP_PYTHON" -m dotenv -f "$PRACTIQ_PROJECT_DIR/.env" run --no-override -- \
    "$PRACTIQ_BACKUP_PYTHON" -m scripts.service_backup "$@"
