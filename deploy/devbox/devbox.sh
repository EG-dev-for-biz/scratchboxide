#!/usr/bin/env bash
set -euo pipefail

################################################################################
# The Scratchbox development machine on Google Cloud (docs/processes/2026-11-03-gcloud-dev-machine.md; the plan:
# docs/research/2026-11-03-district-run-over-run-plan.md section 7a): a G2 with one NVIDIA L4, 32 vCPU and 128 GB, its
# own 2 TB balanced disk at /home, no external IP, SSH only through IAP, powered off when idle (idle-stop.sh).
#
#   deploy/devbox/devbox.sh grants      the machine's service account and every IAM binding, once (needs an admin of the
#                                       project: Owner, or Project IAM Admin + Service Account Admin + Secret Manager Admin)
#   deploy/devbox/devbox.sh create      the machine and its data disk, in the first L4 zone with capacity
#   deploy/devbox/devbox.sh metadata    startup.sh and idle-stop.sh sent to the machine again (after editing them)
#   deploy/devbox/devbox.sh start | stop | status
#   deploy/devbox/devbox.sh ssh-config  the ~/.ssh/config entry for this Mac and the Claude desktop app
#   deploy/devbox/devbox.sh prices      the machine's cost per hour and per month, from the Cloud Billing Catalog API
#
# Needs your own `gcloud auth login`. `grants` and `create` create billed or access-granting resources in the project.
#
#   PROJECT / REGION / ZONES   default scoutscan / us-central1 / "us-central1-a us-central1-b us-central1-c" (the L4 zones)
#   NAME                       default sb-devbox (the machine; its disk is $NAME-data, its account $NAME@)
#   DEV_USER                   the developer's Google account (default: gcloud's active account)
#   IDLE_MINUTES               minutes idle before it powers off (default 60; 0 never)
################################################################################

PROJECT="${PROJECT:-scoutscan}"
REGION="${REGION:-us-central1}"
ZONES="${ZONES:-us-central1-a us-central1-b us-central1-c}"
NAME="${NAME:-sb-devbox}"
MACHINE_TYPE="${MACHINE_TYPE:-g2-standard-32}"
DATA_DISK_GB="${DATA_DISK_GB:-2048}"
BOOT_DISK_GB="${BOOT_DISK_GB:-100}"
IDLE_MINUTES="${IDLE_MINUTES:-60}"
# Ubuntu 24.04 with NVIDIA's 580 driver and CUDA user libraries already installed: no driver build at boot
IMAGE_FAMILY="${IMAGE_FAMILY:-ubuntu-accelerator-2404-amd64-with-nvidia-580}"
IMAGE_PROJECT="ubuntu-os-accelerator-images"
SA="${NAME}@${PROJECT}.iam.gserviceaccount.com"
TRAINING_BUCKET="scoutscan-building-training"
JOB_BUCKET="scoutscan-kd-jobs"
KD_JOB="kd-chunk-job"
MAPS_SECRET="kd-maps-api-key"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
G=(gcloud --project "$PROJECT" --quiet)

dev_user() { echo "${DEV_USER:-$(gcloud config get-value account 2>/dev/null)}"; }

# the zone the machine is in, else empty
zone_of() { "${G[@]}" compute instances list --filter "name=$NAME" --format 'value(zone.basename())' 2>/dev/null | head -1; }

need_zone() {
  local z; z="$(zone_of)"
  [ -n "$z" ] || { echo "no machine named $NAME in $PROJECT (run: $0 create)" >&2; exit 1; }
  echo "$z"
}

grants() {
  local user; user="$(dev_user)"
  echo "[grants] APIs"
  "${G[@]}" services enable compute.googleapis.com iap.googleapis.com oslogin.googleapis.com secretmanager.googleapis.com aiplatform.googleapis.com

  echo "[grants] service account $SA"
  "${G[@]}" iam service-accounts describe "$SA" >/dev/null 2>&1 \
    || "${G[@]}" iam service-accounts create "$NAME" --display-name "Scratchbox development machine"

  # the machine's own account: Vertex AI, its logs, the Maps key, the two buckets, and the K-D chunk job (run and read,
  # not redeploy: it gets no use of the job's own account)
  echo "[grants] the machine's account: Vertex AI, logs, the Maps key, the buckets, the chunk job"
  for role in roles/aiplatform.user roles/logging.logWriter; do
    "${G[@]}" projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role "$role" --condition None >/dev/null
  done
  "${G[@]}" secrets add-iam-policy-binding "$MAPS_SECRET" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
  for b in "$TRAINING_BUCKET" "$JOB_BUCKET"; do
    "${G[@]}" storage buckets add-iam-policy-binding "gs://$b" --member "serviceAccount:$SA" --role roles/storage.objectAdmin >/dev/null
  done
  "${G[@]}" run jobs add-iam-policy-binding "$KD_JOB" --region "$REGION" --member "serviceAccount:$SA" --role roles/run.developer >/dev/null

  # the developer: make, start and stop the machine, reach it through IAP, log in with sudo (OS Login), attach its account
  echo "[grants] $user: the machine, IAP, OS Login with sudo"
  for role in roles/compute.instanceAdmin.v1 roles/iap.tunnelResourceAccessor roles/compute.osAdminLogin; do
    "${G[@]}" projects add-iam-policy-binding "$PROJECT" --member "user:$user" --role "$role" --condition None >/dev/null
  done
  "${G[@]}" iam service-accounts add-iam-policy-binding "$SA" --member "user:$user" --role roles/iam.serviceAccountUser >/dev/null

  # Google APIs from a machine with no external IP go out through the region's Cloud NAT and pay its per-GB charge;
  # Private Google Access sends them (the bucket, Vertex, Secret Manager) straight to Google instead, at no charge
  echo "[grants] Private Google Access on the default subnet in $REGION"
  "${G[@]}" compute networks subnets update default --region "$REGION" --enable-private-ip-google-access
  echo "[grants] done"
}

# SSH reaches the machine only from IAP's range; the project's rule may already cover every instance
network() {
  local covered
  covered="$("${G[@]}" compute firewall-rules list --format json 2>/dev/null | NAME="$NAME" python3 -c '
import json, os, sys
for r in json.load(sys.stdin):
    tags = r.get("targetTags")
    if (r["network"].endswith("/default") and r["direction"] == "INGRESS" and not r.get("disabled")
            and "35.235.240.0/20" in r.get("sourceRanges", []) and (not tags or os.environ["NAME"] in tags)
            and any(a["IPProtocol"] in ("tcp", "all") and ("22" in a.get("ports", ["22"])) for a in r.get("allowed", []))):
        print(r["name"]); break')"
  if [ -n "$covered" ]; then
    echo "[network] SSH from IAP (35.235.240.0/20) is allowed by $covered"
  else
    echo "[network] firewall rule $NAME-iap-ssh: tcp:22 from IAP's range only, to this machine's tag"
    "${G[@]}" compute firewall-rules create "$NAME-iap-ssh" --network default --direction INGRESS --action allow \
      --rules tcp:22 --source-ranges 35.235.240.0/20 --target-tags "$NAME"
  fi
  "${G[@]}" compute routers nats list --router gcp-3d-ai-router --region "$REGION" --format 'value(name,sourceSubnetworkIpRangesToNat)' 2>/dev/null \
    | grep -q ALL_SUBNETWORKS \
    && echo "[network] egress (npm, pip, GitHub) through the region's Cloud NAT gcp-3d-ai-nat" \
    || echo "[network] WARNING: no Cloud NAT covers $REGION's subnets: the machine has no route to npm, pip or GitHub"
}

create() {
  [ -z "$(zone_of)" ] || { echo "$NAME already exists in $(zone_of)"; exit 1; }
  network
  local z
  for z in $ZONES; do
    echo "[create] $NAME ($MACHINE_TYPE, one L4) in $z"
    if "${G[@]}" compute instances create "$NAME" --zone "$z" \
        --machine-type "$MACHINE_TYPE" --maintenance-policy TERMINATE --restart-on-failure \
        --image-family "$IMAGE_FAMILY" --image-project "$IMAGE_PROJECT" \
        --boot-disk-size "${BOOT_DISK_GB}GB" --boot-disk-type pd-balanced \
        --create-disk "name=$NAME-data,size=${DATA_DISK_GB}GB,type=pd-balanced,device-name=sb-data,auto-delete=no" \
        --no-address --tags "$NAME" \
        --service-account "$SA" --scopes cloud-platform \
        --labels "purpose=dev-machine,app=scratchbox" \
        --metadata "enable-oslogin=TRUE,sb-idle-minutes=$IDLE_MINUTES" \
        --metadata-from-file "startup-script=$HERE/startup.sh,sb-idle-stop=$HERE/idle-stop.sh"; then
      echo "[create] up in $z. First boot installs the toolchain (about 10 minutes): $0 status"
      return 0
    fi
    echo "[create] $z refused it (often no G2 capacity); trying the next zone"
  done
  echo "[create] no zone in '$ZONES' had capacity" >&2
  exit 1
}

metadata() {
  local z; z="$(need_zone)"
  "${G[@]}" compute instances add-metadata "$NAME" --zone "$z" \
    --metadata "sb-idle-minutes=$IDLE_MINUTES" \
    --metadata-from-file "startup-script=$HERE/startup.sh,sb-idle-stop=$HERE/idle-stop.sh"
  echo "[metadata] sent; the machine reads them at its next boot (or: sudo google_metadata_script_runner startup)"
}

start() {
  local z; z="$(need_zone)"
  "${G[@]}" compute instances start "$NAME" --zone "$z"
}

stop() {
  local z; z="$(need_zone)"
  "${G[@]}" compute instances stop "$NAME" --zone "$z"
}

status() {
  local z; z="$(need_zone)"
  "${G[@]}" compute instances describe "$NAME" --zone "$z" \
    --format 'table(name,zone.basename(),machineType.basename(),status,lastStartTimestamp,lastStopTimestamp)'
  echo "first-boot provisioning (serial port, last lines):"
  "${G[@]}" compute instances get-serial-port-output "$NAME" --zone "$z" 2>/dev/null | grep -E 'sb-devbox|startup-script' | tail -8 || true
}

ssh_config() {
  local z user login gcloud_bin
  z="$(need_zone)"
  user="$(dev_user)"
  # OS Login's POSIX name: the account with every character but letters and digits made '_'
  login="$(echo "$user" | sed 's/[^A-Za-z0-9]/_/g')"
  gcloud_bin="$(command -v gcloud)"
  cat <<EOF
# Scratchbox development machine ($NAME, $PROJECT, $z): through IAP, started on demand by ssh-proxy.sh
Host $NAME
  HostName $NAME
  User $login
  IdentityFile ~/.ssh/google_compute_engine
  IdentitiesOnly yes
  ProxyCommand $HERE/ssh-proxy.sh $NAME $z $PROJECT $gcloud_bin
  ServerAliveInterval 30
  ServerAliveCountMax 6
  StrictHostKeyChecking accept-new
  HostKeyAlias compute.$NAME.$PROJECT
EOF
}

# Prices from the Cloud Billing Catalog API (the public SKUs of Compute Engine and Networking), on demand
prices() {
  local token
  token="$(gcloud auth print-access-token)"
  CLOUDSDK_TOKEN="$token" REGION="$REGION" DATA_DISK_GB="$DATA_DISK_GB" BOOT_DISK_GB="$BOOT_DISK_GB" python3 - <<'PY'
import json, os, urllib.request
token, region = os.environ['CLOUDSDK_TOKEN'], os.environ['REGION']
def catalog(service):
    skus, page = [], ''
    while True:
        url = f'https://cloudbilling.googleapis.com/v1/services/{service}/skus?pageSize=5000&currencyCode=USD' + (f'&pageToken={page}' if page else '')
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})) as r:
            d = json.load(r)
        skus += d.get('skus', [])
        page = d.get('nextPageToken')
        if not page:
            return skus
compute, networking = catalog('6F81-5844-456A'), catalog('E505-1604-58F8')
def price(skus, desc, where):
    for s in skus:
        if s['description'] == desc and where in s.get('serviceRegions', []) and s['category']['usageType'] == 'OnDemand':
            pe = s['pricingInfo'][0]['pricingExpression']
            u = pe['tieredRates'][-1]['unitPrice']
            return int(u.get('units', 0)) + u.get('nanos', 0) / 1e9, pe['usageUnitDescription']
    raise SystemExit(f'no SKU "{desc}" in {where}')
cpu, cpu_u = price(compute, 'G2 Instance Core running in Americas', region)
ram, ram_u = price(compute, 'G2 Instance Ram running in Americas', region)
gpu, gpu_u = price(compute, 'Nvidia L4 GPU running in Americas', region)
pd, pd_u = price(compute, 'Balanced PD Capacity', region)
nat, nat_u = price(networking, 'Networking Cloud Nat Gateway Uptime', 'global')
natgb, natgb_u = price(networking, 'Networking Cloud Nat Data Processing', 'global')
data_gb, boot_gb = int(os.environ['DATA_DISK_GB']), int(os.environ['BOOT_DISK_GB'])
hours = 730
running = 32 * cpu + 128 * ram + gpu
disks = (data_gb + boot_gb) * pd
print(f'G2 vCPU            {cpu:.6f} USD per {cpu_u} x 32  = {32 * cpu:.4f} /h')
print(f'G2 memory          {ram:.6f} USD per {ram_u} x 128 = {128 * ram:.4f} /h')
print(f'NVIDIA L4          {gpu:.6f} USD per {gpu_u} x 1   = {gpu:.4f} /h')
print(f'Cloud NAT gateway  {nat:.6f} USD per {nat_u} per machine using it = {nat:.4f} /h')
print(f'running: vCPU + memory + GPU + NAT gateway = {running + nat:.4f} /h')
print(f'balanced PD        {pd:.6f} USD per {pd_u}: data {data_gb} GB = {data_gb * pd:.2f}, boot {boot_gb} GB = {boot_gb * pd:.2f}; {disks:.2f} /month = {disks / hours:.4f} /h, running or stopped')
print(f'running, all in: {running + nat + disks / hours:.4f} /h; stopped: {disks / hours:.4f} /h')
print(f'Cloud NAT traffic  {natgb:.6f} USD per {natgb_u} through the NAT (npm, pip, GitHub; Google APIs too unless Private Google Access is on)')
PY
}

case "${1:-}" in
  grants) grants ;;
  network) network ;;
  create) create ;;
  metadata) metadata ;;
  start) start ;;
  stop) stop ;;
  status) status ;;
  ssh-config) ssh_config ;;
  prices) prices ;;
  *) sed -n '4,22p' "$0"; exit 2 ;;
esac
