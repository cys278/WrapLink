#!/usr/bin/env bash
# Live resource view for benchmark hosts.
#
# On machines with 100+ cores, `top` and `htop` print one row per core and
# become unreadable. This prints a single line per second with the numbers
# that identify the bottleneck:
#
#   idle%  near 0     -> CPU bound (add cores, or make the code cheaper)
#   rx/tx  near NIC   -> network bound (smaller responses, compression, NIC)
#   mem    climbing   -> memory bound (Redis backlog, leaks)
#   high idle% + low throughput -> waiting on something else (database,
#                                  locks, a single-threaded process)
#
#   scripts/monitor.sh            # auto-detect the main interface
#   scripts/monitor.sh eth0
#
# CPU% follows "method two" (0-100% across all cores). A process view such
# as `ps` uses "method one", where one fully busy core is 100% and a 128-core
# machine can show 12,800%.
set -euo pipefail

if [[ "$(uname)" != "Linux" ]]; then
  echo "monitor.sh reads /proc and works on Linux only" >&2
  exit 1
fi

default_iface="$( (ip route show default 2>/dev/null || true) | awk '{print $5; exit}')"
if [[ -z "${default_iface}" ]]; then
  default_iface="$(awk 'NR > 2 && $1 != "lo:" {sub(":", "", $1); print $1; exit}' /proc/net/dev)"
fi
iface="${1:-${default_iface}}"
iface="${iface:-eth0}"
cores="$(nproc)"

read_cpu() {
  awk '/^cpu / {idle=$5+$6; total=0; for (i=2;i<=NF;i++) total+=$i; print idle, total}' /proc/stat
}

read_net() {
  awk -v dev="${iface}:" '$1==dev {print $2, $10}' /proc/net/dev
}

printf "cores=%s interface=%s\n" "${cores}" "${iface}"
printf "%-8s %7s %12s %12s %10s %10s\n" time idle% rx_Gbit/s tx_Gbit/s mem_used load1

read -r idle0 total0 < <(read_cpu)
read -r rx0 tx0 < <(read_net || echo "0 0")

while sleep 1; do
  read -r idle1 total1 < <(read_cpu)
  read -r rx1 tx1 < <(read_net || echo "0 0")

  idle_pct=$(awk -v i="$((idle1 - idle0))" -v t="$((total1 - total0))" 'BEGIN { printf "%.1f", t ? 100 * i / t : 0 }')
  rx=$(awk -v b="$((rx1 - rx0))" 'BEGIN { printf "%.2f", b * 8 / 1e9 }')
  tx=$(awk -v b="$((tx1 - tx0))" 'BEGIN { printf "%.2f", b * 8 / 1e9 }')
  mem=$(awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END {printf "%.1fG", (t - a) / 1048576}' /proc/meminfo)
  load=$(cut -d' ' -f1 /proc/loadavg)

  printf "%-8s %7s %12s %12s %10s %10s\n" "$(date +%H:%M:%S)" "${idle_pct}" "${rx}" "${tx}" "${mem}" "${load}"

  idle0=${idle1}; total0=${total1}; rx0=${rx1}; tx0=${tx1}
done
