#!/bin/bash
# Startup script of the Scratchbox development machine (deploy/devbox/devbox.sh create; README:
# docs/processes/2026-11-03-gcloud-dev-machine.md). Compute Engine runs it as root at every boot; every step is idempotent,
# and the one-time installs are skipped once their marker exists. No secrets here: the app reads them from Secret Manager
# when it starts (app-env.sh).
#
#   - the 2 TB data disk (device name sb-data) formatted once and mounted at /home, so every user's checkouts, worktrees,
#     caches and venvs live on it and survive a new boot disk;
#   - the toolchain: clang 19 (the engine's C++20, as clang++), Node 22.18 through nvm (system-wide in /opt/nvm), git,
#     the GitHub CLI, Python 3 with venv, ffmpeg and the libraries MediaPipe and OpenCV load;
#   - the NVIDIA driver comes with the image (ubuntu-accelerator-2404-amd64-with-nvidia-580); this checks it answers;
#   - the idle stop (idle-stop.sh, from the instance metadata), run every 5 minutes by a systemd timer.
set -euo pipefail
export HOME="${HOME:-/root}" DEBIAN_FRONTEND=noninteractive

log() { echo "sb-devbox: $*"; }
META=http://metadata.google.internal/computeMetadata/v1/instance
meta() { curl -sf -H 'Metadata-Flavor: Google' "$META/$1"; }
STATE=/var/lib/sb-devbox
mkdir -p "$STATE"
APT=(apt-get -o DPkg::Lock::Timeout=900 -y -q)

NODE_VERSION=22.18.0
NVM_VERSION=v0.40.3
CLANG_VERSION=19

# --- the data disk at /home ------------------------------------------------------------------------------------------
DISK=/dev/disk/by-id/google-sb-data
if [ -e "$DISK" ]; then
  if ! blkid "$DISK" >/dev/null 2>&1; then
    log "formatting the data disk"
    mkfs.ext4 -q -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard -L sb-home "$DISK"
  fi
  if ! mountpoint -q /home; then
    UUID="$(blkid -s UUID -o value "$DISK")"
    grep -q "$UUID" /etc/fstab || echo "UUID=$UUID /home ext4 discard,defaults,nofail 0 2" >> /etc/fstab
    # whatever the image put in /home moves onto the disk first
    mkdir -p /mnt/sb-home && mount "$DISK" /mnt/sb-home
    rsync -a --ignore-existing /home/ /mnt/sb-home/
    umount /mnt/sb-home
    mount /home
    log "data disk mounted at /home ($(df -h --output=size /home | tail -1 | tr -d ' '))"
  fi
else
  log "WARNING: no data disk at $DISK; /home stays on the boot disk"
fi

# --- packages, once ------------------------------------------------------------------------------------------------
if [ ! -f "$STATE/packages-v1" ]; then
  log "installing packages"
  install -d -m 0755 /etc/apt/keyrings
  "${APT[@]}" update
  "${APT[@]}" install build-essential pkg-config zlib1g-dev git git-lfs curl ca-certificates gnupg rsync unzip jq tmux htop \
    python3 python3-venv python3-dev python3-pip ffmpeg libgl1 libglib2.0-0 libegl1 libgles2 nvtop
  # clang 19 from Ubuntu's own archive, else from apt.llvm.org
  if ! "${APT[@]}" install "clang-$CLANG_VERSION" "lld-$CLANG_VERSION"; then
    curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key | gpg --dearmor -o /etc/apt/keyrings/llvm.gpg
    echo "deb [signed-by=/etc/apt/keyrings/llvm.gpg] http://apt.llvm.org/noble/ llvm-toolchain-noble-$CLANG_VERSION main" > /etc/apt/sources.list.d/llvm.list
    "${APT[@]}" update
    "${APT[@]}" install "clang-$CLANG_VERSION" "lld-$CLANG_VERSION"
  fi
  # the engine compiles with `clang++` ($CXX unset): make that clang 19
  update-alternatives --install /usr/bin/clang clang "/usr/bin/clang-$CLANG_VERSION" 100 \
    --slave /usr/bin/clang++ clang++ "/usr/bin/clang++-$CLANG_VERSION"
  # the GitHub CLI from GitHub's own apt repository
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  "${APT[@]}" update
  "${APT[@]}" install gh
  # the gcloud CLI, when the image has none
  if ! command -v gcloud >/dev/null && [ ! -x /snap/bin/gcloud ]; then
    curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /etc/apt/keyrings/cloud.google.gpg
    echo "deb [signed-by=/etc/apt/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list
    "${APT[@]}" update
    "${APT[@]}" install google-cloud-cli
  fi
  touch "$STATE/packages-v1"
fi

# --- Node through nvm, system-wide ---------------------------------------------------------------------------------
export NVM_DIR=/opt/nvm
if [ ! -x "$NVM_DIR/versions/node/v$NODE_VERSION/bin/node" ]; then
  log "installing Node $NODE_VERSION through nvm $NVM_VERSION"
  [ -d "$NVM_DIR/.git" ] || git clone -q --depth 1 --branch "$NVM_VERSION" https://github.com/nvm-sh/nvm.git "$NVM_DIR"
  bash -c ". '$NVM_DIR/nvm.sh' && nvm install '$NODE_VERSION' && nvm alias default '$NODE_VERSION'"
fi
# on every PATH, login shell or not (the Claude desktop app runs commands over SSH without a login shell)
for b in node npm npx corepack; do
  ln -sfn "$NVM_DIR/versions/node/v$NODE_VERSION/bin/$b" "/usr/local/bin/$b"
done
cat > /etc/profile.d/sb-nvm.sh <<EOF
export NVM_DIR=$NVM_DIR
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh" --no-use
EOF

# --- limits for many worktrees and watchers ------------------------------------------------------------------------
cat > /etc/sysctl.d/90-sb-devbox.conf <<'EOF'
fs.inotify.max_user_watches = 1048576
fs.inotify.max_user_instances = 1024
EOF
sysctl -q --system || true
cat > /etc/security/limits.d/90-sb-devbox.conf <<'EOF'
* soft nofile 65536
* hard nofile 1048576
EOF

# --- the GPU --------------------------------------------------------------------------------------------------------
if command -v nvidia-smi >/dev/null && nvidia-smi -pm 1 >/dev/null 2>&1; then
  log "GPU: $(nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader)"
else
  log "WARNING: nvidia-smi does not answer; the GPU is not usable"
fi

# --- the idle stop ----------------------------------------------------------------------------------------------------
if meta attributes/sb-idle-stop > /usr/local/sbin/sb-idle-stop.new; then
  install -m 0755 /usr/local/sbin/sb-idle-stop.new /usr/local/sbin/sb-idle-stop
  rm -f /usr/local/sbin/sb-idle-stop.new
  cat > /etc/systemd/system/sb-idle-stop.service <<'EOF'
[Unit]
Description=Power the development machine off when idle (deploy/devbox/idle-stop.sh)

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/sb-idle-stop
EOF
  cat > /etc/systemd/system/sb-idle-stop.timer <<'EOF'
[Unit]
Description=Check every 5 minutes whether the development machine is idle

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
  # any user may push the stop back (sb-keep-awake), so the state directory is world-writable with the sticky bit
  echo 'd /run/sb-devbox 1777 root root -' > /etc/tmpfiles.d/sb-devbox.conf
  systemd-tmpfiles --create /etc/tmpfiles.d/sb-devbox.conf
  cat > /usr/local/bin/sb-keep-awake <<'EOF'
#!/bin/sh
# sb-keep-awake HOURS: the idle stop leaves the machine on for HOURS more (0 cancels). For an unattended build with no SSH open.
h="${1:?usage: sb-keep-awake HOURS}"
echo $(( $(date +%s) + h * 3600 )) > /run/sb-devbox/keep-awake-until
echo "the idle stop waits until $(date -d "@$(cat /run/sb-devbox/keep-awake-until)")"
EOF
  chmod 0755 /usr/local/bin/sb-keep-awake
  systemctl daemon-reload
  systemctl enable --now sb-idle-stop.timer
  log "idle stop on: $(meta attributes/sb-idle-minutes || echo 60) minutes"
else
  log "WARNING: no sb-idle-stop in the metadata; the machine will not stop itself"
fi

log "ready: clang $(clang++ --version | head -1 | grep -o '[0-9][0-9.]*' | head -1), node $(node --version), gh $(gh --version | head -1 | awk '{print $3}')"
