#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Benchmarks the Metal path tracer's optimizations against its own baseline on one .sbvg.
//
//   node scripts/bench_sbvg_pathtracer.cjs <helper binary> <file.sbvg> <materials.glb> <out dir> [variant ...]
//
// Every variant renders the same shot (Phase 1 framing: 1280x720, 64 spp, sun 42/150) and is scored on
// rays, GPU render time, rays per second, and how its image differs from the baseline's in 8x8-block
// means (bias, not noise, since the sample streams are identical where the variant does not change them).
// "sampler" variants are scored instead by RMSE against a 1024 spp reference at 8 and 32 spp.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [binary, sbvg, glb, outDir, ...only] = process.argv.slice(2);
if (!binary || !sbvg || !glb || !outDir) {
    console.error('usage: bench_sbvg_pathtracer.cjs <helper> <file.sbvg> <materials.glb> <out dir> [variant ...]');
    process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const SHOT = {
    width: 1280, height: 720, samplesPerPixel: 64, maxBounces: 4, seed: 1,
    lod: { thresholdPx: 1, near: 0.1 },
    lighting: { sun: { elevationDeg: 42, azimuthDeg: 150 } },
    camera: { auto: { verticalFovDeg: 40, pitchDeg: 12, headingDeg: 30, distanceScale: 0.45 } }
};

const VARIANTS = {
    baseline: {},
    'accel-fast-build': { optimizations: { accelFastBuild: true } },
    'bounce-cut-4px': { optimizations: { bounceThresholdPx: 4 } },
    'bounce-cut-8px': { optimizations: { bounceThresholdPx: 8 } },
    'bounce-cut-16px': { optimizations: { bounceThresholdPx: 16 } },
    'gi-cut-4px': { optimizations: { bounceThresholdPx: 4, bounceShadowRays: false } },
    'gi-cut-8px': { optimizations: { bounceThresholdPx: 8, bounceShadowRays: false } },
    'gi-cut-16px': { optimizations: { bounceThresholdPx: 16, bounceShadowRays: false } },
    'primary-raster': { optimizations: { primaryRaster: true } },
    'all-speed': { optimizations: { primaryRaster: true, bounceThresholdPx: 8 } }
};

function render(name, extra) {
    const dir = path.join(outDir, name);
    const config = { sbvgPath: path.resolve(sbvg), outputDir: dir, backend: 'metal', materials: { glbPath: path.resolve(glb) }, ...SHOT, ...extra };
    if (extra.optimizations) config.optimizations = { ...(SHOT.optimizations || {}), ...extra.optimizations };
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    execFileSync(binary, [configPath], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    const stats = JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8'));
    const color = new Float32Array(fs.readFileSync(path.join(dir, 'color.f32')).buffer.slice(0));
    return { stats, color, dir };
}

const lum = (c, i) => 0.2126 * c[i] + 0.7152 * c[i + 1] + 0.0722 * c[i + 2];

function blockDiff(a, b, w, h) {
    const bs = 8, bw = Math.floor(w / bs), bh = Math.floor(h / bs);
    let sumB = 0;
    for (let p = 0; p < w * h; p++) sumB += lum(b, p * 3);
    const meanB = sumB / (w * h);
    let total = 0, over = 0, blocks = 0, maxRel = 0;
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        let sa = 0, sb = 0;
        for (let y = 0; y < bs; y++) for (let x = 0; x < bs; x++) {
            const p = (by * bs + y) * w + bx * bs + x;
            sa += lum(a, p * 3); sb += lum(b, p * 3);
        }
        const rel = Math.abs(sa - sb) / Math.max(sb, 0.02 * meanB * bs * bs);
        total += rel; blocks++;
        if (rel > 0.02) over++;
        maxRel = Math.max(maxRel, rel);
    }
    return { mean: total / blocks, over2pct: over / blocks, max: maxRel };
}

function rmse(a, b) {
    let sq = 0;
    for (let i = 0; i < a.length; i++) sq += (a[i] - b[i]) ** 2;
    return Math.sqrt(sq / a.length);
}

const wanted = only.length ? only : Object.keys(VARIANTS);
const rows = [];
let base = null;
for (const name of wanted) {
    if (!(name in VARIANTS)) { console.error(`unknown variant ${name}`); process.exit(2); }
    const r = render(name, VARIANTS[name]);
    if (name === 'baseline' || !base) base = base ?? (name === 'baseline' ? r : null);
    const s = r.stats;
    const diff = base && r !== base ? blockDiff(r.color, base.color, s.width, s.height) : null;
    rows.push({
        variant: name, cut: s.cut.triangles, bounceCut: s.optimizations?.bounceCut?.triangles ?? '',
        rays: s.rays, renderMs: s.renderMs.toFixed(1), mraysPerS: (s.raysPerSecond / 1e6).toFixed(1),
        accelMs: s.accelerationBuildMs.toFixed(1), speedup: base ? (base.stats.renderMs / s.renderMs).toFixed(2) + 'x' : '',
        blockDiff: diff ? `${(diff.mean * 100).toFixed(3)}% (max ${(diff.max * 100).toFixed(1)}%, ${(diff.over2pct * 100).toFixed(2)}% blocks >2%)` : 'reference'
    });
    console.error(`${name}: ${s.renderMs.toFixed(1)} ms, ${(s.raysPerSecond / 1e6).toFixed(1)} M rays/s`);
}

if (wanted.includes('sampler')) {
    // handled below
}

console.log('| Variant | Cut tris | Bounce tris | Rays | Render ms | M rays/s | AS build ms | Speedup | 8x8-block diff vs baseline |');
console.log('| :-- | --: | --: | --: | --: | --: | --: | --: | :-- |');
for (const r of rows) console.log(`| ${r.variant} | ${r.cut} | ${r.bounceCut} | ${r.rays} | ${r.renderMs} | ${r.mraysPerS} | ${r.accelMs} | ${r.speedup} | ${r.blockDiff} |`);

if (process.env.BENCH_SAMPLERS === '1') {
    console.error('reference render at 1024 spp (PCG)...');
    const ref = render('reference-1024', { samplesPerPixel: 1024 });
    console.log('\n| Sampler | spp | RMSE vs 1024 spp |');
    console.log('| :-- | --: | --: |');
    for (const sampler of ['pcg', 'sobol']) {
        for (const spp of [8, 32]) {
            const r = render(`${sampler}-${spp}`, { samplesPerPixel: spp, optimizations: { sampler } });
            console.log(`| ${sampler} | ${spp} | ${rmse(r.color, ref.color).toExponential(3)} |`);
        }
    }
}
