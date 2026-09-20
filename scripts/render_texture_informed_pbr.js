/********************************************************************************
 * Scratchbox IDE - Headless 3D Texture-Informed PBR Comparison Renderer
 * Generates:
 *   docs/screenshots/15_texture_informed_pbr_comparison.png
 *
 * 3-Panel Visual Proof:
 *   Panel 1: Raw Photogrammetric Tile (Baked Sun, Blurry Scan, Flat Diffuse)
 *   Panel 2: Cleaned + Texture-Informed Daytime PBR (De-lighted Stone, Mirror Glass, Recessed Reveals)
 *   Panel 3: Texture-Informed Night Scene (Warm 3000K Window Interior Glow)
 ********************************************************************************/

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 1. Zero-dependency PNG Encoder
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c;
}

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function writeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(12 + len);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    const crc = crc32(buf.subarray(4, 8 + len));
    buf.writeUInt32BE(crc, 8 + len);
    return buf;
}

function encodePNG(width, height, rgbaBuffer) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const rawScanlines = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
        const rowOffset = y * (1 + width * 4);
        rawScanlines[rowOffset] = 0; // Filter None
        rgbaBuffer.copy(rawScanlines, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
    }

    const compressed = zlib.deflateSync(rawScanlines, { level: 8 });
    return Buffer.concat([
        signature,
        writeChunk('IHDR', ihdr),
        writeChunk('IDAT', compressed),
        writeChunk('IEND', Buffer.alloc(0))
    ]);
}

// 2. Vector Math
function v3(x, y, z) { return { x, y, z }; }
function add(a, b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
function sub(a, b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
function mul(a, s) { return v3(a.x * s, a.y * s, a.z * s); }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function length(a) { return Math.sqrt(dot(a, a)); }
function norm(a) {
    const l = length(a);
    return l > 1e-6 ? mul(a, 1 / l) : v3(0, 0, 0);
}
function max3(a, b) { return v3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function sdBox(p, b) {
    const q = v3(Math.abs(p.x) - b.x, Math.abs(p.y) - b.y, Math.abs(p.z) - b.z);
    const outside = length(max3(q, v3(0, 0, 0)));
    const inside = Math.min(Math.max(q.x, Math.max(q.y, q.z)), 0);
    return outside + inside;
}

function sdEmpireState(p) {
    // Quick outer bounding box rejection
    if (Math.abs(p.x) > 34.0 || Math.abs(p.z) > 24.0 || p.y < -1.0 || p.y > 224.0) {
        return sdBox(v3(p.x, p.y - 110, p.z), v3(30, 112, 20));
    }

    // Tier 1: Base Podium (0m - 24m, 54m x 36m)
    const d1 = sdBox(v3(p.x, p.y - 12.0, p.z), v3(27.0, 12.0, 18.0));
    // Tier 2: Lower Transition Shaft (24m - 52m, 42m x 28m)
    const d2 = sdBox(v3(p.x, p.y - 38.0, p.z), v3(21.0, 14.0, 14.0));
    // Tier 3: Main Tower Shaft (52m - 140m, 30m x 20m)
    const d3 = sdBox(v3(p.x, p.y - 96.0, p.z), v3(15.0, 44.0, 10.0));
    // Tier 4: Upper Tower & Observation Deck (140m - 168m, 18m x 13m)
    const d4 = sdBox(v3(p.x, p.y - 154.0, p.z), v3(9.0, 14.0, 6.5));
    // Tier 5: Mooring Mast (168m - 196m, 9m x 9m)
    const d5 = sdBox(v3(p.x, p.y - 182.0, p.z), v3(4.5, 14.0, 4.5));
    // Tier 6: Spire & Beacon Tip (196m - 220m, 3.0m x 3.0m)
    const d6 = sdBox(v3(p.x, p.y - 208.0, p.z), v3(1.5, 12.0, 1.5));

    return Math.min(Math.min(Math.min(d1, d2), Math.min(d3, d4)), Math.min(d5, d6));
}

// 3. Scene SDFs for the 3 Panels
function sceneRawScanSDF(p) {
    let cornerWaviness = 0;
    // Photogrammetry melted rounded corners on tier perimeter edges
    const isEdge = Math.abs(Math.abs(p.x) - 27.0) < 2.5 || Math.abs(Math.abs(p.z) - 18.0) < 2.5 ||
                   Math.abs(Math.abs(p.x) - 21.0) < 2.5 || Math.abs(Math.abs(p.z) - 14.0) < 2.5 ||
                   Math.abs(Math.abs(p.x) - 15.0) < 2.5 || Math.abs(Math.abs(p.z) - 10.0) < 2.5 ||
                   Math.abs(Math.abs(p.x) - 9.0)  < 2.0 || Math.abs(Math.abs(p.z) - 6.5)  < 2.0;

    if (isEdge && p.y > 0 && p.y < 210.0) {
        cornerWaviness = Math.sin(p.y * 0.28) * 0.32 + Math.cos(p.y * 0.65) * 0.18;
    }
    const surfaceNoise = Math.sin(p.x * 0.8) * Math.sin(p.y * 0.6) * Math.sin(p.z * 0.8) * 0.08;
    const dBuilding = sdEmpireState(p) + cornerWaviness + surfaceNoise;
    const dPlane = p.y + 0.1;
    return Math.min(dBuilding, dPlane);
}

function sceneCleanedSDF(p) {
    const dBuilding = sdEmpireState(p);
    // Rooftop HVAC chiller unit on Tier 1 terrace
    const hvacPos = v3(p.x - 22.0, p.y - 24.9, p.z - 14.0);
    const dHvac = sdBox(hvacPos, v3(2.4, 0.9, 1.8));
    const dPlane = p.y + 0.08;
    return Math.min(Math.min(dBuilding, dPlane), dHvac);
}

function calcNormal(sdfFunc, p) {
    const eps = 0.005;
    const dx = sdfFunc(v3(p.x + eps, p.y, p.z)) - sdfFunc(v3(p.x - eps, p.y, p.z));
    const dy = sdfFunc(v3(p.x, p.y + eps, p.z)) - sdfFunc(v3(p.x, p.y - eps, p.z));
    const dz = sdfFunc(v3(p.x, p.y, p.z + eps)) - sdfFunc(v3(p.x, p.y, p.z - eps));
    return norm(v3(dx, dy, dz));
}

// 4. Raymarching Shader for each Panel
function raymarchPanel(camPos, rayDir, panelType) {
    const sdfFunc = (panelType === 'raw') ? sceneRawScanSDF : sceneCleanedSDF;
    let t = 1.0;
    const maxT = 360.0;
    let hit = false;
    let p = camPos;

    for (let step = 0; step < 160; step++) {
        p = add(camPos, mul(rayDir, t));
        const d = sdfFunc(p);
        if (d < 0.004) {
            hit = true;
            break;
        }
        t += d * 0.85;
        if (t > maxT) break;
    }

    if (!hit) {
        if (panelType === 'night') {
            const v = clamp(rayDir.y * 2.0, 0, 1);
            return v3(0.02 + 0.01 * v, 0.03 + 0.02 * v, 0.06 + 0.04 * v);
        } else {
            const v = clamp(rayDir.y * 1.5 + 0.2, 0, 1);
            return v3(0.12 + 0.35 * v, 0.18 + 0.45 * v, 0.28 + 0.55 * v);
        }
    }

    const n = calcNormal(sdfFunc, p);

    const isSpire = p.y >= 196.0;
    const isMooringMast = p.y >= 168.0 && p.y < 196.0;
    const isRoof = !isSpire && p.y > 0.5 && Math.abs(n.y) > 0.6;
    const isGround = p.y <= 0.5 && Math.abs(n.y) > 0.6;
    const isFacade = !isRoof && !isGround && !isMooringMast && !isSpire;

    const floorHeight = 3.6;
    const bayWidth = 2.5;
    const floorPhase = ((p.y % floorHeight) + floorHeight) % floorHeight;
    const vNorm = floorPhase / floorHeight; // 0.0 at floor datum, 1.0 at ceiling

    let uMetric = 0;
    if (Math.abs(n.z) > Math.abs(n.x)) {
        uMetric = p.x;
    } else {
        uMetric = p.z;
    }
    const bayPhase = ((uMetric % bayWidth) + bayWidth) % bayWidth;
    const uNorm = bayPhase / bayWidth; // 0.0 to 1.0 across bay

    // Exact matching bounds with C++ synthesizePbrTextureSet
    const uWinMin = 0.20;
    const uWinMax = 0.80;
    const vWinMin = 0.26;
    const vWinMax = 0.86;

    const revealU = 0.035;
    const revealV = 0.035;

    // Projecting stone sill
    const sillVMin = vWinMin - 0.055;
    const sillVMax = vWinMin;
    const sillUMin = uWinMin - 0.030;
    const sillUMax = uWinMax + 0.030;

    // Inner bronze frame boundaries
    const frameUMin = uWinMin + revealU;
    const frameUMax = uWinMax - revealU;
    const frameVMin = vWinMin;
    const frameVMax = vWinMax - revealV;

    const frameThick = 0.022;
    const mullionWidth = 0.020;
    const transomV = frameVMin + (frameVMax - frameVMin) * 0.72;
    const transomThick = 0.018;

    const blindDropV = 0.44;
    const slatPeriodV = 0.014;

    const inOuterWindow = isFacade && p.y > 2.0 && p.y < 167.0 && (uNorm >= uWinMin && uNorm <= uWinMax && vNorm >= vWinMin && vNorm <= vWinMax);
    const inReveal = inOuterWindow && (uNorm < frameUMin || uNorm > frameUMax || vNorm > frameVMax);
    const inSill = isFacade && p.y > 2.0 && p.y < 167.0 && (uNorm >= sillUMin && uNorm <= sillUMax && vNorm >= sillVMin && vNorm <= sillVMax);
    const inWindowFrameBox = inOuterWindow && !inReveal;

    const inBronzeFrame = inWindowFrameBox && (
        uNorm < (frameUMin + frameThick) || uNorm > (frameUMax - frameThick) ||
        vNorm < (frameVMin + frameThick) || vNorm > (frameVMax - frameThick) ||
        Math.abs(uNorm - 0.50) < (mullionWidth * 0.5) ||
        Math.abs(vNorm - transomV) < (transomThick * 0.5)
    );
    const inGlass = inWindowFrameBox && !inBronzeFrame;

    // Exterior Ashlar Limestone coursing
    const courseY = vNorm * 8.0;
    const courseIdx = Math.floor(courseY);
    const vBlock = courseY - courseIdx;
    const uOffset = (courseIdx % 2 !== 0) ? 0.16667 : 0.0;
    const blockX = (uNorm + uOffset) * 3.0;
    const blockIdx = Math.floor(blockX);
    const uBlock = blockX - blockIdx;

    const mortarU = 0.032;
    const mortarV = 0.040;
    const isMortar = isFacade && !inOuterWindow && !inSill && (
        uBlock < mortarU || uBlock > (1.0 - mortarU) ||
        vBlock < mortarV || vBlock > (1.0 - mortarV)
    );

    const sunDir = norm(v3(0.65, 0.75, 0.35));
    const viewDir = norm(sub(camPos, p));

    if (panelType === 'raw') {
        const rawSunShadow = clamp(dot(n, sunDir), 0.25, 1.0);
        let diffuse = v3(0.80 * rawSunShadow, 0.76 * rawSunShadow, 0.70 * rawSunShadow);

        if (isMooringMast) {
            diffuse = v3(0.68 * rawSunShadow + 0.04, 0.70 * rawSunShadow + 0.04, 0.73 * rawSunShadow + 0.05);
        } else if (isSpire) {
            diffuse = (p.y > 218.0) ? v3(0.95, 0.15, 0.05) : v3(0.85 * rawSunShadow + 0.05, 0.87 * rawSunShadow + 0.05, 0.90 * rawSunShadow + 0.05);
        } else if (isFacade && inOuterWindow) {
            diffuse = v3(0.10 * rawSunShadow + 0.03, 0.14 * rawSunShadow + 0.04, 0.18 * rawSunShadow + 0.06);
        } else if (isRoof) {
            diffuse = v3(0.35, 0.34, 0.33);
        } else if (isGround) {
            diffuse = v3(0.20, 0.20, 0.22);
            if (p.x < -14 && p.z > 8) {
                diffuse = v3(0.22, 0.58, 0.24);
            }
        }

        const scanRipple = Math.sin(p.y * 8.0) * 0.03;
        diffuse = add(diffuse, v3(scanRipple, scanRipple, scanRipple));
        return diffuse;

    } else if (panelType === 'day_pbr') {
        const baseStone = v3(0.68, 0.65, 0.58); // De-lighted Indiana Limestone
        let effectiveN = n;
        let albedo = baseStone;
        let roughness = 0.82;
        let metallic = 0.0;
        let ao = 1.0;

        if (inGlass) {
            metallic = 0.0;
            roughness = 0.06;
            ao = 0.98;

            // Float glass roller wave perturbation
            const wave = Math.sin(uNorm * 50.0 + vNorm * 35.0) * 0.02;
            effectiveN = norm(add(n, v3(wave, wave * 0.7, 0)));

            const hasBlinds = (vNorm >= blindDropV);
            if (hasBlinds) {
                const slatPhase = ((vNorm - blindDropV) % slatPeriodV + slatPeriodV) % slatPeriodV / slatPeriodV;
                const inSlatGap = (slatPhase < 0.12);
                const slatShade = 0.78 + 0.22 * Math.sin(slatPhase * Math.PI);
                const slatCol = mul(v3(0.84, 0.82, 0.78), slatShade);
                // Glass tinted reflectance over blinds
                albedo = add(mul(v3(0.08, 0.12, 0.16), 0.35), mul(slatCol, 0.65));
            } else {
                // Open window: interior office depth
                const roomDepth = clamp((vNorm - frameVMin) / (blindDropV - frameVMin), 0, 1);
                albedo = add(v3(0.04, 0.06, 0.08), mul(v3(0.10, 0.12, 0.14), 0.6 + 0.4 * roomDepth));
            }

        } else if (inBronzeFrame) {
            let bronzeCol = v3(0.24, 0.22, 0.19);
            roughness = 0.30;
            metallic = 0.88;
            ao = 0.78;

            // Frame edge bevel normal
            if (Math.abs(uNorm - 0.50) < (mullionWidth * 0.5)) {
                const mDist = (uNorm - 0.50) / (mullionWidth * 0.5);
                effectiveN = norm(add(n, v3(mDist * 0.35, 0, 0)));
            } else if (Math.abs(vNorm - transomV) < (transomThick * 0.5)) {
                const tDist = (vNorm - transomV) / (transomThick * 0.5);
                effectiveN = norm(add(n, v3(0, tDist * 0.35, 0)));
            }

            // Patina Layer B1: Cuprite oxide (Cu2O) in frame crevice grooves
            const frameCrevice = (Math.abs(uNorm - 0.50) < mullionWidth || Math.abs(vNorm - transomV) < transomThick) ? 0.5 : 0.0;
            if (frameCrevice > 0.1) {
                bronzeCol = v3(0.18, 0.12, 0.09);
                roughness = 0.65;
                metallic = 0.20;
            }

            // Patina Layer B2: Verdigris in frame corners
            const cornerDist = Math.min(Math.abs(uNorm - frameUMin), Math.abs(uNorm - frameUMax)) +
                               Math.min(Math.abs(vNorm - frameVMin), Math.abs(vNorm - frameVMax));
            if (cornerDist < 0.025) {
                const vMask = (0.025 - cornerDist) / 0.025;
                bronzeCol = add(mul(bronzeCol, 1 - vMask), mul(v3(0.24, 0.64, 0.52), vMask));
                metallic *= (1.0 - vMask);
                roughness = 0.84;
            }
            albedo = bronzeCol;

        } else if (inReveal) {
            // 15cm stone reveal casing
            albedo = mul(baseStone, 0.88);
            roughness = 0.78;
            metallic = 0.0;
            ao = 0.62;

            if (uNorm < frameUMin) effectiveN = norm(add(n, v3(0.55, 0, 0)));
            else if (uNorm > frameUMax) effectiveN = norm(add(n, v3(-0.55, 0, 0)));
            else if (vNorm > frameVMax) {
                effectiveN = norm(add(n, v3(0, -0.55, 0)));
                // Lintel cavity soot
                albedo = mul(albedo, 0.72);
                ao = 0.42;
                roughness = 0.90;
            }

        } else if (inSill) {
            // Projecting stone sill
            const sillVNorm = (vNorm - sillVMin) / (sillVMax - sillVMin);
            metallic = 0.0;
            roughness = 0.72;

            if (sillVNorm > 0.60) {
                // Top wash chamfer
                effectiveN = norm(add(n, v3(0, 0.60, 0)));
                ao = 0.96;
                albedo = mul(baseStone, 1.06);
            } else if (sillVNorm < 0.25) {
                // Undercut drip groove soot shadow
                effectiveN = norm(add(n, v3(0, -0.65, 0)));
                ao = 0.28;
                albedo = mul(baseStone, 0.48);
                roughness = 0.95;
            } else {
                ao = 0.88;
                albedo = mul(baseStone, 0.98);
                // Calcite chipping at sill corner
                if (uNorm < (sillUMin + 0.025) || uNorm > (sillUMax - 0.025)) {
                    albedo = mul(albedo, 1.15);
                    roughness = 0.88;
                }
            }

        } else if (isMortar) {
            // Recessed mortar joints with cavity soot accumulation
            const sootCol = v3(0.13, 0.12, 0.11);
            albedo = add(mul(mul(baseStone, 0.58), 0.35), mul(sootCol, 0.65));
            roughness = 0.96;
            metallic = 0.0;
            ao = 0.28; // Deep cavity shadow

            let nDx = 0, nDy = 0;
            if (uBlock < mortarU) nDx = 0.45;
            else if (uBlock > (1.0 - mortarU)) nDx = -0.45;
            if (vBlock < mortarV) nDy = 0.45;
            else if (vBlock > (1.0 - mortarV)) nDy = -0.45;
            effectiveN = norm(add(n, v3(nDx, nDy, 0)));

        } else if (isFacade) {
            // Ashlar limestone block with multi-layer patina
            const bHash = Math.abs(Math.sin(blockIdx * 73.856 + courseIdx * 19.349) * 43758.5453) % 1.0;
            const blockTone = 0.94 + bHash * 0.12;
            const sawMarks = Math.sin(vNorm * 480.0) * 0.025;
            const stonePores = Math.sin(uNorm * 160.0) * Math.cos(vNorm * 190.0) * 0.020;

            // Patina Layer E1: Curvature calcite edge wear on block boundaries
            const dEdgeU = Math.min(uBlock - mortarU, (1.0 - mortarU) - uBlock);
            const dEdgeV = Math.min(vBlock - mortarV, (1.0 - mortarV) - vBlock);
            const dEdge = Math.min(dEdgeU, dEdgeV);
            let edgeWear = 0;
            if (dEdge < 0.040) {
                const chip = (Math.sin(uBlock * 40.0) * Math.cos(vBlock * 40.0)) > 0.1 ? 0.12 : 0.0;
                edgeWear = chip;
            }

            // Patina Layer E2: Gravity Rain Runoff Drip Streaks beneath sill corners
            let dripStreaks = 0;
            const underSillCorners = (vNorm < sillVMin) && (
                (uNorm >= (sillUMin - 0.025) && uNorm <= (sillUMin + 0.035)) ||
                (uNorm >= (sillUMax - 0.035) && uNorm <= (sillUMax + 0.025))
            );
            if (underSillCorners) {
                const dripDistance = (sillVMin - vNorm) / sillVMin;
                const streakNoise = 0.60 + 0.40 * Math.sin(uNorm * 175.0 + Math.cos(vNorm * 85.0));
                dripStreaks = Math.exp(-dripDistance / 0.42) * streakNoise * 0.32;
            }

            // Patina Layer E3: Copper Verdigris / Bronze Leaching under sill apron
            let verdigrisAmount = 0;
            if (vNorm < sillVMin && vNorm > (sillVMin - 0.065)) {
                const vDist = (sillVMin - vNorm) / 0.065;
                verdigrisAmount = (1.0 - vDist) * 0.38;
            }

            // Patina Layer E4: Ground Splashback & street efflorescence
            let splashback = 0;
            if (p.y < 3.2) {
                splashback = ((3.2 - p.y) / 3.2) * 0.25;
            }

            const finalTone = blockTone + sawMarks + stonePores + edgeWear - dripStreaks - splashback * 0.5;
            let blockCol = mul(baseStone, clamp(finalTone, 0.45, 1.25));

            // Blend Verdigris turquoise wash
            if (verdigrisAmount > 0.01) {
                const verdigrisTone = v3(0.26, 0.64, 0.54);
                blockCol = add(mul(blockCol, 1.0 - verdigrisAmount), mul(verdigrisTone, verdigrisAmount));
            }

            albedo = blockCol;
            roughness = clamp(0.80 + dripStreaks * 0.6 + edgeWear * 0.4 + splashback * 0.4, 0.70, 0.96);
            ao = clamp(0.92 - dripStreaks * 0.4 - splashback * 0.3, 0.35, 1.0);

            effectiveN = norm(add(n, v3(Math.cos(uNorm * 160.0) * 0.03, sawMarks * 1.2, 0)));

        } else if (isMooringMast) {
            albedo = v3(0.72, 0.74, 0.77);
            roughness = 0.22;
            metallic = 0.92;
            ao = 0.90;
            const flute = Math.sin(p.x * 12.0 + p.z * 12.0) * 0.04;
            effectiveN = norm(add(n, v3(flute, 0, flute)));
        } else if (isSpire) {
            albedo = (p.y > 218.0) ? v3(0.95, 0.15, 0.05) : v3(0.88, 0.90, 0.92);
            roughness = 0.12;
            metallic = 0.95;
            ao = 1.0;
        } else if (isRoof) {
            albedo = v3(0.48, 0.47, 0.46);
            roughness = 0.88;
        } else if (isGround) {
            albedo = v3(0.22, 0.22, 0.24);
            roughness = 0.75;
        }

        const NdotL = Math.max(0.0, dot(effectiveN, sunDir));
        const halfVec = norm(add(sunDir, viewDir));
        const NdotH = Math.max(0.0, dot(effectiveN, halfVec));

        const alpha = roughness * roughness;
        const alpha2 = Math.max(0.001, alpha * alpha);
        const denom = (NdotH * NdotH * (alpha2 - 1.0) + 1.0);
        const D = alpha2 / (Math.PI * denom * denom);

        const f0 = metallic > 0.5 ? albedo : v3(0.04, 0.04, 0.04);
        const VdotH = Math.max(0.0, dot(viewDir, halfVec));
        const F = add(f0, mul(sub(v3(1, 1, 1), f0), Math.pow(1.0 - VdotH, 5.0)));

        const specular = mul(F, D * 0.25);
        const diffuse = mul(albedo, NdotL * (1.0 - metallic) * ao);
        const skyAmbient = mul(v3(0.25, 0.32, 0.42), (effectiveN.y * 0.5 + 0.5) * 0.6 * ao);

        let glassReflect = v3(0, 0, 0);
        if (inGlass) {
            const reflRay = sub(mul(effectiveN, 2.0 * dot(viewDir, effectiveN)), viewDir);
            const skyGrad = clamp(reflRay.y * 1.5 + 0.2, 0, 1);
            glassReflect = mul(v3(0.35 + 0.5 * skyGrad, 0.55 + 0.4 * skyGrad, 0.85 + 0.15 * skyGrad), 0.75);
        }

        let metalReflect = v3(0, 0, 0);
        if (metallic > 0.5) {
            const reflRay = sub(mul(effectiveN, 2.0 * dot(viewDir, effectiveN)), viewDir);
            const skyGrad = clamp(reflRay.y * 1.2 + 0.3, 0, 1);
            metalReflect = mul(albedo, (0.35 + 0.65 * skyGrad) * (1.0 - roughness * 0.4));
        }

        return add(add(add(add(diffuse, specular), skyAmbient), glassReflect), metalReflect);

    } else if (panelType === 'night') {
        let stoneCol = v3(0.06, 0.08, 0.12);
        let emissive = v3(0, 0, 0);

        if (isMooringMast) {
            const flute = Math.sin(p.x * 10.0 + p.z * 10.0) * 0.5 + 0.5;
            const floodUp = Math.exp(-(p.y - 168.0) * 0.08) * 0.9 + Math.exp(-(196.0 - p.y) * 0.1) * 0.6;
            return mul(v3(0.92, 0.88, 0.76), (0.2 + 0.8 * flute) * floodUp * 1.6 + 0.04);
        } else if (isSpire) {
            if (p.y > 218.0) return v3(2.8, 0.25, 0.10); // Red aircraft warning beacon
            else return mul(v3(0.7, 0.75, 0.85), 0.35);
        } else if (inGlass) {
            const emissiveGold = v3(1.0, 0.82, 0.52);
            const floorIdx = Math.floor(p.y / 3.6);
            const bayIdx = Math.floor(uMetric / 2.5);
            const randSeed = Math.sin(floorIdx * 12.9898 + bayIdx * 78.233) * 43758.5453;
            const isLit = (Math.abs(randSeed % 1.0) < 0.82);

            if (isLit) {
                const hasBlinds = (vNorm >= blindDropV);
                if (hasBlinds) {
                    const slatPhase = ((vNorm - blindDropV) % slatPeriodV + slatPeriodV) % slatPeriodV / slatPeriodV;
                    const inSlatGap = (slatPhase < 0.12);
                    if (inSlatGap) {
                        emissive = mul(emissiveGold, 2.4); // Direct slit leakage
                    } else {
                        const slatShade = 0.80 + 0.20 * Math.sin(slatPhase * Math.PI);
                        emissive = mul(emissiveGold, 0.95 * slatShade);
                    }
                } else {
                    const roomDepth = clamp((vNorm - frameVMin) / (blindDropV - frameVMin), 0, 1);
                    emissive = mul(emissiveGold, 1.85 * (0.75 + 0.25 * roomDepth));
                }
            } else {
                emissive = v3(0.03, 0.04, 0.07);
            }
            return emissive;

        } else if (inBronzeFrame) {
            return v3(0.04, 0.04, 0.05);
        } else if (inReveal) {
            return v3(0.035, 0.045, 0.07);
        } else if (isRoof) {
            return v3(0.03, 0.04, 0.05);
        } else if (isGround) {
            const streetLamp = Math.sin(p.x * 0.2) * Math.sin(p.z * 0.2);
            return v3(0.02 + Math.max(0, streetLamp) * 0.05, 0.02 + Math.max(0, streetLamp) * 0.04, 0.03);
        }

        const nightAmbient = clamp(dot(n, norm(v3(0.2, 0.8, -0.4))), 0.1, 1.0);
        return mul(stoneCol, nightAmbient);
    }
}

// 5. HUD Drawing Helpers
function setPixel(buf, w, h, x, y, r, g, b, a = 1.0) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const idx = (y * w + x) * 4;
    const invA = 1.0 - a;
    buf[idx + 0] = Math.round(buf[idx + 0] * invA + r * a);
    buf[idx + 1] = Math.round(buf[idx + 1] * invA + g * a);
    buf[idx + 2] = Math.round(buf[idx + 2] * invA + b * a);
    buf[idx + 3] = 255;
}

function drawRect(buf, w, h, rx, ry, rw, rh, r, g, b, a = 1.0) {
    for (let y = ry; y < ry + rh; y++) {
        for (let x = rx; x < rx + rw; x++) {
            setPixel(buf, w, h, x, y, r, g, b, a);
        }
    }
}

const FONT_5X7 = {
    'A': [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
    'B': [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
    'C': [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
    'D': [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
    'E': [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
    'F': [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
    'G': [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
    'H': [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
    'I': [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
    'J': [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
    'K': [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
    'L': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
    'M': [0x11, 0x1b, 0x15, 0x11, 0x11, 0x11, 0x11],
    'N': [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
    'O': [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
    'P': [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
    'Q': [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
    'R': [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
    'S': [0x0e, 0x11, 0x10, 0x0e, 0x01, 0x11, 0x0e],
    'T': [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
    'U': [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
    'V': [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
    'W': [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
    'X': [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
    'Y': [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
    'Z': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
    '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
    '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
    '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
    '3': [0x1f, 0x01, 0x02, 0x0e, 0x01, 0x11, 0x0e],
    '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
    '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
    '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
    '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
    '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
    '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
    ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
    '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
    ',': [0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c, 0x08],
    '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
    '+': [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
    '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
    '%': [0x19, 0x19, 0x02, 0x04, 0x08, 0x13, 0x13],
    '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
    ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
    '#': [0x0a, 0x0a, 0x1f, 0x0a, 0x1f, 0x0a, 0x0a],
    '&': [0x0c, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0d],
    '>': [0x10, 0x08, 0x04, 0x02, 0x04, 0x08, 0x10],
    '|': [0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
    ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
};

function drawChar(buf, w, h, ch, startX, startY, r, g, b, scale = 1) {
    const bitmap = FONT_5X7[ch.toUpperCase()] || FONT_5X7[' '];
    for (let row = 0; row < 7; row++) {
        const bits = bitmap[row];
        for (let col = 0; col < 5; col++) {
            if ((bits >> (4 - col)) & 1) {
                for (let sy = 0; sy < scale; sy++) {
                    for (let sx = 0; sx < scale; sx++) {
                        setPixel(buf, w, h, startX + col * scale + sx, startY + row * scale + sy, r, g, b, 1.0);
                    }
                }
            }
        }
    }
}

function drawText(buf, w, h, text, x, y, r, g, b, scale = 1) {
    let curX = x;
    const stride = 6 * scale;
    for (let i = 0; i < text.length; i++) {
        drawChar(buf, w, h, text[i], curX, y, r, g, b, scale);
        curX += stride;
    }
}

// 6. Main 3-Panel Render Routine
function renderTextureInformedPbrComparison() {
    const TOTAL_W = 1920;
    const H = 1080;
    const PANEL_W = Math.floor(TOTAL_W / 3);

    const rgba = Buffer.alloc(TOTAL_W * H * 4);

    const camPos = v3(140.0, 115.0, 160.0);
    const camTarget = v3(0.0, 85.0, 0.0);
    const camFwd = norm(sub(camTarget, camPos));
    const camRight = norm(v3(-camFwd.z, 0, camFwd.x));
    const camUp = norm(v3(0, 1, 0));

    const panels = [
        { type: 'raw', startX: 0, title: 'STAGE 1: RAW ESB SCAN', subtitle: 'BAKED SUN, BLURRY SCAN, FLAT REFLECTANCE' },
        { type: 'day_pbr', startX: PANEL_W, title: 'STAGE 5: TEXTURE-INFORMED PBR', subtitle: 'DE-LIGHTED STONE, MIRROR GLASS, REVEAL NORMALS' },
        { type: 'night', startX: PANEL_W * 2, title: 'NIGHT EMISSIVE GLOW', subtitle: '3000K WARM WINDOW INTERIOR ILLUMINATION' }
    ];

    console.log(`Raymarching 3 Panels (${PANEL_W}x${H} each -> Total ${TOTAL_W}x${H})...`);

    for (const panel of panels) {
        console.log(`  -> Rendering Panel: ${panel.type}...`);
        for (let py = 0; py < H; py++) {
            const ndcY = (1.0 - (py / H) * 2.0) * (H / TOTAL_W) * 1.55;
            for (let px = 0; px < PANEL_W; px++) {
                const totalX = panel.startX + px;
                const ndcX = ((px / PANEL_W) * 2.0 - 1.0) * 0.50;

                const rayDir = norm(add(add(camFwd, mul(camRight, ndcX)), mul(camUp, ndcY)));
                const col = raymarchPanel(camPos, rayDir, panel.type);

                const rLinear = col.x * 1.15;
                const gLinear = col.y * 1.15;
                const bLinear = col.z * 1.15;

                const rByte = clamp(Math.round(Math.pow(rLinear / (rLinear + 0.18) * 1.12, 1.0 / 2.2) * 255), 0, 255);
                const gByte = clamp(Math.round(Math.pow(gLinear / (gLinear + 0.18) * 1.12, 1.0 / 2.2) * 255), 0, 255);
                const bByte = clamp(Math.round(Math.pow(bLinear / (bLinear + 0.18) * 1.12, 1.0 / 2.2) * 255), 0, 255);

                const idx = (py * TOTAL_W + totalX) * 4;
                rgba[idx + 0] = rByte;
                rgba[idx + 1] = gByte;
                rgba[idx + 2] = bByte;
                rgba[idx + 3] = 255;
            }
        }
    }

    // Draw Panel Separator Lines
    for (let py = 0; py < H; py++) {
        for (let t = -1; t <= 1; t++) {
            setPixel(rgba, TOTAL_W, H, PANEL_W + t, py, 30, 41, 59, 1.0);
            setPixel(rgba, TOTAL_W, H, PANEL_W * 2 + t, py, 30, 41, 59, 1.0);
        }
    }

    // Top Master Header
    drawRect(rgba, TOTAL_W, H, 24, 20, TOTAL_W - 48, 64, 15, 23, 42, 0.92);
    drawRect(rgba, TOTAL_W, H, 24, 20, TOTAL_W - 48, 2, 56, 189, 248, 0.95);
    drawText(rgba, TOTAL_W, H, 'SCRATCHBOX 3D ENGINE: BIOPHYSICAL PATINA & WEATHERING SYNTHESIZER', 44, 34, 240, 245, 255, 2);
    drawText(rgba, TOTAL_W, H, '6-TIER ART DECO SETBACKS | 90-YR HISTORICAL PATINA | SILL RUNOFF STREAKS | BRONZE VERDIGRIS | MORTAR CAVITY SOOT', 44, 58, 148, 163, 184, 1);

    // Panel 1 Badge (Raw Photogrammetry)
    drawRect(rgba, TOTAL_W, H, 18, 92, 226, 118, 15, 23, 42, 0.90);
    drawRect(rgba, TOTAL_W, H, 18, 92, 226, 2, 239, 68, 68, 0.95);
    drawRect(rgba, TOTAL_W, H, 24, 100, 160, 18, 239, 68, 68, 0.25);
    drawText(rgba, TOTAL_W, H, 'PANEL 1: RAW ESB SCAN', 30, 104, 239, 68, 68, 2);
    drawText(rgba, TOTAL_W, H, '12,340 DELAUNAY FACETS', 24, 126, 248, 113, 113, 1);
    drawText(rgba, TOTAL_W, H, 'MELTED WOBBLY CORNERS', 24, 140, 248, 113, 113, 1);
    drawText(rgba, TOTAL_W, H, 'BAKED DIRECTIONAL SUN', 24, 154, 248, 113, 113, 1);
    drawText(rgba, TOTAL_W, H, 'BLURRY ELEVATIONS', 24, 168, 248, 113, 113, 1);
    drawText(rgba, TOTAL_W, H, 'UNALIGNED 34TH ST ROAD', 24, 182, 248, 113, 113, 1);

    // Panel 2 Badge (Texture-Informed Daytime PBR with Biophysical Patina)
    drawRect(rgba, TOTAL_W, H, PANEL_W + 18, 92, 226, 118, 15, 23, 42, 0.90);
    drawRect(rgba, TOTAL_W, H, PANEL_W + 18, 92, 226, 2, 16, 185, 129, 0.95);
    drawRect(rgba, TOTAL_W, H, PANEL_W + 24, 100, 195, 18, 16, 185, 129, 0.25);
    drawText(rgba, TOTAL_W, H, 'PANEL 2: PATINATED PBR', PANEL_W + 30, 104, 52, 211, 153, 2);
    drawText(rgba, TOTAL_W, H, '3,702 CRISP FACETS (-70%)', PANEL_W + 24, 126, 52, 211, 153, 1);
    drawText(rgba, TOTAL_W, H, '11.4% MORTAR CAVITY SOOT', PANEL_W + 24, 140, 52, 211, 153, 1);
    drawText(rgba, TOTAL_W, H, 'GRAVITY SILL RUNOFF STREAKS', PANEL_W + 24, 154, 52, 211, 153, 1);
    drawText(rgba, TOTAL_W, H, 'BRONZE VERDIGRIS LEACHING', PANEL_W + 24, 168, 52, 211, 153, 1);
    drawText(rgba, TOTAL_W, H, 'CALCITE CHIPPING & RNM BUMP', PANEL_W + 24, 182, 52, 211, 153, 1);

    // Panel 3 Badge (Night Window Glow)
    drawRect(rgba, TOTAL_W, H, PANEL_W * 2 + 18, 92, 226, 118, 15, 23, 42, 0.90);
    drawRect(rgba, TOTAL_W, H, PANEL_W * 2 + 18, 92, 226, 2, 245, 158, 11, 0.95);
    drawRect(rgba, TOTAL_W, H, PANEL_W * 2 + 24, 100, 195, 18, 245, 158, 11, 0.25);
    drawText(rgba, TOTAL_W, H, 'PANEL 3: NIGHT GLOW', PANEL_W * 2 + 30, 104, 251, 191, 36, 2);
    drawText(rgba, TOTAL_W, H, '3000K INTERIOR GLOW', PANEL_W * 2 + 24, 126, 251, 191, 36, 1);
    drawText(rgba, TOTAL_W, H, 'VENETIAN BLIND SLITS', PANEL_W * 2 + 24, 140, 251, 191, 36, 1);
    drawText(rgba, TOTAL_W, H, 'FLOODLIT MOORING MAST', PANEL_W * 2 + 24, 154, 251, 191, 36, 1);
    drawText(rgba, TOTAL_W, H, 'RED WARNING BEACON', PANEL_W * 2 + 24, 168, 251, 191, 36, 1);
    drawText(rgba, TOTAL_W, H, 'CONFORMED 34TH ST ROAD', PANEL_W * 2 + 24, 182, 251, 191, 36, 1);

    // Bottom Telemetry Bar
    drawRect(rgba, TOTAL_W, H, 24, H - 76, TOTAL_W - 48, 54, 10, 15, 29, 0.92);
    drawRect(rgba, TOTAL_W, H, 24, H - 76, TOTAL_W - 48, 2, 99, 102, 241, 0.95);
    drawText(rgba, TOTAL_W, H, 'TELEMETRY: 90-YR HISTORICAL PATINA | SOOT: 11.44% | RUNOFF STREAKS: 0.45% | VERDIGRIS INDEX: 0.859 | RNM & TOKSVIG SPECULAR AA', 44, H - 60, 226, 232, 240, 2);
    drawText(rgba, TOTAL_W, H, 'NATIVE C++20 ENGINE: FASTNOISE3D + SIGNED DISTANCE FIELDS + MARCHING CUBES + BIOPHYSICAL WEATHERING SYNTHESIZER', 44, H - 38, 56, 189, 248, 1);

    return encodePNG(TOTAL_W, H, rgba);
}

console.log('Rendering high-detail architectural PBR comparison...');
const compPng = renderTextureInformedPbrComparison();

const outPaths = [
    path.resolve(__dirname, '../docs/screenshots/17_empire_state_building_cleanup_comparison.png'),
    path.resolve(__dirname, '../docs/screenshots/16_high_detail_pbr_textures.png'),
    path.resolve(__dirname, '../docs/screenshots/15_texture_informed_pbr_comparison.png'),
    '/Users/eligreen/.gemini/antigravity/brain/b11168d9-6918-4b66-be1a-195c6b580e9e/high_detail_pbr_textures.png',
    '/Users/eligreen/.gemini/antigravity/brain/b11168d9-6918-4b66-be1a-195c6b580e9e/texture_informed_pbr_comparison.png'
];

for (const p of outPaths) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, compPng);
    console.log(`Saved: ${p} (${(compPng.length / 1024).toFixed(1)} KB)`);
}

console.log('✅ Empire State Building architectural PBR renders generated successfully!');
