#!/usr/bin/env bash
# SSH ProxyCommand for the development machine, on your Mac (`deploy/devbox/devbox.sh ssh-config` writes the entry):
# starts the machine when the idle stop has powered it off, waits for its startup script to finish, then carries the SSH
# connection through an IAP tunnel (the machine has no external IP). Everything but the tunnel goes to stderr: stdout is
# the SSH stream.
#
#   ProxyCommand /path/to/deploy/devbox/ssh-proxy.sh NAME ZONE PROJECT [GCLOUD]
set -euo pipefail

NAME="$1" ZONE="$2" PROJECT="$3" GCLOUD="${4:-gcloud}"
G=("$GCLOUD" --project "$PROJECT" --quiet)

status="$("${G[@]}" compute instances describe "$NAME" --zone "$ZONE" --format 'value(status)' 2>/dev/null || true)"
case "$status" in
  RUNNING) ;;
  TERMINATED|STOPPED|SUSPENDED)
    echo "[$NAME] $status: starting it (about a minute)" >&2
    if [ "$status" = SUSPENDED ]; then "${G[@]}" compute instances resume "$NAME" --zone "$ZONE" >&2; else "${G[@]}" compute instances start "$NAME" --zone "$ZONE" >&2; fi
    # the startup script's last line on the serial port: the toolchain checked and SSH up
    for _ in $(seq 1 60); do
      "${G[@]}" compute instances get-serial-port-output "$NAME" --zone "$ZONE" 2>/dev/null | grep -q 'sb-devbox: ready' && break
      sleep 5
    done
    ;;
  STAGING|PROVISIONING|STOPPING|SUSPENDING|REPAIRING)
    echo "[$NAME] $status: waiting" >&2
    for _ in $(seq 1 60); do
      s="$("${G[@]}" compute instances describe "$NAME" --zone "$ZONE" --format 'value(status)' 2>/dev/null || true)"
      [ "$s" = RUNNING ] && break
      [ "$s" = TERMINATED ] && exec "$0" "$@"
      sleep 5
    done
    ;;
  *) echo "[$NAME] not found in $PROJECT/$ZONE (status '$status')" >&2; exit 1 ;;
esac

exec "${G[@]}" compute start-iap-tunnel "$NAME" 22 --listen-on-stdin --zone "$ZONE" --verbosity warning
