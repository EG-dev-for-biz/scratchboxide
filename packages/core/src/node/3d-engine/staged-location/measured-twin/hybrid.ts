/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The hybrid twin's inputs (docs/research/2026-11-08-hybrid-twin-plan.md): pipeline K's detail stages run on the cut-out
 * scan's own facade orthos (tile_refine's relief_orthos), without the rest of pipeline K. A fresh copy of the orthos is
 * straightened and levelled (rectifyReliefOrthos), its windows fitted (window-fit.ts) and read by the facade reader on
 * the straightened photos (its families' lead planes read, siblings by template), the two merged (mergeReadings), the
 * building's system read once (building-system.ts) and every facade brought onto its array (window-array.ts). Then the
 * twin's own inference (infer.ts) adds congruent copies, finishes, Street View base and relief on the same orthos.
 * The procedural twin builds the shell from them (measured-twin.ts `hybrid`). K's lattice rebuild, polish and texture
 * stage are not run.
 */

import * as fs from 'fs';
import * as path from 'path';
import { mergeReadings, readPlanes, type FacadeAsk } from '../pipeline-k/facade-reader';
import { FACADE_READER_MODEL_KEY, FACADE_READER_PARAMS } from '../pipeline-k/facade-reader';
import type { NamedBuilding } from '../pipeline-k/facade-reader-brief';
import { readBuildingSystem, type BuildingSystem } from '../pipeline-k/building-system';
import type { ModelReadingStore } from '../pipeline-k/model-readings';
import { rectifyReliefOrthos } from '../pipeline-k/pipeline-k';
import { describeMirrorFill, describeMirrorWindows, mirrorFillOrthos, mirrorWindows, SYMMETRY_VERSION } from '../pipeline-k/symmetry';
import { inferWindowArrays } from '../pipeline-k/window-array';
import { fitWindowsForOrthos } from '../window-fit';
import { decodePng } from '../../../texture-processing';
import { encodePng } from '../png-encode';
import { inferFromSelfOrthos, type InferModels, type InferredInputs, type StreetViewSource } from './infer';

export const HYBRID_VERSION = 'measured-twin-hybrid/1';

/** The facade reader reads at most this many planes (the largest walls first); the building's system and the arrays carry the rest (ESB, cold: 120 planes cost 170 calls). */
export const HYBRID_READER_PLANES = 24;

export interface HybridReport {
    version: string;
    orthos: { facades: number; rectified: number; ms: number };
    windowFit: { windows: number; ms: number };
    reader?: { read: number; replaced: number; kept: number; readerWindows: number; calls: number; reused: number; ms: number } | { reason: string };
    system?: { conf: number; patterns: number; regions: number } | { reason: string };
    array: { windows: number; facades: number; ms: number };
    /** Pipeline K's symmetry (symmetry.ts): unread texels filled from each facade's mirror (generated), then the reader's windows confirmed or filled at their mirror sites. */
    symmetry?: { version: string; fill: string; windows?: string; /** Mirror-filled texels the twin's texture may draw (its photo masks count them covered; the window fit still reads them as unread). */ textureTexels?: number; ms: number } | { reason: string };
    ms: number;
}

/** Each step's time is kept; a step that needs a model and has none says so. */
export async function hybridInputs(refineDir: string, workDir: string, opts: { models?: InferModels; store?: ModelReadingStore; building?: NamedBuilding; streetView?: StreetViewSource; groundY: number; signal?: AbortSignal; progress?: (m: string) => void; readerPlanes?: number; /** The cut-out scan (any GLB of its geometry): with it, pipeline K's symmetry fills and confirms (symmetry.ts). */ symmetryScan?: string }): Promise<InferredInputs & { hybrid: HybridReport; orthosDir: string }> {
    const t0 = Date.now();
    const src = path.join(refineDir, 'relief_orthos');
    if (!fs.existsSync(path.join(src, 'facades.json'))) throw new Error(`the cut-out wrote no facade orthos (${src}); the hybrid needs them`);
    // a fresh copy, so nothing a pipeline K run left beside the originals is reused
    const copy = path.join(workDir, 'relief_orthos');
    for (const d of fs.existsSync(workDir) ? fs.readdirSync(workDir) : []) if (d.startsWith('relief_orthos')) fs.rmSync(path.join(workDir, d), { recursive: true, force: true });
    fs.mkdirSync(copy, { recursive: true });
    for (const f of fs.readdirSync(src)) if (fs.statSync(path.join(src, f)).isFile()) fs.copyFileSync(path.join(src, f), path.join(copy, f));
    opts.progress?.('hybrid: straightening the facade photos');
    const tR = Date.now();
    const k = await rectifyReliefOrthos(copy, { ...(opts.signal ? { signal: opts.signal } : {}) });
    const orthos = { facades: k.reports.length, rectified: k.reports.filter(r => r.report).length, ms: Date.now() - tR };
    // pipeline K's symmetry, step 2: each facade's unread texels filled from its own mirror or a twin facade's, on a clone of
    // the orthos every later step reads (generated; the photo around a region must agree with its mirror)
    let orthosDir = k.orthosDir, symReport: Awaited<ReturnType<typeof mirrorFillOrthos>>['report'] | undefined, symmetry: HybridReport['symmetry'];
    const tS = Date.now();
    if (opts.symmetryScan) {
        opts.progress?.('hybrid: reading the building\'s symmetry');
        try {
            const filled = await mirrorFillOrthos(k.orthosDir, k.key, { scanGlb: opts.symmetryScan, groundY: opts.groundY, footprint: [] }, { ...(opts.signal ? { signal: opts.signal } : {}) });
            orthosDir = filled.orthosDir; symReport = filled.report;
            symmetry = { version: SYMMETRY_VERSION, fill: describeMirrorFill(filled.report), ms: Date.now() - tS };
        } catch (err) { if (opts.signal?.aborted) throw err; symmetry = { reason: `the symmetry step failed: ${err instanceof Error ? err.message : String(err)}` }; }
    } else symmetry = { reason: 'no scan given' };
    const ask: FacadeAsk | undefined = opts.models ? async (png, prompt) => opts.models!.text(Array.isArray(png) ? png : [png], prompt) : undefined;
    // the window fit and the facade reader side by side, as pipeline K runs them
    opts.progress?.('hybrid: fitting and reading the windows');
    const tF = Date.now();
    const readP = ask ? readPlanes(orthosDir, ask, { params: { ...FACADE_READER_PARAMS, maxPlanes: opts.readerPlanes ?? HYBRID_READER_PLANES } as unknown as typeof FACADE_READER_PARAMS, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.building ? { building: opts.building } : {}), ...(opts.store ? { readings: { store: opts.store, model: FACADE_READER_MODEL_KEY } } : {}) }) : undefined;
    readP?.catch(() => undefined);
    const wf = await fitWindowsForOrthos(orthosDir, { ...(opts.signal ? { signal: opts.signal } : {}) });
    const count = () => wf.fit.facades.reduce((n, e) => n + ('rects' in e ? e.rects.length : 0), 0);
    const windowFit = { windows: count(), ms: Date.now() - tF };
    let reader: HybridReport['reader'];
    if (readP) {
        try {
            const fr = await readP;
            const m = mergeReadings(orthosDir, wf.fit, fr.records.readings).merged;
            const recs = fr.records.facades, by = (o: string) => recs.filter(x => x.outcome === o).length;
            const c = fr.records.calls as { calls?: number; reused?: number } | undefined;
            reader = { read: recs.length, replaced: by('replaced'), kept: by('kept'), readerWindows: m.readerWindows, calls: c?.calls ?? 0, reused: c?.reused ?? 0, ms: fr.records.ms };
        } catch (err) { reader = { reason: `the facade reader failed: ${err instanceof Error ? err.message : String(err)}` }; }
    } else reader = { reason: 'no vision model' };
    let system: BuildingSystem | undefined, sysRep: HybridReport['system'];
    if (ask) {
        try {
            const bs = await readBuildingSystem(orthosDir, ask, { ...(opts.building ? { building: opts.building } : {}), ...(opts.store ? { readings: { store: opts.store, model: FACADE_READER_MODEL_KEY } } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
            system = bs.system;
            sysRep = bs.system ? { conf: bs.system.conf, patterns: bs.system.patterns.length, regions: bs.system.regions.length } : { reason: bs.reason ?? 'no answer' };
        } catch (err) { sysRep = { reason: `the system read failed: ${err instanceof Error ? err.message : String(err)}` }; }
    } else sysRep = { reason: 'no vision model' };
    opts.progress?.('hybrid: laying the window arrays');
    const tA = Date.now();
    const frames = (JSON.parse(fs.readFileSync(path.join(orthosDir, 'facades.json'), 'utf8')) as { facades: Array<{ centroid: number[]; orthoTMax: number; axisT: number[] }> }).facades;
    const top = Math.max(...frames.map(f => f.centroid[1] + f.orthoTMax * f.axisT[1]));
    const wa = inferWindowArrays(orthosDir, wf.fit, undefined, { envelopeTopY: top, ...(system ? { system } : {}) });
    const array = { windows: count(), facades: wa.facades.length, ms: Date.now() - tA };
    // the reader's windows confirm or fill their mirror sites (unread sites only), after the array as pipeline K runs it
    if (symReport && symmetry && 'fill' in symmetry) {
        try { symmetry.windows = describeMirrorWindows(mirrorWindows(orthosDir, wf.fit, symReport)); } catch (err) { symmetry.windows = `the mirror windows failed: ${err instanceof Error ? err.message : String(err)}`; }
    }
    // the twin's own inference on the same orthos: congruent copies, finishes, Street View base, relief
    opts.progress?.('hybrid: finishes, Street View base and relief');
    const inf = await inferFromSelfOrthos(orthosDir, { fit: wf.fit, groundY: opts.groundY, ...(opts.models ? { models: opts.models } : {}), ...(opts.store ? { store: opts.store } : {}), ...(opts.building ? { building: opts.building } : {}), ...(opts.streetView ? { streetView: opts.streetView } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
    // the mirror-filled texels count as covered for the twin's texture only (its photo masks), labelled generated by the
    // fill; the window fit, reader and arrays above read the rectifier's own mask, as pipeline K's do
    if (symmetry && 'fill' in symmetry) {
        let freed = 0;
        const fj = JSON.parse(fs.readFileSync(path.join(orthosDir, 'facades.json'), 'utf8')) as { facades: Array<{ facadeId: number; image: string; mirrorMask?: string }> };
        for (const f of fj.facades) {
            const ph = inf.photos[f.facadeId];
            if (!f.mirrorMask || !ph?.mask || !fs.existsSync(path.join(orthosDir, f.mirrorMask))) continue;
            const unc = decodePng(fs.readFileSync(ph.mask)), mir = decodePng(fs.readFileSync(path.join(orthosDir, f.mirrorMask)));
            if (unc.width !== mir.width || unc.height !== mir.height) continue;
            const out = new Uint8Array(unc.width * unc.height);
            for (let i = 0; i < out.length; i++) { const u = unc.rgba[i * 4] >= 128, m = mir.rgba[i * 4] >= 128; out[i] = u && !m ? 255 : 0; if (u && m) freed++; }
            const file = ph.mask.replace(/\.png$/, '_sym.png');
            fs.writeFileSync(file, encodePng(unc.width, unc.height, out, 1));
            ph.mask = file;
        }
        symmetry.textureTexels = freed;
    }
    const hybrid: HybridReport = { version: HYBRID_VERSION, orthos, windowFit, reader, system: sysRep, array, ...(symmetry ? { symmetry } : {}), ms: Date.now() - t0 };
    fs.writeFileSync(path.join(workDir, 'hybrid_report.json'), JSON.stringify({ hybrid, infer: inf.report }, null, 1));
    return { ...inf, hybrid, orthosDir: orthosDir };
}
