/**
 * Reads each cloudy reference sky with Gemini vision and records the cloud the app would draw for it: a volumetric
 * cumulus sky cover and up to four shell decks (CloudShellLayer: altitude, thickness, coverage, optical depth, feature
 * size, streaking). The model is the domain engine here exactly as in the app, where the agent chooses cloud decks;
 * this runs once per reference and is cached in references.json, so benchmark runs stay deterministic and make no calls.
 *
 *   npx tsx scripts/sky-realism/annotate-clouds.ts [--force] [--only <id>]
 *
 * Billed: one vision call per cloudy reference (gemini-4-argon). Not run by tests.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readHdrEquirect, measureEquirectSky, luminance } from '../../packages/core/src/node/atmosphere-benchmark/equirect-sky';
import { encodePng } from '../../packages/core/src/node/3d-engine/staged-location/png-encode';
import { GeminiClient, DEFAULT_GEMINI_MODEL } from '../../packages/core/src/node/gemini/gemini-client';
import { resolveCloudShellLayers } from '../../packages/core/src/browser/generative-canvas/services/atmosphere/cloud-shell-layers';

const MANIFEST = path.join(__dirname, 'references.json');
const CACHE = path.join(os.homedir(), '.cache', 'scratchbox', 'sky-references');

const DECK = {
    type: 'OBJECT',
    properties: {
        label: { type: 'STRING', description: 'What you would call this deck (for reports only).' },
        baseAltitudeMeters: { type: 'NUMBER' },
        thicknessMeters: { type: 'NUMBER' },
        coverage: { type: 'NUMBER', description: 'Fraction of the sky this deck covers, 0-1.' },
        opticalDepth: { type: 'NUMBER', description: 'Vertical optical depth of a covered column: thin cirrus 0.05-1, altostratus/stratus 3-20.' },
        featureSizeMeters: { type: 'NUMBER', description: 'Horizontal size of its cells or streaks.' },
        streakElongation: { type: 'NUMBER', description: '1 for round cells; 4-12 for streaks.' },
        streakHeadingDeg: { type: 'NUMBER' },
        forwardScattering: { type: 'NUMBER', description: 'Henyey-Greenstein g: ice ~0.75, water ~0.85.' }
    },
    required: ['baseAltitudeMeters', 'thicknessMeters', 'coverage', 'opticalDepth', 'featureSizeMeters']
};
const SCHEMA = {
    type: 'OBJECT',
    properties: {
        cumulusSkyCover: { type: 'NUMBER', description: 'Sky cover (0-1) of heaped, convective, volumetric cloud (cumulus-like), 0 if none.' },
        cumulusBaseAltitudeMeters: { type: 'NUMBER', description: 'Base height of that cloud, if any.' },
        decks: { type: 'ARRAY', items: DECK, description: 'Up to 4 thin or layered decks (sheets, streaks, cells) that are not heaped cumulus.' },
        reasoning: { type: 'STRING', description: 'One or two sentences on what you see.' }
    },
    required: ['cumulusSkyCover', 'decks', 'reasoning']
};

/** The sky half of the panorama, exposed on its median, ACES, sRGB, 1024x256 PNG. */
function skyPng(file: string): Buffer {
    const img = readHdrEquirect(file);
    const W = 1024, H = 256, fx = img.width / W, fy = img.height / 2 / H;
    const Ys: number[] = [];
    for (let i = 0; i < (img.width * img.height) / 2; i += 7) Ys.push(luminance(img.rgb[i * 3], img.rgb[i * 3 + 1], img.rgb[i * 3 + 2]));
    Ys.sort((a, b) => a - b);
    const k = 0.25 / Math.max(1e-9, Ys[Math.floor(Ys.length / 2)]);
    const aces = (v: number) => Math.min(1, Math.max(0, (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14)));
    const enc = (v: number) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
    const px = new Uint8Array(W * H * 3);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const s = (Math.floor(j * fy) * img.width + Math.floor(i * fx)) * 3, d = (j * W + i) * 3;
        for (let c = 0; c < 3; c++) px[d + c] = enc(aces(img.rgb[s + c] * k));
    }
    return encodePng(W, H, px, 3);
}

async function main() {
    const force = process.argv.includes('--force');
    const onlyIdx = process.argv.indexOf('--only');
    const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : undefined;
    const refs = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Array<Record<string, any>>;
    const genai: any = await new GeminiClient().getGenAIClient();
    if (!genai?.models?.generateContent) throw new Error('annotate-clouds: no Gemini client is configured (credentials not found)');
    let calls = 0;
    const unread: string[] = [];
    for (const ref of refs) {
        if (only && ref.id !== only) continue;
        if (ref.weather === 'clear' || ref.timeOfDay === 'night') continue;
        if (ref.clouds && !force) continue;
        const file = path.join(CACHE, `${ref.polyhavenId}_2k.hdr`);
        if (!fs.existsSync(file)) throw new Error(`annotate-clouds: ${file} is missing; run the benchmark once to fetch the references`);
        const sun = measureEquirectSky(readHdrEquirect(file)).sun;
        const prompt = `This is the sky half of a 360° equirectangular photograph (horizon along the bottom edge, zenith along the top, azimuth across). ${sun ? `The sun is ${sun.elevationDeg.toFixed(0)}° above the horizon.` : 'The sun is not visible.'}
Describe the cloud so a renderer can redraw this sky. It draws two kinds: a volumetric layer of heaped, convective cloud (give its sky cover and base height), and up to four thin decks drawn as sheets with physical parameters (cirrus streaks, cirrostratus or altostratus sheets, altocumulus or cirrocumulus cells, stratocumulus fields, haze or smoke layers). Choose what reproduces what you see; use 0 cumulus and no decks for a clear sky. Altitudes in metres above the ground.`;
        const t0 = Date.now();
        const request = {
            model: DEFAULT_GEMINI_MODEL,
            contents: [{ inlineData: { mimeType: 'image/png', data: skyPng(file).toString('base64') } }, prompt],
            config: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.1 }
        };
        // Transient network failures are retried (3 attempts, 2 s then 4 s); anything else is reported as is.
        let response: any;
        let failure: string | undefined;
        for (let attempt = 1; ; attempt++) {
            try {
                // A request that has not answered in 150 s is abandoned and retried (answers take 16-80 s; one hung for 10 minutes).
                response = await Promise.race([
                    genai.models.generateContent(request),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 150 s')), 150_000))
                ]);
                break;
            } catch (err) {
                const message = String((err as Error)?.message ?? err);
                if (!/fetch failed|ECONNRESET|ETIMEDOUT|timed out|503|UNAVAILABLE/i.test(message)) throw err;
                // A sky the model cannot answer for after three tries is left unannotated (reported), never filled in.
                if (attempt >= 3) { failure = message; break; }
                await new Promise(r => setTimeout(r, 2000 * attempt));
            }
        }
        calls++;
        if (failure) {
            unread.push(`${ref.id} (${failure})`);
            process.stdout.write(`${ref.id}: NOT annotated, ${failure}\n`);
            continue;
        }
        const answer = JSON.parse(response?.text || '{}');
        const decks = (answer.decks ?? []).slice(0, 4);
        resolveCloudShellLayers(decks, 'annotate-clouds'); // throws, naming the field, if the model gave an unusable deck
        ref.clouds = {
            cumulusSkyCover: Math.min(0.98, Math.max(0, answer.cumulusSkyCover ?? 0)),
            ...(answer.cumulusBaseAltitudeMeters ? { cumulusBaseAltitudeMeters: answer.cumulusBaseAltitudeMeters } : {}),
            decks,
            reasoning: answer.reasoning,
            source: `${DEFAULT_GEMINI_MODEL} reading of the photo, ${new Date().toISOString().slice(0, 10)}`
        };
        process.stdout.write(`${ref.id}: cumulus ${ref.clouds.cumulusSkyCover}, ${decks.length} deck(s) ${decks.map((d: any) => d.label).join(', ')} (${Date.now() - t0} ms) — ${answer.reasoning}\n`);
        fs.writeFileSync(MANIFEST, JSON.stringify(refs, null, 1));
    }
    console.log(`${calls} vision call(s)${unread.length ? `; not annotated: ${unread.join('; ')}` : ''}`);
}

main().catch(err => { console.error(err); process.exit(1); });
