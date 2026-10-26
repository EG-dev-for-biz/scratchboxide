/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Massing evaluation, step 1 (dev tool): every staged run in a worktree's cache that recorded a structure scan
 * (orchestrator.ts run note structure_scan), newest per place, with its roof photo rendered the way
 * execute_3d_python_script renders it (roofPhotoFor). Writes <out>/cases.json for massing-eval.py.
 *
 *   npx tsx scripts/dev/massing-eval-prep.ts <worktree> <out-dir>
 */

import * as fs from 'fs';
import * as path from 'path';
import { roofPhotoFor, type StructureScanNote } from '../../packages/core/src/node/gemini/tools/python-3d-tools';

const [root, out] = process.argv.slice(2);
if (!root || !out) { console.error('usage: massing-eval-prep.ts <worktree> <out-dir>'); process.exit(2); }
const runs = path.join(root, '.scratchbox', 'cache', 'staged_location', 'runs');
const byPlace = new Map<string, { runId: string; mtime: number; note: StructureScanNote & { place?: string } }>();
for (const runId of fs.existsSync(runs) ? fs.readdirSync(runs) : []) {
    const f = path.join(runs, runId, 'structure_scan.json');
    if (!fs.existsSync(f)) continue;
    const note = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!note.scanGlb || !fs.existsSync(note.scanGlb)) continue;
    const place = String(note.place ?? runId), mtime = fs.statSync(f).mtimeMs;
    const prev = byPlace.get(place);
    if (!prev || prev.mtime < mtime) byPlace.set(place, { runId, mtime, note });
}
fs.mkdirSync(out, { recursive: true });
const cases = [...byPlace.values()].map(({ runId, note }) => {
    let roof: ReturnType<typeof roofPhotoFor> | undefined;
    try { roof = roofPhotoFor(note); } catch (err) { console.warn(`${note.place}: no roof photo (${(err as Error).message})`); }
    return { runId, place: note.place, scanGlb: note.scanGlb, districtGlb: note.districtGlb, groundY: note.groundY, plan: note.plan, planSource: note.planSource, roofPhoto: roof?.path, roofFrame: roof?.frame };
});
fs.writeFileSync(path.join(out, 'cases.json'), JSON.stringify(cases, null, 1));
console.log(`${cases.length} cases: ${cases.map(c => c.place).join('; ')}`);
