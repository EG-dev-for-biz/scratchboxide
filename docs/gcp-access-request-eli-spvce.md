# Google Cloud access request: eli@spvce.ai, project `scoutscan`

I need to create storage buckets and run the app's processing in the cloud (Cloud Run GPU inference, Vertex AI training). Today my account cannot write to the app's buckets (403 on `scoutscan-splat-worlds`).

## 1. Project roles for eli@spvce.ai

| Need | Role |
|---|---|
| Create buckets, set their permissions, read and write objects | `roles/storage.admin` |
| Deploy and run the Cloud Run GPU services | `roles/run.admin` |
| Start Vertex AI custom training jobs | `roles/aiplatform.user` |
| Run services and jobs as the project's service account | `roles/iam.serviceAccountUser` |
| Build and push the container images | `roles/cloudbuild.builds.editor`, `roles/artifactregistry.writer` |
| Read logs when something fails | `roles/logging.viewer` |
| Enable APIs the project hasn't used yet | `roles/serviceusage.serviceUsageAdmin` |

One command, run by a project Owner:

```bash
for r in storage.admin run.admin aiplatform.user iam.serviceAccountUser cloudbuild.builds.editor artifactregistry.writer logging.viewer serviceusage.serviceUsageAdmin; do
  gcloud projects add-iam-policy-binding scoutscan --member=user:eli@spvce.ai --role=roles/$r --condition=None
done
```

## 2. Existing buckets

Please confirm each exists, and that both eli@spvce.ai and the processing service account have Storage Object Admin on it.

| Bucket | Holds |
|---|---|
| `scoutscan-splat-worlds` | Built splat worlds and their saved scene versions (currently denies eli@spvce.ai) |
| `scoutscan-building-training` | Location build caches (tiles, district parts, remeshes) and training records |
| `scoutscan-trellis-jobs` | Inputs and outputs of the Trellis GPU services |
| `scoutscan-pbr-library` | Surface material texture library |
| `scoutscan-multiview-artifacts` | Multi-view capture outputs |
| `scoutscan-geobox` | Geo and location data |

## 3. New buckets

| Bucket | Holds | Settings |
|---|---|---|
| `scoutscan-districts` | Finished district massing and scenes, one folder per place | Standard storage |
| `scoutscan-processing-scratch` | Intermediate files from cloud jobs | Lifecycle: delete objects after 14 days |
| `scoutscan-model-weights` | Model weights for the GPU services | Standard storage; read-only for the service account |

All buckets: region **us-central1** (beside the Cloud Run GPU and Vertex AI work; match the existing buckets' region if different), uniform bucket-level access, public access prevention enforced.

## 4. Processing service account

`agentplatform@scoutscan.iam.gserviceaccount.com` (or whichever account the services and jobs run as):

- Storage Object Admin on every bucket above
- `roles/artifactregistry.reader` to pull images

## 5. GPU quota (us-central1)

- Cloud Run: NVIDIA L4 GPU quota
- Vertex AI: custom training GPU quota

Thanks!
