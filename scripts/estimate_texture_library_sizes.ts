/**
 * Estimates the real tile width of every texture library set whose publisher gives none (texture-library-sizes.ts),
 * from its colour preview and its publisher's text, with the app's vision model. First the same estimate is made for a
 * sample of sets whose publisher does give a size and scored against it; then the unsized sets are estimated and written,
 * with that score, to assets/textures/library/estimated-sizes.json (an existing file's sets are kept and only the
 * missing ones asked for, unless --redo). This bills the vision model: about one call per 12 sets.
 *
 *   npx vite-node scripts/estimate_texture_library_sizes.ts -- [--validate 48] [--limit N] [--redo]
 */

import * as fs from 'fs';
import * as path from 'path';
import { createStagedLocationDeps } from '../packages/core/src/node/3d-engine/staged-location/staged-location-tool';
import { libraryColourPreview, loadTextureLibraryIndex } from '../packages/core/src/node/3d-engine/texture-library';
import { decodeImageInMemory } from '../packages/core/src/node/3d-engine/staged-location/tile-texture-transfer';
import { encodePng } from '../packages/core/src/node/3d-engine/staged-location/png-encode';
import { ESTIMATED_SIZES_FILE, parseSizes, previewSheet, scoreEstimates, sizePrompt, SIZE_BATCH, type EstimatedSizes } from '../packages/core/src/node/3d-engine/texture-library-sizes';
import { VisionModelChain } from '../packages/core/src/node/gemini/vision-model-chain';
import type { TextureLibraryEntry } from '../packages/core/src/common/spatial/texture-library-index';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : process.argv[i + 1] ?? ''; };
const root = path.resolve(__dirname, '..');

async function main(): Promise<void> {
    const index = loadTextureLibraryIndex(root);
    if (!index) throw new Error('the texture library index has not been built (npx vite-node scripts/build_texture_library_index.ts)');
    const deps = await createStagedLocationDeps(root);
    if (!deps.vision || !('client' in deps.vision)) throw new Error(`no vision model: ${(deps.vision as { unavailable?: string })?.unavailable ?? 'not configured'}`);
    const chain = new VisionModelChain<string>({ client: deps.vision.client, candidates: deps.vision.candidates });
    const file = path.join(root, 'assets', 'textures', 'library', ESTIMATED_SIZES_FILE);
    const prior: EstimatedSizes | undefined = fs.existsSync(file) && process.argv.indexOf('--redo') < 0 ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
    const usable = index.sets.filter(e => e.maps.color);
    const text = (e: TextureLibraryEntry) => `${e.appearance} Tags: ${e.tags.slice(0, 10).join(', ')}.`;
    let model = '';

    // one sheet of up to SIZE_BATCH sets per call, several calls at once
    async function estimate(sets: TextureLibraryEntry[], label: string): Promise<Map<string, { widthM: number; conf: number }>> {
        const out = new Map<string, { widthM: number; conf: number }>();
        const batches: TextureLibraryEntry[][] = [];
        for (let i = 0; i < sets.length; i += SIZE_BATCH) batches.push(sets.slice(i, i + SIZE_BATCH));
        let next = 0, done = 0;
        await Promise.all(Array.from({ length: Math.min(6, batches.length) }, async () => {
            while (next < batches.length) {
                const batch = batches[next++];
                const shown: Array<{ e: TextureLibraryEntry; img: ReturnType<typeof decodeImageInMemory> }> = [];
                for (const e of batch) {
                    const bytes = await libraryColourPreview(e, root).catch(() => undefined);
                    if (bytes) try { shown.push({ e, img: decodeImageInMemory(bytes) }); } catch { /* an undecodable preview: left unestimated */ }
                }
                if (!shown.length) continue;
                const sheet = previewSheet(shown.map(s => s.img));
                try {
                    const r = await chain.generate({
                        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from(encodePng(sheet.width, sheet.height, sheet.rgba, 4)).toString('base64') } }, { text: sizePrompt(shown.map(s => text(s.e))) }] }],
                        config: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 4096 }
                    }, { stage: 'library-sizes', thinkingBudget: 512, valid: x => { try { parseSizes((x.candidates?.[0]?.content?.parts ?? []).filter(p => !(p as { thought?: boolean }).thought).map(p => p.text ?? '').join(''), shown.length); return true; } catch { return false; } } });
                    model ||= r.model ?? '';
                    const reply = (r.response.candidates?.[0]?.content?.parts ?? []).filter(p => !(p as { thought?: boolean }).thought).map(p => p.text ?? '').join('');
                    parseSizes(reply, shown.length).forEach((s, k) => { if (s) out.set(shown[k].e.id, s); });
                } catch (err) { console.warn(`${label}: a batch failed: ${err instanceof Error ? err.message : String(err)}`); }
                done++;
                if (done % 10 === 0 || done === batches.length) console.log(`${label}: ${done}/${batches.length} sheets, ${out.size} sets estimated`);
            }
        }));
        return out;
    }

    // 1. scored against publisher sizes, spread over the library (every k-th sized set)
    const known = usable.filter(e => e.realSizeM);
    const want = Number(arg('validate') ?? 48), step = Math.max(1, Math.floor(known.length / Math.max(1, want)));
    const sample = known.filter((_, i) => i % step === 0).slice(0, want);
    const checked = await estimate(sample, 'validation');
    const validation = scoreEstimates(sample.filter(e => checked.has(e.id)).map(e => ({ estimatedM: checked.get(e.id)!.widthM, knownM: e.realSizeM![0] })));
    console.log('validation against publisher sizes:', JSON.stringify(validation));

    // 2. the unsized sets
    const missing = usable.filter(e => !e.realSizeM && !prior?.sets[e.id]).slice(0, Number(arg('limit') ?? Infinity));
    const estimated = await estimate(missing, 'unsized');
    const doc: EstimatedSizes = {
        schema: 'scratchbox.texture-library-sizes/1',
        about: 'Real tile widths, metres, for library sets whose publisher gives no size: estimated by a vision model from each set\'s colour preview and publisher text (generated; scripts/estimate_texture_library_sizes.ts). A publisher size always wins. validation: the same estimate against sets whose publisher gives a size.',
        model: model || prior?.model || 'unknown', estimatedAt: new Date().toISOString(),
        validation,
        sets: Object.fromEntries([...Object.entries(prior?.sets ?? {}), ...estimated.entries()].sort((a, b) => a[0].localeCompare(b[0])))
    };
    fs.writeFileSync(file, JSON.stringify(doc, null, 1) + '\n');
    console.log(`wrote ${Object.keys(doc.sets).length} estimates (${estimated.size} new of ${missing.length} asked) to ${path.relative(root, file)}`);
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
