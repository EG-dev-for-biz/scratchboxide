import * as fs from 'fs-extra';
import * as path from 'path';

const root = path.resolve(__dirname, '..');

// Inject secrets into process.env if needed
try {
  const secrets = JSON.parse(fs.readFileSync(path.join(root, 'secrets.json'), 'utf8'));
  if (secrets.GOOGLE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = typeof secrets.GOOGLE_SERVICE_ACCOUNT_JSON === 'string'
      ? secrets.GOOGLE_SERVICE_ACCOUNT_JSON
      : JSON.stringify(secrets.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
} catch (e) {}

// Crucial: Delete consumer Gemini API keys so Vertex AI service account is used
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_AI_API_KEY;
delete process.env.GOOGLE_API_KEY;

import { GoogleMediaCredentialsService } from '../packages/core/src/node/google-media-credentials-service';
import { GoogleMediaGenerationService } from '../packages/core/src/node/google-media-generation-service';
import { MediaAssetStore } from '../packages/core/src/node/media-asset-store';
import { createGoogleStationImageGenerator, BeautifyStationService } from '../packages/core/src/node/spatial/BeautifyStationService';
import { SurveyStationRenderService } from '../packages/core/src/node/spatial/SurveyStationRenderService';
import { SurveySynthesisEngine } from '../packages/core/src/common/spatial/SurveySynthesisEngine';

async function main() {
  console.log('Testing genuine survey beautify pipeline using Vertex AI (gemini-2.5-flash-image)...');
  const creds = new GoogleMediaCredentialsService();
  const assetStore = new MediaAssetStore();
  const mediaService = new GoogleMediaGenerationService(assetStore, () => creds.createClient());

  const generator = createGoogleStationImageGenerator({
    mediaService,
    assetStore,
    workspaceRoot: root,
    fidelity: 'production',
    imageSize: '2K',
    modelPriority: ['gemini-2.5-flash-image', 'gemini-3.1-flash-image']
  });

  const glbPath = path.join(root, 'public/models/colosseum_grounded.glb');
  const renderer = new SurveyStationRenderService();
  await renderer.loadMesh(glbPath);

  const beautifier = new BeautifyStationService(renderer, generator);

  const engine = new SurveySynthesisEngine();
  const anchor = {
    lat: 41.8902,
    lng: 12.4922,
    elevationMeters: 22.0,
    headingDeg: 0,
    formattedAddress: 'Colosseum, Rome'
  };

  const stations = engine.synthesize(anchor, {
    type: 'foveated-multi-tier',
    cameraCount: 24,
    targetRadiusMeters: 150,
    tierRadiiMeters: [110, 130, 180],
    altitudeTiersMeters: [
      anchor.elevationMeters + 3.0,
      anchor.elevationMeters + 30.0,
      anchor.elevationMeters + 75.0
    ],
    lookAtOffsetLocalENU: [0, 20, 0],
    lookAtTiersOffsetLocalENU: [
      [0, 6.0, 0],
      [0, 28.0, 0],
      [0, 20.0, 0]
    ]
  });

  // Pick Tier 2 Station 13 (elevated facade overview at ~52m altitude)
  const station = stations[12] || stations[0];
  console.log(`Using Station ${station.id}: ${station.name}`);
  console.log(`Pos: [${station.positionLocalENU.map(v => v.toFixed(1)).join(', ')}], Yaw: ${station.yawDegrees}°, Pitch: ${station.pitchDegrees}°`);

  console.log('Rendering station blockout and calling beautifier.beautify() ...');
  const t0 = Date.now();
  const res = await beautifier.beautify(
    station,
    {
      locationName: 'Rome Colosseum',
      architecturalStyle: 'Ancient Roman travertine limestone amphitheatre with arched arcades, Corinthian columns, and authentic Roman masonry under warm Mediterranean sunlight',
      moodPromptContext: 'Warm afternoon Mediterranean sunlight with realistic Roman stone shadows'
    },
    {
      width: 1280,
      height: 720,
      maxRerolls: 1
    }
  );

  const durationSec = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`Completed in ${durationSec}s!`);
  console.log(`QC Result: Accepted = ${res.accepted}, Overlap = ${res.qc.overlapPercent.toFixed(1)}%, Residual = ${res.qc.residualPx.toFixed(2)}px`);

  const outBlockout = path.join(root, 'docs/screenshots/152_colosseum_vertex_station_blockout.png');
  const outBeauty = path.join(root, 'docs/screenshots/152_colosseum_vertex_station_beautified.png');

  await fs.writeFile(outBlockout, res.blockout.png);
  await fs.writeFile(outBeauty, res.imagePng);
  console.log('Saved blockout to:', outBlockout);
  console.log('Saved beautified result to:', outBeauty);
}

main().catch(err => {
  console.error('Fatal error in Vertex AI test:', err);
  process.exit(1);
});
