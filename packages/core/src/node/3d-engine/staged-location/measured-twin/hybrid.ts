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
import { inferWindowArrays } from '../pipeline-k/window-array';
import { fitWindowsForOrthos } from '../window-fit';
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
    ms: number;
}

/** Each step's time is kept; a step that needs a model and has none says so. */
export async function hybridInputs(refineDir: string, workDir: string, opts: { models?: InferModels; store?: ModelReadingStore; building?: NamedBuilding; streetView?: StreetViewSource; groundY: number; signal?: AbortSignal; progress?: (m: string) => void; readerPlanes?: number }): Promise<InferredInputs & { hybrid: HybridReport; orthosDir: string }> {
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
    const ask: FacadeAsk | undefined = opts.models ? async (png, prompt) => opts.models!.text(Array.isArray(png) ? png : [png], prompt) : undefined;
    // the window fit and the facade reader side by side, as pipeline K runs them
    opts.progress?.('hybrid: fitting and reading the windows');
    const tF = Date.now();
    const readP = ask ? readPlanes(k.orthosDir, ask, { params: { ...FACADE_READER_PARAMS, maxPlanes: opts.readerPlanes ?? HYBRID_READER_PLANES } as unknown as typeof FACADE_READER_PARAMS, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.building ? { building: opts.building } : {}), ...(opts.store ? { readings: { store: opts.store, model: FACADE_READER_MODEL_KEY } } : {}) }) : undefined;
    readP?.catch(() => undefined);
    const wf = await fitWindowsForOrthos(k.orthosDir, { ...(opts.signal ? { signal: opts.signal } : {}) });
    const count = () => wf.fit.facades.reduce((n, e) => n + ('rects' in e ? e.rects.length : 0), 0);
    const windowFit = { windows: count(), ms: Date.now() - tF };
    let reader: HybridReport['reader'];
    if (readP) {
        try {
            const fr = await readP;
            const m = mergeReadings(k.orthosDir, wf.fit, fr.records.readings).merged;
            const recs = fr.records.facades, by = (o: string) => recs.filter(x => x.outcome === o).length;
            const c = fr.records.calls as { calls?: number; reused?: number } | undefined;
            reader = { read: recs.length, replaced: by('replaced'), kept: by('kept'), readerWindows: m.readerWindows, calls: c?.calls ?? 0, reused: c?.reused ?? 0, ms: fr.records.ms };
        } catch (err) { reader = { reason: `the facade reader failed: ${err instanceof Error ? err.message : String(err)}` }; }
    } else reader = { reason: 'no vision model' };
    let system: BuildingSystem | undefined, sysRep: HybridReport['system'];
    if (ask) {
        try {
            const bs = await readBuildingSystem(k.orthosDir, ask, { ...(opts.building ? { building: opts.building } : {}), ...(opts.store ? { readings: { store: opts.store, model: FACADE_READER_MODEL_KEY } } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
            system = bs.system;
            sysRep = bs.system ? { conf: bs.system.conf, patterns: bs.system.patterns.length, regions: bs.system.regions.length } : { reason: bs.reason ?? 'no answer' };
        } catch (err) { sysRep = { reason: `the system read failed: ${err instanceof Error ? err.message : String(err)}` }; }
    } else sysRep = { reason: 'no vision model' };
    opts.progress?.('hybrid: laying the window arrays');
    const tA = Date.now();
    const frames = (JSON.parse(fs.readFileSync(path.join(k.orthosDir, 'facades.json'), 'utf8')) as { facades: Array<{ centroid: number[]; orthoTMax: number; axisT: number[] }> }).facades;
    const top = Math.max(...frames.map(f => f.centroid[1] + f.orthoTMax * f.axisT[1]));
    const wa = inferWindowArrays(k.orthosDir, wf.fit, undefined, { envelopeTopY: top, ...(system ? { system } : {}) });
    const array = { windows: count(), facades: wa.facades.length, ms: Date.now() - tA };
    // the twin's own inference on the same orthos: congruent copies, finishes, Street View base, relief
    opts.progress?.('hybrid: finishes, Street View base and relief');
    const inf = await inferFromSelfOrthos(k.orthosDir, { fit: wf.fit, groundY: opts.groundY, ...(opts.models ? { models: opts.models } : {}), ...(opts.store ? { store: opts.store } : {}), ...(opts.building ? { building: opts.building } : {}), ...(opts.streetView ? { streetView: opts.streetView } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
    const hybrid: HybridReport = { version: HYBRID_VERSION, orthos, windowFit, reader, system: sysRep, array, ms: Date.now() - t0 };
    fs.writeFileSync(path.join(workDir, 'hybrid_report.json'), JSON.stringify({ hybrid, infer: inf.report }, null, 1));
    return { ...inf, hybrid, orthosDir: k.orthosDir };
}
