#!/bin/bash
# The development machine's idle stop (installed by startup.sh as /usr/local/sbin/sb-idle-stop, run every 5 minutes by
# sb-idle-stop.timer). The machine is idle when, at a check, all three hold:
#   - no SSH connection is open (an IAP tunnel: a terminal, the Claude desktop app, a port forward to the app);
#   - the 15-minute load average is under the threshold (a build, a test run or a compile keeps it above);
#   - no keep-awake time still to come (`sb-keep-awake HOURS`, for an unattended run with nobody connected).
# Idle at every check for the configured minutes in a row, it powers the machine off from inside: Compute Engine marks it
# TERMINATED, the vCPUs, memory and GPU stop billing, and both disks are kept. Start it again with
# `deploy/devbox/devbox.sh start`, or by connecting through deploy/devbox/ssh-proxy.sh, which starts it.
#
# Instance metadata: sb-idle-minutes (default 60; 0 never stops), sb-idle-load (default 1.0).
set -euo pipefail

META=http://metadata.google.internal/computeMetadata/v1/instance/attributes
meta() { curl -sf -H 'Metadata-Flavor: Google' "$META/$1" || true; }
MINUTES="$(meta sb-idle-minutes)"; MINUTES="${MINUTES:-60}"
MAX_LOAD="$(meta sb-idle-load)"; MAX_LOAD="${MAX_LOAD:-1.0}"
RUN=/run/sb-devbox
SINCE="$RUN/idle-since"
mkdir -p "$RUN"
say() { logger -t sb-idle-stop "$*"; }

[ "$MINUTES" -gt 0 ] || { rm -f "$SINCE"; exit 0; }

now="$(date +%s)"
ssh_open="$(ss -Htn state established '( sport = :22 )' | wc -l)"
load15="$(cut -d' ' -f3 /proc/loadavg)"
awake_until="$(cat "$RUN/keep-awake-until" 2>/dev/null || echo 0)"

busy=""
[ "$ssh_open" -gt 0 ] && busy="$ssh_open SSH connection(s)"
awk -v l="$load15" -v m="$MAX_LOAD" 'BEGIN { exit !(l >= m) }' && busy="${busy:+$busy, }load $load15"
[ "$awake_until" -gt "$now" ] && busy="${busy:+$busy, }kept awake until $(date -d "@$awake_until" '+%H:%M')"

if [ -n "$busy" ]; then
  rm -f "$SINCE"
  exit 0
fi

[ -f "$SINCE" ] || echo "$now" > "$SINCE"
idle_min=$(( (now - $(cat "$SINCE")) / 60 ))
if [ "$idle_min" -ge "$MINUTES" ]; then
  say "idle for $idle_min minutes (no SSH, load $load15 < $MAX_LOAD): powering off"
  rm -f "$SINCE"
  shutdown -h now "sb-idle-stop: idle for $idle_min minutes"
else
  say "idle for $idle_min of $MINUTES minutes (no SSH, load $load15)"
fi
