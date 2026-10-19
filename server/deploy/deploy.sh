#!/usr/bin/env bash
# Installed root-owned; the CI SSH key can invoke only this image receiver.
set -euo pipefail
[[ $# == 1 && $1 =~ ^deploy\ ([0-9a-f]{40})$ ]] || exit 64
revision=${BASH_REMATCH[1]}
exec 9>/run/lock/practiq-deploy.lock
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
cd /opt/practiq/config
compose=(docker compose --project-name practiq --env-file /etc/practiq/service.env
    --env-file /etc/practiq/image.env -f server/deploy/service.compose.yml
    -f server/deploy/production.compose.yml)
previous=$(cat /etc/practiq/image.env)
# Receive only Docker image data; repository scripts are never executed as root.
docker image load
image="practiq-ai:$revision"
docker image inspect "$image" >/dev/null
rollback() {
    printf '%s\n' "$previous" > /etc/practiq/image.env
    "${compose[@]}" up -d --no-build --no-deps --wait --wait-timeout 180 ai
}
trap 'status=$?; trap - ERR; rollback || echo "ROLLBACK FAILED: operator action required" >&2; exit "$status"' ERR
printf 'PRACTIQ_IMAGE=%s\n' "$image" > /etc/practiq/image.env
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-build --no-deps --wait --wait-timeout 180 ai
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:8090/ready >/dev/null
trap - ERR
echo "Deployed $revision"
