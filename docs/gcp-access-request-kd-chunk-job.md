# Google Cloud access request: the K-D chunk job, project `scoutscan`

The Cloud Run job `kd-chunk-job` builds city blocks in the cloud. Today it runs as the app's account (`agentplatform@`), with the Maps API key stored as a plain setting on the job that anyone who can view Cloud Run jobs can read. I'd like it to run as its own service account (`kd-chunk-job@`) and read its two keys from Secret Manager instead. That account, both secrets and the job's bucket already exist. What's missing are three permission grants on them. These need Owner, or Secret Manager Admin plus Service Account Admin, and my account (eli@spvce.ai) has neither.

## Please run (as a project Owner)

```bash
JOB_SA=kd-chunk-job@scoutscan.iam.gserviceaccount.com
APP_SA=agentplatform@scoutscan.iam.gserviceaccount.com

# the job's account reads its two keys
gcloud secrets add-iam-policy-binding kd-service-account --project scoutscan --member "serviceAccount:$JOB_SA" --role roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding kd-maps-api-key --project scoutscan --member "serviceAccount:$JOB_SA" --role roles/secretmanager.secretAccessor

# the app's account starts runs of the job as the job's account
gcloud iam service-accounts add-iam-policy-binding "$JOB_SA" --project scoutscan --member "serviceAccount:$APP_SA" --role roles/iam.serviceAccountUser

# the job's account reads and writes its two buckets; the app's account uses the job bucket
gcloud storage buckets add-iam-policy-binding gs://scoutscan-kd-jobs --member "serviceAccount:$JOB_SA" --role roles/storage.objectAdmin
gcloud storage buckets add-iam-policy-binding gs://scoutscan-building-training --member "serviceAccount:$JOB_SA" --role roles/storage.objectAdmin
gcloud storage buckets add-iam-policy-binding gs://scoutscan-kd-jobs --member "serviceAccount:$APP_SA" --role roles/storage.objectAdmin
```

The first three commands are the ones I can't run myself. I could run the last three (I have Storage Admin), but they're included so one paste covers everything.

Each grant applies only to the named secret, service account or bucket, not to the whole project. Running a command twice changes nothing.

## Or, instead

Grant eli@spvce.ai `roles/secretmanager.admin` and `roles/iam.serviceAccountAdmin` on `scoutscan`, and I'll run the same grants myself.

Thanks!
