const fs = require('fs');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

async function main() {
  const serviceAccountPath = path.resolve(__dirname, '../service-account.json');
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(`Service account not found at ${serviceAccountPath}`);
  }

  const sa = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  const projectId = sa.project_id || 'scoutscan';
  console.log(`Using GCP Project: ${projectId}`);

  const auth = new GoogleAuth({
    keyFile: serviceAccountPath,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });

  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const accessToken = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse.token;
  console.log('Successfully acquired Google Cloud access token.');

  // Load test image
  const inputImagePath = path.resolve(__dirname, '../test_streetview.jpg');
  if (!fs.existsSync(inputImagePath)) {
    throw new Error(`Input image not found at ${inputImagePath}`);
  }

  const imageBuffer = fs.readFileSync(inputImagePath);
  const base64Image = imageBuffer.toString('base64');
  console.log(`Loaded test image (${inputImagePath}), size: ${imageBuffer.length} bytes`);

  // Models to test in order of preference
  const candidateModels = [
    'imagegeneration@006',
    'imagegeneration@005',
    'imagegeneration@002',
    'imagen-4.0-upscale-preview',
    'imagen-3.0-generate-001'
  ];

  const locations = ['us-central1'];

  for (const location of locations) {
    for (const model of candidateModels) {
      const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predict`;
      console.log(`\nAttempting upscale with model: ${model} in ${location}...`);
      console.log(`POST ${url}`);

      const requestBody = {
        instances: [
          {
            prompt: '',
            image: {
              bytesBase64Encoded: base64Image
            }
          }
        ],
        parameters: {
          sampleCount: 1,
          mode: 'upscale',
          upscaleConfig: {
            upscaleFactor: 'x2'
          }
        }
      };

      try {
        const startTime = Date.now();
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`Response status: ${res.status} ${res.statusText} (${elapsed}s)`);

        if (!res.ok) {
          const errorText = await res.text();
          console.error(`Error from ${model}:`, errorText.slice(0, 300));
          continue;
        }

        const data = await res.json();
        if (data.predictions && data.predictions.length > 0) {
          const prediction = data.predictions[0];
          const b64Out = prediction.bytesBase64Encoded;
          if (b64Out) {
            const outBuf = Buffer.from(b64Out, 'base64');
            const outputPath = path.resolve(__dirname, '../upscaled_output.png');
            fs.writeFileSync(outputPath, outBuf);
            console.log(`\nSUCCESS! Upscaled image written to: ${outputPath}`);
            console.log(`Output image size: ${outBuf.length} bytes`);
            return;
          } else {
            console.log('Prediction received but no bytesBase64Encoded:', Object.keys(prediction));
          }
        } else {
          console.log('No predictions returned:', JSON.stringify(data).slice(0, 300));
        }
      } catch (err) {
        console.error(`Request exception for ${model}:`, err.message);
      }
    }
  }

  throw new Error('All model attempts failed or were unavailable.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
