/**
 * Sky realism benchmark: renders the sky dome under the sun of each reference HDR sky photograph and scores the
 * render against the photo with exposure-free measurements (packages/core/src/node/atmosphere-benchmark).
 *
 *   npx tsx scripts/sky-realism/benchmark.ts [--manifest <refs.json>] --out <dir>
 *
 * The manifest (default scripts/sky-realism/references.json: 59 CC0 Poly Haven "puresky" HDRIs) is a JSON array:
 *   { id, file? | polyhavenId?, timeOfDay?, weather?, coords?: [lat, lng], capturedLocalUnix?, utcOffsetHours?, minSampleElevationDeg? }
 * Poly Haven references are fetched once at 2K into ~/.cache/scratchbox/sky-references. Their date_taken is local
 * camera time; utcOffsetHours is set only where it was calibrated (South African captures: UTC+2, checked against the
 * measured sun disc of 20 references). whiteBalanceKelvin is Poly Haven's recorded white balance: the render is
 * adapted to it (Bradford, blackbody white to D65) before comparing, as the camera adapted the photo.
 * The sun comes from the disc in the photo; with none visible, from the NOAA ephemeris when the capture time and its
 * UTC offset are known; otherwise the reference is skipped and listed with the reason. Nothing is assumed.
 *
 * Writes <out>/report.json, <out>/report.html and side-by-side PNGs (photo | render), all tone-mapped the same way.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readHdrEquirect, measureEquirectSky, EquirectImage, SkyMeasurement, whiteBalanceMatrix, applyColorMatrix } from '../../packages/core/src/node/atmosphere-benchmark/equirect-sky';
import { integrateSpectrum, planckRadiance } from '../../packages/core/src/browser/generative-canvas/services/atmosphere/spectral-sun';
import { renderSkyDomeEquirects } from '../../packages/core/src/node/atmosphere-benchmark/sky-dome-equirect-renderer';
import { scoreSkyRealism, SKY_REALISM_TOLERANCES, SkyRealismScore } from '../../packages/core/src/node/atmosphere-benchmark/sky-realism-score';
import { calculateNOAASolarPosition } from '../../packages/core/src/browser/generative-canvas/services/atmosphere/solar-position';
import { encodePng } from '../../packages/core/src/node/3d-engine/staged-location/png-encode';
import type { AtmosphericScatteringConfig } from '../../packages/core/src/browser/generative-canvas/services/atmosphere/atmosphere-types';

interface Reference {
    id: string;
    file?: string;
    polyhavenId?: string;
    timeOfDay?: string;
    weather?: string;
    coords?: [number, number];
    capturedLocalUnix?: number;
    utcOffsetHours?: number;
    minSampleElevationDeg?: number;
    /** The camera white balance the photo was processed at; the render gets the same adaptation before comparing. */
    whiteBalanceKelvin?: number;
}

function arg(name: string, fallback?: string): string {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
}

const CACHE = path.join(os.homedir(), '.cache', 'scratchbox', 'sky-references');

/** The reference's HDR on disk: its file, or the Poly Haven 2K .hdr fetched once into the cache. */
async function referenceFile(ref: Reference): Promise<string> {
    if (ref.file) return ref.file;
    if (!ref.polyhavenId) throw new Error(`reference ${ref.id} has neither file nor polyhavenId`);
    const local = path.join(CACHE, `${ref.polyhavenId}_2k.hdr`);
    if (fs.existsSync(local)) return local;
    const files = await (await fetch(`https://api.polyhaven.com/files/${ref.polyhavenId}`, { headers: { 'User-Agent': 'scratchbox-sky-benchmark' } })).json() as { hdri?: { '2k'?: { hdr?: { url: string } } } };
    const url = files.hdri?.['2k']?.hdr?.url;
    if (!url) throw new Error(`Poly Haven has no 2K .hdr for ${ref.polyhavenId}`);
    const res = await fetch(url, { headers: { 'User-Agent': 'scratchbox-sky-benchmark' } });
    if (!res.ok) throw new Error(`fetching ${url}: HTTP ${res.status}`);
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()));
    return local;
}

/** The scene configuration the app would build for this sky: the measured sun, and cloud cover when the photo has cloud. */
function configFor(ref: Reference, sunElevationDeg: number, measured: SkyMeasurement): { config: AtmosphericScatteringConfig; note?: string } {
    const config: AtmosphericScatteringConfig = { sunElevation: sunElevationDeg, sunAzimuth: 180 };
    if (ref.weather === 'overcast' || ref.weather === 'rain') {
        Object.assign(config, { volumetricClouds: true, cloudCoverage: 0.95 });
        return { config, note: 'overcast drawn as volumetric cover 0.95' };
    }
    if (ref.weather === 'partly_cloudy') {
        const cover = measured.neutralBrightFraction ?? 0.4;
        Object.assign(config, { volumetricClouds: true, cloudCoverage: Math.max(0.05, cover) });
        return { config, note: measured.neutralBrightFraction !== undefined ? `volumetric cover ${cover.toFixed(2)} (measured)` : 'volumetric cover 0.4 (not measurable at this sun)' };
    }
    if (ref.weather === 'fog') return { config, note: 'fog: the sky dome has no fog layer; drawn clear' };
    return { config };
}

function downsample(img: EquirectImage, w: number, h: number): EquirectImage {
    const out = new Float32Array(w * h * 3);
    const fx = img.width / w, fy = img.height / h;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = Math.floor(j * fy); y < Math.floor((j + 1) * fy); y++) for (let x = Math.floor(i * fx); x < Math.floor((i + 1) * fx); x++) {
            const k = (y * img.width + x) * 3;
            r += img.rgb[k]; g += img.rgb[k + 1]; b += img.rgb[k + 2]; n++;
        }
        out[(j * w + i) * 3] = r / n; out[(j * w + i) * 3 + 1] = g / n; out[(j * w + i) * 3 + 2] = b / n;
    }
    return { width: w, height: h, rgb: out };
}

/** Exposes so the reference patch sits at 0.3, ACES-fitted (Narkowicz) tone curve, sRGB encoding; sky half only. */
function toneMapSky(img: EquirectImage, refY: number, into: Uint8Array, stride: number, x0: number) {
    const k = 0.3 / refY;
    const aces = (v: number) => Math.min(1, Math.max(0, (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14)));
    const srgb = (v: number) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
    for (let j = 0; j < img.height / 2; j++) for (let i = 0; i < img.width; i++) {
        const s = (j * img.width + i) * 3, d = j * stride + (x0 + i) * 3;
        for (let c = 0; c < 3; c++) into[d + c] = srgb(aces(img.rgb[s + c] * k));
    }
}

async function main() {
    const manifest: Reference[] = JSON.parse(fs.readFileSync(arg('manifest', path.join(__dirname, 'references.json')), 'utf8'));
    const out = arg('out');
    fs.mkdirSync(out, { recursive: true });

    type Job = { ref: Reference; photo: EquirectImage; measured: SkyMeasurement; sunEl: number; sunSource: string; config: AtmosphericScatteringConfig; note?: string };
    const jobs: Job[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const ref of manifest) {
        const photo = readHdrEquirect(await referenceFile(ref));
        const measured = measureEquirectSky(photo, { sunMayBeUp: ref.timeOfDay !== 'night', minSampleElevationDeg: ref.minSampleElevationDeg });
        let sunEl: number | undefined, sunSource = '';
        if (measured.sun) { sunEl = measured.sun.elevationDeg; sunSource = 'disc in photo'; }
        else if (ref.coords && ref.capturedLocalUnix !== undefined && ref.utcOffsetHours !== undefined) {
            const utc = new Date((ref.capturedLocalUnix - ref.utcOffsetHours * 3600) * 1000);
            sunEl = calculateNOAASolarPosition(utc, ref.coords[0], ref.coords[1]).elevationDeg;
            sunSource = `NOAA at ${utc.toISOString()}`;
        }
        if (sunEl === undefined) { skipped.push({ id: ref.id, reason: 'no sun disc and no capture time with a known UTC offset' }); continue; }
        const { config, note } = configFor(ref, sunEl, measured);
        jobs.push({ ref, photo: downsample(photo, 512, 256), measured, sunEl, sunSource, config, note });
    }

    const t0 = Date.now();
    const renders = await renderSkyDomeEquirects(jobs.map(j => j.config), { onProgress: (d, n) => { if (d % 10 === 0 || d === n) console.log(`rendered ${d}/${n}`); } });
    console.log(`rendered ${renders.length} skies in ${Date.now() - t0} ms`);

    const strips: Array<{ sunEl: number; px: Uint8Array }> = [];
    const rows: Array<{ id: string; timeOfDay?: string; weather?: string; sunElevationDeg: number; sunSource: string; note?: string; score: SkyRealismScore; image: string }> = [];
    jobs.forEach((job, i) => {
        // Process the render as the photographer's camera did: the same white balance.
        const wb = job.ref.whiteBalanceKelvin !== undefined
            ? whiteBalanceMatrix(integrateSpectrum(l => planckRadiance(l, job.ref.whiteBalanceKelvin!)))
            : undefined;
        const image = wb ? applyColorMatrix(renders[i].image, wb) : renders[i].image;
        const lights = wb ? { ...renders[i].lights, sunColor: ([0, 1, 2].map(r => wb[r][0] * renders[i].lights.sunColor[0] + wb[r][1] * renders[i].lights.sunColor[1] + wb[r][2] * renders[i].lights.sunColor[2]) as [number, number, number]) } : renders[i].lights;
        const renderMeasured = job.measured.sun
            ? measureEquirectSky(image, { knownSun: { elevationDeg: job.sunEl, imageAzimuthDeg: 180 }, minSampleElevationDeg: job.ref.minSampleElevationDeg })
            : measureEquirectSky(image, { sunMayBeUp: false, minSampleElevationDeg: job.ref.minSampleElevationDeg });
        const score = scoreSkyRealism(job.measured, renderMeasured, lights, job.sunEl);
        const W = 512, H = 128, px = new Uint8Array(W * 2 * H * 3);
        toneMapSky(job.photo, job.measured.referenceLuminance, px, W * 2 * 3, 0);
        toneMapSky(image, renderMeasured.referenceLuminance, px, W * 2 * 3, W);
        const file = `${job.ref.id}.png`;
        fs.writeFileSync(path.join(out, file), encodePng(W * 2, H, px, 3));
        strips.push({ sunEl: job.sunEl, px });
        rows.push({ id: job.ref.id, timeOfDay: job.ref.timeOfDay, weather: job.ref.weather, sunElevationDeg: job.sunEl, sunSource: job.sunSource, note: job.note, score, image: file });
    });

    // One sheet, highest sun first, a 4 px gap between pairs and a 4 px divider between photo and render.
    strips.sort((a, b) => b.sunEl - a.sunEl);
    const SW = 1024 + 4, SH = 128, GAP = 4, PER = 18;
    for (let page = 0; page * PER < strips.length; page++) {
        const part = strips.slice(page * PER, (page + 1) * PER);
        const sheet = new Uint8Array(SW * part.length * (SH + GAP) * 3).fill(17);
        part.forEach((st, n) => {
            for (let j = 0; j < SH; j++) for (let i = 0; i < 1024; i++) {
                const src = (j * 1024 + i) * 3, x = i < 512 ? i : i + 4, dst = ((n * (SH + GAP) + j) * SW + x) * 3;
                sheet[dst] = st.px[src]; sheet[dst + 1] = st.px[src + 1]; sheet[dst + 2] = st.px[src + 2];
            }
        });
        fs.writeFileSync(path.join(out, `contact_sheet_${page + 1}.png`), encodePng(SW, part.length * (SH + GAP), sheet, 3));
    }

    const metricNames = Object.keys(SKY_REALISM_TOLERANCES) as Array<keyof typeof SKY_REALISM_TOLERANCES>;
    const summary = Object.fromEntries(metricNames.map(m => {
        const v = rows.map(r => r.score.metrics[m]).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
        return [m, { tolerance: SKY_REALISM_TOLERANCES[m], n: v.length, passRate: v.length ? v.filter(x => x <= SKY_REALISM_TOLERANCES[m]).length / v.length : undefined, median: v[Math.floor(v.length / 2)] }];
    }));
    const allPass = rows.filter(r => r.score.failed.length === 0).length;
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ summary, conditionsFullyPassing: allPass, scored: rows.length, skipped, rows }, null, 1));

    const fmt = (m: string, v: number | undefined) => v === undefined ? '<td class="na">–</td>' : `<td class="${v <= (SKY_REALISM_TOLERANCES as Record<string, number>)[m] ? 'ok' : 'bad'}">${v.toFixed(3)}</td>`;
    const html = `<!doctype html><meta charset="utf-8"><title>Sky realism benchmark</title>
<style>body{font:13px system-ui;background:#111;color:#ddd;margin:16px}table{border-collapse:collapse}td,th{padding:3px 8px;border-bottom:1px solid #333;text-align:left}td.ok{color:#7d7}td.bad{color:#f77}td.na{color:#666}img{display:block;width:640px}</style>
<h2>Sky realism benchmark — ${rows.length} skies scored, ${allPass} pass every measure</h2>
<table><tr><th>measure</th><th>tolerance</th><th>pass rate</th><th>median</th><th>n</th></tr>
${metricNames.map(m => `<tr><td>${m}</td><td>${SKY_REALISM_TOLERANCES[m]}</td><td>${summary[m].passRate === undefined ? '–' : Math.round(summary[m].passRate * 100) + '%'}</td><td>${summary[m].median?.toFixed(3) ?? '–'}</td><td>${summary[m].n}</td></tr>`).join('')}</table>
<p>Skipped: ${skipped.map(s => `${s.id} (${s.reason})`).join('; ') || 'none'}</p>
<table><tr><th>sky (photo | render)</th><th>condition</th>${metricNames.map(m => `<th>${m}</th>`).join('')}</tr>
${rows.sort((a, b) => b.sunElevationDeg - a.sunElevationDeg).map(r => `<tr><td><img src="${r.image}"></td><td>${r.id}<br>${r.timeOfDay ?? ''} · ${r.weather ?? ''}<br>sun ${r.sunElevationDeg.toFixed(1)}° (${r.sunSource})${r.note ? `<br>${r.note}` : ''}</td>${metricNames.map(m => fmt(m, r.score.metrics[m])).join('')}</tr>`).join('')}
</table>`;
    fs.writeFileSync(path.join(out, 'report.html'), html);
    console.log(JSON.stringify({ scored: rows.length, conditionsFullyPassing: allPass, skipped: skipped.length, summary }, null, 1));
}

main().catch(err => { console.error(err); process.exit(1); });
