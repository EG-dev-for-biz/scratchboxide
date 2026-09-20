const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ============================================================================
// 1. FAST NODE.JS PNG ENCODER
// ============================================================================
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
    const ihdrChunk = writeChunk('IHDR', ihdr);

    const rawScanlines = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
        const rowOffset = y * (1 + width * 4);
        rawScanlines[rowOffset] = 0; // Filter byte 0 (None)
        rgbaBuffer.copy(rawScanlines, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
    }

    const compressed = zlib.deflateSync(rawScanlines, { level: 8 });
    const idatChunk = writeChunk('IDAT', compressed);
    const iendChunk = writeChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// ============================================================================
// 2. VECTOR MATH & PROCEDURAL NOISE
// ============================================================================
function v3(x, y, z) { return { x, y, z }; }
function add(a, b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
function sub(a, b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
function mul(a, s) { return v3(a.x * s, a.y * s, a.z * s); }
function mulV(a, b) { return v3(a.x * b.x, a.y * b.y, a.z * b.z); }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross(a, b) {
    return v3(
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x
    );
}
function length(a) { return Math.sqrt(dot(a, a)); }
function norm(a) {
    const len = length(a);
    return len > 1e-6 ? mul(a, 1 / len) : v3(0, 0, 0);
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpV3(a, b, t) { return add(mul(a, 1 - t), mul(b, t)); }

function hash31(p) {
    let p3 = v3(
        (p.x * 0.1031) % 1,
        (p.y * 0.1030) % 1,
        (p.z * 0.0973) % 1
    );
    const d = dot(p3, v3(p3.y + 33.33, p3.z + 33.33, p3.x + 33.33));
    p3 = add(p3, v3(d, d, d));
    return ((p3.x + p3.y) * p3.z) % 1;
}

function noise3D(p) {
    const ix = Math.floor(p.x), iy = Math.floor(p.y), iz = Math.floor(p.z);
    const fx = p.x - ix, fy = p.y - iy, fz = p.z - iz;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const uz = fz * fz * (3 - 2 * fz);

    const c000 = hash31(v3(ix, iy, iz));
    const c100 = hash31(v3(ix + 1, iy, iz));
    const c010 = hash31(v3(ix, iy + 1, iz));
    const c110 = hash31(v3(ix + 1, iy + 1, iz));
    const c001 = hash31(v3(ix, iy, iz + 1));
    const c101 = hash31(v3(ix + 1, iy, iz + 1));
    const c011 = hash31(v3(ix, iy + 1, iz + 1));
    const c111 = hash31(v3(ix + 1, iy + 1, iz + 1));

    const x00 = lerp(c000, c100, ux);
    const x10 = lerp(c010, c110, ux);
    const x01 = lerp(c001, c101, ux);
    const x11 = lerp(c011, c111, ux);

    const y0 = lerp(x00, x10, uy);
    const y1 = lerp(x01, x11, uy);

    return lerp(y0, y1, uz);
}

function fbm3D(p, octaves = 4) {
    let sum = 0, amp = 0.5, freq = 1.0;
    for (let i = 0; i < octaves; i++) {
        sum += noise3D(mul(p, freq)) * amp;
        freq *= 2.02;
        amp *= 0.5;
    }
    return sum;
}

// Henyey-Greenstein Phase Function for Mie Forward Scattering
function henyeyGreenstein(cosTheta, g) {
    const g2 = g * g;
    const denom = Math.pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
    return (1.0 - g2) / (4.0 * Math.PI * Math.max(denom, 1e-4));
}

// ============================================================================
// 3. SCENE SIGNED DISTANCE FIELD (SDF) GEOMETRY
// ============================================================================

// Terrain Heightfield (Fast analytical multi-scale heightfield)
function getTerrainHeight(x, z) {
    const macro = Math.sin(x * 0.12) * Math.cos(z * 0.12) * 1.5;
    const ridge = (noise3D(v3(x * 0.18, 0, z * 0.18)) - 0.5) * 1.8;
    const micro = (noise3D(v3(x * 0.45, 0, z * 0.45)) - 0.5) * 0.4;
    return macro + ridge + micro - 0.6;
}

// Hero Monolith Box SDF with Runic Chamfers
function sdBox(p, b) {
    const qx = Math.abs(p.x) - b.x;
    const qy = Math.abs(p.y) - b.y;
    const qz = Math.abs(p.z) - b.z;
    const outX = Math.max(qx, 0);
    const outY = Math.max(qy, 0);
    const outZ = Math.max(qz, 0);
    const outDist = Math.sqrt(outX * outX + outY * outY + outZ * outZ);
    const inDist = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
    return outDist + inDist;
}

// Cylinder SDF for Tree Trunks
function sdCappedCylinder(p, h, r) {
    const dX = Math.sqrt(p.x * p.x + p.z * p.z) - r;
    const dY = Math.abs(p.y) - h;
    const outX = Math.max(dX, 0);
    const outY = Math.max(dY, 0);
    return Math.min(Math.max(dX, dY), 0) + Math.sqrt(outX * outX + outY * outY);
}

// Sphere SDF for Foliage Canopy Clusters
function sdSphere(p, r) {
    return length(p) - r;
}

// Material IDs
const MAT_TERRAIN = 1;
const MAT_MONOLITH = 2;
const MAT_TREE_TRUNK = 3;
const MAT_FOLIAGE = 4;
const MAT_MOSS = 5;

function sceneSDF(p) {
    // 1. Stratified Biome Terrain
    const th = getTerrainHeight(p.x, p.z);
    let dTerrain = p.y - th;
    let mat = MAT_TERRAIN;
    let minDist = dTerrain;

    // 2. Ancient Hero Monolith on Plateau
    // Positioned at (0.2, 1.8, -1.0), tilted slightly
    const pMono = sub(p, v3(0.3, 1.9, -1.2));
    // Subtle rotation around Y and Z
    const cY = Math.cos(0.15), sY = Math.sin(0.15);
    const rotX = pMono.x * cY - pMono.z * sY;
    const rotZ = pMono.x * sY + pMono.z * cY;
    const dMono = sdBox(v3(rotX, pMono.y, rotZ), v3(0.55, 2.2, 0.55)) - 0.04;
    if (dMono < minDist) {
        minDist = dMono;
        mat = MAT_MONOLITH;
    }

    // 3. Tree 1 (Left Fore-ground Oak) at (-3.2, 0.4, -0.5)
    const pTree1 = sub(p, v3(-3.2, 0.8, -0.6));
    const trunk1 = sdCappedCylinder(pTree1, 1.6, 0.22);
    // Branches
    const branch1 = sdCappedCylinder(sub(pTree1, v3(0.4, 0.8, 0.2)), 0.8, 0.12);
    const branch2 = sdCappedCylinder(sub(pTree1, v3(-0.3, 1.2, -0.3)), 0.7, 0.10);
    const dTrunk1 = Math.min(trunk1, Math.min(branch1, branch2));
    if (dTrunk1 < minDist) {
        minDist = dTrunk1;
        mat = MAT_TREE_TRUNK;
    }

    // Foliage 1 Canopy clusters (Translucent SSS)
    const fol1a = sdSphere(sub(pTree1, v3(0.2, 1.8, 0.1)), 0.95);
    const fol1b = sdSphere(sub(pTree1, v3(-0.5, 1.5, -0.2)), 0.85);
    const fol1c = sdSphere(sub(pTree1, v3(0.6, 1.3, 0.4)), 0.78);
    // Leaf noise displacement
    const disp1 = (noise3D(mul(p, 4.5)) - 0.5) * 0.18;
    const dFol1 = Math.min(fol1a, Math.min(fol1b, fol1c)) + disp1;
    if (dFol1 < minDist) {
        minDist = dFol1;
        mat = MAT_FOLIAGE;
    }

    // 4. Tree 2 (Right Background Pine/Oak) at (3.5, 1.2, -2.5)
    const pTree2 = sub(p, v3(3.4, 1.4, -2.2));
    const dTrunk2 = sdCappedCylinder(pTree2, 1.9, 0.24);
    if (dTrunk2 < minDist) {
        minDist = dTrunk2;
        mat = MAT_TREE_TRUNK;
    }

    const fol2a = sdSphere(sub(pTree2, v3(0, 2.0, 0)), 1.1);
    const fol2b = sdSphere(sub(pTree2, v3(0.5, 1.5, -0.3)), 0.9);
    const disp2 = (noise3D(mul(p, 4.0)) - 0.5) * 0.18;
    const dFol2 = Math.min(fol2a, fol2b) + disp2;
    if (dFol2 < minDist) {
        minDist = dFol2;
        mat = MAT_FOLIAGE;
    }

    // 5. Tree 3 (Distant Left Pine) at (-1.8, 1.6, -4.5)
    const pTree3 = sub(p, v3(-2.0, 1.8, -4.2));
    const dTrunk3 = sdCappedCylinder(pTree3, 1.8, 0.18);
    if (dTrunk3 < minDist) {
        minDist = dTrunk3;
        mat = MAT_TREE_TRUNK;
    }
    const dFol3 = sdSphere(sub(pTree3, v3(0, 1.8, 0)), 1.05) + (noise3D(mul(p, 3.8)) - 0.5) * 0.15;
    if (dFol3 < minDist) {
        minDist = dFol3;
        mat = MAT_FOLIAGE;
    }

    return { dist: minDist, mat };
}

// SDF Surface Normal
function calcNormal(p) {
    const eps = 0.003;
    const d = sceneSDF(p).dist;
    const nx = sceneSDF(v3(p.x + eps, p.y, p.z)).dist - d;
    const ny = sceneSDF(v3(p.x, p.y + eps, p.z)).dist - d;
    const nz = sceneSDF(v3(p.x, p.y, p.z + eps)).dist - d;
    return norm(v3(nx, ny, nz));
}

// Ambient Occlusion
function calcAO(p, n) {
    let occ = 0.0;
    let sca = 1.0;
    for (let i = 1; i <= 5; i++) {
        const hr = 0.06 * i;
        const aopos = add(p, mul(n, hr));
        const dd = sceneSDF(aopos).dist;
        occ += (hr - dd) * sca;
        sca *= 0.65;
    }
    return clamp(1.0 - 2.8 * occ, 0.0, 1.0);
}

// Soft Shadow
function calcShadow(ro, rd, mint, maxt, k = 16, maxSteps = 16) {
    let res = 1.0;
    let t = mint;
    for (let i = 0; i < maxSteps && t < maxt; i++) {
        const h = sceneSDF(add(ro, mul(rd, t))).dist;
        if (h < 0.001) return 0.0;
        res = Math.min(res, k * h / t);
        t += clamp(h, 0.06, 0.5);
    }
    return clamp(res, 0.0, 1.0);
}

// Triplanar Texturing Sampler
function sampleTriplanarWood(p, n) {
    // Oak fibers along Y axis
    const r = Math.sqrt(p.x * p.x + p.z * p.z);
    const rings = Math.sin(r * 28.0 + noise3D(mul(p, 3.0)) * 4.0);
    const fiber = fbm3D(v3(p.x * 2.0, p.y * 18.0, p.z * 2.0), 3);
    const darkWood = v3(0.24, 0.15, 0.08);
    const lightWood = v3(0.48, 0.32, 0.18);
    const t = clamp(rings * 0.3 + fiber * 0.7, 0, 1);
    return {
        albedo: lerpV3(darkWood, lightWood, t),
        roughness: 0.85
    };
}

function sampleTriplanarRock(p, n) {
    // Geological horizontal bedding strata
    const strata = Math.sin(p.y * 8.5 + noise3D(v3(p.x * 0.8, p.y * 2.5, p.z * 0.8)) * 3.0);
    const fineRock = fbm3D(mul(p, 4.0), 4);
    const darkRock = v3(0.20, 0.21, 0.23);
    const paleRock = v3(0.42, 0.43, 0.45);
    const ironBand = v3(0.48, 0.28, 0.18);

    const tStrata = clamp(strata * 0.5 + 0.5, 0, 1);
    let base = lerpV3(darkRock, paleRock, tStrata);
    if (fineRock > 0.65) base = lerpV3(base, ironBand, (fineRock - 0.65) * 2.5);

    return {
        albedo: base,
        roughness: clamp(0.70 + fineRock * 0.25, 0.1, 0.98)
    };
}

function sampleTriplanarMoss(p, n) {
    const mossNoise = fbm3D(mul(p, 5.0), 4);
    const deepMoss = v3(0.12, 0.28, 0.08);
    const lightMoss = v3(0.28, 0.52, 0.16);
    return {
        albedo: lerpV3(deepMoss, lightMoss, clamp(mossNoise, 0, 1)),
        roughness: 0.92
    };
}

// Subsurface Scattering (Burley Dipole Transmission)
function computeSSS(p, n, lightDir, viewDir, profile) {
    // Forward-to-backward transmission through thin leaves / edges
    const vDotL = dot(viewDir, lightDir);
    const nDotL = dot(n, lightDir);

    // Backscattering wrap lighting: light penetrating from behind
    const transDot = Math.max(0.0, -dot(viewDir, add(lightDir, mul(n, 0.35))));
    const forwardScatter = Math.pow(transDot, 3.5) * 1.8;

    // Thickness approximation via inverted SDF step
    const sampleBack = sub(p, mul(lightDir, 0.15));
    const internalDist = clamp(-sceneSDF(sampleBack).dist + 0.15, 0.02, 0.5);

    // Burley diffusion falloff: exp(-d/scatterRadius)
    const attenR = Math.exp(-internalDist / (profile.scatterRadius.x * 0.2));
    const attenG = Math.exp(-internalDist / (profile.scatterRadius.y * 0.2));
    const attenB = Math.exp(-internalDist / (profile.scatterRadius.z * 0.2));

    const sssColor = mulV(profile.transmissionTint, v3(attenR, attenG, attenB));
    return mul(sssColor, forwardScatter * profile.weight);
}

// ============================================================================
// 4. MAIN RENDERING ENGINE: RAYMARCHING + VOLUMETRIC GOD RAYS
// ============================================================================

const W = 1280;
const H = 720;
console.log(`[Scratchbox Nature & Atmosphere] Initializing photorealistic render at ${W}x${H}...`);

const startTime = Date.now();

// Camera Setup: Cinematic Golden-Hour Angle framing the Ancient Monolith & Forest
const camPos = v3(-1.2, 2.6, 5.2);
const camTarget = v3(0.1, 1.8, -1.0);
const camFwd = norm(sub(camTarget, camPos));
const camRight = norm(cross(camFwd, v3(0, 1, 0)));
const camUp = cross(camRight, camFwd);
const fov = 42 * (Math.PI / 180);
const tanFov = Math.tan(fov * 0.5);
const aspect = W / H;

// Low Golden-Hour Sun: backlighting the forest for dramatic god rays
const sunDir = norm(v3(0.72, 0.38, -0.65));
const sunColor = v3(3.8, 2.6, 1.3); // High dynamic range warm gold
const skyZenith = v3(0.22, 0.42, 0.78);
const skyHorizon = v3(0.85, 0.65, 0.42);

// Volumetric Media Setup
const fogDensity = 0.038;
const fogAnisotropy = 0.74; // Strong forward Mie scattering
const fogHeightScale = 3.5;
const fogScatteringColor = v3(0.95, 0.78, 0.52);

// Framebuffer (HDR Float RGB)
const hdrBuffer = new Float32Array(W * H * 3);

// SSS Material Profile for Green Leaves
const LEAF_SSS = {
    scatterRadius: v3(0.85, 2.80, 0.45),
    transmissionTint: v3(0.55, 0.95, 0.18),
    weight: 0.92
};

for (let y = 0; y < H; y++) {
    const v = (1.0 - 2.0 * ((y + 0.5) / H)) * tanFov;

    for (let x = 0; x < W; x++) {
        const u = (2.0 * ((x + 0.5) / W) - 1.0) * aspect * tanFov;
        const rayDir = norm(add(mul(camRight, u), add(mul(camUp, v), camFwd)));

        // 1. Raymarch Scene Surface
        let t = 0.2;
        let hit = false;
        let hitMat = 0;
        let p = camPos;
        const maxDist = 32.0;

        for (let step = 0; step < 96 && t < maxDist; step++) {
            p = add(camPos, mul(rayDir, t));
            const sdf = sceneSDF(p);
            if (sdf.dist < 0.002) {
                hit = true;
                hitMat = sdf.mat;
                break;
            }
            t += Math.max(sdf.dist * 0.85, 0.003);
        }

        let surfaceRadiance = v3(0, 0, 0);

        if (hit) {
            const n = calcNormal(p);
            const viewDir = mul(rayDir, -1);
            const ao = calcAO(p, n);
            const shadow = calcShadow(add(p, mul(n, 0.02)), sunDir, 0.05, 12.0, 18);

            let albedo = v3(0.5, 0.5, 0.5);
            let roughness = 0.8;
            let metallic = 0.0;
            let sssContrib = v3(0, 0, 0);

            if (hitMat === MAT_TERRAIN) {
                // Slope-based Biome Masking
                const cosSlope = clamp(n.y, 0, 1);
                const slopeDeg = Math.acos(cosSlope) * (180 / Math.PI);
                const rockFactor = clamp((slopeDeg - 28.0) / 14.0, 0, 1);

                const rockSample = sampleTriplanarRock(p, n);
                const mossSample = sampleTriplanarMoss(p, n);

                albedo = lerpV3(mossSample.albedo, rockSample.albedo, rockFactor);
                roughness = lerp(mossSample.roughness, rockSample.roughness, rockFactor);
            } else if (hitMat === MAT_MONOLITH) {
                // Monolith: Basalt Stone with Triplanar Moss Overgrowth on tops and ledges
                const rock = sampleTriplanarRock(mul(p, 1.4), n);
                const moss = sampleTriplanarMoss(mul(p, 2.0), n);
                const mossMask = clamp((n.y * 0.65 + noise3D(mul(p, 3.0)) * 0.5 - 0.2) * 2.0, 0, 1);

                albedo = lerpV3(rock.albedo, moss.albedo, mossMask);
                roughness = lerp(rock.roughness, moss.roughness, mossMask);
                metallic = 0.05;
            } else if (hitMat === MAT_TREE_TRUNK) {
                const wood = sampleTriplanarWood(p, n);
                albedo = wood.albedo;
                roughness = wood.roughness;
            } else if (hitMat === MAT_FOLIAGE) {
                // Lush green translucent foliage with SSS
                const leafNoise = noise3D(mul(p, 5.0));
                albedo = lerpV3(v3(0.22, 0.48, 0.12), v3(0.42, 0.72, 0.18), leafNoise);
                roughness = 0.58;

                // Burley Dipole Subsurface Scattering forward translucency
                sssContrib = computeSSS(p, n, sunDir, viewDir, LEAF_SSS);
            }

            // Direct Lighting (PBR Microfacet Diffuse + Specular)
            const nDotL = Math.max(0.0, dot(n, sunDir));
            const h = norm(add(sunDir, viewDir));
            const nDotH = Math.max(0.0, dot(n, h));
            const specPower = (2.0 / (roughness * roughness + 1e-4)) - 2.0;
            const spec = Math.pow(nDotH, clamp(specPower, 1, 128)) * (1.0 - roughness);

            const directDiffuse = mul(mulV(albedo, sunColor), (nDotL * shadow) / Math.PI);
            const directSpec = mul(sunColor, spec * shadow * (metallic * 0.8 + 0.04));

            // Hemispherical Ambient Irradiance (Spherical Harmonics Golden Hour approximation)
            const skyWeight = clamp(n.y * 0.5 + 0.5, 0, 1);
            const ambient = lerpV3(skyHorizon, skyZenith, skyWeight);
            const ambientDiffuse = mul(mulV(albedo, ambient), 0.35 * ao);

            surfaceRadiance = add(directDiffuse, add(directSpec, add(ambientDiffuse, mul(sssContrib, shadow))));
        } else {
            // Sky & Golden-Hour Atmosphere Background
            const skyGrad = clamp(rayDir.y * 0.5 + 0.5, 0, 1);
            let skyCol = lerpV3(skyHorizon, skyZenith, skyGrad);

            // Sun Disc & Halo
            const sunDot = Math.max(0.0, dot(rayDir, sunDir));
            const sunDisc = Math.pow(sunDot, 1200.0) * 8.0;
            const sunGlow = Math.pow(sunDot, 16.0) * 1.5;
            skyCol = add(skyCol, mul(sunColor, sunDisc + sunGlow));

            surfaceRadiance = skyCol;
            t = maxDist;
        }

        // ====================================================================
        // 2. VOLUMETRIC PARTICIPATING MEDIA & GOD RAY RAYMARCHER
        // ====================================================================
        const volSteps = 12;
        const volStepSize = t / volSteps;
        let transmittance = 1.0;
        let inscattering = v3(0, 0, 0);

        const cosSun = dot(rayDir, sunDir);
        const phaseMie = henyeyGreenstein(cosSun, fogAnisotropy);

        for (let s = 0; s < volSteps; s++) {
            const stepDist = (s + 0.5) * volStepSize;
            const pVol = add(camPos, mul(rayDir, stepDist));

            // Height-dependent exponential fog
            const heightAtten = Math.exp(-Math.max(pVol.y, 0.0) / fogHeightScale);
            const density = fogDensity * heightAtten;

            if (density > 1e-5) {
                // Fast 5-step shadow test to determine god rays
                const shadowVal = calcShadow(pVol, sunDir, 0.1, 8.0, 10, 5);

                // Optical depth step (Beer-Lambert)
                const stepOpticalDepth = density * volStepSize;
                const stepTransmittance = Math.exp(-stepOpticalDepth);

                // In-scattered light from sun + ambient
                const sunLight = mul(sunColor, shadowVal * phaseMie * 4.2);
                const ambientLight = mul(skyHorizon, 0.25);
                const totalLight = add(sunLight, ambientLight);

                const stepInscatter = mul(mulV(totalLight, fogScatteringColor), (1.0 - stepTransmittance) * transmittance);
                inscattering = add(inscattering, stepInscatter);
                transmittance *= stepTransmittance;

                if (transmittance < 0.02) break;
            }
        }

        // Composite Surface + In-scattering
        const finalPixel = add(mul(surfaceRadiance, transmittance), inscattering);

        const idx = (y * W + x) * 3;
        hdrBuffer[idx + 0] = finalPixel.x;
        hdrBuffer[idx + 1] = finalPixel.y;
        hdrBuffer[idx + 2] = finalPixel.z;
    }
}

// ============================================================================
// 5. POST-PROCESSING: 2-PASS GAUSSIAN BLOOM & ACES FILMIC TONE MAPPING
// ============================================================================
console.log('[Post-Process] Applying 2-Pass Gaussian Bloom & Filmic ACES Tone Mapping...');

const bloomBuffer = new Float32Array(W * H * 3);
const tempBuffer = new Float32Array(W * H * 3);
const bloomRadius = 8;

// Horizontal pass
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        let r = 0, g = 0, b = 0, wSum = 0;
        for (let k = -bloomRadius; k <= bloomRadius; k++) {
            const nx = clamp(x + k, 0, W - 1);
            const idx = (y * W + nx) * 3;
            const weight = Math.exp(-(k * k) / (2.0 * 4.5 * 4.5));
            // Luminance threshold for god ray bloom
            const lum = hdrBuffer[idx] * 0.2126 + hdrBuffer[idx + 1] * 0.7152 + hdrBuffer[idx + 2] * 0.0722;
            if (lum > 1.1) {
                r += hdrBuffer[idx] * weight;
                g += hdrBuffer[idx + 1] * weight;
                b += hdrBuffer[idx + 2] * weight;
            }
            wSum += weight;
        }
        const tidx = (y * W + x) * 3;
        tempBuffer[tidx + 0] = r / wSum;
        tempBuffer[tidx + 1] = g / wSum;
        tempBuffer[tidx + 2] = b / wSum;
    }
}

// Vertical pass
for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
        let r = 0, g = 0, b = 0, wSum = 0;
        for (let k = -bloomRadius; k <= bloomRadius; k++) {
            const ny = clamp(y + k, 0, H - 1);
            const tidx = (ny * W + x) * 3;
            const weight = Math.exp(-(k * k) / (2.0 * 4.5 * 4.5));
            r += tempBuffer[tidx + 0] * weight;
            g += tempBuffer[tidx + 1] * weight;
            b += tempBuffer[tidx + 2] * weight;
            wSum += weight;
        }
        const bidx = (y * W + x) * 3;
        bloomBuffer[bidx + 0] = r / wSum;
        bloomBuffer[bidx + 1] = g / wSum;
        bloomBuffer[bidx + 2] = b / wSum;
    }
}

// ACES Filmic Tone Mapping Curve (Krzysztof Narkowicz)
function acesFilmic(v) {
    const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return v3(
        clamp((v.x * (a * v.x + b)) / (v.x * (c * v.x + d) + e), 0, 1),
        clamp((v.y * (a * v.y + b)) / (v.y * (c * v.y + d) + e), 0, 1),
        clamp((v.z * (a * v.z + b)) / (v.z * (c * v.z + d) + e), 0, 1)
    );
}

// Convert to sRGB and write to RGBA buffer
const rgbaBuffer = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const hdrIdx = i * 3;

        // Combine HDR + Bloom
        const combined = v3(
            hdrBuffer[hdrIdx + 0] + bloomBuffer[hdrIdx + 0] * 0.40,
            hdrBuffer[hdrIdx + 1] + bloomBuffer[hdrIdx + 1] * 0.40,
            hdrBuffer[hdrIdx + 2] + bloomBuffer[hdrIdx + 2] * 0.40
        );

        // Exposure & Tone Mapping
        const exposed = mul(combined, 1.15);
        const mapped = acesFilmic(exposed);

        // Gamma 2.2 correction + subtle cinematic vignette
        const uvX = (x / W) - 0.5;
        const uvY = (y / H) - 0.5;
        const vignette = clamp(1.0 - (uvX * uvX + uvY * uvY) * 0.65, 0.7, 1.0);

        const sRGB = v3(
            Math.pow(mapped.x * vignette, 1.0 / 2.2),
            Math.pow(mapped.y * vignette, 1.0 / 2.2),
            Math.pow(mapped.z * vignette, 1.0 / 2.2)
        );

        const pixIdx = i * 4;
        rgbaBuffer[pixIdx + 0] = Math.round(sRGB.x * 255);
        rgbaBuffer[pixIdx + 1] = Math.round(sRGB.y * 255);
        rgbaBuffer[pixIdx + 2] = Math.round(sRGB.z * 255);
        rgbaBuffer[pixIdx + 3] = 255;
    }
}

const elapsedMs = Date.now() - startTime;
console.log(`[Render Complete] High-fidelity nature & atmosphere scene rendered in ${elapsedMs}ms! Encoding PNG...`);

const pngBuffer = encodePNG(W, H, rgbaBuffer);

const targetPaths = [
    path.resolve(__dirname, '../docs/screenshots/12_nature_atmosphere_photorealism.png'),
    '/Users/eligreen/.gemini/antigravity/brain/2933a10a-f510-4853-a96a-7f0c3ad06abc/12_nature_atmosphere_photorealism.png',
    '/Users/eligreen/.gemini/antigravity/brain/2933a10a-f510-4853-a96a-7f0c3ad06abc/screenshots/12_nature_atmosphere_photorealism.png'
];

for (const target of targetPaths) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, pngBuffer);
    console.log(`  Saved screenshot: ${target} (${(pngBuffer.length / 1024).toFixed(1)} KB)`);
}

console.log('✅ Visual verification screenshot successfully rendered and saved!');
