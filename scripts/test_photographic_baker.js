const fs = require('fs');
const path = require('path');
const { decodePng, encodePng } = require('../packages/core/dist/node/texture-processing.js');

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function sampleBilinear(img, px, py) {
    const x0 = clamp(Math.floor(px), 0, img.width - 1);
    const y0 = clamp(Math.floor(py), 0, img.height - 1);
    const x1 = clamp(x0 + 1, 0, img.width - 1);
    const y1 = clamp(y0 + 1, 0, img.height - 1);
    const fx = px - x0;
    const fy = py - y0;

    const idx00 = (y0 * img.width + x0) * 4;
    const idx10 = (y0 * img.width + x1) * 4;
    const idx01 = (y1 * img.width + x0) * 4;
    const idx11 = (y1 * img.width + x1) * 4;

    const res = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
        const c0 = img.data[idx00 + c] * (1 - fx) + img.data[idx10 + c] * fx;
        const c1 = img.data[idx01 + c] * (1 - fx) + img.data[idx11 + c] * fx;
        res[c] = c0 * (1 - fy) + c1 * fy;
    }
    return res;
}

function prepareSkinMap(img) {
    const W = img.width, H = img.height;
    const skin = new Uint8Array(W * H * 4);
    const isSkin = new Uint8Array(W * H);

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const idx = (y * W + x) * 4;
            const r = img.data[idx + 0];
            const g = img.data[idx + 1];
            const b = img.data[idx + 2];
            const a = img.data[idx + 3];

            // In user reference photos, background is dark (< 50) or below wrist cuff (y > 485)
            const isDark = (r < 55 && g < 55 && b < 55);
            const isCuff = (y > 485 && (r < 65 || (r > 200 && g > 200 && b > 200)));
            const valid = (a > 128) && !isDark && !isCuff && (r > 60) && (r > b * 0.9);

            if (valid) {
                isSkin[y * W + x] = 1;
                skin[idx + 0] = r;
                skin[idx + 1] = g;
                skin[idx + 2] = b;
                skin[idx + 3] = 255;
            }
        }
    }

    // 25-pass nearest skin flood fill for seamless border extension
    for (let pass = 0; pass < 25; pass++) {
        let filled = 0;
        for (let y = 1; y < H - 1; y++) {
            for (let x = 1; x < W - 1; x++) {
                const i = y * W + x;
                if (isSkin[i] === 0) {
                    const neighbors = [i - 1, i + 1, i - W, i + W];
                    for (const n of neighbors) {
                        if (isSkin[n] === 1) {
                            skin[i * 4 + 0] = skin[n * 4 + 0];
                            skin[i * 4 + 1] = skin[n * 4 + 1];
                            skin[i * 4 + 2] = skin[n * 4 + 2];
                            skin[i * 4 + 3] = 255;
                            isSkin[i] = 2;
                            filled++;
                            break;
                        }
                    }
                }
            }
        }
        for (let i = 0; i < W * H; i++) {
            if (isSkin[i] === 2) isSkin[i] = 1;
        }
        if (filled === 0) break;
    }

    return { data: skin, width: W, height: H };
}

// Landmark interpolation using Inverse Distance Weighting
function createIdwSampler(landmarks) {
    const pExp = 2.5;
    const eps = 1e-4;

    return function(uNorm, vNorm) {
        let sumW = 0;
        let sumX = 0;
        let sumY = 0;

        for (const lm of landmarks) {
            const du = uNorm - lm.uNorm;
            const dv = vNorm - lm.vNorm;
            const dist = Math.hypot(du, dv);
            if (dist < 1e-5) {
                return [lm.px, lm.py];
            }
            const w = 1.0 / (Math.pow(dist, pExp) + eps);
            sumW += w;
            sumX += w * lm.px;
            sumY += w * lm.py;
        }

        return [sumX / sumW, sumY / sumW];
    };
}

async function run() {
    console.log('Loading raw reference images...');
    const dorsalRaw = decodePng(fs.readFileSync('public/textures/reference_user/user_dorsal_raw.png'));
    const palmarRaw = decodePng(fs.readFileSync('public/textures/reference_user/user_palmar_raw.png'));

    console.log('Building clean skin maps (nearest-skin border extension)...');
    const dorsalSkin = prepareSkinMap(dorsalRaw);
    const palmarSkin = prepareSkinMap(palmarRaw);

    // Exact landmarks calibrated to 3D mesh sculpted nail plates and joint anatomy
    // Dorsal: uNorm: 0 = pinky, 1 = thumb. vNorm: 0 = wrist, 1 = middle tip.
    const dorsalLandmarks = [
        { uNorm: 0.0616, vNorm: 0.7413, px: 331, py: 164 }, // Pinky nail
        { uNorm: 0.2295, vNorm: 0.8816, px: 402, py: 67 },  // Ring nail
        { uNorm: 0.3898, vNorm: 0.9419, px: 471, py: 21 },  // Middle nail
        { uNorm: 0.6009, vNorm: 0.9040, px: 564, py: 41 },  // Index nail
        { uNorm: 0.9402, vNorm: 0.5976, px: 698, py: 222 }, // Thumb nail

        // MCP Knuckles
        { uNorm: 0.120, vNorm: 0.460, px: 390, py: 280 }, // Pinky MCP
        { uNorm: 0.230, vNorm: 0.490, px: 430, py: 265 }, // Ring MCP
        { uNorm: 0.370, vNorm: 0.520, px: 485, py: 250 }, // Middle MCP
        { uNorm: 0.550, vNorm: 0.480, px: 540, py: 260 }, // Index MCP
        { uNorm: 0.820, vNorm: 0.320, px: 570, py: 360 }, // Thumb CMC

        // Wrist (Forearm anchor)
        { uNorm: 0.444, vNorm: 0.230, px: 490, py: 475 },
        { uNorm: 0.150, vNorm: 0.230, px: 440, py: 475 },
        { uNorm: 0.750, vNorm: 0.230, px: 540, py: 475 }
    ];

    // Palmar: in 3D, uNorm: 0 = pinky, 1 = thumb.
    // In photo: Pinky is on RIGHT (px ~ 711), Thumb is on LEFT (px ~ 323).
    const palmarLandmarks = [
        { uNorm: 0.0616, vNorm: 0.7413, px: 711, py: 176 }, // Pinky tip
        { uNorm: 0.2295, vNorm: 0.8816, px: 646, py: 68 },  // Ring tip
        { uNorm: 0.3898, vNorm: 0.9419, px: 576, py: 17 },  // Middle tip
        { uNorm: 0.6009, vNorm: 0.9040, px: 476, py: 30 },  // Index tip
        { uNorm: 0.9402, vNorm: 0.5976, px: 323, py: 215 }, // Thumb tip

        // MCP Knuckles / Palmar crease boundaries
        { uNorm: 0.120, vNorm: 0.460, px: 643, py: 250 }, // Pinky MCP
        { uNorm: 0.230, vNorm: 0.490, px: 600, py: 240 }, // Ring MCP
        { uNorm: 0.370, vNorm: 0.520, px: 550, py: 235 }, // Middle MCP
        { uNorm: 0.550, vNorm: 0.480, px: 500, py: 240 }, // Index MCP
        { uNorm: 0.820, vNorm: 0.320, px: 440, py: 330 }, // Thumb CMC

        // Wrist (Tattoo anchor)
        { uNorm: 0.444, vNorm: 0.230, px: 488.5, py: 475 },
        { uNorm: 0.150, vNorm: 0.230, px: 540.0, py: 475 },
        { uNorm: 0.750, vNorm: 0.230, px: 435.0, py: 475 }
    ];

    const dorsalSampler = createIdwSampler(dorsalLandmarks);
    const palmarSampler = createIdwSampler(palmarLandmarks);

    const width = 2048, height = 2048;
    const albedoBuf = Buffer.alloc(width * height * 4);
    const normalBuf = Buffer.alloc(width * height * 4);
    const ormBuf = Buffer.alloc(width * height * 4);

    console.log('Synthesizing 2048x2048 PBR atlas via photographic projection...');

    // 3D sculpted nail plate ellipses for ORM roughness mapping
    const nailPlates = [
        { name: 'Thumb',  u: 0.4437, v: 0.4083, ru: 0.020, rv: 0.025 },
        { name: 'Index',  u: 0.2944, v: 0.1202, ru: 0.015, rv: 0.022 },
        { name: 'Middle', u: 0.2015, v: 0.0846, ru: 0.015, rv: 0.024 },
        { name: 'Ring',   u: 0.1310, v: 0.1413, ru: 0.014, rv: 0.022 },
        { name: 'Pinky',  u: 0.0571, v: 0.2732, ru: 0.013, rv: 0.020 }
    ];

    for (let y = 0; y < height; y++) {
        const v = y / (height - 1);
        for (let x = 0; x < width; x++) {
            const u = x / (width - 1);
            const idx = (y * width + x) * 4;

            let r = 160, g = 125, b = 112; // Base melanin fallback
            let roughness = 158; // 0.62 dorsal skin

            if (u < 0.50) {
                // ================= DORSAL ISLAND =================
                // u in [0.03, 0.47]
                const uNorm = clamp((u - 0.03) / 0.44, 0, 1);
                const vNorm = clamp(1.0 - (v - 0.03) / 0.94, 0, 1);

                const [targetPx, targetPy] = dorsalSampler(uNorm, vNorm);
                // Clamp sample y to wrist area if on forearm
                const clampedPy = (vNorm < 0.230) ? Math.min(475, targetPy) : targetPy;

                const sample = sampleBilinear(dorsalSkin, targetPx, clampedPy);
                r = Math.round(sample[0]);
                g = Math.round(sample[1]);
                b = Math.round(sample[2]);

                // Check nail roughness
                for (const nail of nailPlates) {
                    const du = (u - nail.u) / nail.ru;
                    const dv = (v - nail.v) / nail.rv;
                    const distNail = Math.hypot(du, dv);
                    if (distNail <= 1.0) {
                        // Smooth keratin transition
                        const tNail = Math.min(1.0, (1.0 - distNail) * 3.0);
                        roughness = Math.round(roughness * (1.0 - tNail) + 71 * tNail); // 0.28 gloss
                        break;
                    }
                }
            } else {
                // ================= PALMAR ISLAND =================
                // u in [0.53, 0.97]
                // Parity fix: In 3D, u = 0.53 is Thumb (uNorm = 1), u = 0.97 is Pinky (uNorm = 0)
                const uNorm = clamp(1.0 - (u - 0.53) / 0.44, 0, 1);
                const vNorm = clamp(1.0 - (v - 0.03) / 0.94, 0, 1);

                const [targetPx, targetPy] = palmarSampler(uNorm, vNorm);
                const clampedPy = (vNorm < 0.230) ? Math.min(475, targetPy) : targetPy;

                const sample = sampleBilinear(palmarSkin, targetPx, clampedPy);
                r = Math.round(sample[0]);
                g = Math.round(sample[1]);
                b = Math.round(sample[2]);

                // Palmar glabrous skin has hydrated friction ridges
                roughness = 133; // 0.52
            }

            albedoBuf[idx + 0] = r;
            albedoBuf[idx + 1] = g;
            albedoBuf[idx + 2] = b;
            albedoBuf[idx + 3] = 255;

            ormBuf[idx + 0] = 255; // AO
            ormBuf[idx + 1] = roughness;
            ormBuf[idx + 2] = 0;   // Dielectric
            ormBuf[idx + 3] = 255;
        }
    }

    // Sobel tangent-space normal map from luminance
    console.log('Generating Sobel photographic normal map...');
    const lum = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
        lum[i] = (albedoBuf[i * 4 + 0] * 0.299 + albedoBuf[i * 4 + 1] * 0.587 + albedoBuf[i * 4 + 2] * 0.114) / 255.0;
    }

    const normStrength = 2.2;
    for (let y = 0; y < height; y++) {
        const y0 = Math.max(0, y - 1);
        const y1 = Math.min(height - 1, y + 1);
        for (let x = 0; x < width; x++) {
            const x0 = Math.max(0, x - 1);
            const x1 = Math.min(width - 1, x + 1);

            const dx = (lum[y * width + x1] - lum[y * width + x0]) * normStrength;
            const dy = (lum[y1 * width + x] - lum[y0 * width + x]) * normStrength;
            const len = Math.hypot(dx, dy, 1.0);

            const nx = clamp(Math.round(128 + (-dx / len) * 127), 0, 255);
            const ny = clamp(Math.round(128 + (-dy / len) * 127), 0, 255);
            const nz = clamp(Math.round((1.0 / len) * 255), 0, 255);

            const idx = (y * width + x) * 4;
            normalBuf[idx + 0] = nx;
            normalBuf[idx + 1] = ny;
            normalBuf[idx + 2] = nz;
            normalBuf[idx + 3] = 255;
        }
    }

    console.log('Encoding PNGs...');
    const albedoPng = encodePng(width, height, albedoBuf);
    const normalPng = encodePng(width, height, normalBuf);
    const ormPng = encodePng(width, height, ormBuf);

    fs.writeFileSync('public/textures/humanoid/hand_albedo.png', albedoPng);
    fs.writeFileSync('public/textures/humanoid/hand_normal.png', normalPng);
    fs.writeFileSync('public/textures/humanoid/hand_orm.png', ormPng);

    console.log('Saved hand_albedo.png:', albedoPng.length, 'bytes');
    console.log('Saved hand_normal.png:', normalPng.length, 'bytes');
    console.log('Saved hand_orm.png:', ormPng.length, 'bytes');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
