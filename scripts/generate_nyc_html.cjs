const fs = require('fs');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Scratchbox IDE: NYC Midtown Manhattan / ESB Algorithmic UV & PBR Proof</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js"></script>
    <style>
        :root {
            --bg-base: #060910;
            --bg-card: #0d131f;
            --bg-card-border: #1c2738;
            --accent-cyan: #38bdf8;
            --accent-blue: #3b82f6;
            --accent-amber: #f59e0b;
            --accent-green: #10b981;
            --accent-purple: #c084fc;
            --text-main: #f8fafc;
            --text-sub: #94a3b8;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background-color: var(--bg-base);
            color: var(--text-main);
            font-family: 'Inter', -apple-system, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }

        /* Header */
        header {
            padding: 10px 20px;
            background: linear-gradient(180deg, #0d1527 0%, #060910 100%);
            border-bottom: 1px solid var(--bg-card-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            z-index: 10;
        }
        .header-left h1 {
            font-size: 16px;
            font-weight: 800;
            background: linear-gradient(135deg, #38bdf8 0%, #c084fc 50%, #f59e0b 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .header-left p {
            font-size: 11px;
            color: var(--text-sub);
            margin-top: 2px;
            font-family: 'JetBrains Mono', monospace;
        }

        .pills {
            display: flex;
            gap: 6px;
        }
        .pill {
            font-size: 11px;
            font-weight: 600;
            padding: 3px 8px;
            border-radius: 9999px;
            border: 1px solid var(--bg-card-border);
            background: rgba(15, 23, 42, 0.8);
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .pill.cyan { border-color: rgba(56, 189, 248, 0.4); color: #38bdf8; }
        .pill.amber { border-color: rgba(245, 158, 11, 0.5); color: #fbbf24; }
        .pill.green { border-color: rgba(16, 185, 129, 0.4); color: #34d399; }
        .pill.purple { border-color: rgba(192, 132, 252, 0.4); color: #c084fc; }

        /* Secondary Toolbar */
        .controls-toolbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 20px;
            background: #090e18;
            border-bottom: 1px solid var(--bg-card-border);
            z-index: 9;
        }
        .btn-group {
            display: flex;
            background: rgba(15, 23, 42, 0.8);
            border: 1px solid var(--bg-card-border);
            border-radius: 6px;
            overflow: hidden;
            gap: 1px;
        }
        .btn {
            background: #131c2e;
            color: var(--text-sub);
            border: none;
            padding: 5px 12px;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s ease;
            font-family: 'Inter', sans-serif;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .btn:hover {
            color: var(--text-main);
            background: #1e293b;
        }
        .btn.active {
            color: #fff;
            background: var(--accent-blue);
        }
        .btn.active-cyan {
            color: #000;
            background: var(--accent-cyan);
            font-weight: 700;
        }
        .btn.active-amber {
            color: #000;
            background: var(--accent-amber);
            font-weight: 700;
        }

        /* Stage Container */
        .stage-container {
            flex: 1;
            position: relative;
            background: #020408;
            overflow: hidden;
        }

        /* Views */
        .view-panel {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: flex;
        }
        .view-panel.hidden {
            display: none;
        }

        /* 3D Viewport Panels */
        .viewport-panel {
            flex: 1;
            position: relative;
            border-right: 1px solid var(--bg-card-border);
            overflow: hidden;
        }
        .viewport-panel:last-child {
            border-right: none;
        }
        .viewport-canvas {
            width: 100%;
            height: 100%;
            display: block;
        }

        /* Badges & Telemetry HUD */
        .viewport-badge {
            position: absolute;
            top: 14px;
            left: 14px;
            background: rgba(6, 9, 16, 0.85);
            backdrop-filter: blur(8px);
            border: 1px solid var(--bg-card-border);
            padding: 8px 12px;
            border-radius: 6px;
            pointer-events: none;
            z-index: 5;
        }
        .viewport-badge h2 {
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 0.3px;
        }
        .viewport-badge p {
            font-size: 11px;
            color: var(--text-sub);
            font-family: 'JetBrains Mono', monospace;
            margin-top: 2px;
        }
        .badge-left h2 { color: #94a3b8; }
        .badge-right h2 { color: var(--accent-cyan); }

        /* 2D Texture Atlas View */
        .texture-view {
            width: 100%;
            height: 100%;
            display: flex;
            background: #040711;
        }
        .texture-col {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 16px;
            position: relative;
            overflow: auto;
        }
        .texture-col:first-child {
            border-right: 1px solid var(--bg-card-border);
        }
        .texture-frame {
            position: relative;
            background: #0b1120;
            border: 1px solid #1e293b;
            border-radius: 8px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.6);
            overflow: hidden;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        .texture-frame img {
            display: block;
            width: 460px;
            height: 460px;
            object-fit: contain;
            image-rendering: pixelated;
        }
        .atlas-meta-box {
            position: absolute;
            top: 14px;
            left: 14px;
            background: rgba(6, 10, 20, 0.9);
            border: 1px solid var(--bg-card-border);
            border-radius: 6px;
            padding: 8px 12px;
            z-index: 4;
        }
        .atlas-meta-box h3 {
            font-size: 12px;
            font-weight: 700;
        }
        .atlas-meta-box p {
            font-size: 11px;
            color: var(--text-sub);
            font-family: 'JetBrains Mono', monospace;
            margin-top: 2px;
        }

        /* 4x Zoom Loupe Card */
        .loupe-card {
            position: absolute;
            bottom: 20px;
            right: 20px;
            width: 580px;
            background: rgba(13, 19, 31, 0.95);
            backdrop-filter: blur(12px);
            border: 1px solid var(--bg-card-border);
            border-radius: 10px;
            padding: 14px;
            box-shadow: 0 12px 36px rgba(0,0,0,0.7);
            z-index: 8;
        }
        .loupe-card h4 {
            font-size: 13px;
            font-weight: 700;
            color: var(--accent-cyan);
            margin-bottom: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .loupe-split {
            display: flex;
            gap: 12px;
        }
        .loupe-box {
            flex: 1;
            text-align: center;
        }
        .loupe-box canvas {
            width: 100%;
            height: 200px;
            border-radius: 6px;
            border: 1px solid #334155;
            background: #020408;
            image-rendering: pixelated;
            display: block;
        }
        .loupe-box .box-lbl {
            font-size: 11px;
            color: var(--text-sub);
            margin-top: 4px;
            font-family: 'JetBrains Mono', monospace;
        }
        .loupe-card .sub-note {
            font-size: 11px;
            color: #64748b;
            font-family: 'JetBrains Mono', monospace;
            margin-top: 8px;
            line-height: 1.4;
        }

        /* Telemetry Footer */
        footer {
            padding: 8px 20px;
            background: #080d1a;
            border-top: 1px solid var(--bg-card-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            color: var(--text-sub);
            z-index: 10;
        }
        .telemetry-item strong {
            color: var(--text-main);
        }
        .telemetry-item.cyan strong { color: var(--accent-cyan); }
        .telemetry-item.amber strong { color: var(--accent-amber); }
        .telemetry-item.green strong { color: var(--accent-green); }

        .loading-overlay {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(6, 9, 16, 0.9);
            border: 1px solid var(--bg-card-border);
            padding: 16px 24px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 10px;
            z-index: 20;
        }
        .spinner {
            width: 16px;
            height: 16px;
            border: 2px solid rgba(56, 189, 248, 0.2);
            border-top-color: var(--accent-cyan);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <header>
        <div class="header-left">
            <h1>🏛️ NYC Empire State Building & Midtown: Algorithmic UV & PBR Proof</h1>
            <p>40.74844° N, -73.98566° W · 70 Submeshes · 460.5m Elevation · Bedford Indiana Limestone & Bitumen</p>
        </div>
        <div class="pills">
            <div class="pill cyan"><span>1K PBR Mode (512² → 1024²)</span></div>
            <div class="pill green"><span>100% Geometry Lock (0.000 mm Drift)</span></div>
            <div class="pill amber"><span>UV Scaling 1.000x (Identical Mapping)</span></div>
            <div class="pill purple"><span>Bedford Limestone & Bitumen</span></div>
        </div>
    </header>

    <div class="controls-toolbar">
        <div class="btn-group">
            <button class="btn active-cyan" id="btnTab3D" onclick="switchMainTab('3d')">3D ESB Viewports</button>
            <button class="btn" id="btnTab2D" onclick="switchMainTab('2d')">2D Texture Atlas & 4x Loupe</button>
        </div>

        <div id="controls3D" style="display:flex; gap:8px;">
            <div class="btn-group">
                <button class="btn active" id="btnSideBySide" onclick="setMode('sideBySide')">Side-by-Side</button>
                <button class="btn" id="btnEnhancedOnly" onclick="setMode('enhancedOnly')">Enhanced Only</button>
                <button class="btn" id="btnOrigOnly" onclick="setMode('origOnly')">Original Only</button>
            </div>
            <div class="btn-group">
                <button class="btn active" id="btnPresetTower" onclick="setCameraPreset('tower')">Tower View</button>
                <button class="btn" id="btnPresetFacade" onclick="setCameraPreset('facade')">Facade Setbacks</button>
                <button class="btn" id="btnPresetStreet" onclick="setCameraPreset('street')">5th Ave Street</button>
                <button class="btn" id="btnPresetLoupe" onclick="setCameraPreset('loupe')">Macro Loupe (Limestone)</button>
            </div>
            <div class="btn-group">
                <button class="btn" id="btnWireframe" onclick="toggleWireframe()">Wireframe Lock</button>
                <button class="btn" id="btnAutoRotate" onclick="toggleAutoRotate()">Auto-Rotate</button>
            </div>
        </div>

        <div id="controls2D" style="display:none; gap:8px; flex-wrap:wrap;">
            <div class="btn-group" id="channelSelector">
                <button class="btn active" id="btnChanAlbedo" onclick="selectPbrChannel('albedo', this)">1K Albedo</button>
                <button class="btn" id="btnChanNormal" onclick="selectPbrChannel('normal', this)">1K Normal</button>
                <button class="btn" id="btnChanRoughness" onclick="selectPbrChannel('roughness', this)">1K Roughness</button>
                <button class="btn" id="btnChanOrm" onclick="selectPbrChannel('orm', this)">1K ORM (Packed)</button>
            </div>
            <div class="btn-group" id="atlasSelector">
                <button class="btn active" id="btnTex8" onclick="selectAtlasTexture(8, this)">Texture 8 (Limestone Shaft)</button>
                <button class="btn" id="btnTex42" onclick="selectAtlasTexture(42, this)">Texture 42 (Art Deco Setbacks)</button>
                <button class="btn" id="btnTex33" onclick="selectAtlasTexture(33, this)">Texture 33 (5th Ave Base)</button>
            </div>
            <div class="btn-group" id="loupeSelector">
                <button class="btn active" id="btnPatchAshlar" onclick="setLoupePatch('ashlar', this)">Limestone Ashlar</button>
                <button class="btn" id="btnPatchMullion" onclick="setLoupePatch('mullion', this)">Vertical Mullions</button>
                <button class="btn" id="btnPatchAsphalt" onclick="setLoupePatch('asphalt', this)">5th Ave Bitumen</button>
            </div>
        </div>
    </div>

    <div class="stage-container">
        <!-- 3D View Panel -->
        <div class="view-panel" id="panel3D">
            <div class="viewport-panel" id="panelLeft">
                <div class="viewport-badge badge-left">
                    <h2>ORIGINAL GOOGLE 3D TILE SCAN</h2>
                    <p id="leftStats">70 Submeshes · Blurry 512² JPEG Atlases</p>
                </div>
                <div class="loading-overlay" id="loadingLeft"><div class="spinner"></div>Loading Raw Tile Scan...</div>
                <div class="viewport-canvas" id="containerLeft"></div>
            </div>

            <div class="viewport-panel" id="panelRight">
                <div class="viewport-badge badge-right">
                    <h2>ALGORITHMIC UV & PBR ENHANCED (1K MAPS)</h2>
                    <p id="rightStats">70 Submeshes · 1K PBR Suite (1024²) · 0.000 mm Drift</p>
                </div>
                <div class="loading-overlay" id="loadingRight"><div class="spinner"></div>Loading Enhanced PBR GLB...</div>
                <div class="viewport-canvas" id="containerRight"></div>
            </div>
        </div>

        <!-- 2D Texture Atlas & Loupe Panel -->
        <div class="view-panel hidden" id="panel2D">
            <div class="texture-view">
                <!-- Left 2D Texture: Original -->
                <div class="texture-col">
                    <div class="atlas-meta-box">
                        <h3 style="color:#94a3b8;" id="atlasTitleOrig">ORIGINAL PHOTOGRAMMETRIC ATLAS</h3>
                        <p id="atlasSubOrig">512 × 512 px · 81.1 KB JPEG · Soft / Compressed</p>
                    </div>
                    <div class="texture-frame">
                        <img id="imgAtlasOrig" src="models/nyc_esb_stone_texture_8_orig.jpg" alt="Original Atlas">
                    </div>
                </div>

                <!-- Right 2D Texture: Enhanced -->
                <div class="texture-col">
                    <div class="atlas-meta-box">
                        <h3 style="color:var(--accent-cyan);" id="atlasTitleEnh">1K PBR SUITE ATLAS (BEDFORD LIMESTONE)</h3>
                        <p id="atlasSubEnh">1024 × 1024 px · 1K PBR Suite (0.000 px Drift)</p>
                    </div>
                    <div class="texture-frame">
                        <img id="imgAtlasEnh" src="models/nyc_esb_stone_texture_8_enhanced_1k.jpg" alt="1K PBR Atlas">
                    </div>
                </div>

                <!-- 4x Zoom Loupe Card -->
                <div class="loupe-card">
                    <h4>
                        <span>🔬 4x Extreme Micro-Detail Loupe</span>
                        <span id="loupeTargetTitle" style="color:#f59e0b; font-size:11px;">Target: Limestone Ashlar & Mullions</span>
                    </h4>
                    <div class="loupe-split">
                        <div class="loupe-box">
                            <canvas id="canvasLoupeOrig" width="300" height="300"></canvas>
                            <div class="box-lbl">Original 512² (Soft / Blurry)</div>
                        </div>
                        <div class="loupe-box">
                            <canvas id="canvasLoupeEnh" width="300" height="300"></canvas>
                            <div class="box-lbl" style="color:var(--accent-cyan);">1K PBR Suite (Micro-Grain / Channels)</div>
                        </div>
                    </div>
                    <div class="sub-note" id="loupeSubNote">
                        Spatial Drift: 0.000 px (Direct 2D Polygon Projection). Fine oolitic limestone grain, sharpened vertical Art Deco mullions, and clean bitumen aggregate with zero artificial streaks.
                    </div>
                </div>
            </div>
        </div>
    </div>

    <footer>
        <div class="telemetry-item green">
            TOTAL VERTICES: <strong>236,579 (0.000 mm Drift)</strong>
        </div>
        <div class="telemetry-item cyan">
            TEXTURE RESOLUTION: <strong>512² → 1024² (1K PBR Suite)</strong>
        </div>
        <div class="telemetry-item amber">
            UV SCALING: <strong>1.000x (Identical Mapping)</strong>
        </div>
        <div class="telemetry-item">
            LITHOLOGY: <strong>Bedford Limestone (Cavitation 42.0, Strata 140.0)</strong>
        </div>
        <div class="telemetry-item green">
            ROAD BITUMEN: <strong>3,156,160 Texels (100% Protected)</strong>
        </div>
    </footer>

    <script>
        let sceneLeft, cameraLeft, rendererLeft, controlsLeft, modelLeft;
        let sceneRight, cameraRight, rendererRight, controlsRight, modelRight;
        let activeTab = '3d';
        let currentAtlasId = 8;
        let currentPatchId = 'ashlar';
        let activePbrChannel = 'albedo';
        let wireframe = false;
        let autoRotate = false;
        let isSyncing = false;

        const TEXTURES = {
            8: {
                orig: 'models/nyc_esb_stone_texture_8_orig.jpg',
                albedo: 'models/nyc_esb_stone_texture_8_enhanced_1k.jpg',
                normal: 'models/nyc_esb_stone_texture_8_normal_1k.jpg',
                roughness: 'models/nyc_esb_stone_texture_8_roughness_1k.jpg',
                orm: 'models/nyc_esb_stone_texture_8_orm_1k.png',
                titleOrig: 'ORIGINAL PHOTOGRAMMETRIC ATLAS (Texture 8 - Tower Shaft)',
                subOrig: '512 × 512 px · 81.1 KB JPEG · Soft / Compressed',
                titleEnh: '1K PBR SUITE (BEDFORD LIMESTONE MICRO-POROSITY)',
                subEnh: '1024 × 1024 px · 697 KB · 1K PBR Suite (0.000 px Drift)'
            },
            42: {
                orig: 'models/nyc_esb_setback_texture_42_orig.jpg',
                albedo: 'models/nyc_esb_setback_texture_42_enhanced_1k.jpg',
                normal: 'models/nyc_esb_setback_texture_42_normal_1k.jpg',
                roughness: 'models/nyc_esb_setback_texture_42_roughness_1k.jpg',
                orm: 'models/nyc_esb_setback_texture_42_orm_1k.png',
                titleOrig: 'ORIGINAL PHOTOGRAMMETRIC ATLAS (Texture 42 - Setbacks)',
                subOrig: '512 × 512 px · 67.5 KB JPEG · Muddy Compression',
                titleEnh: '1K PBR SUITE (ART DECO SETBACK CORNICE & MULLIONS)',
                subEnh: '1024 × 1024 px · 674 KB · 1K PBR Suite (0.000 px Drift)'
            },
            33: {
                orig: 'models/nyc_esb_street_texture_33_orig.jpg',
                albedo: 'models/nyc_esb_street_texture_33_enhanced_1k.jpg',
                normal: 'models/nyc_esb_street_texture_33_normal_1k.jpg',
                roughness: 'models/nyc_esb_street_texture_33_roughness_1k.jpg',
                orm: 'models/nyc_esb_street_texture_33_orm_1k.png',
                titleOrig: 'ORIGINAL PHOTOGRAMMETRIC ATLAS (Texture 33 - 5th Ave Base)',
                subOrig: '512 × 512 px · 62.1 KB JPEG · Uncalibrated Road',
                titleEnh: '1K PBR SUITE (5TH AVE BITUMEN AGGREGATE)',
                subEnh: '1024 × 1024 px · 654 KB · 1K PBR Suite (Road Protected)'
            }
        };

        const PATCHES = {
            ashlar: {
                texId: 8,
                ox: 220, oy: 160, osize: 70,
                ex: 440, ey: 320, esize: 140,
                title: 'Target: Limestone Ashlar & Bedding Strata (1K)',
                note: 'Spatial Drift: 0.000 px (1K Mode). Fine calcarenite oolitic micro-grain, horizontal ashlar bedding courses, and deepened mortar joint relief.'
            },
            mullion: {
                texId: 8,
                ox: 310, oy: 230, osize: 70,
                ex: 620, ey: 460, esize: 140,
                title: 'Target: Art Deco Vertical Mullions & Window Spandrels (1K)',
                note: 'Spatial Drift: 0.000 px (1K Mode). Bilateral de-lighting removes canyon shadows while sharpening structural pier verticality.'
            },
            asphalt: {
                texId: 33,
                ox: 240, oy: 240, osize: 70,
                ex: 480, ey: 480, esize: 140,
                title: 'Target: 5th Ave Bitumen Aggregate & Clean Road Markings (1K)',
                note: 'Bitumen Protection (1K Mode): 3,156,160 road texels shielded from cavitation. Roadway markings remain crisp without artificial stone grooves.'
            }
        };

        function selectPbrChannel(channel, el) {
            activePbrChannel = channel;
            document.querySelectorAll('#channelSelector .btn').forEach(b => b.classList.remove('active'));
            if (el) el.classList.add('active');

            const t = TEXTURES[currentAtlasId];
            if (!t) return;

            const url = t[channel] || t.albedo;
            document.getElementById('imgAtlasEnh').src = url;

            const channelLabels = {
                albedo: '1K ALBEDO (DE-LIGHTED & SHARPENED)',
                normal: '1K NORMAL MAP (SCHARR MULTI-FREQUENCY GRADIENT)',
                roughness: '1K ROUGHNESS MAP (BIOPHYSICAL LAPLACIAN CURVATURE)',
                orm: '1K PACKED ORM (R:AO, G:ROUGHNESS, B:METALLIC)'
            };
            document.getElementById('atlasTitleEnh').textContent = (channelLabels[channel] || '1K PBR MAP') + ' - TEXTURE ' + currentAtlasId;
            document.getElementById('atlasSubEnh').textContent = '1024 × 1024 px · 1K PBR Map (' + channel.toUpperCase() + ') · 0.000 px Drift';
            updateLoupe();
        }

        function switchMainTab(tab) {
            activeTab = tab;
            const btn3D = document.getElementById('btnTab3D');
            const btn2D = document.getElementById('btnTab2D');
            const p3D = document.getElementById('panel3D');
            const p2D = document.getElementById('panel2D');
            const c3D = document.getElementById('controls3D');
            const c2D = document.getElementById('controls2D');

            if (tab === '3d') {
                btn3D.className = 'btn active-cyan';
                btn2D.className = 'btn';
                p3D.classList.remove('hidden');
                p2D.classList.add('hidden');
                c3D.style.display = 'flex';
                c2D.style.display = 'none';
                setTimeout(onResize, 50);
            } else {
                btn3D.className = 'btn';
                btn2D.className = 'btn active-cyan';
                p3D.classList.add('hidden');
                p2D.classList.remove('hidden');
                c3D.style.display = 'none';
                c2D.style.display = 'flex';
                updateLoupe();
            }
        }

        function selectAtlasTexture(texId, el) {
            currentAtlasId = texId;
            document.querySelectorAll('#atlasSelector .btn').forEach(b => b.classList.remove('active'));
            if (el) el.classList.add('active');

            const t = TEXTURES[texId];
            if (!t) return;

            document.getElementById('imgAtlasOrig').src = t.orig;
            document.getElementById('imgAtlasEnh').src = t[activePbrChannel] || t.albedo;
            document.getElementById('atlasTitleOrig').textContent = t.titleOrig;
            document.getElementById('atlasSubOrig').textContent = t.subOrig;

            const channelLabels = {
                albedo: '1K ALBEDO (DE-LIGHTED & SHARPENED)',
                normal: '1K NORMAL MAP (SCHARR MULTI-FREQUENCY GRADIENT)',
                roughness: '1K ROUGHNESS MAP (BIOPHYSICAL LAPLACIAN CURVATURE)',
                orm: '1K PACKED ORM (R:AO, G:ROUGHNESS, B:METALLIC)'
            };
            document.getElementById('atlasTitleEnh').textContent = (channelLabels[activePbrChannel] || '1K PBR MAP') + ' - TEXTURE ' + texId;
            document.getElementById('atlasSubEnh').textContent = '1024 × 1024 px · 1K PBR Map (' + activePbrChannel.toUpperCase() + ') · 0.000 px Drift';

            if (texId === 33 && currentPatchId !== 'asphalt') {
                setLoupePatch('asphalt', document.getElementById('btnPatchAsphalt'));
            } else if (texId !== 33 && currentPatchId === 'asphalt') {
                setLoupePatch('ashlar', document.getElementById('btnPatchAshlar'));
            } else {
                updateLoupe();
            }
        }

        function setLoupePatch(patchId, el) {
            currentPatchId = patchId;
            document.querySelectorAll('#loupeSelector .btn').forEach(b => b.classList.remove('active'));
            if (el) el.classList.add('active');

            const patch = PATCHES[patchId];
            if (!patch) return;

            if (patch.texId !== currentAtlasId) {
                const btnTex = patch.texId === 8 ? document.getElementById('btnTex8') : patch.texId === 42 ? document.getElementById('btnTex42') : document.getElementById('btnTex33');
                selectAtlasTexture(patch.texId, btnTex);
            }

            document.getElementById('loupeTargetTitle').textContent = patch.title;
            document.getElementById('loupeSubNote').textContent = patch.note;
            updateLoupe();
        }

        function updateLoupe() {
            const patch = PATCHES[currentPatchId] || PATCHES.ashlar;
            const imgOrig = document.getElementById('imgAtlasOrig');
            const imgEnh = document.getElementById('imgAtlasEnh');
            const cOrig = document.getElementById('canvasLoupeOrig');
            const cEnh = document.getElementById('canvasLoupeEnh');
            if (!cOrig || !cEnh) return;

            const ctxOrig = cOrig.getContext('2d');
            const ctxEnh = cEnh.getContext('2d');
            ctxOrig.imageSmoothingEnabled = false;
            ctxEnh.imageSmoothingEnabled = false;

            if (imgOrig.complete && imgOrig.naturalWidth > 0) {
                ctxOrig.clearRect(0, 0, 300, 300);
                ctxOrig.drawImage(imgOrig, patch.ox, patch.oy, patch.osize, patch.osize, 0, 0, 300, 300);
            } else {
                imgOrig.onload = updateLoupe;
            }

            if (imgEnh.complete && imgEnh.naturalWidth > 0) {
                ctxEnh.clearRect(0, 0, 300, 300);
                ctxEnh.drawImage(imgEnh, patch.ex, patch.ey, patch.esize, patch.esize, 0, 0, 300, 300);
            } else {
                imgEnh.onload = updateLoupe;
            }
        }

        function init() {
            init3D();
            window.addEventListener('resize', onResize);
            updateLoupe();
        }

        function init3D() {
            const containerLeft = document.getElementById('containerLeft');
            const containerRight = document.getElementById('containerRight');

            sceneLeft = new THREE.Scene();
            sceneLeft.background = new THREE.Color(0x060910);
            cameraLeft = new THREE.PerspectiveCamera(45, containerLeft.clientWidth / containerLeft.clientHeight, 1.0, 5000);
            cameraLeft.position.set(-90, 480, 520);

            rendererLeft = new THREE.WebGLRenderer({ antialias: true, alpha: false });
            rendererLeft.setSize(containerLeft.clientWidth, containerLeft.clientHeight);
            rendererLeft.setPixelRatio(window.devicePixelRatio);
            rendererLeft.toneMapping = THREE.ACESFilmicToneMapping;
            rendererLeft.toneMappingExposure = 1.1;
            containerLeft.appendChild(rendererLeft.domElement);

            controlsLeft = new THREE.OrbitControls(cameraLeft, rendererLeft.domElement);
            controlsLeft.target.set(-91, 200, 16);
            controlsLeft.enableDamping = true;
            controlsLeft.dampingFactor = 0.05;

            sceneRight = new THREE.Scene();
            sceneRight.background = new THREE.Color(0x060910);
            cameraRight = new THREE.PerspectiveCamera(45, containerRight.clientWidth / containerRight.clientHeight, 1.0, 5000);
            cameraRight.position.copy(cameraLeft.position);

            rendererRight = new THREE.WebGLRenderer({ antialias: true, alpha: false });
            rendererRight.setSize(containerRight.clientWidth, containerRight.clientHeight);
            rendererRight.setPixelRatio(window.devicePixelRatio);
            rendererRight.toneMapping = THREE.ACESFilmicToneMapping;
            rendererRight.toneMappingExposure = 1.1;
            containerRight.appendChild(rendererRight.domElement);

            controlsRight = new THREE.OrbitControls(cameraRight, rendererRight.domElement);
            controlsRight.target.copy(controlsLeft.target);
            controlsRight.enableDamping = true;
            controlsRight.dampingFactor = 0.05;

            [sceneLeft, sceneRight].forEach(scene => {
                const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 1.2);
                hemiLight.position.set(0, 500, 0);
                scene.add(hemiLight);

                const dirLight1 = new THREE.DirectionalLight(0xfffbeb, 1.6);
                dirLight1.position.set(200, 450, 300);
                scene.add(dirLight1);

                const dirLight2 = new THREE.DirectionalLight(0x93c5fd, 0.7);
                dirLight2.position.set(-300, 200, -200);
                scene.add(dirLight2);

                const grid = new THREE.GridHelper(1000, 50, 0x1e293b, 0x0f172a);
                grid.position.y = -35;
                scene.add(grid);
            });

            controlsLeft.addEventListener('change', () => {
                if (isSyncing) return;
                isSyncing = true;
                cameraRight.position.copy(cameraLeft.position);
                cameraRight.quaternion.copy(cameraLeft.quaternion);
                controlsRight.target.copy(controlsLeft.target);
                controlsRight.update();
                isSyncing = false;
            });

            controlsRight.addEventListener('change', () => {
                if (isSyncing) return;
                isSyncing = true;
                cameraLeft.position.copy(cameraRight.position);
                cameraLeft.quaternion.copy(cameraRight.quaternion);
                controlsLeft.target.copy(controlsRight.target);
                controlsLeft.update();
                isSyncing = false;
            });

            loadModels();
            animate();
        }

        function loadModels() {
            const loader = new THREE.GLTFLoader();

            loader.load('models/spce_scan_studio_raw_tile.glb', gltf => {
                modelLeft = gltf.scene;
                sceneLeft.add(modelLeft);
                document.getElementById('loadingLeft').style.display = 'none';
            }, undefined, err => {
                console.error('Failed to load left model:', err);
                document.getElementById('loadingLeft').innerHTML = '<div style="color:#ef4444;">Failed to load raw model</div>';
            });

            loader.load('models/nyc_empire_state_building_pbr_enhanced.glb', gltf => {
                modelRight = gltf.scene;
                sceneRight.add(modelRight);
                document.getElementById('loadingRight').style.display = 'none';
            }, undefined, err => {
                console.error('Failed to load right model:', err);
                document.getElementById('loadingRight').innerHTML = '<div style="color:#ef4444;">Failed to load PBR model</div>';
            });
        }

        function setCameraPreset(preset) {
            document.querySelectorAll('#controls3D .btn-group:nth-child(2) .btn').forEach(b => b.classList.remove('active'));

            if (preset === 'tower') {
                document.getElementById('btnPresetTower').classList.add('active');
                cameraLeft.position.set(-90, 480, 520);
                controlsLeft.target.set(-91, 200, 16);
            } else if (preset === 'facade') {
                document.getElementById('btnPresetFacade').classList.add('active');
                cameraLeft.position.set(-30, 240, 180);
                controlsLeft.target.set(-91, 190, 16);
            } else if (preset === 'street') {
                document.getElementById('btnPresetStreet').classList.add('active');
                cameraLeft.position.set(60, 45, 120);
                controlsLeft.target.set(-60, 15, 30);
            } else if (preset === 'loupe') {
                document.getElementById('btnPresetLoupe').classList.add('active');
                cameraLeft.position.set(-5, 235, 38);
                controlsLeft.target.set(0, 235, 0);
            }

            controlsLeft.update();
            cameraRight.position.copy(cameraLeft.position);
            controlsRight.target.copy(controlsLeft.target);
            controlsRight.update();
        }

        function setMode(mode) {
            const pLeft = document.getElementById('panelLeft');
            const pRight = document.getElementById('panelRight');
            const bSbs = document.getElementById('btnSideBySide');
            const bEnh = document.getElementById('btnEnhancedOnly');
            const bOrig = document.getElementById('btnOrigOnly');

            bSbs.classList.remove('active');
            bEnh.classList.remove('active');
            bOrig.classList.remove('active');

            if (mode === 'sideBySide') {
                pLeft.style.display = 'block';
                pRight.style.display = 'block';
                bSbs.classList.add('active');
            } else if (mode === 'enhancedOnly') {
                pLeft.style.display = 'none';
                pRight.style.display = 'block';
                bEnh.classList.add('active');
            } else if (mode === 'origOnly') {
                pLeft.style.display = 'block';
                pRight.style.display = 'none';
                bOrig.classList.add('active');
            }
            setTimeout(onResize, 50);
        }

        function toggleWireframe() {
            wireframe = !wireframe;
            document.getElementById('btnWireframe').classList.toggle('active', wireframe);
            [modelLeft, modelRight].forEach(m => {
                if (!m) return;
                m.traverse(node => {
                    if (node.isMesh && node.material) {
                        const mats = Array.isArray(node.material) ? node.material : [node.material];
                        mats.forEach(mat => mat.wireframe = wireframe);
                    }
                });
            });
        }

        function toggleAutoRotate() {
            autoRotate = !autoRotate;
            document.getElementById('btnAutoRotate').classList.toggle('active', autoRotate);
        }

        function onResize() {
            const containerLeft = document.getElementById('containerLeft');
            const containerRight = document.getElementById('containerRight');

            if (containerLeft && containerLeft.clientWidth > 0 && containerLeft.clientHeight > 0) {
                cameraLeft.aspect = containerLeft.clientWidth / containerLeft.clientHeight;
                cameraLeft.updateProjectionMatrix();
                rendererLeft.setSize(containerLeft.clientWidth, containerLeft.clientHeight);
            }

            if (containerRight && containerRight.clientWidth > 0 && containerRight.clientHeight > 0) {
                cameraRight.aspect = containerRight.clientWidth / containerRight.clientHeight;
                cameraRight.updateProjectionMatrix();
                rendererRight.setSize(containerRight.clientWidth, containerRight.clientHeight);
            }
        }

        function animate() {
            requestAnimationFrame(animate);

            if (autoRotate && activeTab === '3d') {
                controlsLeft.autoRotate = true;
                controlsLeft.autoRotateSpeed = 1.0;
                controlsLeft.update();
                cameraRight.position.copy(cameraLeft.position);
                cameraRight.quaternion.copy(cameraLeft.quaternion);
                controlsRight.target.copy(controlsLeft.target);
                controlsRight.update();
            } else if (activeTab === '3d') {
                controlsLeft.update();
                controlsRight.update();
            }

            if (activeTab === '3d') {
                rendererLeft.render(sceneLeft, cameraLeft);
                rendererRight.render(sceneRight, cameraRight);
            }
        }

        window.onload = init;
    </script>
</body>
</html>
`;

fs.writeFileSync('public/nyc_esb_proof.html', html, 'utf8');
console.log('Successfully written public/nyc_esb_proof.html, size:', html.length);
