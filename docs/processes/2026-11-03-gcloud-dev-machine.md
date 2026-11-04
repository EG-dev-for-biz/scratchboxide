# Process: the Scratchbox development machine on Google Cloud

> **Recorded:** 2026-11-03
> **Status:** Unverified (scripts written and checked read-only; the machine is not created yet: it needs the admin step below)
> **Tags:** `operate-scratchbox` `google-cloud` `dev-machine` `iap` `gpu`
> **Target Domain:** Development infrastructure

The plan is section 7a of `docs/research/2026-11-03-district-run-over-run-plan.md`. Claude sessions, builds and tests run on
a G2 machine in `scoutscan` instead of on the overloaded Mac. The Mac keeps the Metal path tracer and your viewing. The
user approved the machine on 2026-11-03 ("Yes, set it up").

---

## 1. The machine

| | |
|---|---|
| Name | `sb-devbox`, project `scoutscan`, the first of `us-central1-a/b/c` with G2 capacity (the bucket and the chunk jobs are in `us-central1`) |
| Shape | `g2-standard-32`: 32 vCPU, 128 GB, one NVIDIA L4 (24 GB) |
| Image | `ubuntu-accelerator-2404-amd64-with-nvidia-580` (Ubuntu 24.04 with NVIDIA's 580 driver: nothing to build at boot) |
| Disks | 100 GB balanced boot disk; **2 TB balanced data disk mounted at `/home`** (every checkout, worktree, cache and venv), kept when the machine is deleted |
| Network | **No external IP.** SSH only through IAP: the project's rule `allow-ssh-ingress-from-iap` (35.235.240.0/20, tcp:22) already covers it. Egress (npm, pip, GitHub) through the region's existing Cloud NAT `gcp-3d-ai-nat`; no new NAT. Private Google Access on the subnet sends the bucket, Vertex and Secret Manager past the NAT |
| Login | OS Login: your Google account, POSIX name `eli_spvce_ai`, with sudo |
| Account | `sb-devbox@scoutscan.iam.gserviceaccount.com`, attached (no key file): Vertex AI user, log writer, `secretAccessor` on `kd-maps-api-key`, object admin on `scoutscan-building-training` and `scoutscan-kd-jobs`, `run.developer` on the `kd-chunk-job` job (run and read executions; it gets no use of the job's own account, so it cannot redeploy it) |
| Toolchain | `startup.sh`: clang 19 as `clang++`, Node 22.18 through nvm (system-wide, `/opt/nvm`, on every PATH), git, git-lfs, the GitHub CLI, Python 3.12 with venv, ffmpeg; `bootstrap-user.sh`: `npm ci`, `.venv` from `requirements.txt` (PyPI's Linux torch wheels carry CUDA; the script fails unless torch sees the L4), Depth Anything V2 Small's weights |
| Secrets | Read from Secret Manager by `app-env.sh` into the app's own environment when it starts: never a file, never printed, never in a test's environment |

Everything is in `deploy/devbox/`:

| File | Runs where | Does |
|---|---|---|
| `devbox.sh` | your Mac | `grants` (admin, once), `create`, `metadata`, `start`, `stop`, `status`, `ssh-config`, `prices` |
| `startup.sh` | the machine, as root, every boot | the data disk at `/home`, the toolchain (once), the GPU check, the idle stop |
| `idle-stop.sh` | the machine, every 5 minutes | powers it off when idle (below) |
| `bootstrap-user.sh` | the machine, as you, in a checkout | Node packages, the CUDA venv, the depth weights, the `scratchbox-devbox` launch entry |
| `app-env.sh` | the machine | runs the app with Vertex AI through the machine's account, the bucket, and the secrets |
| `ssh-proxy.sh` | your Mac, as SSH's ProxyCommand | starts the machine when it is off, then tunnels SSH through IAP |

## 2. Cost

From the Cloud Billing Catalog API (`deploy/devbox/devbox.sh prices`, 2026-11-03, on-demand, us-central1):

| Item | Price | This machine |
|---|---|---|
| G2 vCPU | $0.024988 per vCPU hour | 32 vCPU: $0.7996 /h |
| G2 memory | $0.002927 per GiB hour | 128 GiB: $0.3747 /h |
| NVIDIA L4 | $0.560040 per GPU hour | 1: $0.5600 /h |
| Cloud NAT gateway | $0.0014 per machine hour | $0.0014 /h |
| **Running** | | **$1.7358 /h** |
| Balanced persistent disk | $0.10 per GiB month | 2,048 + 100 GiB: $214.80 /month ($0.2942 /h), running or stopped |
| **Running, disks included** | | **$2.0300 /h** |
| Cloud NAT data processing | $0.045 per GiB | npm, pip and GitHub traffic only, with Private Google Access on |

A working day of 8 hours is about $13.89 of machine; the disks are $214.80 a month whether it runs or not.

## 3. Idle stop

Every 5 minutes `sb-idle-stop.timer` checks three things. The machine counts as idle when all three hold:
- no SSH connection is open: a terminal, the Claude desktop app, or a port forward to the app;
- the 15-minute load average is under 1.0 (a build, a test run or a compile keeps it above);
- no keep-awake time is still to come.

Idle at every check for **60 minutes in a row**, it powers itself off. Compute Engine marks it `TERMINATED`, and the vCPU,
memory and GPU charges stop. Both disks stay, and so does everything on them.

- **Start it again:** just connect. `ssh sb-devbox`, or the desktop app's SSH connection, goes through `ssh-proxy.sh`,
  which starts the machine and waits for it (about a minute). Or run `deploy/devbox/devbox.sh start`.
- **Keep it on with nobody connected** (an unattended build): `sb-keep-awake 4` on the machine keeps it on for 4 hours.
- **Change the wait:** `IDLE_MINUTES=90 deploy/devbox/devbox.sh metadata`, then reboot; `0` never stops it.
- **Its log:** `journalctl -t sb-idle-stop` on the machine.

## 4. Set-up steps

1. **The admin step, once.** Your account `eli@spvce.ai` cannot create machines, grant IAM roles or open IAP tunnels in
   `scoutscan`; the org's admins are `hanno@spvce.ai` and `alex@spvce.ai`. One of them runs, from a checkout of this
   branch, `DEV_USER=eli@spvce.ai deploy/devbox/devbox.sh grants`. It creates `sb-devbox@` and grants:
   - the machine's account the roles in section 1;
   - you `compute.instanceAdmin.v1`, `iap.tunnelResourceAccessor`, `compute.osAdminLogin`, and `serviceAccountUser` on
     `sb-devbox@`;
   - Private Google Access on the `default` subnet in `us-central1`.
2. **Create the machine.** Run `deploy/devbox/devbox.sh create`. The first boot installs the toolchain in about 10
   minutes; `deploy/devbox/devbox.sh status` shows its progress.
3. **SSH from the Mac.** Run `gcloud compute os-login ssh-keys add --key-file ~/.ssh/google_compute_engine.pub` once (if
   the key does not exist, `gcloud compute ssh sb-devbox --tunnel-through-iap` makes and registers it). Then append
   `deploy/devbox/devbox.sh ssh-config` to `~/.ssh/config`.
4. **The checkout**, then `deploy/devbox/bootstrap-user.sh` in it.

## 5. The Claude desktop app

Add the machine as an SSH connection named **`sb-devbox`**. The host is `sb-devbox`, the alias from `~/.ssh/config` above;
the app's SSH uses that entry, its ProxyCommand included. Sessions then start on the machine, and their worktrees, builds
and tests run there. The app keeps binding `127.0.0.1`, so the launch token stays loopback-only. To open the app from the
Mac, forward its three ports:

```bash
ssh -N -L 3730:127.0.0.1:3730 -L 3731:127.0.0.1:3731 -L 3732:127.0.0.1:3732 sb-devbox
```

Then open `http://localhost:3730/?token=<the token the dev server prints>` in the Browser pane.

## 6. Tests on the machine

`vitest.config.ts` gives every test `SCRATCHBOX_TORCH_DEVICE=cpu`, which pins the torch sidecars' auto device to the CPU.
It also gives `METADATA_SERVER_DETECTION=none`, which keeps Google's client libraries away from the machine's
service-account credentials, so a test cannot reach Vertex or the bucket. Run tests as on the Mac: only the files you
touched, plus `npm run typecheck`, with at most 4 workers.

---

## 7. What was tested & what worked (Verified)

* **Network check** — `devbox.sh network` → `allow-ssh-ingress-from-iap` allows SSH from IAP; `gcp-3d-ai-nat` covers
  every subnet in `us-central1`.
* **Prices** — `devbox.sh prices` → the table in section 2, read from the Cloud Billing Catalog API.
* **Cache size** — `gcloud storage du -s` on `gs://scoutscan-building-training/cache/v1/` (2026-11-03): `staged_location`
  160.6 GB, `tile_refine` 165.6 GB, `tile_vegetation` 5.1 GB, about 331 GB in all. A build restores only the entries it
  asks for, so the 2 TB disk holds the whole mirror with room for checkouts and new runs. The bucket is in `us-central1`
  and reached over Private Google Access, so the restores cross no NAT and cost no egress.

## 8. What broke / didn't work

* **No machine yet:** `eli@spvce.ai` holds `run.admin`, `storage.admin`, `artifactregistry.editor`, `iam.serviceAccountUser`
  and some viewer roles in `scoutscan`. `testIamPermissions` returns none of `compute.instances.create`,
  `iam.serviceAccounts.create`, `resourcemanager.projects.setIamPolicy`, `secretmanager.secrets.setIamPolicy` or
  `iap.tunnelInstances.accessViaIAP`. The app's own account (`agentplatform@`, Editor) can create machines but cannot
  grant roles or open IAP tunnels, so the admin step is needed whichever account creates the machine.

## 9. Not ours, seen in the project

* `ray-sbgs-ray-cluster-head-10d2a00d-compute` (n1-standard-4, `us-central1-a`, RUNNING since 2026-06-10, account
  `ray-autoscaler-sa-v1@`, project Editor): owner unknown; left alone.
* `gcp-3d-ai-vm` (n1-standard-8, `us-central1-a`, TERMINATED).
* The firewall rule `default-allow-ssh` allows tcp:22 from `0.0.0.0/0` to every instance with an external IP (this
  machine has none), and `default-allow-rdp` allows tcp:3389 the same way.
