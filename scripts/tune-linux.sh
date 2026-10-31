#!/usr/bin/env bash
# Kernel and process limits for hosts that serve or generate very high
# connection counts. Defaults on most distributions are sized for desktop
# workloads and quietly cap throughput long before CPU or NIC limits:
# accept queues overflow, ephemeral ports run out, and file descriptors hit
# 1024.
#
#   sudo scripts/tune-linux.sh          # apply now and persist across reboots
#   sudo scripts/tune-linux.sh --dry-run
#
# Review every value for your environment before using it in production.
set -euo pipefail

dry_run=false
[[ "${1:-}" == "--dry-run" ]] && dry_run=true

settings=(
  # Pending connections the kernel will queue per listening socket.
  "net.core.somaxconn=65535"
  "net.ipv4.tcp_max_syn_backlog=65535"
  # Packets queued when the NIC delivers faster than the kernel drains.
  "net.core.netdev_max_backlog=250000"
  # Load generators open many outbound connections; widen the port range
  # and reuse TIME_WAIT sockets for new outbound connections.
  "net.ipv4.ip_local_port_range=1024 65535"
  "net.ipv4.tcp_tw_reuse=1"
  "net.ipv4.tcp_fin_timeout=15"
  # Larger socket buffers for high-bandwidth links.
  "net.core.rmem_max=134217728"
  "net.core.wmem_max=134217728"
  "net.ipv4.tcp_rmem=4096 87380 134217728"
  "net.ipv4.tcp_wmem=4096 65536 134217728"
  # System-wide file descriptor ceiling.
  "fs.file-max=4194304"
  "fs.nr_open=4194304"
  # Redis recommends this so background saves do not fail under load.
  "vm.overcommit_memory=1"
)

if $dry_run; then
  printf '%s\n' "${settings[@]}"
  echo "* soft nofile 1048576"
  echo "* hard nofile 1048576"
  exit 0
fi

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

conf=/etc/sysctl.d/99-wraplink.conf
: > "${conf}"

for setting in "${settings[@]}"; do
  sysctl -w "${setting}" >/dev/null
  echo "${setting%%=*} = ${setting#*=}" >> "${conf}"
done

cat > /etc/security/limits.d/99-wraplink.conf <<LIMITS
* soft nofile 1048576
* hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
LIMITS

# Transparent huge pages cause latency spikes in Redis.
if [[ -w /sys/kernel/mm/transparent_hugepage/enabled ]]; then
  echo never > /sys/kernel/mm/transparent_hugepage/enabled
fi

echo "Applied. Persisted to ${conf} and /etc/security/limits.d/99-wraplink.conf"
echo "Log out and back in (or restart services) for the nofile limit to apply."
echo "For systemd services also set LimitNOFILE=1048576 in the unit."
