#!/usr/bin/env bash
# Runs tester.mjs on every host in a hosts file over SSH, in parallel, with a
# synchronized start, then aggregates the results. Works with any provider
# or bare-metal machines.
#
#   TARGET_URL=http://10.0.1.20:3000/container-demo \
#   ./ssh-fleet.sh hosts.txt --duration 300 --connections 400 --pipelining 5
#
# hosts.txt: one SSH destination per line (user@host). Each host needs the
# repository at $REPO_DIR with `npm ci` already run.
set -euo pipefail

hosts_file="${1:?hosts file required}"
shift

: "${TARGET_URL:?TARGET_URL is required}"
REPO_DIR="${REPO_DIR:-WrapLink}"
START_DELAY_SECONDS="${START_DELAY_SECONDS:-20}"

start_at="$(( ($(date +%s) + START_DELAY_SECONDS) * 1000 ))"
run_dir="results/ssh-$(date +%Y%m%dT%H%M%S)"
mkdir -p "${run_dir}"

echo "Synchronized start (epoch ms): ${start_at}"

pids=()
while IFS= read -r host; do
  [[ -z "${host}" || "${host}" == \#* ]] && continue
  safe_name="${host//[^A-Za-z0-9_.-]/_}"
  ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "${host}" \
    "cd ${REPO_DIR} && node benchmark/distributed/tester.mjs --url '${TARGET_URL}' --start-at ${start_at} --out /tmp/wraplink-results.json $*" \
    > "${run_dir}/${safe_name}.out" 2> "${run_dir}/${safe_name}.err" &
  pids+=("$!")
done < "${hosts_file}"

failed=0
for pid in "${pids[@]}"; do
  wait "${pid}" || failed=$((failed + 1))
done

echo "Testers finished (${failed} failed). Aggregating ${run_dir}"
node "$(dirname "$0")/aggregate.mjs" "${run_dir}"
