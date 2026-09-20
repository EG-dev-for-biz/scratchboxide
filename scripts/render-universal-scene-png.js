const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ============================================================================
// 1. PURE NODE.JS PNG ENCODER
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
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const ihdrChunk = writeChunk('IHDR', ihdr);

    const rawScanlines = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
        const rowOffset = y * (1 + width * 4);
        rawScanlines[rowOffset] = 0;
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
    const i = v3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    const f = sub(p, i);
    const u = v3(
        f.x * f.x * (3.0 - 2.0 * f.x),
        f.y * f.y * (3.0 - 2.0 * f.y),
        f.z * f.z * (3.0 - 2.0 * f.z)
    );

    const n000 = hash31(i);
    const n100 = hash31(add(i, v3(1, 0, 0)));
    const n010 = hash31(add(i, v3(0, 1, 0)));
    const n110 = hash31(add(i, v3(1, 1, 0)));
    const n001 = hash31(add(i, v3(0, 0, 1)));
    const n101 = hash31(add(i, v3(1, 0, 1)));
    const n011 = hash31(add(i, v3(0, 1, 1)));
    const n111 = hash31(add(i, v3(1, 1, 1)));

    return lerp(
        lerp(lerp(n000, n100, u.x), lerp(n010, n110, u.x), u.y),
        lerp(lerp(n001, n101, u.x), lerp(n011, n111, u.x), u.y),
        u.z
    );
}

function fbm(p) {
    let value = 0;
    let amplitude = 0.5;
    let freq = mul(p, 1.0);
    for (let o = 0; o < 3; o++) {
        value += amplitude * noise3D(freq);
        freq = mul(freq, 2.0);
        amplitude *= 0.5;
    }
    return value;
}

// ============================================================================
// 3. COOK-TORRANCE GGX MICROFACET BRDF
// ============================================================================
function fresnelSchlick(cosTheta, F0) {
    const f = Math.pow(1.0 - clamp(cosTheta, 0, 1), 5);
    return v3(
        F0.x + (1.0 - F0.x) * f,
        F0.y + (1.0 - F0.y) * f,
        F0.z + (1.0 - F0.z) * f
    );
}

function ndfGGX(NdotH, roughness) {
    const alpha = roughness * roughness;
    const a2 = alpha * alpha;
    const NdotH2 = NdotH * NdotH;
    const denom = NdotH2 * (a2 - 1.0) + 1.0;
    return a2 / (Math.PI * denom * denom + 1e-7);
}

function visSmithJoint(NdotV, NdotL, roughness) {
    const a2 = Math.pow(roughness * roughness, 2);
    const gv = NdotL * Math.sqrt(NdotV * (NdotV - NdotV * a2) + a2);
    const gl = NdotV * Math.sqrt(NdotL * (NdotL - NdotL * a2) + a2);
    return 0.5 / (gv + gl + 1e-7);
}

// ============================================================================
// 4. SIGNED DISTANCE FIELDS (SDF) OF UNIVERSAL SCENE
// ============================================================================
function sdfSphere(p, r) { return length(p) - r; }

function sdfCappedCylinder(p, h, r) {
    const d = v3(length(v3(p.x, 0, p.z)) - r, Math.abs(p.y) - h, 0);
    return Math.min(Math.max(d.x, d.y), 0.0) + length(v3(Math.max(d.x, 0), Math.max(d.y, 0), 0));
}

function sdfTorus(p, rMajor, rMinor) {
    const q = v3(length(v3(p.x, 0, p.z)) - rMajor, p.y, 0);
    return length(v3(q.x, q.y, 0)) - rMinor;
}

function sdfBox(p, b) {
    const q = v3(Math.abs(p.x) - b.x, Math.abs(p.y) - b.y, Math.abs(p.z) - b.z);
    return length(v3(Math.max(q.x, 0), Math.max(q.y, 0), Math.max(q.z, 0))) +
           Math.min(Math.max(q.x, Math.max(q.y, q.z)), 0.0);
}

function sdfRoundBox(p, b, r) {
    const q = v3(Math.abs(p.x) - b.x, Math.abs(p.y) - b.y, Math.abs(p.z) - b.z);
    return length(v3(Math.max(q.x, 0), Math.max(q.y, 0), Math.max(q.z, 0))) +
           Math.min(Math.max(q.x, Math.max(q.y, q.z)), 0.0) - r;
}

// Scene SDF map returning { dist, matId }
function mapScene(p) {
    let minDist = 1e9;
    let matId = 0; 
    // 1: Pedestal Onyx, 2: Reactor Titanium Body, 3: Gold Toruses, 
    // 4: Basalt Pylons, 5: Emissive Turquoise Core, 6: Clutter Props, 7: Emissive Conduit Stripes

    // 1. Pedestal: Stepped Onyx Plinth with Bevel
    const dPedestalBase = sdfCappedCylinder(sub(p, v3(0, -0.15, 0)), 0.15, 3.8);
    const dPedestalStep = sdfCappedCylinder(sub(p, v3(0, 0.04, 0)), 0.04, 2.9);
    const dPedestal = Math.min(dPedestalBase, dPedestalStep);
    if (dPedestal < minDist) {
        minDist = dPedestal;
        matId = 1;
    }

    // 2. Primary: Central Reactor Top Cap & Base Mount
    const dCapTop = sdfCappedCylinder(sub(p, v3(0, 2.22, 0)), 0.20, 0.96);
    const dCapBot = sdfCappedCylinder(sub(p, v3(0, 0.48, 0)), 0.20, 0.96);
    const dCaps = Math.min(dCapTop, dCapBot);
    if (dCaps < minDist) {
        minDist = dCaps;
        matId = 2;
    }

    // 6 Vertical Titanium Containment Staves leaving window openings to view core
    for (let s = 0; s < 6; s++) {
        const ang = s * (Math.PI / 3.0);
        const sx = Math.cos(ang) * 0.88;
        const sz = Math.sin(ang) * 0.88;
        const dStave = sdfRoundBox(sub(p, v3(sx, 1.35, sz)), v3(0.08, 0.68, 0.08), 0.02);
        if (dStave < minDist) {
            minDist = dStave;
            matId = 2;
        }
    }

    // 3. Primary: Dual Magnetic Containment Toruses (Polished 24k Gold)
    const dTorUpper = sdfTorus(sub(p, v3(0, 1.82, 0)), 1.28, 0.12);
    const dTorLower = sdfTorus(sub(p, v3(0, 0.88, 0)), 1.28, 0.12);
    const dToruses = Math.min(dTorUpper, dTorLower);
    if (dToruses < minDist) {
        minDist = dToruses;
        matId = 3;
    }

    // 4. Secondary: 4 Radial Heavy Basalt Pylons with Beveled Chamfers
    for (let i = 0; i < 4; i++) {
        const angle = i * Math.PI * 0.5;
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const px = cosA * p.x + sinA * p.z;
        const pz = -sinA * p.x + cosA * p.z;
        const localP = sub(v3(px, p.y, pz), v3(1.70, 1.35, 0));

        const dPylon = sdfRoundBox(localP, v3(0.18, 1.15, 0.36), 0.04);
        if (dPylon < minDist) {
            minDist = dPylon;
            matId = 4;
        }

        // Emissive vertical indicator stripe on outer pylon spine
        const dStripe = sdfBox(sub(localP, v3(0.19, 0, 0)), v3(0.015, 0.90, 0.04));
        if (dStripe < minDist) {
            minDist = dStripe;
            matId = 7;
        }

        // Structural anchoring brackets
        const dBracketUpper = sdfBox(sub(localP, v3(-0.25, 0.75, 0)), v3(0.18, 0.08, 0.12));
        const dBracketLower = sdfBox(sub(localP, v3(-0.25, -0.75, 0)), v3(0.18, 0.08, 0.12));
        const dBrackets = Math.min(dBracketUpper, dBracketLower);
        if (dBrackets < minDist) {
            minDist = dBrackets;
            matId = 2;
        }
    }

    // 5. Emissive Plasma Core: Central Incandescent Turquoise Orb
    const dPlasma = sdfSphere(sub(p, v3(0, 1.35, 0)), 0.58);
    const dPlasmaRing = sdfTorus(sub(p, v3(0, 1.35, 0)), 0.42, 0.045);
    const dPlasmaTotal = Math.min(dPlasma, dPlasmaRing);
    if (dPlasmaTotal < minDist) {
        minDist = dPlasmaTotal;
        matId = 5;
    }

    // 6. Tertiary Clutter: Scattered canisters, power nodes, rings, and bolts on pedestal
    const clutterPositions = [
        { p: v3(1.6, 0.16, 1.8), r: 0.14, h: 0.16 },
        { p: v3(1.9, 0.11, 1.5), r: 0.11, h: 0.11 },
        { p: v3(-1.8, 0.14, 1.7), r: 0.16, h: 0.14 },
        { p: v3(-1.5, 0.09, -1.9), r: 0.22, h: 0.09 },
        { p: v3(0.3, 0.06, 2.2), r: 0.08, h: 0.06 },
        { p: v3(-0.4, 0.06, 2.3), r: 0.09, h: 0.06 },
        { p: v3(2.2, 0.06, -0.8), r: 0.12, h: 0.05 },
        { p: v3(-2.3, 0.06, 0.4), r: 0.14, h: 0.06 }
    ];

    for (const c of clutterPositions) {
        const dC = sdfCappedCylinder(sub(p, c.p), c.h, c.r);
        if (dC < minDist) {
            minDist = dC;
            matId = 6;
        }
    }

    // Curved power conduits linking pylons to pedestal
    for (let j = 0; j < 4; j++) {
        const a = (j * Math.PI * 0.5) + 0.35;
        const pConduit = sub(p, v3(Math.cos(a) * 2.05, 0.18, Math.sin(a) * 2.05));
        const dConduit = sdfTorus(pConduit, 0.35, 0.045);
        if (dConduit < minDist) {
            minDist = dConduit;
            matId = 6;
        }
    }

    return { dist: minDist, matId };
}

// Normal via central differences
function calcNormal(p) {
    const e = 0.0015;
    const dx = mapScene(v3(p.x + e, p.y, p.z)).dist - mapScene(v3(p.x - e, p.y, p.z)).dist;
    const dy = mapScene(v3(p.x, p.y + e, p.z)).dist - mapScene(v3(p.x, p.y - e, p.z)).dist;
    const dz = mapScene(v3(p.x, p.y, p.z + e)).dist - mapScene(v3(p.x, p.y, p.z - e)).dist;
    return norm(v3(dx, dy, dz));
}

// Curvature and Ambient Occlusion
function calcCurvatureAO(p, N) {
    const delta = 0.035;
    const p1 = add(p, mul(N, delta));
    const distDelta = mapScene(p1).dist;
    const pointiness = clamp((distDelta - delta) * 25.0, 0, 1);

    let aoSum = 0.0;
    const aoDistances = [0.06, 0.14, 0.28, 0.50];
    for (let k = 0; k < aoDistances.length; k++) {
        const d = aoDistances[k];
        const sampleP = add(p, mul(N, d));
        const distScene = mapScene(sampleP).dist;
        aoSum += Math.max(0.0, (d - distScene) / d) * (0.8 / (k + 1));
    }
    const cavityAO = clamp(aoSum, 0, 1);
    return { pointiness, cavityAO };
}

// Soft raymarched shadows
function calcShadow(ro, rd, mint, maxt, k) {
    let res = 1.0;
    let t = mint;
    for (let i = 0; i < 28 && t < maxt; i++) {
        const h = mapScene(add(ro, mul(rd, t))).dist;
        if (h < 0.001) return 0.0;
        res = Math.min(res, k * h / t);
        t += clamp(h, 0.03, 0.25);
    }
    return clamp(res, 0.0, 1.0);
}

// ============================================================================
// 5. CAMERA & 3-POINT STUDIO LIGHTING RIG
// ============================================================================
const W = 1280;
const H = 800;
const aspect = W / H;
const fov = 38 * (Math.PI / 180);
const halfTan = Math.tan(fov * 0.5);

// Frame closer with dramatic low-angle hero tilt
const camPos = v3(4.2, 2.9, 5.2);
const camTarget = v3(0.0, 1.30, 0.0);
const camFwd = norm(sub(camTarget, camPos));
const worldUp = v3(0, 1, 0);
const camRight = norm(cross(camFwd, worldUp));
const camUp = norm(cross(camRight, camFwd));

// 3-Point Studio Lighting (Kelvin chromatic calibration)
const lights = [
    {
        name: 'Key_Daylight_5600K',
        pos: v3(5.5, 6.2, 5.0),
        color: v3(1.0, 0.95, 0.88),
        intensity: 2.8,
        kShadow: 18.0
    },
    {
        name: 'Fill_CoolSky_7500K',
        pos: v3(-5.8, 4.0, 4.2),
        color: v3(0.72, 0.85, 1.0),
        intensity: 1.1,
        kShadow: 12.0
    },
    {
        name: 'Rim_Kicker_6500K',
        pos: v3(-2.8, 5.5, -6.5),
        color: v3(0.96, 0.98, 1.0),
        intensity: 3.6,
        kShadow: 24.0
    },
    {
        name: 'Ground_Bounce_3200K',
        pos: v3(0.0, -1.5, 0.0),
        color: v3(0.38, 0.32, 0.26),
        intensity: 0.65,
        kShadow: 8.0
    }
];

// ============================================================================
// 6. RAYMARCHING & MULTI-LAYER WEATHERING SHADER
// ============================================================================
function raymarch(ro, rd) {
    let t = 0.5;
    for (let step = 0; step < 170; step++) {
        const p = add(ro, mul(rd, t));
        const res = mapScene(p);
        if (res.dist < 0.002) {
            return { hit: true, t, p, matId: res.matId };
        }
        if (t > 24.0) break;
        t += res.dist * 0.92;
    }
    return { hit: false, t: 1e9 };
}

function shadeRay(ro, rd) {
    const march = raymarch(ro, rd);
    if (!march.hit) {
        const ty = clamp((rd.y + 0.25) / 0.8, 0, 1);
        const centerGlow = Math.max(0, dot(rd, norm(sub(v3(0, 1.35, 0), ro))));
        const bgBottom = v3(0.008, 0.010, 0.015);
        const bgTop = v3(0.022, 0.030, 0.048);
        const studioBackdrop = lerpV3(bgBottom, bgTop, ty);
        const halo = mul(v3(0.08, 0.35, 0.55), Math.pow(centerGlow, 8.0) * 0.40);
        return add(studioBackdrop, halo);
    }

    const p = march.p;
    const N = calcNormal(p);
    const V = mul(rd, -1);
    const NdotV = Math.max(0.001, dot(N, V));

    const { pointiness, cavityAO } = calcCurvatureAO(p, N);
    const microNoise = fbm(mul(p, 4.5));
    const scratchNoise = noise3D(mul(p, 18.0));

    let albedo = v3(0.5, 0.5, 0.5);
    let metallic = 0.0;
    let roughness = 0.5;
    let F0 = v3(0.04, 0.04, 0.04);
    let emissive = v3(0, 0, 0);
    let clearcoat = 0.0;
    let clearcoatRoughness = 0.1;

    if (march.matId === 1) {
        // Pedestal: Black Beveled Onyx
        albedo = v3(0.025, 0.028, 0.035);
        metallic = 0.08;
        roughness = 0.22 + 0.06 * microNoise;
        F0 = v3(0.05, 0.05, 0.06);
        clearcoat = 0.85;
        clearcoatRoughness = 0.18;
    } else if (march.matId === 2) {
        // Primary: Titanium Grade 5 Chamber with Edge-Wear Weathering
        const baseTitanium = v3(0.28, 0.32, 0.36);
        const wornEdgeMetal = v3(0.88, 0.84, 0.78);
        const creviceDirt = v3(0.02, 0.02, 0.015);

        const edgeWearMask = clamp(pointiness * 2.8 + scratchNoise * 0.35 - 0.4, 0, 1);
        const grimeMask = clamp(cavityAO * 1.8 - 0.2, 0, 1);

        albedo = lerpV3(baseTitanium, wornEdgeMetal, edgeWearMask);
        albedo = lerpV3(albedo, creviceDirt, grimeMask);

        metallic = lerp(0.85, 0.95, edgeWearMask) * (1.0 - grimeMask * 0.8);
        roughness = lerp(0.38, 0.18, edgeWearMask);
        roughness = lerp(roughness, 0.88, grimeMask);
        F0 = lerpV3(v3(0.58, 0.56, 0.54), v3(0.92, 0.88, 0.82), edgeWearMask);
    } else if (march.matId === 3) {
        // Containment Torus: Polished 24k Gold (Pure chromatic Fresnel gleam)
        albedo = v3(1.0, 0.72, 0.22);
        metallic = 0.98;
        roughness = 0.12 + 0.04 * scratchNoise;
        F0 = v3(1.0, 0.78, 0.35);
    } else if (march.matId === 4) {
        // Secondary: Rough Basalt / Dark Composite Pylons with Edge Chipping
        const basaltBase = v3(0.08, 0.09, 0.11);
        const chippedEdge = v3(0.65, 0.62, 0.58);
        const creviceGrime = v3(0.01, 0.01, 0.01);

        const edgeMask = clamp(pointiness * 3.2 - 0.3, 0, 1);
        const grimeMask = clamp(cavityAO * 2.2, 0, 1);

        albedo = lerpV3(basaltBase, chippedEdge, edgeMask);
        albedo = lerpV3(albedo, creviceGrime, grimeMask);

        metallic = lerp(0.15, 0.80, edgeMask) * (1.0 - grimeMask);
        roughness = lerp(0.65, 0.35, edgeMask);
        roughness = lerp(roughness, 0.95, grimeMask);
        F0 = v3(0.04, 0.04, 0.04);
    } else if (march.matId === 5) {
        // Glowing Turquoise Plasma Core (Incandescent HDR)
        albedo = v3(0.2, 0.95, 1.0);
        emissive = mul(v3(0.3, 2.2, 3.8), 7.5);
        metallic = 0.0;
        roughness = 0.04;
        F0 = v3(0.08, 0.08, 0.08);
    } else if (march.matId === 6) {
        // Tertiary Clutter: Dark industrial metal fasteners & canisters
        albedo = v3(0.22, 0.24, 0.26);
        metallic = 0.75;
        roughness = 0.42;
        F0 = v3(0.4, 0.4, 0.4);
    } else if (march.matId === 7) {
        // Emissive Fiber-Optic Conduit Stripe on Pylon Spine
        albedo = v3(0.1, 0.8, 1.0);
        emissive = mul(v3(0.15, 1.4, 2.8), 4.2);
        metallic = 0.1;
        roughness = 0.1;
        F0 = v3(0.08, 0.08, 0.08);
    }

    let directRadiance = v3(0, 0, 0);

    for (const light of lights) {
        const L = norm(sub(light.pos, p));
        const H = norm(add(V, L));
        const NdotL = Math.max(0, dot(N, L));
        if (NdotL <= 0) continue;

        const NdotH = Math.max(0.001, dot(N, H));
        const VdotH = Math.max(0.001, dot(V, H));
        const LdotH = Math.max(0.001, dot(L, H));

        const shadow = calcShadow(add(p, mul(N, 0.02)), L, 0.05, 8.0, light.kShadow);
        if (shadow <= 0.001) continue;

        const lightRad = mul(light.color, light.intensity * shadow);

        const D = ndfGGX(NdotH, roughness);
        const G = visSmithJoint(NdotV, NdotL, roughness);
        const F = fresnelSchlick(VdotH, F0);

        const specTerm = mulV(F, mul(lightRad, D * G * NdotL));

        const fd90 = 0.5 + 2.0 * LdotH * LdotH * roughness;
        const lScatter = 1.0 + (fd90 - 1.0) * Math.pow(1.0 - NdotL, 5);
        const vScatter = 1.0 + (fd90 - 1.0) * Math.pow(1.0 - NdotV, 5);
        const diffTerm = mulV(albedo, mul(lightRad, (1.0 - metallic) * (lScatter * vScatter / Math.PI) * NdotL));

        let ccTerm = v3(0, 0, 0);
        if (clearcoat > 0) {
            const Dcc = ndfGGX(NdotH, clearcoatRoughness);
            const Gcc = visSmithJoint(NdotV, NdotL, 0.25);
            const Fcc = fresnelSchlick(VdotH, v3(0.04, 0.04, 0.04));
            ccTerm = mul(mulV(Fcc, lightRad), Dcc * Gcc * NdotL * clearcoat * 1.5);
        }

        directRadiance = add(directRadiance, add(add(diffTerm, specTerm), ccTerm));
    }

    const ambientLight = v3(0.025, 0.032, 0.045);
    const aoFactor = 1.0 - cavityAO * 0.75;
    const ambientRadiance = mulV(albedo, mul(ambientLight, aoFactor));

    // Internal Plasma Core Glow illumination on surrounding geometry
    const distToCore = length(sub(p, v3(0, 1.35, 0)));
    const coreDir = norm(sub(v3(0, 1.35, 0), p));
    const NdotCore = Math.max(0, dot(N, coreDir));
    const coreIntensity = Math.exp(-distToCore * 1.1) * 2.2;
    const coreRad = mul(v3(0.15, 0.95, 1.5), coreIntensity);

    // Diffuse bounce for non-metals
    const diffuseCore = mulV(albedo, mul(coreRad, NdotCore * (1.0 - metallic * 0.9)));

    // Specular highlight from core on metallic surfaces (gold rings, titanium)
    const Hcore = norm(add(V, coreDir));
    const NdotHcore = Math.max(0.001, dot(N, Hcore));
    const VdotHcore = Math.max(0.001, dot(V, Hcore));
    const Dcore = ndfGGX(NdotHcore, roughness);
    const Gcore = visSmithJoint(NdotV, NdotCore, roughness);
    const Fcore = fresnelSchlick(VdotHcore, F0);
    const specCore = mulV(Fcore, mul(coreRad, Dcore * Gcore * NdotCore * metallic));

    return add(add(add(directRadiance, ambientRadiance), emissive), add(diffuseCore, specCore));
}

// ============================================================================
// 7. ACES FILMIC TONE MAPPING & POST-PROCESSING
// ============================================================================
function acesFilmic(x) {
    const a = 2.51;
    const b = 0.03;
    const c = 2.43;
    const d = 0.59;
    const e = 0.14;
    return (x * (a * x + b)) / (x * (c * x + d) + e);
}

function toneMapAndGamma(c) {
    const mapped = v3(
        clamp(acesFilmic(c.x), 0, 1),
        clamp(acesFilmic(c.y), 0, 1),
        clamp(acesFilmic(c.z), 0, 1)
    );
    return v3(
        Math.pow(mapped.x, 1.0 / 2.2),
        Math.pow(mapped.y, 1.0 / 2.2),
        Math.pow(mapped.z, 1.0 / 2.2)
    );
}

// ============================================================================
// 8. RENDER PIPELINE WITH HDR BLOOM & PNG ENCODING
// ============================================================================
console.log(`[Universal Scene Renderer] Rendering ${W}x${H} photorealistic scene...`);
const startTime = Date.now();
const hdrBuffer = new Float32Array(W * H * 3);

for (let y = 0; y < H; y++) {
    const v = (1.0 - (y + 0.5) / H) * 2.0 - 1.0;
    const yTan = v * halfTan;

    for (let x = 0; x < W; x++) {
        const u = ((x + 0.5) / W) * 2.0 - 1.0;
        const xTan = u * halfTan * aspect;

        const rayDir = norm(add(add(camFwd, mul(camRight, xTan)), mul(camUp, yTan)));
        const colHdr = shadeRay(camPos, rayDir);

        const idx = (y * W + x) * 3;
        hdrBuffer[idx + 0] = colHdr.x;
        hdrBuffer[idx + 1] = colHdr.y;
        hdrBuffer[idx + 2] = colHdr.z;
    }

    if (y % 100 === 0 || y === H - 1) {
        console.log(`  Progress: ${Math.round((y + 1) / H * 100)}% (${y + 1}/${H} scanlines)`);
    }
}

console.log('[Universal Scene Renderer] Applying optical Bloom pass...');
// Fast separable 2-pass bloom on HDR values exceeding threshold 1.2
const bloomBuffer = new Float32Array(W * H * 3);
const bloomRadius = 14;

// Horizontal pass
const tempBuffer = new Float32Array(W * H * 3);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        let r = 0, g = 0, b = 0, wSum = 0;
        for (let k = -bloomRadius; k <= bloomRadius; k++) {
            const nx = clamp(x + k, 0, W - 1);
            const idx = (y * W + nx) * 3;
            const weight = Math.exp(-(k * k) / (2.0 * 5.0 * 5.0));
            // Threshold
            const lum = hdrBuffer[idx] * 0.2126 + hdrBuffer[idx + 1] * 0.7152 + hdrBuffer[idx + 2] * 0.0722;
            if (lum > 1.2) {
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
            const weight = Math.exp(-(k * k) / (2.0 * 5.0 * 5.0));
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

// Composite Bloom + Tone Mapping to sRGB RGBA
const rgbaBuffer = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
    const hdrIdx = i * 3;
    const finalHdr = v3(
        hdrBuffer[hdrIdx + 0] + bloomBuffer[hdrIdx + 0] * 0.45,
        hdrBuffer[hdrIdx + 1] + bloomBuffer[hdrIdx + 1] * 0.45,
        hdrBuffer[hdrIdx + 2] + bloomBuffer[hdrIdx + 2] * 0.45
    );
    const colSrgb = toneMapAndGamma(finalHdr);

    const pixIdx = i * 4;
    rgbaBuffer[pixIdx + 0] = Math.round(colSrgb.x * 255);
    rgbaBuffer[pixIdx + 1] = Math.round(colSrgb.y * 255);
    rgbaBuffer[pixIdx + 2] = Math.round(colSrgb.z * 255);
    rgbaBuffer[pixIdx + 3] = 255;
}

const elapsedMs = Date.now() - startTime;
console.log(`[Universal Scene Renderer] Raymarching complete in ${elapsedMs}ms! Encoding PNG...`);

const pngBuffer = encodePNG(W, H, rgbaBuffer);

// Target destinations
const targets = [
    path.resolve(__dirname, '../docs/screenshots/11_universal_photorealistic_scene.png'),
    '/Users/eligreen/.gemini/antigravity/brain/2933a10a-f510-4853-a96a-7f0c3ad06abc/11_universal_photorealistic_scene.png',
    '/Users/eligreen/.gemini/antigravity/brain/2933a10a-f510-4853-a96a-7f0c3ad06abc/screenshots/11_universal_photorealistic_scene.png'
];

for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, pngBuffer);
    console.log(`  Saved screenshot: ${target} (${(pngBuffer.length / 1024).toFixed(1)} KB)`);
}

console.log('✅ Universal Photorealistic Scene Image Generation Complete!');
