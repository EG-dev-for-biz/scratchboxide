/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade reader's view of the whole building (facade-reader.ts): before any plane is read, the largest planes are laid
 * out on one contact sheet, each cell named by its row and column and described by where it stands (its facing, its size,
 * its height above the lowest plane), and the vision model writes a brief: the building in a few sentences, and its
 * FAMILIES, the planes that carry one window system (the four faces of a tower's shaft, the bays of one setback level).
 * Every later reading of a plane is told the brief, its family's system and where the plane stands, so it reads the plane
 * as a part of this building, not as a stranger; and a family's planes can share what one of them was read to hold
 * (facade-reader-template.ts). The brief is context and grouping only: what is drawn still comes from each plane's photo.
 */

import * as fs from 'fs';
import * as path from 'path';
import { decodePng } from '../../../texture-processing';
import { encodePng } from '../png-encode';

/** Where a plane stands, from its frame: what the brief and every reading are told. */
export interface PlanePlace {
    facadeId: number; kind: 'wall' | 'roof';
    /** The way its outside faces, as a compass bearing (0 north, 90 east), walls only. */
    bearingDeg?: number;
    widthM: number; heightM: number;
    /** Its bottom and top above the building's lowest plane (m). */
    bottomM: number; topM: number;
}

type PlaneFrameLike = { facadeId: number; kind?: string; image: string; width: number; height: number; pixel: number; centroid?: number[]; normal?: number[]; axisT?: number[]; tMin?: number; tMax?: number };

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const compassOf = (deg: number) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

/** Each plane's place. The local frame is x east, y up, z south (LocalTangentPlane), so a normal (x, y, z) faces bearing atan2(x, -z). */
export function planePlaces(frames: PlaneFrameLike[]): Map<number, PlanePlace> {
    const heights = frames.map(f => {
        const c = f.centroid ?? [0, 0, 0], up = f.axisT ?? [0, 1, 0];
        const a = c[1] + up[1] * (f.tMin ?? 0), b = c[1] + up[1] * (f.tMax ?? 0);
        return [Math.min(a, b), Math.max(a, b)] as [number, number];
    });
    const ground = Math.min(...heights.map(h => h[0]));
    const out = new Map<number, PlanePlace>();
    frames.forEach((f, i) => {
        const n = f.normal ?? [0, 1, 0], roof = f.kind === 'roof' || Math.abs(n[1]) > 0.9;
        const bearing = roof ? undefined : Math.round(((Math.atan2(n[0], -n[2]) * 180) / Math.PI + 360) % 360);
        out.set(f.facadeId, {
            facadeId: f.facadeId, kind: roof ? 'roof' : 'wall', ...(bearing !== undefined ? { bearingDeg: bearing } : {}),
            widthM: Math.round(f.width * f.pixel * 10) / 10, heightM: Math.round(f.height * f.pixel * 10) / 10,
            bottomM: Math.round(heights[i][0] - ground), topM: Math.round(heights[i][1] - ground)
        });
    });
    return out;
}

export const describePlace = (p: PlanePlace) => p.kind === 'roof'
    ? `a roof or terrace ${p.widthM} m by ${p.heightM} m, ${p.topM} m above the building's lowest plane`
    : `a wall facing ${compassOf(p.bearingDeg!)} (${p.bearingDeg} degrees), ${p.widthM} m wide and ${p.heightM} m tall, from ${p.bottomM} m to ${p.topM} m above the building's lowest plane`;

export const BRIEF_PARAMS = {
    /** Planes on the contact sheet at most: the walls first, each the largest covered area first. */
    maxCells: 40,
    /** Columns of the sheet, and each cell's box (px) a plane is scaled into (its aspect kept). */
    columns: 8, cellW: 220, cellH: 320, gutter: 10
} as const;

export interface ContactSheet { png: Buffer; width: number; height: number; cells: Array<{ cell: string; facadeId: number }> }

/** The planes' photos laid out on one sheet on white, each in its own cell, row by row; uncovered areas stay as the photo has them. */
export function contactSheet(orthosDir: string, frames: PlaneFrameLike[], P = BRIEF_PARAMS): ContactSheet {
    const picked = frames.slice(0, P.maxCells);
    const cols = Math.min(P.columns, picked.length), rows = Math.ceil(picked.length / Math.max(1, cols));
    const W = cols * (P.cellW + P.gutter) + P.gutter, H = rows * (P.cellH + P.gutter) + P.gutter;
    const out = new Uint8Array(W * H * 4).fill(255);
    const cells: ContactSheet['cells'] = [];
    picked.forEach((f, k) => {
        const r = Math.floor(k / cols), c = k % cols;
        cells.push({ cell: `r${r + 1}c${c + 1}`, facadeId: f.facadeId });
        const img = decodePng(fs.readFileSync(path.join(orthosDir, f.image)));
        const s = Math.min(P.cellW / img.width, P.cellH / img.height);
        const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
        const ox = P.gutter + c * (P.cellW + P.gutter) + Math.floor((P.cellW - w) / 2), oy = P.gutter + r * (P.cellH + P.gutter) + (P.cellH - h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const sx = Math.min(img.width - 1, Math.floor(x / s)), sy = Math.min(img.height - 1, Math.floor(y / s)), p = (sy * img.width + sx) * 4, q = ((oy + y) * W + ox + x) * 4;
            if (img.rgba[p + 3] === 0) { out[q] = out[q + 1] = out[q + 2] = 128; continue; }
            out[q] = img.rgba[p]; out[q + 1] = img.rgba[p + 1]; out[q + 2] = img.rgba[p + 2];
        }
    });
    return { png: encodePng(W, H, out, 4), width: W, height: H, cells };
}

/** The building the request named: what the brief and every reading are told it is. */
export interface NamedBuilding { name: string; address?: string }
const named = (b: NamedBuilding) => `${b.name}${b.address && b.address !== b.name ? ` (${b.address})` : ''}`;

export function briefPrompt(cells: ContactSheet['cells'], places: Map<number, PlanePlace>, building?: NamedBuilding): string {
    return [
        ...(building ? [`These are the surfaces of ${named(building)}: use what you know of it, and what the photos show.`] : []),
        'This sheet shows the surfaces of ONE building, each photographed straight on and straightened from a 3D scan, each in its own cell (cells are not to one scale; uniform grey or black is not covered by the photo). The cells, row by row:',
        ...cells.map(c => `- ${c.cell}: ${describePlace(places.get(c.facadeId)!)}`),
        'Read the building as an architect would. Give "building": two or three sentences on it (its style, its tiers or setbacks, what its walls and openings are made of).',
        'Then group the cells into FAMILIES: cells that carry the same window system (the same kind, size and spacing of openings, at the same storey height), such as the faces of one tower shaft or the bays of one setback level. Prefer more, smaller families: never put together cells whose openings differ in size, spacing or grouping, or that stand at different tiers or heights; a cell may stand alone. For each family give "name" (a few words), "cells" (its cell names), "openings": one sentence on its windows (width, panes, how they pair or group, what lies between them), and "storeyM": its storey height in metres if you can tell.',
        'Also give "conf": 0..100.',
        'Answer with JSON only: {"building":"...","families":[{"name":"...","cells":["r1c1"],"openings":"...","storeyM":3.6}],"conf":0}'
    ].join('\n');
}

export interface PlaneFamily { name: string; planes: number[]; openings?: string; storeyM?: number }
export interface BuildingBrief { building: string; families: PlaneFamily[]; conf: number }

/** Parses and checks a brief; cells name the sheet's planes (an unknown cell is dropped; a plane is in one family at most). Throws on anything malformed. */
export function parseBrief(text: string, cells: ContactSheet['cells'] = []): BuildingBrief {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('the reply holds no JSON object');
    const j = JSON.parse(text.slice(a, b + 1));
    if (typeof j?.building !== 'string' || !Array.isArray(j.families)) throw new Error('the reply has no "building" or no "families" list');
    const byCell = new Map(cells.map(c => [c.cell.toLowerCase(), c.facadeId]));
    const taken = new Set<number>(), families: PlaneFamily[] = [];
    for (const f of j.families) {
        if (typeof f?.name !== 'string' || !Array.isArray(f.cells)) throw new Error('a family without a "name" or "cells"');
        const planes = (f.cells as unknown[]).flatMap(c => { const id = typeof c === 'string' ? byCell.get(c.trim().toLowerCase()) : undefined; return id !== undefined && !taken.has(id) ? (taken.add(id), [id]) : []; });
        if (!planes.length && cells.length) continue;
        const storey = typeof f.storeyM === 'number' && Number.isFinite(f.storeyM) && f.storeyM > 1.5 && f.storeyM < 12 ? f.storeyM : undefined;
        families.push({ name: f.name.slice(0, 60), planes, ...(typeof f.openings === 'string' ? { openings: f.openings.slice(0, 300) } : {}), ...(storey ? { storeyM: Math.round(storey * 100) / 100 } : {}) });
    }
    const conf = typeof j.conf === 'number' && Number.isFinite(j.conf) ? Math.max(0, Math.min(100, j.conf)) : 50;
    return { building: j.building.slice(0, 600), families, conf };
}

/** What a reading of this plane is told about the building: the brief, its family's system and where it stands. */
export function contextFor(brief: BuildingBrief | undefined, place: PlanePlace | undefined, family: PlaneFamily | undefined, building?: NamedBuilding): string {
    if (!brief && !place && !building) return '';
    return [
        'Building context (to read this plane as part of its building; draw only what this photo shows):',
        ...(building ? [`- It is ${named(building)}.`] : []),
        ...(brief ? [`- The building: ${brief.building}`] : []),
        ...(place ? [`- This plane: ${describePlace(place)}.`] : []),
        ...(family ? [`- It belongs to the family "${family.name}" (${family.planes.length} planes)${family.openings ? `, whose openings are: ${family.openings}` : ''}${family.storeyM ? `; storeys about ${family.storeyM} m` : ''}.`] : [])
    ].join('\n');
}
