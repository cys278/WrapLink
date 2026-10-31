#!/usr/bin/env bash
# Runs a local Redis Cluster as plain processes on one machine.
#
# A single Redis process executes commands on one thread, which caps it at
# roughly 100-200k operations per second. A cluster spreads the 16,384 hash
# slots over many processes, so throughput scales with CPU cores.
#
#   scripts/redis-cluster.sh setup                  # 15 masters + 15 replicas
#   scripts/redis-cluster.sh setup --masters 3 --replicas 0
#   scripts/redis-cluster.sh urls                   # REDIS_CLUSTER_URLS=...
#   scripts/redis-cluster.sh status
#   scripts/redis-cluster.sh stop | start | clean
#
# Options:
#   --masters N       primary nodes (default 15)
#   --replicas N      replicas per primary (default 1)
#   --base-port P     first port (default 7001)
#   --host H          address nodes bind to and announce (default 127.0.0.1)
#   --maxmemory SIZE  per-node memory cap, e.g. 8gb (default: unlimited)
#   --dir D           data directory (default .redis-cluster)
#
# Requires redis-server and redis-cli 6.2+ on PATH.
set -euo pipefail

MASTERS=15
REPLICAS=1
BASE_PORT=7001
HOST=127.0.0.1
MAXMEMORY=0
DIR=.redis-cluster

action="${1:-help}"
shift || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --masters) MASTERS="$2"; shift 2 ;;
    --replicas) REPLICAS="$2"; shift 2 ;;
    --base-port) BASE_PORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --maxmemory) MAXMEMORY="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

NODES=$(( MASTERS * (1 + REPLICAS) ))
LAST_PORT=$(( BASE_PORT + NODES - 1 ))

if (( MASTERS < 3 )); then
  echo "Redis Cluster needs at least 3 masters" >&2
  exit 2
fi

ports() {
  seq "${BASE_PORT}" "${LAST_PORT}"
}

require() {
  for binary in redis-server redis-cli; do
    command -v "${binary}" >/dev/null || {
      echo "${binary} not found. Install Redis 6.2+ (apt install redis-server / brew install redis)." >&2
      exit 1
    }
  done
}

write_config() {
  local port="$1"
  local node_dir="${DIR}/${port}"

  mkdir -p "${node_dir}"

  cat > "${node_dir}/redis.conf" <<CONF
port ${port}
bind ${HOST}
cluster-announce-ip ${HOST}
protected-mode no
daemonize yes
dir $(cd "${node_dir}" && pwd)
pidfile $(cd "${node_dir}" && pwd)/redis.pid
logfile $(cd "${node_dir}" && pwd)/redis.log
cluster-enabled yes
cluster-config-file nodes.conf
cluster-node-timeout 5000
# Write-behind links live only in Redis until they are synced, so keep an
# append-only log. everysec bounds loss to about one second on power failure.
appendonly yes
appendfsync everysec
save ""
# Evict only keys that carry a TTL (cached links). Pending write-behind
# links and sync queues have no TTL and are never evicted.
maxmemory ${MAXMEMORY}
maxmemory-policy volatile-lru
CONF
}

start_nodes() {
  for port in $(ports); do
    [[ -f "${DIR}/${port}/redis.conf" ]] || write_config "${port}"
    redis-server "${DIR}/${port}/redis.conf"
  done

  for port in $(ports); do
    until redis-cli -h "${HOST}" -p "${port}" ping >/dev/null 2>&1; do
      sleep 0.1
    done
  done
}

stop_nodes() {
  for port in $(ports); do
    redis-cli -h "${HOST}" -p "${port}" shutdown >/dev/null 2>&1 || true
  done
}

case "${action}" in
  setup)
    require

    if [[ -d "${DIR}" ]]; then
      echo "${DIR} already exists. Run '$0 clean' first or '$0 start'." >&2
      exit 1
    fi

    echo "Starting ${NODES} nodes on ports ${BASE_PORT}-${LAST_PORT}"
    start_nodes

    nodes=()
    for port in $(ports); do
      nodes+=("${HOST}:${port}")
    done

    redis-cli --cluster create "${nodes[@]}" \
      --cluster-replicas "${REPLICAS}" \
      --cluster-yes

    echo
    echo "Cluster ready: ${MASTERS} masters, $(( MASTERS * REPLICAS )) replicas"
    "$0" urls --masters "${MASTERS}" --replicas "${REPLICAS}" \
      --base-port "${BASE_PORT}" --host "${HOST}" --dir "${DIR}"
    ;;

  start)
    require
    start_nodes
    echo "Started ${NODES} nodes"
    ;;

  stop)
    stop_nodes
    echo "Stopped ${NODES} nodes"
    ;;

  status)
    redis-cli -h "${HOST}" -p "${BASE_PORT}" cluster info | grep -E "cluster_state|cluster_known_nodes|cluster_size"
    redis-cli --cluster check "${HOST}:${BASE_PORT}" | tail -n 5
    ;;

  urls)
    # A few root nodes are enough; the client discovers the rest.
    urls=()
    for port in $(seq "${BASE_PORT}" $(( BASE_PORT + 2 ))); do
      urls+=("redis://${HOST}:${port}")
    done
    (IFS=,; echo "REDIS_CLUSTER_URLS=${urls[*]}")
    ;;

  clean)
    stop_nodes
    rm -rf "${DIR}"
    echo "Removed ${DIR}"
    ;;

  *)
    sed -n '2,24p' "$0"
    ;;
esac
