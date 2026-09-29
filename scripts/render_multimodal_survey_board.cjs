const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(REPO_ROOT, 'docs/screenshots');

const htmlPath = path.join(REPO_ROOT, 'public/survey_multimodal_conditioning_board.html');
const outScreenshot = path.join(SCREENSHOT_DIR, '136_multimodal_survey_conditioning_board.png');

function getBase64(fileRel) {
  const p = path.join(REPO_ROOT, fileRel);
  const data = fs.readFileSync(p);
  return `data:image/png;base64,${data.toString('base64')}`;
}

const rawAndBeautify = getBase64('docs/screenshots/92_flight_frame_01_split_full_textured_vs_beautify.png');
const realClay = getBase64('docs/screenshots/137_real_station_clay.png');
const realDepth = getBase64('docs/screenshots/137_real_station_mist_depth.png');
const realNormal = getBase64('docs/screenshots/137_real_station_normal.png');
const constantineBbox = getBase64('docs/screenshots/131_bbox_comparison_side_by_side_constantine.png');
const splatStudio = getBase64('docs/screenshots/135_geographic_3dgs_studio.png');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Survey Multimodal Conditioning Architecture</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, sans-serif; }
  body {
    width: 1920px;
    height: 1080px;
    background: #080b12;
    color: #f1f5f9;
    padding: 32px 48px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    border-bottom: 1px solid rgba(255,255,255,0.1);
    padding-bottom: 16px;
  }
  .title-group h1 {
    font-size: 27px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #ffffff;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .badge {
    background: linear-gradient(135deg, #0284c7, #4f46e5);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 4px 10px;
    border-radius: 6px;
    color: #fff;
  }
  .title-group p {
    font-size: 13.5px;
    color: #94a3b8;
    margin-top: 4px;
  }
  .metrics-strip {
    display: flex;
    gap: 24px;
  }
  .metric-item {
    text-align: right;
  }
  .metric-val {
    font-size: 18px;
    font-weight: 700;
    color: #38bdf8;
    font-variant-numeric: tabular-nums;
  }
  .metric-lbl {
    font-size: 10.5px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 18px;
    height: 840px;
    margin-top: 18px;
  }
  .card {
    background: rgba(15, 23, 42, 0.75);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 16px 36px rgba(0,0,0,0.4);
    backdrop-filter: blur(16px);
  }
  .card-header {
    padding: 12px 16px;
    background: rgba(30, 41, 59, 0.5);
    border-bottom: 1px solid rgba(255,255,255,0.06);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .card-title {
    font-size: 12.5px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .card-pill {
    font-size: 10px;
    padding: 3px 8px;
    border-radius: 4px;
    font-weight: 600;
  }
  .pill-amber { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
  .pill-blue  { background: rgba(14, 165, 233, 0.15); color: #38bdf8; border: 1px solid rgba(14, 165, 233, 0.3); }
  .pill-purple{ background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); }
  .pill-green { background: rgba(34, 197, 94, 0.15);  color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }

  .card-media {
    flex: 1;
    position: relative;
    overflow: hidden;
    background: #020617;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card-media img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .card-media .split-half-left {
    position: absolute;
    left: 0; top: 0;
    width: 200%; height: 100%;
    object-fit: cover;
    object-position: left;
  }
  .card-media .split-half-right {
    position: absolute;
    right: 0; top: 0;
    width: 200%; height: 100%;
    object-fit: cover;
    object-position: right;
  }

  .card-body {
    padding: 14px 16px;
    background: rgba(15, 23, 42, 0.9);
    border-top: 1px solid rgba(255,255,255,0.06);
  }
  .card-subtitle {
    font-size: 12.5px;
    font-weight: 600;
    color: #e2e8f0;
    margin-bottom: 5px;
  }
  .card-desc {
    font-size: 11.5px;
    line-height: 1.45;
    color: #94a3b8;
  }
  .spec-tag {
    display: inline-block;
    margin-top: 8px;
    font-size: 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    background: rgba(255,255,255,0.05);
    padding: 3px 6px;
    border-radius: 4px;
    color: #cbd5e1;
  }
  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    color: #64748b;
    border-top: 1px solid rgba(255,255,255,0.06);
    padding-top: 10px;
  }
  .footer-left {
    display: flex;
    gap: 16px;
  }
  .model-verdict {
    color: #38bdf8;
    font-weight: 600;
  }
</style>
</head>
<body>
  <div class="header">
    <div class="title-group">
      <h1>
        Survey Multimodal Conditioning Architecture
        <span class="badge">Spatial Triplet Contract</span>
      </h1>
      <p>Multi-channel metric priors required to prevent generative AI hallucinations and guarantee 100% watertight 3D Gaussian Splats</p>
    </div>
    <div class="metrics-strip">
      <div class="metric-item">
        <div class="metric-val">3 Dense Passes</div>
        <div class="metric-lbl">RGB &bull; Depth &bull; Normal</div>
      </div>
      <div class="metric-item">
        <div class="metric-val">Zero Drift</div>
        <div class="metric-lbl">Pinhole Metric Lock</div>
      </div>
      <div class="metric-item">
        <div class="metric-val">Sub-Millisecond</div>
        <div class="metric-lbl">Native C++20 Raster</div>
      </div>
    </div>
  </div>

  <div class="grid">
    <!-- Card 1: Raw RGB Baseline -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">1. Raw RGB Baseline</div>
        <span class="card-pill pill-amber">Leaf LOD Baseline</span>
      </div>
      <div class="card-media">
        <img src="${rawAndBeautify}" class="split-half-left" alt="Raw Photogrammetry">
      </div>
      <div class="card-body">
        <div class="card-subtitle">Google 3D Tiles Photogrammetry</div>
        <div class="card-desc">
          Provides authentic real-world landmark albedo, fenestration positions, and surrounding context. Captures actual physical structures with baked noon sun and photogrammetric noise.
        </div>
        <div class="spec-tag">Channel: RGB24 | Leaf errorTarget &le; 0.5</div>
      </div>
    </div>

    <!-- Card 2: Metric Depth -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">2. Metric Float32 Depth</div>
        <span class="card-pill pill-blue">Rigid Distance Bounds</span>
      </div>
      <div class="card-media">
        <img src="${realDepth}" alt="Metric Float32 Depth Map">
      </div>
      <div class="card-body">
        <div class="card-subtitle">Pinhole Camera-Z Metric Depth Map</div>
        <div class="card-desc">
          Renders exact metric distance \(Z\) per pixel in meters. Pins the volumetric bounds so diffusion models cannot push or pull facades forward/backward or hallucinate depth boiling.
        </div>
        <div class="spec-tag">Channel: Float32Array [Near 0.5m &bull; Far 20km]</div>
      </div>
    </div>

    <!-- Card 3: Surface Normals -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">3. Surface Normals</div>
        <span class="card-pill pill-purple">Orientation &amp; Plumb</span>
      </div>
      <div class="card-media">
        <img src="${realNormal}" alt="Surface Normal Vectors">
      </div>
      <div class="card-body">
        <div class="card-subtitle">Camera-Space Surface Normals \([\mathbf{N}_x, \mathbf{N}_y, \mathbf{N}_z]\)</div>
        <div class="card-desc">
          Orthogonal RGB surface orientation vectors. Tells the generative model which way each facade and cornice faces, enforcing plumb vertical columns and level horizontal entablatures.
        </div>
        <div class="spec-tag">Channel: \(\mathbf{N}_{\text{cam}}\) &bull; ControlNet Normal</div>
      </div>
    </div>

    <!-- Card 4: AI Restoration & 3DGS -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">4. AI Restoration &rarr; 3DGS</div>
        <span class="card-pill pill-green">Unprojected Splats</span>
      </div>
      <div class="card-media">
        <img src="${rawAndBeautify}" class="split-half-right" alt="AI Beautified Travertine">
      </div>
      <div class="card-body">
        <div class="card-subtitle">De-lighted Travertine &bull; Watertight Splats</div>
        <div class="card-desc">
          Restored travertine porosity with baked noon glare removed. Unprojects directly via \(\mathbf{P} = \mathbf{K}^{-1}(u Z, v Z, Z)^T\) into 3D Gaussians with calibrated covariance and zero floaters.
        </div>
        <div class="spec-tag">Output: station_to_splats (.spz / .splat)</div>
      </div>
    </div>
  </div>

  <div class="footer">
    <div class="footer-left">
      <span>Architectural Model Recommendation: <strong class="model-verdict">Dense Multi-ControlNet (FLUX.1 [dev] / SDXL)</strong> for geometry lock &bull; <strong>Gemini 2.5/3.7</strong> for semantic de-lighting</span>
    </div>
    <div class="footer-right">
      <span>Scratchbox 3D Engine &bull; SurveySynthesisEngine &bull; station_to_splats.cpp</span>
    </div>
  </div>
</body>
</html>`;

fs.writeFileSync(htmlPath, html, 'utf8');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const cmd = `"${chromePath}" --headless=new --screenshot="${outScreenshot}" --window-size=1920,1080 --hide-scrollbars "file://${htmlPath}"`;

try {
  execSync(cmd, { stdio: 'inherit' });
  console.log('Successfully saved high-res multimodal survey board to:', outScreenshot);
} catch (e) {
  console.error('Chrome capture error:', e.message);
}
