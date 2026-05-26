#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <out-dir> <name> -- <stress-runner args...>" >&2
  exit 2
fi
OUT_DIR="$1"
NAME="$2"
shift 2
if [ "${1:-}" = "--" ]; then shift; fi
mkdir -p "$OUT_DIR"
next_pids=$(ss -ltnp 2>/dev/null | awk '/:3000/ { while (match($0,/pid=[0-9]+/)) { print substr($0,RSTART+4,RLENGTH-4); $0=substr($0,RSTART+RLENGTH) } }' | sort -nu | paste -sd, -)
caddy_pids=$(pgrep -d, -x caddy || true)
pg_pids=$(pgrep -d, -x postgres || true)
redis_pids=$(pgrep -d, -x redis-server || true)
all_pids=$(printf '%s,%s,%s,%s' "$next_pids" "$caddy_pids" "$pg_pids" "$redis_pids" | tr ',' '\n' | awk 'NF' | sort -nu | paste -sd, -)
{
  echo "name=$NAME"
  echo "next_pids=$next_pids"
  echo "caddy_pids=$caddy_pids"
  echo "postgres_pids=$pg_pids"
  echo "redis_pids=$redis_pids"
  echo "all_pids=$all_pids"
  echo "started_at=$(date -Is)"
} > "$OUT_DIR/$NAME.meta"
if [ -n "$all_pids" ]; then
  pidstat -h -r -u -p "$all_pids" 1 > "$OUT_DIR/$NAME.pidstat" 2>&1 &
  pidstat_pid=$!
else
  pidstat_pid=""
fi
mpstat 1 > "$OUT_DIR/$NAME.mpstat" 2>&1 &
mpstat_pid=$!
set +e
node scripts/perf/stress-runner.mjs "$@" --output "$OUT_DIR/$NAME.json" > "$OUT_DIR/$NAME.stdout" 2> "$OUT_DIR/$NAME.stderr"
status=$?
set -e
if [ -n "${pidstat_pid:-}" ]; then kill "$pidstat_pid" 2>/dev/null || true; wait "$pidstat_pid" 2>/dev/null || true; fi
kill "$mpstat_pid" 2>/dev/null || true; wait "$mpstat_pid" 2>/dev/null || true
{
  echo "finished_at=$(date -Is)"
  echo "status=$status"
} >> "$OUT_DIR/$NAME.meta"
cat "$OUT_DIR/$NAME.stdout"
cat "$OUT_DIR/$NAME.stderr" >&2
exit "$status"
