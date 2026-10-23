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
 * reading of it and how well that reading fits it); the roof plate; the build's own GLBs. All coordinates are the tile
 * frame (x east, y up, z south, metres); a face's point is origin + s * axisS + t * axisT. The brief says what each part
 * is (measured, read, generated) and never claims more.
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

export const BRIEF_SCHEMA = 'scratchbox.building-brief/1';

export interface BuildingBriefRecord {
    /** The brief's JSON. */
    path: string;
    /** Survey photographs, plates and the roof plate written with it. */
    images: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const v3 = (v: readonly number[]) => v.map(r3);
const faceRecord = (f: MassingFace) => ({
    key: f.key, kind: f.kind, part: f.part, origin: v3(f.origin), axisS: v3(f.axisS), axisT: v3(f.axisT), normal: v3(f.normal),
    sMin: r3(f.sMin), sMax: r3(f.sMax), tMin: r3(f.tMin), tMax: r3(f.tMax), areaM2: r3(f.area)
});

export function writeBuildingBrief(input: {
    dir: string; place: string; groundY: number;
    massing: Pick<Massing, 'parts'>; roofObjects: RoofObject[];
    builtFaces: MassingFace[]; facades: FacadeGroup[];
    stations: GStation[]; renders: Array<{ station: number; file: string }>;
    plates: Array<{ key: string; face: MassingFace; coverage: number; widthM: number; heightM: number; colour: string; relief: string; program?: FacadeProgram; check?: ReadingCheck }>;
    roofPlates: Array<{ key: string; coverage: number; colour: string }>;
    files: { clayGlb: string; texturedGlb: string };
    steps: StepRecord[];
}): BuildingBriefRecord {
    fs.mkdirSync(input.dir, { recursive: true });
    const renderOf = new Map(input.renders.map(r => [r.station, r.file]));
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
        plates: input.plates.map(p => ({ key: p.key, face: faceRecord(p.face), coverage: r3(p.coverage), widthM: r3(p.widthM), heightM: r3(p.heightM), colourImage: p.colour, reliefImage: p.relief, imageFrame: 'u = metres from the left edge, h = metres up from the bottom edge, 0.05 m per pixel; relief: warm stands proud of the face, cool sets back, black unseen', ...(p.program ? { reading: p.program } : {}), ...(p.check ? { readingFit: { explains: p.check.explained, lift: p.check.lift, weak: p.check.weak } } : {}) })),
        roofPlates: input.roofPlates.map(p => ({ key: p.key, coverage: r3(p.coverage), colourImage: p.colour })),
        build: { clayGlb: input.files.clayGlb, texturedGlb: input.files.texturedGlb, note: 'pipeline G\'s build: sb.read_glb reads it into meshes a script can add to' },
        steps: input.steps.map(s => ({ step: s.step, accepted: s.accepted, proposed: s.proposed, ...(s.skipped ? { skipped: s.skipped } : {}), notes: s.notes.slice(0, 12) }))
    };
    const file = path.join(input.dir, 'brief.json');
    fs.writeFileSync(file, JSON.stringify(brief, null, 1));
    const images = input.renders.length + input.plates.length * 2 + input.roofPlates.length;
    return { path: file, images };
}
