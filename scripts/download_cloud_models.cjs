/**
 * Download Trained Models and Checkpoints from Google Cloud Run / Cloud Storage to Local Drive.
 * 
 * Supports:
 * - 4DAnyone / 4DGS Humanoid Models and SMPL-X Base Weights (scratchbox-canvas-4danyone-artifacts)
 * - OmniRoam Preview & Refine Checkpoints (wander-ray-models-scratchbox-canvas)
 * - GeoBox Location Checkpoints & Gallery (scratchbox-canvas-geobox)
 */

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { GoogleAuth } = require('google-auth-library');

const REPO_ROOT = path.resolve(__dirname, '..');

function loadCredentials() {
  const secretsPath = path.join(REPO_ROOT, 'secrets.json');
  if (!fs.existsSync(secretsPath)) {
    throw new Error(`Cannot find ${secretsPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  const sa = raw.GOOGLE_SERVICE_ACCOUNT_JSON
    ? (typeof raw.GOOGLE_SERVICE_ACCOUNT_JSON === 'string'
        ? JSON.parse(raw.GOOGLE_SERVICE_ACCOUNT_JSON)
        : raw.GOOGLE_SERVICE_ACCOUNT_JSON)
    : raw;
  return sa;
}

async function getAccessToken(sa) {
  const auth = new GoogleAuth({
    credentials: sa,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  return tokenResponse.token;
}

async function downloadFile(bucket, objectName, localPath, token) {
  fs.mkdirSync(path.dirname(localPath), { recursive: true });

  // Get object metadata for size verification
  const metaUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}`;
  const metaRes = await fetch(metaUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!metaRes.ok) {
    throw new Error(`Failed to fetch metadata for gs://${bucket}/${objectName}: ${metaRes.statusText}`);
  }
  const meta = await metaRes.json();
  const remoteSize = parseInt(meta.size, 10);

  // Check if file already exists with same size
  if (fs.existsSync(localPath)) {
    const stat = fs.statSync(localPath);
    if (stat.size === remoteSize) {
      console.log(`⏩ [Skip] Already up to date: ${path.relative(REPO_ROOT, localPath)} (${(remoteSize / 1024 / 1024).toFixed(2)} MB)`);
      return;
    }
  }

  console.log(`⬇️  [Download] gs://${bucket}/${objectName} -> ${path.relative(REPO_ROOT, localPath)} (${(remoteSize / 1024 / 1024).toFixed(2)} MB)`);
  const t0 = Date.now();
  const mediaUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}?alt=media`;
  const mediaRes = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!mediaRes.ok) {
    throw new Error(`Failed to download gs://${bucket}/${objectName}: ${mediaRes.statusText}`);
  }

  const tmpPath = `${localPath}.part`;
  const fileStream = fs.createWriteStream(tmpPath);
  await new Promise((resolve, reject) => {
    Readable.fromWeb(mediaRes.body).pipe(fileStream).on('finish', resolve).on('error', reject);
  });

  fs.renameSync(tmpPath, localPath);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const mbps = (remoteSize / 1024 / 1024 / (elapsed > 0 ? elapsed : 1)).toFixed(2);
  console.log(`✅ [Done] ${path.relative(REPO_ROOT, localPath)} downloaded in ${elapsed}s (${mbps} MB/s)`);
}

async function downloadPrefix(bucket, prefix, localBaseDir, token, maxItems = 1000) {
  let pageToken = '';
  let items = [];
  do {
    const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o?prefix=${encodeURIComponent(prefix)}&maxResults=1000${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`List failed: ${res.statusText}`);
    const data = await res.json();
    if (data.items) items = items.concat(data.items);
    pageToken = data.nextPageToken;
    if (items.length >= maxItems) break;
  } while (pageToken);

  console.log(`📦 Found ${items.length} files under gs://${bucket}/${prefix}`);
  for (const item of items) {
    if (item.name.endsWith('/')) continue;
    const relPath = item.name.slice(prefix.length).replace(/^\//, '');
    const localPath = path.join(localBaseDir, relPath);
    await downloadFile(bucket, item.name, localPath, token);
  }
}

async function main() {
  const sa = loadCredentials();
  console.log(`🔑 Service Account: ${sa.client_email} (Project: ${sa.project_id})`);
  let token = await getAccessToken(sa);
  console.log('✅ Acquired OAuth2 access token.\n');

  // 1. SMPL-X Body Models (311 MB)
  console.log('--- Step 1: Downloading SMPL-X Body Models ---');
  const smplxFiles = [
    'models/body_models/smplx/SMPLX_FEMALE.npz',
    'models/body_models/smplx/SMPLX_MALE.npz',
    'models/body_models/smplx/SMPLX_NEUTRAL.npz'
  ];
  for (const file of smplxFiles) {
    const local = path.join(REPO_ROOT, 'models', 'smplx', path.basename(file));
    await downloadFile('scratchbox-canvas-4danyone-artifacts', file, local, token);
  }

  // 2. 4DAnyone Trained 4DGS Humanoid Models (artifacts/ ~86 MB and demos/ ~98 MB)
  console.log('\n--- Step 2: Downloading 4DAnyone Trained Humanoid Models (4DGS) ---');
  await downloadPrefix('scratchbox-canvas-4danyone-artifacts', 'artifacts/', path.join(REPO_ROOT, 'models', '4danyone', 'artifacts'), token);
  await downloadPrefix('scratchbox-canvas-4danyone-artifacts', 'demos/', path.join(REPO_ROOT, 'models', '4danyone', 'demos'), token);

  // 3. OmniRoam Foundation Checkpoints (~6 GB)
  console.log('\n--- Step 3: Downloading OmniRoam Checkpoints ---');
  const omniFiles = [
    'OmniRoam/Preview/preview.ckpt',
    'OmniRoam/Refine/refine.ckpt'
  ];
  for (const file of omniFiles) {
    const local = path.join(REPO_ROOT, 'models', 'omniroam', path.basename(file));
    await downloadFile('wander-ray-models-scratchbox-canvas', file, local, token);
  }

  // 4. GeoBox Checkpoint and Gallery
  console.log('\n--- Step 4: Verifying GeoBox Checkpoint & Gallery ---');
  const geoboxLocal = path.join(REPO_ROOT, 'build', 'geobox_checkpoints', 'geobox_real_trained.pt');
  await downloadFile('scratchbox-canvas-geobox', 'checkpoints/geobox_real_trained.pt', geoboxLocal, token);

  const galleryLocal = path.join(REPO_ROOT, 'build', 'geobox_checkpoints', 'coordinates_100K.npy');
  await downloadFile('scratchbox-canvas-geobox', 'gallery/coordinates_100K.npy', galleryLocal, token);

  console.log('\n======================================================');
  console.log('🎉 All Cloud Run trained models successfully downloaded!');
  console.log('======================================================');
}

main().catch(err => {
  console.error('❌ Download failed:', err);
  process.exit(1);
});
