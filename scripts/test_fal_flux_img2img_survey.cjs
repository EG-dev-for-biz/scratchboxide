const https = require('https');
const fs = require('fs');
const path = require('path');

let falKey = process.env.FAL_KEY;
if (!falKey) {
  try {
    const s = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../secrets.json'), 'utf8'));
    falKey = s.FAL_KEY;
  } catch (e) {}
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function runJob() {
  const tileUrl = "https://v3b.fal.media/files/b/0aac6391/lZaQSIsjiUoqHazvPu0GJ_textured_tile_1790698409719.png";
  
  const payload = {
    prompt: "High resolution aerial architectural survey photograph of the Roman Colosseum amphitheatre, pristine ancient weathered travertine marble masonry, sharp arches, natural Mediterranean afternoon lighting, clean stone pavement, crisp photographic details, eliminate photogrammetric artifacts",
    image_url: tileUrl,
    strength: 0.60,
    guidance_scale: 3.5,
    num_inference_steps: 28,
    image_size: "landscape_16_9"
  };

  console.log('Dispatching to queue.fal.run/fal-ai/flux-general/image-to-image ...');
  const queueRes = await httpPost('https://queue.fal.run/fal-ai/flux-general/image-to-image', JSON.stringify(payload), falKey);
  console.log('Queue response:', JSON.stringify(queueRes));

  if (!queueRes.status_url) throw new Error('No status_url');
  
  const startTime = Date.now();
  while (Date.now() - startTime < 300000) {
    await sleep(2500);
    const statusData = await httpGet(queueRes.status_url, falKey);
    const status = statusData.body.status;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[+${elapsed}s] Status: ${status}`);

    if (status === 'COMPLETED') {
      console.log('Completed! Fetching result...');
      const finalRes = await httpGet(queueRes.response_url, falKey);
      console.log('Result:', JSON.stringify(finalRes.body, null, 2));
      if (finalRes.body.images && finalRes.body.images[0]?.url) {
        const outUrl = finalRes.body.images[0].url;
        const imgBuf = await new Promise((resolve, reject) => {
          https.get(outUrl, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
          }).on('error', reject);
        });
        const outPath = path.resolve(__dirname, '../docs/screenshots/142_fal_flux_img2img_textured_tile.png');
        fs.writeFileSync(outPath, imgBuf);
        console.log('Saved image-to-image result to:', outPath);
      }
      return;
    }
    if (status === 'FAILED') throw new Error('Job failed: ' + JSON.stringify(statusData.body));
  }
}

runJob().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
