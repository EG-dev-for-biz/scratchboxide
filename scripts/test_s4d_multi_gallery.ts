import fs from 'node:fs';
import path from 'node:path';
import { S4DWorldModelBridge } from '../packages/core/src/node/spatial/S4DWorldModelBridge.js';
import { GeospatialSemanticClass } from '../packages/core/src/common/geospatial-4d-protocol.js';

interface DistrictEvaluation {
  id: string;
  name: string;
  wgs84: { lat: number; lng: number; alt: number };
  durationMs: number;
  occupancyRatePct: number;
  temporalConsistencyPct: number;
  maxSpeedKmh: number;
  classDistribution: Record<string, { count: number; pct: number }>;
  waypoints: { x: number; y: number; z: number; speedKmh: number }[];
  frames: { time: number; voxels: number[][] }[];
  localImage: string;
  aiImageUrl: string;
  aiDescription: string;
  videoAvailable?: boolean;
  videoSources?: {
    comparison: { local: string; gcs: string };
    synthesis: { local: string; gcs: string };
    blockout: { local: string; gcs: string };
  };
  storyboardBeats?: string[];
}

const comparisonSignedUrl = 'https://scratchbox-canvas-4danyone-artifacts.storage.googleapis.com/s4d_viewer/videos/s4d_manhattan_comparison.mp4?x-goog-signature=6e305c4da4e98878a26461426dea4a67110152cf88d38ce8f420e3e3f65c47b0075f38169fa4554168ff92ab6eeff23c047fa0fb78c83e859a73f4a8247793f3058abb60f5a9bb8dd1e07345f985b0a2e7027f1091b37570f34dbbc6364ee18c7ac406fe67c8038222a238b6808234d32c3e64f8205e4b230b480791ac4d72c705fa48aeb4406cb0ebae62554c842e8708f2bd51275748520ba3b685b37fc9c563727e0c5a0748f55b32b42f937b9cc6e4e39188ecf5f42b47616e014dd66e08750c03fd8c645771533c5e34aba3d513fba975ac3dcdb6afc8be118f1ad06ee422f40d17d42c3fa7c7db08e0ab65802351aef806a872d9271d6c60e5628f6b66&x-goog-algorithm=GOOG4-RSA-SHA256&x-goog-credential=credit%40scratchbox-canvas.iam.gserviceaccount.com%2F20260917%2Fus-central1%2Fstorage%2Fgoog4_request&x-goog-date=20260917T155544Z&x-goog-expires=604800&x-goog-signedheaders=host';
const synthesisSignedUrl = 'https://scratchbox-canvas-4danyone-artifacts.storage.googleapis.com/s4d_viewer/videos/s4d_manhattan_omni_synthesis.mp4?x-goog-signature=1cc2ddc1acbe043e876fca30eb1b0b9052b8dc498f069d7201304de3275e9e994076be19cdb9bd80bd91973e33f0bc1343a1283315b6c6ff58228bcec094f3f94aea692f3335a522b9b48e3e5f802bd075e142aa3157eaa0e0edd5b3f02b3dafe61ff2c70c59963bfd0539b253e3b76853f4ec6ccf258feaf179992cd5d20819fb6f8258dec8cd9f0ea0f5217645a9e44454dac0c1ec0c9f9b09133dd6aa5d95095679200ee848cac7a36d74401a63c4eeab733f62155dc737a6bb019a03e5c3ccdbc86b9d9fb5dec9e35282e7091717c7573264ef5aed026ab3c9c7b83a23c2ef269cd188fa3afae88e7c297350d5c216bff0e7feaad0bf508f5165faf958c6&x-goog-algorithm=GOOG4-RSA-SHA256&x-goog-credential=credit%40scratchbox-canvas.iam.gserviceaccount.com%2F20260917%2Fus-central1%2Fstorage%2Fgoog4_request&x-goog-date=20260917T155545Z&x-goog-expires=604800&x-goog-signedheaders=host';
const blockoutSignedUrl = 'https://scratchbox-canvas-4danyone-artifacts.storage.googleapis.com/s4d_viewer/videos/s4d_manhattan_blockout_ref.mp4?x-goog-signature=27afa871cd185dae604cafcd9785ab90ad8ec5266da531ea758171f5ff8ff1c86f55f36786221391a3ed23f689f577f898eea8d69791fe0b0574c1b0ad3bce619e3146934433d64b4fa1155ea8e5c815939bb765ce85bc7032b06a699b4949b64ade834406b3e9a76ab539b01667371ed29df89ae84a4e61a8aee885282fdec4ccc9ede586e6a1d33c33c0be3662f44553b87b7944d88f818237527b0f0cb7bc9243676856a0e651cb39378e5cc42cc40ba2f8353bd2b7ac396faa0f0a5adc65566195017bee9739abf97c05c35fcdc98f6dfe4dd5c4a694e40abfc7271c4e34d134622bd2b729d770be6cf91ff6ffc59865998fbdab0a9dd748a71c422fd6a2&x-goog-algorithm=GOOG4-RSA-SHA256&x-goog-credential=credit%40scratchbox-canvas.iam.gserviceaccount.com%2F20260917%2Fus-central1%2Fstorage%2Fgoog4_request&x-goog-date=20260917T155546Z&x-goog-expires=604800&x-goog-signedheaders=host';

const samples = [
  {
    name: 'Manhattan Canyon Corridor',
    prompt: 'data/test_sample_prompt.json',
    tensor: 'data/test_sample_tensor.rle',
    localImage: 'images/manhattan_ai.png',
    aiImageUrl: 'https://scratchbox-canvas-4danyone-artifacts.storage.googleapis.com/s4d_viewer/images/manhattan_ai.png?x-goog-signature=4b60b2dd8c9fa443213386927da5f5d83ae04467d1303ba7c8aa9f7f48e3cf346062f6ea5278eaae5ee57a8bf6067fa167b09c25da7fe121aa6a56ec72b7a9f77f52a78ec4f23e4ea97a31eb2ca984185bc1f609753df1fb8ba8ae49f997cb2441951593eb4cb6e8d1a1b5d5ba3017726487e35b7190ca385cfcf1c565d3ec62ad051c5d0a6c026caea69cf16c7cf6d3e3518a4a75778848dbfe1dfdb8d4b31276a74beab560df3aa37bc230e527d7e4ba3986a7ff4b896b42b478d103306dbccf67bc06bf8aee20b4105260dd4c35ee9ffaf421eb1bc128f7bb9cbebe32a90f5cb7468a5c3702155799a80e1c21054df56845ee8ba307fa96d194c25d808c1d&x-goog-algorithm=GOOG4-RSA-SHA256&x-goog-credential=credit%40scratchbox-canvas.iam.gserviceaccount.com%2F20260917%2Fus-central1%2Fstorage%2Fgoog4_request&x-goog-date=20260917T153319Z&x-goog-expires=604800&x-goog-signedheaders=host',
    aiDescription: 'Skyscraper canyon at golden hour dusk. Volumetric sunlight cuts between glass and limestone towers; wet reflective asphalt shimmers with motion-blurred vehicle tail lights.',
    videoAvailable: true,
    videoSources: {
      comparison: { local: 'videos/s4d_manhattan_comparison.mp4', gcs: comparisonSignedUrl },
      synthesis: { local: 'videos/s4d_manhattan_omni_synthesis.mp4', gcs: synthesisSignedUrl },
      blockout: { local: 'videos/s4d_manhattan_blockout_ref.mp4', gcs: blockoutSignedUrl }
    },
    storyboardBeats: [
      'storyboards/beat_00.jpg',
      'storyboards/beat_01.jpg',
      'storyboards/beat_02.jpg',
      'storyboards/beat_03.jpg',
      'storyboards/beat_04.jpg',
      'storyboards/beat_05.jpg',
      'storyboards/beat_06.jpg',
      'storyboards/beat_07.jpg'
    ]
  },
  {
    name: 'Tokyo Shibuya Commercial',
    prompt: 'data/shibuya_prompt.json',
    tensor: 'data/shibuya_tensor.rle',
    localImage: 'images/shibuya_ai.png',
    aiImageUrl: 'https://scratchbox-canvas-4danyone-artifacts.storage.googleapis.com/s4d_viewer/images/shibuya_ai.png?x-goog-signature=77b613c6218fad5158158c8b0e62678a42c1625eae6e5ae19da967361a9e4c8a15e8b213d1e498be0e53185ee111bb41ecb14048b93906c33077b75a41b4d5ca5eba374fd011232554b58b9e513619935501b9d705c96c26bf77e0b59e42377521393f4a41a0cfb2ae8ae90c34d7b6c2fb020de6a72450043be313aa144c563ce8b158b0fa2d7833f36b439ae9ad727944a528927d05de5c2059dc97eac129efaba0ecab98eba02d96d9d852af7105a17e570d71329d218c7eb59a9a392c62da7b1b406d8c9d47c8cc71c14d52a1e3278636640e78cc605001df48c98d40d6dd75c336045753de364b8b301259c7ae54c472d10aafeca40e3cf3930adc1bb2e4&x-goog-algorithm=GOOG4-RSA-SHA256&x-goog-credential=credit%40scratchbox-canvas.iam.gserviceaccount.com%2F20260917%2Fus-central1%2Fstorage%2Fgoog4_request&x-goog-date=20260917T153321Z&x-goog-expires=604800&x-goog-signedheaders=host',
    aiDescription: 'Famous scramble crossing during light rain at night. Giant digital LED billboards and neon storefronts reflect across wet streets with dynamic umbrella-holding pedestrian crowds.'
  },
  {
    name: 'Alpine Mountain Ridge',
    prompt: 'data/alpine_prompt.json',
    tensor: 'data/alpine_tensor.rle',
    localImage: 'images/alpine_ai.png',
    aiImageUrl: 'https://scratchbox-canvas-4danyone-artifacts.storage.googleapis.com/s4d_viewer/images/alpine_ai.png?x-goog-signature=27025b73cf42b5b7ca1c44bf4d3317793cd61f8526b16fd5381fe774561355e55b9556e402f489aab8b76282641ec5e5e14ded7a29259e84e675c85d029715b7e3a7238cbc26104bd9cb7bdbdac693dde2ce3083165d2225454c394cda635d88808507a441d430af480973270f7c2be5b3eabd9f2c783903f8572e4a31c5b040055435360a09c560b4691e0ab6c77e6b49cc51e5fe5f9c3753b3ea206cb77cf868932c264795b544ef248a8fb6ca0e3cc84c89c8976823c7db2ef77abf9ee32a8ef0988b3e507b799c6b73c73401ca641c7f07e7491a094392d7f398f0f524c40cb750856bf0683bb851674268f21b5f5de084cb72b5b629a2591788d7a98d4e&x-goog-algorithm=GOOG4-RSA-SHA256&x-goog-credential=credit%40scratchbox-canvas.iam.gserviceaccount.com%2F20260917%2Fus-central1%2Fstorage%2Fgoog4_request&x-goog-date=20260917T153323Z&x-goog-expires=604800&x-goog-signedheaders=host',
    aiDescription: 'Swiss Alps summit ridge at sunrise. Rugged granite cliffs with fresh snow dusting, deep forested alpine valleys, and golden morning sunlight cutting through mountain fog.'
  },
  {
    name: 'Dubai Marina Waterfront',
    prompt: 'data/dubai_prompt.json',
    tensor: 'data/dubai_tensor.rle',
    localImage: 'images/dubai_ai.png',
    aiImageUrl: 'https://scratchbox-canvas-4danyone-artifacts.storage.googleapis.com/s4d_viewer/images/dubai_ai.png?x-goog-signature=57da029caa8e0d3f0ef7f6eaec756d4bf8e4e95f7423d6a27f4856a8a17db439abc6e954aef87988f1bd7eaa72507c3a6170e68578a8680fc8328f2ef83ff512b807563f025419dff8ce8f66312fe03fa015ebd65c9e513e356684b9ea94e4dc92ec3dcb037103af9104b85b9e9b277d2fb30a41f79f38602df1e4c055cb4b8b289bfbd7e964e991bb48e5be3ddbe10a8233633b65dbc47da4c6bd87dacbf484fbcf70838554f191b32bce82459917c66c48904022491e4219c6c87ad6e7e75f5992810fce74d908c73b6f16f166392aecc06e2ab4c3fcb223f779cfdf5d2351060d02ff9c1aec00b6aeb718c6a9aa9e204bc046f0535e6f35350109cea3d990&x-goog-algorithm=GOOG4-RSA-SHA256&x-goog-credential=credit%40scratchbox-canvas.iam.gserviceaccount.com%2F20260917%2Fus-central1%2Fstorage%2Fgoog4_request&x-goog-date=20260917T153326Z&x-goog-expires=604800&x-goog-signedheaders=host',
    aiDescription: 'Futuristic waterfront canal at twilight. Luxury yachts cruise turquoise waters flanked by spiraling architectural supertalls reflecting sunset colors, bordered by palm-lined promenades.'
  },
];

const classNames: Record<number, string> = {
  [GeospatialSemanticClass.FREE_SPACE]: 'Free Space',
  [GeospatialSemanticClass.GROUND]: 'Ground',
  [GeospatialSemanticClass.ROAD]: 'Road',
  [GeospatialSemanticClass.BUILDING]: 'Building',
  [GeospatialSemanticClass.VEGETATION]: 'Vegetation',
  [GeospatialSemanticClass.DYNAMIC_VEHICLE]: 'Dynamic Vehicle',
  [GeospatialSemanticClass.DYNAMIC_PEDESTRIAN]: 'Dynamic Pedestrian',
  [GeospatialSemanticClass.SKY]: 'Sky',
  [GeospatialSemanticClass.WATER]: 'Water',
  [GeospatialSemanticClass.INFRASTRUCTURE]: 'Infrastructure',
};

const evaluations: DistrictEvaluation[] = [];

console.log(`\n======================================================`);
console.log(`  🧪 Scratchbox-4D Multi-District Evaluation Suite`);
console.log(`======================================================\n`);

for (const sample of samples) {
  if (!fs.existsSync(sample.prompt) || !fs.existsSync(sample.tensor)) {
    console.warn(`[WARN] Skipping missing sample: ${sample.name}`);
    continue;
  }

  const promptRaw = JSON.parse(fs.readFileSync(sample.prompt, 'utf8'));
  const rleBase64 = fs.readFileSync(sample.tensor, 'utf8');

  const expectedVoxels = 16 * 64 * 64 * 32;
  const decompressed = S4DWorldModelBridge.rleDecode(rleBase64, expectedVoxels);

  const classCounts: Record<number, number> = {};
  for (let i = 0; i < decompressed.length; i++) {
    const cls = decompressed[i];
    classCounts[cls] = (classCounts[cls] || 0) + 1;
  }

  const freeSpace = classCounts[GeospatialSemanticClass.FREE_SPACE] || 0;
  const occupied = expectedVoxels - freeSpace;
  const occupancyPct = (occupied / expectedVoxels) * 100;

  // Temporal static check
  const frameStride = 64 * 64 * 32;
  let staticChecks = 0;
  let staticMatches = 0;
  for (let t = 0; t < 15; t++) {
    const offA = t * frameStride;
    const offB = (t + 1) * frameStride;
    for (let v = 0; v < frameStride; v++) {
      const a = decompressed[offA + v];
      const b = decompressed[offB + v];
      if (a === GeospatialSemanticClass.BUILDING || a === GeospatialSemanticClass.ROAD || a === GeospatialSemanticClass.GROUND) {
        staticChecks++;
        if (a === b) staticMatches++;
      }
    }
  }
  const tempConsist = staticChecks > 0 ? (staticMatches / staticChecks) * 100 : 100;

  // Class distribution breakdown
  const classDist: Record<string, { count: number; pct: number }> = {};
  for (const [cls, cnt] of Object.entries(classCounts)) {
    const name = classNames[Number(cls)] || `Class_${cls}`;
    classDist[name] = { count: cnt, pct: Number(((cnt / expectedVoxels) * 100).toFixed(2)) };
  }

  // Trajectory kinematics
  const waypoints = promptRaw.prompt.waypoints || [];
  let maxSpeed = 0;
  for (const w of waypoints) {
    if (w.speedKmh > maxSpeed) maxSpeed = w.speedKmh;
  }

  // Subsample 5 frames for lightweight WebGL rendering
  const subsampledFrames: { time: number; voxels: number[][] }[] = [];
  for (const t of [0, 4, 8, 12, 15]) {
    const off = t * frameStride;
    const vox: number[][] = [];
    for (let z = 0; z < 32; z += 2) {
      for (let y = 0; y < 64; y += 2) {
        for (let x = 0; x < 64; x += 2) {
          const idx = off + (z * 64 * 64 + y * 64 + x);
          const cls = decompressed[idx];
          if (cls !== GeospatialSemanticClass.FREE_SPACE && cls !== GeospatialSemanticClass.SKY) {
            vox.push([x - 32, y - 32, z, cls]);
          }
        }
      }
    }
    subsampledFrames.push({ time: t, voxels: vox });
  }

  evaluations.push({
    id: promptRaw.id || promptRaw.sample_id || `s4d_${evaluations.length}`,
    name: sample.name,
    wgs84: promptRaw.prompt.originWGS84 || promptRaw.prompt.origin_wgs84 || { lat: 40.7128, lng: -74.006, alt: 10 },
    durationMs: promptRaw.prompt.totalDurationMs || promptRaw.prompt.duration_ms || 4000,
    occupancyRatePct: Number(occupancyPct.toFixed(2)),
    temporalConsistencyPct: Number(tempConsist.toFixed(2)),
    maxSpeedKmh: Number(maxSpeed.toFixed(1)),
    classDistribution: classDist,
    waypoints: waypoints,
    frames: subsampledFrames,
    localImage: sample.localImage,
    aiImageUrl: sample.aiImageUrl,
    aiDescription: sample.aiDescription,
    videoAvailable: sample.videoAvailable,
    videoSources: sample.videoSources,
    storyboardBeats: sample.storyboardBeats
  });

  console.log(`📍 District: ${sample.name}`);
  console.log(`   - Occupancy: ${occupancyPct.toFixed(2)}% (${occupied.toLocaleString()} voxels)`);
  console.log(`   - Static Consistency: ${tempConsist.toFixed(2)}%`);
  console.log(`   - Max Kinematic Speed: ${maxSpeed.toFixed(1)} km/h`);
  if (sample.videoAvailable) {
    console.log(`   - 🎬 Video Stream Available: Comparison, Omni 1.1 Flash, 3D Blockout`);
  }
  console.log('');
}

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scratchbox-4D Multi-District Evaluation & Omni 1.1 Video Gallery</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; background-color: #070a12; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; overflow: hidden; height: 100vh; }
    #canvas-container { width: 100vw; height: 100vh; position: absolute; top: 0; left: 0; z-index: 1; }
    
    /* Left Telemetry Panel */
    #overlay { position: absolute; top: 20px; left: 20px; z-index: 10; background: rgba(15, 23, 42, 0.94); backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 14px; padding: 18px; max-width: 360px; box-shadow: 0 10px 40px rgba(0,0,0,0.7); }
    h2 { margin: 0 0 6px 0; font-size: 17px; font-weight: 700; color: #38bdf8; display: flex; align-items: center; gap: 8px; }
    .district-selector { display: flex; gap: 6px; margin: 12px 0; flex-wrap: wrap; }
    .district-btn { background: #1e293b; border: 1px solid rgba(255,255,255,0.15); color: #cbd5e1; padding: 6px 12px; font-size: 11px; font-weight: 600; border-radius: 6px; cursor: pointer; transition: all 0.2s ease; }
    .district-btn:hover { background: #334155; color: #fff; border-color: #38bdf8; }
    .district-btn.active { background: #0284c7; color: #fff; border-color: #38bdf8; box-shadow: 0 0 12px rgba(56, 189, 248, 0.5); }
    .metrics { font-size: 12px; line-height: 1.6; color: #94a3b8; margin-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 10px; }
    .metrics span { color: #f1f5f9; font-weight: 600; }
    
    /* Right AI Generative World Panel */
    #ai-panel { position: absolute; top: 20px; right: 20px; z-index: 10; background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(16px); border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 14px; padding: 16px; width: 480px; max-width: calc(100vw - 40px); box-shadow: 0 10px 40px rgba(0,0,0,0.7); transition: all 0.3s ease; max-height: calc(100vh - 40px); overflow-y: auto; }
    #ai-panel::-webkit-scrollbar { width: 5px; }
    #ai-panel::-webkit-scrollbar-thumb { background: rgba(56, 189, 248, 0.3); border-radius: 10px; }
    #ai-panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .ai-badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); font-size: 10px; font-weight: 700; padding: 3px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px; }
    .ai-badge::before { content: ""; width: 6px; height: 6px; background: #38bdf8; border-radius: 50%; box-shadow: 0 0 8px #38bdf8; }
    
    /* Navigation Tabs */
    .ai-tabs { display: flex; gap: 6px; margin-bottom: 12px; background: rgba(0,0,0,0.3); padding: 4px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.06); }
    .ai-tab { flex: 1; background: transparent; border: none; color: #94a3b8; padding: 6px 8px; font-size: 11px; font-weight: 600; border-radius: 6px; cursor: pointer; text-align: center; transition: all 0.2s ease; }
    .ai-tab:hover { color: #f1f5f9; background: rgba(255,255,255,0.05); }
    .ai-tab.active { background: #0284c7; color: #fff; box-shadow: 0 2px 8px rgba(2, 132, 199, 0.4); }

    /* Media Containers */
    .media-box { width: 100%; border-radius: 10px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.1); box-shadow: 0 4px 20px rgba(0,0,0,0.5); background: #000; position: relative; }
    .img-wrap { position: relative; width: 100%; cursor: pointer; }
    .img-wrap img { width: 100%; height: auto; display: block; transition: transform 0.3s ease; }
    .img-wrap:hover img { transform: scale(1.02); }
    .img-overlay-tip { position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.75); color: #fff; font-size: 10px; padding: 3px 8px; border-radius: 4px; pointer-events: none; }
    
    /* Video Box & Switcher */
    #video-container { display: none; }
    #video-container.active { display: block; }
    video { width: 100%; height: auto; display: block; border-radius: 8px; background: #000; }
    .video-switch-row { display: flex; gap: 6px; margin-top: 10px; }
    .video-switch-btn { flex: 1; background: #1e293b; border: 1px solid rgba(255,255,255,0.15); color: #94a3b8; font-size: 10px; font-weight: 600; padding: 6px 4px; border-radius: 6px; cursor: pointer; text-align: center; transition: all 0.2s ease; }
    .video-switch-btn:hover { background: #334155; color: #fff; }
    .video-switch-btn.active { background: rgba(56, 189, 248, 0.2); border-color: #38bdf8; color: #38bdf8; font-weight: 700; }
    
    /* Storyboard Strip */
    .storyboard-strip { display: flex; gap: 4px; margin-top: 10px; overflow-x: auto; padding-bottom: 4px; }
    .storyboard-thumb { width: 52px; height: 32px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.2); overflow: hidden; flex-shrink: 0; cursor: pointer; position: relative; opacity: 0.7; transition: all 0.2s ease; }
    .storyboard-thumb:hover, .storyboard-thumb.active { opacity: 1; border-color: #38bdf8; transform: translateY(-2px); box-shadow: 0 2px 8px rgba(56,189,248,0.4); }
    .storyboard-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .storyboard-label { position: absolute; bottom: 0; left: 0; width: 100%; background: rgba(0,0,0,0.7); font-size: 7px; text-align: center; color: #fff; }

    /* Workflow Accordion */
    .workflow-card { margin-top: 12px; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px; font-size: 11px; }
    .workflow-header { font-weight: 700; color: #f59e0b; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .workflow-step { margin-bottom: 6px; line-height: 1.4; color: #cbd5e1; }
    .workflow-step b { color: #38bdf8; }

    .ai-desc { font-size: 11px; color: #94a3b8; line-height: 1.5; margin-top: 10px; }

    /* Bottom Timeline Panel */
    #timeline-panel { position: absolute; bottom: 25px; left: 50%; transform: translateX(-50%); z-index: 10; background: rgba(15, 23, 42, 0.92); backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 12px; padding: 12px 24px; display: flex; align-items: center; gap: 16px; box-shadow: 0 10px 35px rgba(0,0,0,0.65); }
    .slider { width: 260px; accent-color: #38bdf8; cursor: pointer; }
    .legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; font-size: 11px; }
    .legend-item { display: flex; align-items: center; gap: 4px; }
    .dot { width: 10px; height: 10px; border-radius: 2px; }

    /* Lightbox Modal */
    #lightbox { display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.92); z-index: 100; justify-content: center; align-items: center; flex-direction: column; }
    #lightbox.open { display: flex; }
    #lightbox img { max-width: 90vw; max-height: 80vh; border-radius: 10px; box-shadow: 0 0 50px rgba(56, 189, 248, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); }
    #lightbox-caption { color: #e2e8f0; margin-top: 16px; font-size: 14px; max-width: 800px; text-align: center; }
    #lightbox-close { position: absolute; top: 25px; right: 35px; color: #94a3b8; font-size: 32px; font-weight: 700; cursor: pointer; }
    #lightbox-close:hover { color: #fff; }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
</head>
<body>
  <div id="canvas-container"></div>
  
  <!-- Left Telemetry & Selection Panel -->
  <div id="overlay">
    <h2>Scratchbox-4D World Engine</h2>
    <div style="font-size: 11px; color: #94a3b8;">Spatiotemporal Occupancy & Generative Diffusion Evaluation:</div>
    <div class="district-selector" id="district-btns"></div>
    <div class="metrics" id="district-metrics"></div>
    <div class="legend">
      <div class="legend-item"><div class="dot" style="background:#475569"></div>Road</div>
      <div class="legend-item"><div class="dot" style="background:#22c55e"></div>Ground/Veg</div>
      <div class="legend-item"><div class="dot" style="background:#38bdf8"></div>Building</div>
      <div class="legend-item"><div class="dot" style="background:#0284c7"></div>Water</div>
      <div class="legend-item"><div class="dot" style="background:#ef4444"></div>Vehicle</div>
      <div class="legend-item"><div class="dot" style="background:#f59e0b"></div>Camera Path</div>
    </div>
  </div>

  <!-- Right AI Generative World & Video Panel -->
  <div id="ai-panel">
    <div id="ai-panel-header">
      <div class="ai-badge">Google Omni 1.1 Flash 3D Conditioning</div>
      <button id="toggle-lightbox-btn" style="background:none; border:none; color:#38bdf8; font-size:11px; font-weight:600; cursor:pointer;">🔍 Fullscreen</button>
    </div>

    <!-- Mode Selector Tabs -->
    <div class="ai-tabs">
      <button class="ai-tab active" id="tab-video" onclick="switchMediaMode('video')">🎬 Video Stream</button>
      <button class="ai-tab" id="tab-image" onclick="switchMediaMode('image')">🖼️ Photorealistic Still</button>
      <button class="ai-tab" id="tab-workflow" onclick="switchMediaMode('workflow')">⚙️ Omni Pipeline</button>
    </div>

    <!-- 1. Video Stream Player Mode -->
    <div id="video-container" class="active">
      <div class="media-box">
        <video id="ai-video-player" autoplay loop muted playsinline controls>
          <source id="video-source" src="${comparisonSignedUrl}" type="video/mp4">
          Your browser does not support HTML5 video.
        </video>
      </div>

      <!-- Video Switcher Controls -->
      <div class="video-switch-row" id="video-switch-row">
        <button class="video-switch-btn active" id="vbtn-comp" onclick="selectVideoSource('comparison')">⚡ Side-by-Side Split</button>
        <button class="video-switch-btn" id="vbtn-synth" onclick="selectVideoSource('synthesis')">✨ Polished Omni Render</button>
        <button class="video-switch-btn" id="vbtn-block" onclick="selectVideoSource('blockout')">📐 &lt;VIDEO_REF_0&gt; Blockout</button>
      </div>

      <!-- Storyboard Beat Scrubber -->
      <div style="margin-top: 10px; font-size: 10px; color: #94a3b8; display: flex; justify-content: space-between;">
        <span><b>Storyboard Beats</b> (Multimodal Reference Inputs):</span>
        <span id="video-time-tag">3.0s @ 24fps</span>
      </div>
      <div class="storyboard-strip" id="storyboard-strip"></div>
    </div>

    <!-- 2. AI Still Image Mode -->
    <div id="image-container" style="display: none;">
      <div class="img-wrap" id="ai-img-wrap">
        <img id="ai-preview-img" src="" alt="Photorealistic 4D AI Synthesis">
        <div class="img-overlay-tip">Click to Expand (8K)</div>
      </div>
    </div>

    <!-- Description & Context -->
    <div class="ai-desc" id="ai-desc-text"></div>

    <!-- 3. Omni 1.1 Flash Conditioning Workflow Details -->
    <div class="workflow-card" id="workflow-card">
      <div class="workflow-header">
        <span>⚡ Omni 1.1 Flash 3D Blockout Reference Pipeline</span>
      </div>
      <div class="workflow-step">
        <b>1. Prepare Assets:</b> Export 3-second 3D blockout animation (72 frames @ 24fps) or 8 keyframe layout beats from Scratchbox-4D spatiotemporal tensor.
      </div>
      <div class="workflow-step">
        <b>2. Multimodal Anchor:</b> Attach 3D blockout video as <code>&lt;VIDEO_REF_0&gt;</code> to anchor exact camera flight paths, building masses, depth, and spatial motion.
      </div>
      <div class="workflow-step">
        <b>3. Focused Prompt:</b> Direct surface textures, golden hour dusk lighting, wet asphalt reflections, and illuminated glass curtain-wall supertalls cleanly onto the blockout structure.
      </div>
      <div class="workflow-step">
        <b>4. Draft & Upscale:</b> Synthesize at 720p draft for motion consistency, then upscale approved segments up to 4K resolution.
      </div>
    </div>
  </div>

  <!-- Bottom Timeline Panel -->
  <div id="timeline-panel">
    <button id="toggle-cam" style="background:#0284c7; border:none; color:#fff; font-size:11px; font-weight:700; padding:6px 12px; border-radius:6px; cursor:pointer;">Follow Camera</button>
    <div style="font-size:12px; color:#cbd5e1; font-weight:600;">Time:</div>
    <input type="range" min="0" max="4" value="0" class="slider" id="time-slider">
    <div id="time-val" style="font-size:12px; font-family:monospace; color:#38bdf8; min-width:35px;">t=0</div>
  </div>

  <!-- Lightbox Modal -->
  <div id="lightbox">
    <div id="lightbox-close">&times;</div>
    <img id="lightbox-img" src="" alt="Zoomed view">
    <div id="lightbox-caption"></div>
  </div>

  <script>
    const evaluationsData = ${JSON.stringify(evaluations)};
    const urlParams = new URLSearchParams(window.location.search);
    const distParam = urlParams.get('district');
    let currentDistrictIdx = 0;
    if (distParam !== null) {
      const parsed = parseInt(distParam);
      if (!isNaN(parsed) && parsed >= 0 && parsed < evaluationsData.length) {
        currentDistrictIdx = parsed;
      }
    }
    let currentFrameIdx = 0;
    let activeMediaMode = 'video';
    let currentVideoType = 'comparison';

    const container = document.getElementById('canvas-container');
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x070a12, 0.008);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(65, -75, 50);
    camera.up.set(0, 0, 1);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(50, -50, 80);
    scene.add(dirLight);

    const classColors = {
      1: 0x22c55e, // Ground
      2: 0x475569, // Road
      3: 0x38bdf8, // Building
      4: 0x16a34a, // Vegetation
      5: 0xef4444, // Dynamic Vehicle
      6: 0xf97316, // Dynamic Pedestrian
      8: 0x0284c7, // Water
      9: 0x9333ea  // Infrastructure
    };

    let instancedVoxelMesh = null;
    let trajectoryGroup = new THREE.Group();
    scene.add(trajectoryGroup);
    const boxGeometry = new THREE.BoxGeometry(1.8, 1.8, 1.8);

    function buildTrajectory(waypoints) {
      while(trajectoryGroup.children.length > 0){ 
        const obj = trajectoryGroup.children[0];
        trajectoryGroup.remove(obj); 
      }

      if (waypoints && waypoints.length > 0) {
        const curvePoints = waypoints.map(w => new THREE.Vector3(w.x, w.y, w.z));
        const curve = new THREE.CatmullRomCurve3(curvePoints);
        const tubeGeo = new THREE.TubeGeometry(curve, 64, 0.6, 8, false);
        const tubeMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xd97706, roughness: 0.2, metalness: 0.8 });
        const tubeMesh = new THREE.Mesh(tubeGeo, tubeMat);
        trajectoryGroup.add(tubeMesh);

        curvePoints.forEach(p => {
          const dotGeo = new THREE.SphereGeometry(0.8, 8, 8);
          const dotMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
          const dot = new THREE.Mesh(dotGeo, dotMat);
          dot.position.copy(p);
          trajectoryGroup.add(dot);
        });
      }
    }

    function switchMediaMode(mode) {
      activeMediaMode = mode;
      document.querySelectorAll('.ai-tab').forEach(t => t.classList.remove('active'));
      document.getElementById('tab-' + mode).classList.add('active');

      const videoBox = document.getElementById('video-container');
      const imgBox = document.getElementById('image-container');
      const workflowCard = document.getElementById('workflow-card');

      if (mode === 'video') {
        videoBox.style.display = 'block';
        imgBox.style.display = 'none';
        workflowCard.style.display = 'block';
      } else if (mode === 'image') {
        videoBox.style.display = 'none';
        imgBox.style.display = 'block';
        workflowCard.style.display = 'none';
      } else if (mode === 'workflow') {
        videoBox.style.display = 'none';
        imgBox.style.display = 'none';
        workflowCard.style.display = 'block';
      }
    }

    function selectVideoSource(type) {
      currentVideoType = type;
      document.querySelectorAll('.video-switch-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('vbtn-' + (type === 'comparison' ? 'comp' : (type === 'synthesis' ? 'synth' : 'block'))).classList.add('active');

      const dist = evaluationsData[currentDistrictIdx];
      const videoEl = document.getElementById('ai-video-player');
      if (dist.videoSources && dist.videoSources[type]) {
        const srcObj = dist.videoSources[type];
        const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        videoEl.src = isLocal ? srcObj.local : srcObj.gcs;
        videoEl.load();
        videoEl.play().catch(e => console.log('Autoplay muted:', e));
      }
    }

    function populateStoryboards(beats) {
      const strip = document.getElementById('storyboard-strip');
      strip.innerHTML = '';
      if (!beats || beats.length === 0) return;

      beats.forEach((b, idx) => {
        const thumb = document.createElement('div');
        thumb.className = 'storyboard-thumb' + (idx === 0 ? ' active' : '');
        const timeSec = (idx * (3.0 / 7)).toFixed(1);
        thumb.innerHTML = \`<img src="\${b}" alt="Beat \${idx}"><div class="storyboard-label">\${timeSec}s</div>\`;
        thumb.title = \`Storyboard Beat \${idx + 1}/8 (t=\${timeSec}s)\`;
        thumb.addEventListener('click', () => {
          document.querySelectorAll('.storyboard-thumb').forEach(t => t.classList.remove('active'));
          thumb.classList.add('active');
          const videoEl = document.getElementById('ai-video-player');
          videoEl.currentTime = parseFloat(timeSec);
        });
        strip.appendChild(thumb);
      });
    }

    function updateAIPanel(dist) {
      const img = document.getElementById('ai-preview-img');
      img.src = dist.aiImageUrl || dist.localImage;
      img.onerror = () => { img.src = dist.localImage; };
      document.getElementById('ai-desc-text').innerHTML = '<b>' + dist.name + '</b>: ' + dist.aiDescription;

      const tabVideo = document.getElementById('tab-video');
      if (dist.videoAvailable) {
        tabVideo.style.display = 'block';
        populateStoryboards(dist.storyboardBeats);
        selectVideoSource(currentVideoType);
        switchMediaMode('video');
      } else {
        tabVideo.style.display = 'none';
        switchMediaMode('image');
      }
    }

    function renderScene() {
      const dist = evaluationsData[currentDistrictIdx];
      if (!dist) return;

      const metricsDiv = document.getElementById('district-metrics');
      metricsDiv.innerHTML = \`
        <b>\${dist.name}</b> (ID: \${dist.id})<br>
        Origin: <span>\${dist.wgs84.lat.toFixed(4)}, \${dist.wgs84.lng.toFixed(4)} (Alt: \${dist.wgs84.alt}m)</span><br>
        Occupancy Rate: <span>\${dist.occupancyRatePct}%</span> | Static Stability: <span>\${dist.temporalConsistencyPct}%</span><br>
        Kinematic Peak Speed: <span>\${dist.maxSpeedKmh} km/h</span> | Duration: <span>\${dist.durationMs} ms</span><br>
        Voxels per sequence: <span>2,097,152 (16 frames)</span>
      \`;

      updateAIPanel(dist);
      buildTrajectory(dist.waypoints);

      if (instancedVoxelMesh) {
        scene.remove(instancedVoxelMesh);
        instancedVoxelMesh.geometry.dispose();
      }

      const frame = dist.frames[currentFrameIdx];
      const voxels = frame.voxels;
      const count = voxels.length;

      const material = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 });
      instancedVoxelMesh = new THREE.InstancedMesh(boxGeometry, material, count);
      instancedVoxelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      const dummy = new THREE.Object3D();
      const color = new THREE.Color();

      for (let i = 0; i < count; i++) {
        const [x, y, z, cls] = voxels[i];
        dummy.position.set(x, y, z);
        dummy.updateMatrix();
        instancedVoxelMesh.setMatrixAt(i, dummy.matrix);

        const hexColor = classColors[cls] || 0x64748b;
        color.setHex(hexColor);
        instancedVoxelMesh.setColorAt(i, color);
      }

      instancedVoxelMesh.instanceMatrix.needsUpdate = true;
      if (instancedVoxelMesh.instanceColor) instancedVoxelMesh.instanceColor.needsUpdate = true;
      scene.add(instancedVoxelMesh);

      controls.target.set(0, 0, 10);
      controls.update();
    }

    // Build buttons
    const btnsContainer = document.getElementById('district-btns');
    evaluationsData.forEach((d, idx) => {
      const btn = document.createElement('button');
      btn.className = 'district-btn' + (idx === currentDistrictIdx ? ' active' : '');
      btn.innerText = d.name.split(' ')[0];
      btn.title = d.name;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.district-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentDistrictIdx = idx;
        renderScene();
      });
      btnsContainer.appendChild(btn);
    });

    // Lightbox modal logic
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    const lightboxCaption = document.getElementById('lightbox-caption');
    function openLightbox() {
      const dist = evaluationsData[currentDistrictIdx];
      lightboxImg.src = dist.aiImageUrl || dist.localImage;
      lightboxCaption.innerHTML = '<b>' + dist.name + '</b> — ' + dist.aiDescription;
      lightbox.classList.add('open');
    }
    document.getElementById('ai-img-wrap').addEventListener('click', openLightbox);
    document.getElementById('toggle-lightbox-btn').addEventListener('click', openLightbox);
    document.getElementById('lightbox-close').addEventListener('click', () => lightbox.classList.remove('open'));
    lightbox.addEventListener('click', (e) => { if (e.target === lightbox) lightbox.classList.remove('open'); });

    renderScene();

    const slider = document.getElementById('time-slider');
    const timeVal = document.getElementById('time-val');
    slider.addEventListener('input', (e) => {
      currentFrameIdx = parseInt(e.target.value);
      const dist = evaluationsData[currentDistrictIdx];
      timeVal.innerText = 't=' + dist.frames[currentFrameIdx].time;
      renderScene();
    });

    let followCamera = false;
    document.getElementById('toggle-cam').addEventListener('click', () => {
      followCamera = !followCamera;
      const btn = document.getElementById('toggle-cam');
      btn.innerText = followCamera ? 'Free Orbit View' : 'Follow Camera';
      btn.style.background = followCamera ? '#10b981' : '#0284c7';
    });

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    let animTime = 0;
    function animate() {
      requestAnimationFrame(animate);
      const dist = evaluationsData[currentDistrictIdx];
      if (followCamera && dist.waypoints && dist.waypoints.length > 0) {
        animTime = (animTime + 0.004) % 1;
        const ptIndex = Math.floor(animTime * (dist.waypoints.length - 1));
        const wp = dist.waypoints[ptIndex];
        camera.position.set(wp.x, wp.y, wp.z);
        const lookIdx = Math.min(dist.waypoints.length - 1, ptIndex + 1);
        const nextWp = dist.waypoints[lookIdx];
        camera.lookAt(nextWp.x, nextWp.y, nextWp.z);
      } else {
        controls.update();
      }
      renderer.render(scene, camera);
    }
    animate();
  </script>
</body>
</html>`;

const outPath = path.resolve('public/s4d_multi_gallery.html');
fs.writeFileSync(outPath, htmlContent, 'utf8');
console.log(`[PASS] Exported multi-district gallery with video and photorealistic AI visualizations to: ${outPath}`);
