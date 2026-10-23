/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G's building brief: everything a G build measured, read and rendered about one building, written beside it for
 * whoever works on the building next (the chat model with its tools, a script, a person): the massing parts (footprint
 * loops, heights, roof planes) and the objects on the roof; every wall and roof face with its frame; the facades grouped
 * from a footprint's piers; every survey station's pose and its render; every wall plate (colour and relief images, the
 * reading of it and how well that reading fits it, and, for a wall still weak after its re-read, a search-grounded
 * reference of it drawn from what Google Search found, with its two models' accounts and sources: references.ts); the
 * roof plate; the build's own GLBs. All coordinates are the tile frame (x east, y up, z south, metres); a face's point is
 * origin + s * axisS + t * axisT. The brief says what each part is (measured, read, generated) and never claims more.
 *
 * `.scratchbox/cache`, where the rest of a staged build's working files live, is one of the chat tools' IGNORED_DIRS
 * (workspace-tools.ts): workspace_view_file and workspace_view_image refuse anything under it. A brief written there is
 * invisible to the very tools it exists for. When `publicDir` is given, every image the brief would otherwise point into
 * the cache with (station renders, plate colour and relief images, the roof plate, a search-grounded reference) is copied
 * there instead, and brief.json itself is written there, not in the cache: public/, like public/models (massing-glb.ts's
 * published GLBs), is outside IGNORED_DIRS. Without `publicDir` (tests, a caller that reads the brief another way) the
 * cache-dir behaviour is unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Massing } from '../pipeline-e/massing-spec';
import type { MassingFace } from '../pipeline-e/native-massing';
import type { StepRecord } from '../pipeline-e/inference';
import type { ReadingCheck } from './check';
import type { FacadeGroup } from './facades';
import type { FacadeProgram } from './read';
import type { RoofObject } from './roof-objects';
import type { GStation } from './stations';
import { LEDGER_SCHEMA, type LedgerEntry } from '../pipeline-h/ledger';

export const BRIEF_SCHEMA = 'scratchbox.building-brief/1';

export interface BuildingBriefRecord {
    /** The brief's JSON, under `publicDir` when given (so workspace_view_file can open it), else under `dir`. */
    path: string;
    /** Survey photographs, plates, the roof plate and any weak-wall references written with it, alongside the JSON. */
    images: number;
}

/**
 * JSON that only breaks a value onto multiple lines when its single-line form would run past COMPACT_WIDTH characters:
 * plain JSON.stringify(v, null, 1) puts every number of every coordinate pair on its own line, which turned this file
 * into 7,800+ lines for one building, too many for workspace_view_file to read in a couple of calls. Any value short
 * enough (a vector, a face's frame, often a whole small object) stays on one line in its ordinary compact form; only a
 * value that does not fit is expanded, one line per element or property, each tried compact again in turn.
 */
export const COMPACT_WIDTH = 320;
export function compactJson(value: unknown, indent = 0): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    const flat = JSON.stringify(value);
    if (flat.length <= COMPACT_WIDTH) return flat;
    const pad = '  '.repeat(indent), padIn = '  '.repeat(indent + 1);
    if (Array.isArray(value)) {
        if (!value.length) return '[]';
        return `[\n${value.map(v => `${padIn}${compactJson(v, indent + 1)}`).join(',\n')}\n${pad}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (!entries.length) return '{}';
    return `{\n${entries.map(([k, v]) => `${padIn}${JSON.stringify(k)}: ${compactJson(v, indent + 1)}`).join(',\n')}\n${pad}}`;
}

/**
 * Copies `src` into `dir` (its own basename; a second file of the same name gets a short suffix so nothing is
 * overwritten) and returns the copy's path; `src` unchanged if it does not exist or `dir` is not given, so a missing or
 * not-yet-wired image never breaks the rest of the brief.
 */
function publish(src: string, dir: string | undefined, used: Set<string>): string {
    if (!src || !dir) return src;
    try {
        if (!fs.existsSync(src)) return src;
        fs.mkdirSync(dir, { recursive: true });
        const ext = path.extname(src), base = path.basename(src, ext);
        let name = `${base}${ext}`, n = 1;
        while (used.has(name)) name = `${base}_${++n}${ext}`;
        used.add(name);
        const out = path.join(dir, name);
        fs.copyFileSync(src, out);
        return out;
    } catch {
        return src;
    }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const v3 = (v: readonly number[]) => v.map(r3);
const faceRecord = (f: MassingFace) => ({
    key: f.key, kind: f.kind, part: f.part, origin: v3(f.origin), axisS: v3(f.axisS), axisT: v3(f.axisT), normal: v3(f.normal),
    sMin: r3(f.sMin), sMax: r3(f.sMax), tMin: r3(f.tMin), tMax: r3(f.tMax), areaM2: r3(f.area)
});

export function writeBuildingBrief(input: {
    dir: string; place: string; groundY: number;
    /** Where brief.json and its images are published so workspace_view_file / workspace_view_image can reach them (see the module comment); omit to write into `dir` as before. */
    publicDir?: string;
    massing: Pick<Massing, 'parts'>; roofObjects: RoofObject[];
    builtFaces: MassingFace[]; facades: FacadeGroup[];
    stations: GStation[]; renders: Array<{ station: number; file: string }>;
    plates: Array<{
        key: string; face: MassingFace; coverage: number; widthM: number; heightM: number; colour: string; relief: string; program?: FacadeProgram; check?: ReadingCheck;
        /** A search-grounded reference for a wall still weak after its re-read (references.ts); never a measurement. */
        references?: Array<{ model: string; image: string; account: string; queries: string[]; sources: Array<{ title?: string; uri?: string }> }>;
    }>;
    roofPlates: Array<{ key: string; coverage: number; colour: string }>;
    files: { clayGlb: string; texturedGlb: string };
    steps: StepRecord[];
    /** The evidence ledger (pipeline-h/ledger.ts): every decision between sources, with the candidates not taken. */
    ledger?: LedgerEntry[];
}): BuildingBriefRecord {
    fs.mkdirSync(input.dir, { recursive: true });
    const used = new Set<string>();
    const pub = (src: string) => publish(src, input.publicDir, used);
    const renderOf = new Map(input.renders.map(r => [r.station, pub(r.file)]));
    const brief = {
        schema: BRIEF_SCHEMA,
        place: input.place,
        frame: 'tile frame: x east, y up, z south, metres; a face point is origin + s * axisS + t * axisT',
        groundY: r3(input.groundY),
        how: 'Massing parts and faces are the vector footprint at the heights the scan and Google Solar measure (vector-modelled); roof objects are fitted to the scan (scan-fitted); plates are station renders of the photo tiles laid onto each face in metres; readings are what a vision model read off a plate (photo-inferred), with how much of the plate they explain; nothing here is a photograph of the real building except through the tiles.',
        massing: input.massing.parts.map(p => ({ id: p.id, baseY: r3(p.baseY), topY: r3(p.topY), loops: p.loops.map(l => l.map(([x, z]) => [r3(x), r3(z)])), roofPlanes: p.planes.map(q => ({ y: `${r3(q.a)} + ${r3(q.b)} * x + ${r3(q.c)} * z`, tag: q.tag })) })),
        roofObjects: input.roofObjects.map(o => ({ id: o.part.id, verdict: o.verdict, outline: o.part.loops[0].map(([x, z]) => [r3(x), r3(z)]), baseY: r3(o.part.baseY), topY: r3(o.part.topY), roofPlanes: o.planes, note: o.reason })),
        faces: input.builtFaces.filter(f => f.kind === 'wall' || f.kind === 'roof').map(faceRecord),
        facades: input.facades.map(g => ({ key: g.face.key, members: g.members.map(m => m.key), widthM: r3(g.face.sMax - g.face.sMin), heightM: r3(g.face.tMax - g.face.tMin), face: faceRecord(g.face) })),
        stations: input.stations.map(s => ({ name: s.station.name, row: s.row, face: s.face, position: v3(s.station.positionLocalENU), forward: v3(s.station.forwardVector), distanceM: s.distanceM, render: renderOf.get(s.station.id) })),
        plates: input.plates.map(p => ({
            key: p.key, face: faceRecord(p.face), coverage: r3(p.coverage), widthM: r3(p.widthM), heightM: r3(p.heightM), colourImage: pub(p.colour), reliefImage: pub(p.relief),
            imageFrame: 'u = metres from the left edge, h = metres up from the bottom edge, 0.05 m per pixel; relief: warm stands proud of the face, cool sets back, black unseen',
            ...(p.program ? { reading: p.program } : {}), ...(p.check ? { readingFit: { explains: p.check.explained, lift: p.check.lift, weak: p.check.weak } } : {}),
            ...(p.references?.length ? { searchGroundedReferences: { note: 'Drawn by an image model from what Google Search found for this wall; a reference for detail the survey could not read, never a measurement. Use what the references agree on and the scan does not contradict.', references: p.references.map(r => ({ ...r, image: pub(r.image) })) } } : {})
        })),
        roofPlates: input.roofPlates.map(p => ({ key: p.key, coverage: r3(p.coverage), colourImage: pub(p.colour) })),
        build: { clayGlb: input.files.clayGlb, texturedGlb: input.files.texturedGlb, note: 'pipeline G\'s build: sb.read_glb reads it into meshes a script can add to' },
        steps: input.steps.map(s => ({ step: s.step, accepted: s.accepted, proposed: s.proposed, ...(s.skipped ? { skipped: s.skipped } : {}), notes: s.notes.slice(0, 12) })),
        ...(input.ledger ? { ledger: { schema: LEDGER_SCHEMA, entries: input.ledger } } : {})
    };
    const file = path.join(input.publicDir ?? input.dir, 'brief.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, compactJson(brief));
    const images = input.renders.length + input.plates.length * 2 + input.roofPlates.length + input.plates.reduce((a, p) => a + (p.references?.length ?? 0), 0);
    return { path: file, images };
}
