const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let falKey = process.env.FAL_KEY;
if (!falKey) {
  try {
    const s = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../secrets.json'), 'utf8'));
    falKey = s.FAL_KEY;
  } catch (e) {}
}

if (!falKey) {
  console.error('ERROR: No FAL_KEY found');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function uploadToFalStorage(buf, key, contentType = 'image/png') {
  const initRes = await new Promise((resolve, reject) => {
    const req = https.request('https://rest.alpha.fal.ai/storage/upload/initiate', {
      method: 'POST',
      headers: { 'Authorization': 'Key ' + key, 'Content-Type': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d)); }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ file_name: 'textured_tile_' + Date.now() + '.png', content_type: contentType }));
    req.end();
  });

  if (!initRes || !initRes.upload_url) throw new Error('Failed to initiate FAL upload: ' + JSON.stringify(initRes));
  const uploadUrl = new URL(initRes.upload_url);
  await new Promise((resolve, reject) => {
    const req = https.request(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': buf.length }
    }, res => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });

  return initRes.file_url;
}

async function httpPost(url, payload, key) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Key ' + key,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function httpGet(url, key) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Authorization': 'Key ' + key } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(d) }); } catch(e) { reject(new Error(d)); }
      });
    }).on('error', reject);
  });
}

async function runFalJob(endpoint, input, key) {
  console.log(`Submitting job to queue.fal.run/${endpoint} ...`);
  const queueRes = await httpPost(`https://queue.fal.run/${endpoint}`, JSON.stringify(input), key);
  console.log('Queue response:', JSON.stringify(queueRes));

  if (!queueRes.status_url) {
    throw new Error('No status_url in response: ' + JSON.stringify(queueRes));
  }

  const statusUrl = queueRes.status_url;
  const responseUrl = queueRes.response_url;

  const startTime = Date.now();
  while (Date.now() - startTime < 300000) {
    await sleep(2500);
    const statusData = await httpGet(statusUrl, key);
    const status = statusData.body.status;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[+${elapsed}s] Status: ${status}`);

    if (status === 'COMPLETED') {
      console.log('Job completed! Fetching result from:', responseUrl);
      const finalRes = await httpGet(responseUrl, key);
      return finalRes.body;
    }

    if (status === 'FAILED') {
      throw new Error('Fal job failed: ' + JSON.stringify(statusData.body));
    }
  }

  throw new Error('Fal job timed out after 5 minutes');
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const srcTile = path.join(root, 'docs/screenshots/91_flight_frame_01_full_textured_glb.png');
  const prepTile = path.join(root, 'docs/screenshots/140_prepared_3d_tile_texture_capture.png');

  console.log('1. Preparing 16:9 1024x576 capture of authentic 3D tile texture from:', srcTile);
  // Scale and crop to exact 1024x576 (16:9)
  execSync(`ffmpeg -y -i "${srcTile}" -vf "scale=1024:576:force_original_aspect_ratio=increase,crop=1024:576" "${prepTile}"`, { stdio: 'inherit' });

  console.log('2. Uploading authentic 3D tile texture capture to FAL storage ...');
  const tileBuf = fs.readFileSync(prepTile);
  const tileUrl = await uploadToFalStorage(tileBuf, falKey);
  console.log('Uploaded to:', tileUrl);

  const input = {
    prompt: "Authentic high resolution architectural photograph of the Roman Colosseum amphitheatre, ancient weathered travertine limestone masonry, crisp arches and arcades, classical Corinthian columns, natural Mediterranean daylight with clear blue sky, photorealistic 8k architectural survey, razor sharp masonry texture, eliminate photogrammetric melting",
    control_lora_image_url: tileUrl,
    control_lora_strength: 0.88,
    preprocess_depth: true,
    guidance_scale: 3.5,
    num_inference_steps: 28,
    image_size: "landscape_16_9"
  };

  console.log('3. Running fal-ai/flux-control-lora-depth with authentic 3D tile texture ...');
  const result = await runFalJob('fal-ai/flux-control-lora-depth', input, falKey);
  console.log('FLUX.1 [dev] Result:', JSON.stringify(result, null, 2));

  if (result.images && result.images[0]?.url) {
    const imgUrl = result.images[0].url;
    console.log('Downloading generated image from:', imgUrl);
    const imgBuf = await new Promise((resolve, reject) => {
      https.get(imgUrl, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });

    const outPath = path.resolve(__dirname, '../docs/screenshots/140_fal_flux_textured_tile_result.png');
    fs.writeFileSync(outPath, imgBuf);
    console.log('✅ Successfully saved FLUX.1 [dev] textured tile result to:', outPath);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
