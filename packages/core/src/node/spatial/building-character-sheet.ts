/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Building-survey character sheet: four survey stations of one isolated structure, rendered and laid out as a 2x2 sheet
 * on white, made photorealistic by ONE image-model call at 4K (Nano Banana 2) so every view shows the same building in
 * the same colours, then split back into the four station frames. Each panel is checked like a beautified station: the
 * edge-alignment QC (the camera did not move) and the scan-outline check (nothing drawn outside the scan, nothing cut
 * short, subject wholly in frame) and the colour gate (checkPanelColour: the material keeps the tile photos' hue and
 * chroma), and the sheet itself must carry no dividing lines or borders (checkSheetBorders). The
 * sheet is accepted only when all of that passes; otherwise it is generated again.
 */

import type { ColmapCameraPose } from '../../common/spatial/colmap-vector-reference-types';
import { buildCharacterSheetPrompt } from '../../browser/generative-canvas/services/location-beautify-service';
import { decodePng, encodePng } from '../texture-processing';
import { SurveyStationRenderService, type StationBlockoutRender } from './SurveyStationRenderService';
import { BeautifyStationService, checkStationOutline, srgbToLab, toStationImageAnswer, type BeautifyQc, type OutlineLimits, type StationImageGenerator } from './BeautifyStationService';

export interface CharacterSheetOptions {
    /** Width of one panel (default 1920); the panel height follows the stations' aspect, the sheet is 2 x 2 panels. */
    panelWidth?: number;
    /** Reference render: the GLB's tile photos (default) or studio clay. */
    renderMode?: 'textured' | 'clay';
    glbPath?: string;
    /** Further sheets after a rejected one (default 2). */
    maxRerolls?: number;
    outline?: OutlineLimits;
    /** Colour gate threshold (MAX_PANEL_COLOUR_SHIFT by default). */
    maxColourShift?: number;
    /** The colour gate fails panels (default true). Off, the colour is still measured and reported, but neither fails a panel nor ranks sheets. */
    colourGate?: boolean;
    /**
     * Sheets generated per round, in parallel (default 1). The best of them is kept: fewest failing panels, then the
     * smallest colour shift from the tile photos, then the smallest outline miss. One sheet is a high-variance draw (a
     * Haughwout repeat repainted the grey cast iron red brick, 2026-10-24); several give the gate something to choose from.
     */
    candidates?: number;
    /**
     * Ranks the sheets that pass every check by what they are for: e.g. pipeline H lays the panels on its wall plates,
     * reads them, and returns how much of each wall the reading explains times its edge precision. Higher is better.
     * Sheet checks only say a sheet is usable; two usable sheets can read very differently (Haughwout, 2026-10-24: 13-28 %
     * explained across accepted sheets). Without it the first accepted sheet is kept.
     */
    score?: (sheet: CharacterSheetResult) => Promise<{ value: number; detail?: unknown }>;
    /** With `score`: usable sheets to collect (within the round budget) before choosing between them (default 2). */
    keepAccepted?: number;
    /**
     * With `score`: a sheet with at most this many failing panels (and no dividing lines) is still usable and is scored
     * (default 0: only fully accepted sheets). Its failing panels are marked (qc.passed false), so the caller lays only the
     * passing ones. Few whole sheets pass (10-17 % on Haughwout, most of the rest on one drifting panel), so the score
     * otherwise rarely has two sheets to choose between.
     */
    scoreMaxFailingPanels?: number;
    styleSuffix?: string;
    signal?: AbortSignal;
}

export interface CharacterSheetPanel {
    station: ColmapCameraPose;
    alignedStation: ColmapCameraPose;
    blockout: StationBlockoutRender;
    /** The panel cut from the sheet, resampled to the station frame. */
    imagePng: Buffer;
    qc: BeautifyQc;
    /** The colour gate (checkPanelColour); absent for a clay reference, which carries no colour to hold it to. */
    colour?: PanelColourCheck;
}

export interface PanelColourCheck {
    /** Median CIELAB of the structure in the tile-photo reference and in the generated panel. */
    referenceLab: [number, number, number];
    panelLab: [number, number, number];
    /** Hue/chroma shift: the distance between the two medians in the a/b plane (lightness is free to change). */
    shift: number;
    passed: boolean;
    reason?: string;
}

/**
 * Largest hue/chroma shift (CIELAB a/b distance) a panel may make from the tile photos' own colour. Even overcast light
 * neutralises the tiles' blue-purple cast by up to about 9 (Haughwout sheets that kept the grey cast iron: 0-8.9); the
 * sheet that repainted it red brick shifted its facades 14.9-16.8 (2026-10-24).
 */
export const MAX_PANEL_COLOUR_SHIFT = 10;

/**
 * The colour gate: the structure's median colour in a generated panel against its median colour in the tile-photo
 * reference render, over the reference's silhouette shrunk away from its edges. Lightness may change (de-lighting), hue
 * and chroma may not swing: a panel that repaints the material (grey cast iron as red brick) fails.
 */
export function checkPanelColour(reference: StationBlockoutRender, rgba: Buffer, width: number, height: number, maxShift = MAX_PANEL_COLOUR_SHIFT): PanelColourCheck {
    const W = reference.width, H = reference.height, r = Math.max(2, Math.round(W / 200)), step = Math.max(1, Math.round(W / 480));
    const inside = (x: number, y: number) => {
        for (const [dx, dy] of [[-r, 0], [r, 0], [0, -r], [0, r], [0, 0]]) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H || !reference.silhouette[yy * W + xx]) return false;
        }
        return true;
    };
    const ref: number[][] = [[], [], []], gen: number[][] = [[], [], []];
    for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
        if (!inside(x, y)) continue;
        const i = (y * W + x) * 4, gx = Math.min(width - 1, Math.floor((x + 0.5) * width / W)), gy = Math.min(height - 1, Math.floor((y + 0.5) * height / H)), j = (gy * width + gx) * 4;
        const a = srgbToLab(reference.rgba[i], reference.rgba[i + 1], reference.rgba[i + 2]), b = srgbToLab(rgba[j], rgba[j + 1], rgba[j + 2]);
        for (let c = 0; c < 3; c++) { ref[c].push(a[c]); gen[c].push(b[c]); }
    }
    const median = (v: number[]) => { if (!v.length) return NaN; const s = [...v].sort((p, q) => p - q); return s[s.length >> 1]; };
    const referenceLab = ref.map(median) as [number, number, number], panelLab = gen.map(median) as [number, number, number];
    const shift = Math.hypot(panelLab[1] - referenceLab[1], panelLab[2] - referenceLab[2]);
    if (!Number.isFinite(shift)) return { referenceLab, panelLab, shift: 0, passed: true, reason: 'no structure in the reference to compare colours over' };
    const passed = shift <= maxShift;
    return { referenceLab, panelLab, shift, passed, reason: passed ? undefined : `the colour swings ${shift.toFixed(1)} in hue/chroma from the tile photos (> ${maxShift}): the material was repainted` };
}

/** A line the model drew along a quadrant divider or the sheet's outer edge, though the prompt asks for none. */
export interface SheetBorderLine {
    band: 'vertical divider' | 'horizontal divider' | 'top edge' | 'bottom edge' | 'left edge' | 'right edge';
    /** Share of the band's length (where no structure reaches into it) that carries a line. */
    coverage: number;
}

export interface SheetBorderCheck {
    passed: boolean;
    lines: SheetBorderLine[];
    reason?: string;
}

/** Half-width of a border band, as a share of a quadrant's width. */
export const SHEET_BORDER_BAND = 0.01;
/** Luminance difference from the band's background that marks a line pixel (8-bit). */
export const SHEET_LINE_CONTRAST = 40;
/** A band is a drawn line when this share of its length carries one. */
export const SHEET_LINE_COVERAGE = 0.25;

/**
 * Dividing lines and borders on a returned sheet: along the two quadrant dividers and the four outer edges, a band
 * SHEET_BORDER_BAND wide each side is the background, except where a panel's own structure (its scan silhouette, grown
 * by the band) reaches into it. A position along the band carries a line when some pixel across the band differs from
 * the band's background luminance by SHEET_LINE_CONTRAST; a band whose positions carry one over SHEET_LINE_COVERAGE of
 * its free length is a drawn line, and the sheet fails.
 */
export function checkSheetBorders(rgba: Buffer, width: number, height: number, blockouts: StationBlockoutRender[]): SheetBorderCheck {
    const qw = width / 2, qh = height / 2;
    const b = Math.max(2, Math.round(SHEET_BORDER_BAND * qw));
    const lum = (x: number, y: number) => { const i = (y * width + x) * 4; return (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000; };
    // is there structure at sheet pixel (x, y), or within the band's reach of it?
    const structureNear = (x: number, y: number) => {
        const q = (x >= qw ? 1 : 0) + (y >= qh ? 2 : 0), bl = blockouts[q];
        if (!bl) return false;
        const sx = (x - (q % 2) * qw) * bl.width / qw, sy = (y - Math.floor(q / 2) * qh) * bl.height / qh;
        const r = 2 * b * bl.width / qw, step = Math.max(1, r / 3);
        for (let dy = -r; dy <= r; dy += step) for (let dx = -r; dx <= r; dx += step) {
            const px = Math.round(sx + dx), py = Math.round(sy + dy);
            if (px >= 0 && py >= 0 && px < bl.width && py < bl.height && bl.silhouette[py * bl.width + px]) return true;
        }
        return false;
    };
    const bands: Array<{ band: SheetBorderLine['band']; along: 'x' | 'y'; at: number }> = [
        { band: 'vertical divider', along: 'y', at: Math.round(qw) }, { band: 'horizontal divider', along: 'x', at: Math.round(qh) },
        { band: 'left edge', along: 'y', at: b }, { band: 'right edge', along: 'y', at: width - 1 - b },
        { band: 'top edge', along: 'x', at: b }, { band: 'bottom edge', along: 'x', at: height - 1 - b }
    ];
    const lines: SheetBorderLine[] = [];
    for (const bd of bands) {
        const len = bd.along === 'y' ? height : width, step = Math.max(1, Math.round(len / 600));
        const across = (t: number, o: number): [number, number] => bd.along === 'y' ? [Math.min(width - 1, Math.max(0, bd.at + o)), t] : [t, Math.min(height - 1, Math.max(0, bd.at + o))];
        // positions along the band that no structure reaches into: only there is the band background
        const freeAt: number[] = [];
        // (checked across the band's whole width: a divider band straddles two quadrants)
        for (let t = 0; t < len; t += step) if ([-b, 0, b].every(o => { const [x, y] = across(t, o); return !structureNear(x, y); })) freeAt.push(t);
        if (freeAt.length === 0) continue;
        const samples: number[] = [];
        for (const t of freeAt) for (let o = -b; o <= b; o += Math.max(1, b >> 2)) { const [x, y] = across(t, o); samples.push(lum(x, y)); }
        samples.sort((p, q) => p - q);
        const bg = samples[samples.length >> 1];
        let free = 0, hit = 0;
        for (const t of freeAt) {
            free++;
            for (let o = -b; o <= b; o++) { const [x, y] = across(t, o); if (Math.abs(lum(x, y) - bg) > SHEET_LINE_CONTRAST) { hit++; break; } }
        }
        const coverage = free ? hit / free : 0;
        if (coverage > SHEET_LINE_COVERAGE) lines.push({ band: bd.band, coverage });
    }
    return { passed: lines.length === 0, lines, reason: lines.length ? `lines drawn along the ${lines.map(l => `${l.band} (${Math.round(l.coverage * 100)}% of it)`).join(', ')}` : undefined };
}

export interface CharacterSheetResult {
    prompt: string;
    /** The 2x2 reference sheet sent to the model, and the sheet it answered with. */
    inputPng: Buffer;
    sheetPng: Buffer;
    panels: CharacterSheetPanel[];
    /** Dividing lines or borders drawn on the sheet (checkSheetBorders); any one rejects the sheet. */
    borders: SheetBorderCheck;
    accepted: boolean;
    attempts: number;
    /** Every sheet generated, in order: whether it passed, its failing panels, colour shift and outline miss. */
    tried?: Array<{ attempt: number; accepted: boolean; failingPanels: number; bordersPassed: boolean; colourShift: number; outlineMiss: number; score?: number }>;
    /** The `score` of this sheet, when one was given and the sheet was usable. */
    score?: { value: number; detail?: unknown };
    /** Usable for the caller: accepted, or (scoreMaxFailingPanels) only a few panels failed, which the caller leaves out. */
    usable?: boolean;
    modelUsed?: string;
    modelNote?: string;
}

const failing = (r: { panels: Array<{ qc: BeautifyQc }>; borders: SheetBorderCheck }) => r.panels.filter(p => !p.qc.passed).length + (r.borders.passed ? 0 : 1);
/** Sum of the panels' hue/chroma shifts from the tile photos (0 where a panel has no colour check). */
const colourShift = (panels: Array<{ colour?: PanelColourCheck }>) => panels.reduce((a, p) => a + (p.colour?.shift ?? 0), 0);
const outlineMiss = (panels: Array<{ qc: BeautifyQc }>) => panels.reduce((a, p) => a + (p.qc.outline ? p.qc.outline.overflow + p.qc.outline.underfill : 0), 0);

export async function beautifyCharacterSheet(
    renderer: SurveyStationRenderService,
    generator: StationImageGenerator,
    stations: ColmapCameraPose[],
    locationName: string,
    options: CharacterSheetOptions = {}
): Promise<CharacterSheetResult> {
    if (stations.length !== 4) throw new Error(`beautifyCharacterSheet: a character sheet takes four stations, got ${stations.length}`);
    const aspect = stations[0].aspectRatio || 16 / 9;
    if (stations.some(s => Math.abs((s.aspectRatio || 16 / 9) - aspect) > 0.01)) throw new Error('beautifyCharacterSheet: the four stations must share one aspect ratio to tile a 2 x 2 sheet');
    const PW = options.panelWidth ?? 1920, PH = Math.round(PW / aspect), SW = PW * 2, SH = PH * 2;
    const textured = (options.renderMode ?? 'textured') === 'textured';
    if (textured && !options.glbPath) throw new Error('beautifyCharacterSheet: renderMode "textured" needs glbPath (the GLB whose tile photos are rendered)');

    const blockouts: StationBlockoutRender[] = [];
    for (const st of stations) {
        blockouts.push(textured
            ? await renderer.renderStation(st, { renderMode: 'albedo', glbPath: options.glbPath, width: PW, height: PH })
            : renderer.renderStationBlockout(st, { width: PW, height: PH }));
    }
    // the reference sheet: each structure on white, in quadrant order (top left, top right, bottom left, bottom right)
    const sheet = Buffer.alloc(SW * SH * 4, 255);
    blockouts.forEach((b, q) => {
        const ox = (q % 2) * PW, oy = Math.floor(q / 2) * PH;
        for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
            if (!b.silhouette[y * PW + x]) continue;
            const si = (y * PW + x) * 4, di = ((oy + y) * SW + ox + x) * 4;
            sheet[di] = b.rgba[si]; sheet[di + 1] = b.rgba[si + 1]; sheet[di + 2] = b.rgba[si + 2];
        }
    });
    const inputPng = encodePng(SW, SH, sheet);
    const aspectLabel = BeautifyStationService.aspectLabel(aspect);
    const prompt = buildCharacterSheetPrompt({ locationName, stations, styleSuffix: options.styleSuffix });

    const maxRerolls = options.maxRerolls ?? 2;
    const perRound = Math.max(1, Math.floor(options.candidates ?? 1));
    const gate = options.colourGate !== false;
    let best: CharacterSheetResult | null = null;
    let attempts = 0;
    const tried: CharacterSheetResult['tried'] = [];
    const evaluate = (png: Buffer, modelUsed: string | undefined, modelNote: string | undefined): CharacterSheetResult => {
        const out = decodePng(png);
        const panels: CharacterSheetPanel[] = stations.map((station, q) => {
            // the quadrant, resampled to the station frame (the model answers at its own resolution)
            const qw = out.width / 2, qh = out.height / 2, ox = (q % 2) * qw, oy = Math.floor(q / 2) * qh;
            const rgba = Buffer.alloc(PW * PH * 4);
            for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
                const sx = Math.min(out.width - 1, Math.floor(ox + (x + 0.5) * qw / PW)), sy = Math.min(out.height - 1, Math.floor(oy + (y + 0.5) * qh / PH));
                out.rgba.copy(rgba, (y * PW + x) * 4, (sy * out.width + sx) * 4, (sy * out.width + sx) * 4 + 4);
            }
            const { qc, aligned } = BeautifyStationService.verifyStationImage(renderer, station, blockouts[q], rgba, PW, PH);
            const fit = checkStationOutline(blockouts[q], station, rgba, PW, PH, options.outline);
            qc.outline = fit;
            if (!fit.passed) { qc.passed = false; qc.reason = [qc.reason, fit.reason].filter(Boolean).join('; '); }
            // the colour gate needs the tile photos' colour: only a textured reference has it
            const colour = textured ? checkPanelColour(blockouts[q], rgba, PW, PH, options.maxColourShift) : undefined;
            if (gate && colour && !colour.passed) { qc.passed = false; qc.reason = [qc.reason, colour.reason].filter(Boolean).join('; '); }
            return { station, alignedStation: aligned, blockout: blockouts[q], imagePng: encodePng(PW, PH, rgba), qc, ...(colour ? { colour } : {}) };
        });
        const borders = checkSheetBorders(out.rgba, out.width, out.height, blockouts);
        const res: CharacterSheetResult = { prompt, inputPng, sheetPng: png, panels, borders, accepted: false, attempts, modelUsed, modelNote };
        res.accepted = failing(res) === 0;
        return res;
    };
    // fewest failing panels, then (gate on) the smallest colour shift, then the smallest outline miss
    const better = (a: CharacterSheetResult, b: CharacterSheetResult) => failing(a) !== failing(b) ? failing(a) < failing(b)
        : gate && colourShift(a.panels) !== colourShift(b.panels) ? colourShift(a.panels) < colourShift(b.panels) : outlineMiss(a.panels) < outlineMiss(b.panels);
    // maxRerolls + 1 rounds, `candidates` sheets each. Without `score` the first round with an accepted sheet ends it; with
    // one, rounds go on until `keepAccepted` sheets passed (or the budget is spent) and the best-scoring accepted sheet wins.
    const want = options.score ? Math.max(1, Math.floor(options.keepAccepted ?? 2)) : 1;
    const accepted: CharacterSheetResult[] = [];
    for (let round = 0; round <= maxRerolls && accepted.length < want; round++) {
        if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : Object.assign(new Error('Character sheet was stopped'), { name: 'AbortError' });
        const answers = await Promise.all(Array.from({ length: perRound }, () => generator.generate({ prompt, blockoutPng: inputPng, aspectRatio: aspectLabel, width: SW, height: SH, imageSize: '4K', signal: options.signal })));
        const round_: CharacterSheetResult[] = [];
        for (const a of answers) {
            attempts++;
            const { png, modelUsed, modelNote } = toStationImageAnswer(a);
            const res = evaluate(png, modelUsed, modelNote);
            round_.push(res);
            tried.push({ attempt: attempts, accepted: res.accepted, failingPanels: res.panels.filter(p => !p.qc.passed).length, bordersPassed: res.borders.passed, colourShift: +colourShift(res.panels).toFixed(2), outlineMiss: +outlineMiss(res.panels).toFixed(4) });
            if (!best || better(res, best)) best = res;
        }
        // only usable sheets are scored: every check passed, or (scoreMaxFailingPanels) a few panels failed and are left out
        const maxFail = options.score ? Math.max(0, Math.floor(options.scoreMaxFailingPanels ?? 0)) : 0;
        const passed = round_.filter(r => r.borders.passed && r.panels.filter(p => !p.qc.passed).length <= maxFail);
        passed.forEach(r => { r.usable = true; });
        if (options.score && passed.length) {
            const scores = await Promise.all(passed.map(r => options.score!(r)));
            passed.forEach((r, i) => { r.score = scores[i]; const t = tried[attempts - round_.length + round_.indexOf(r)]; if (t) t.score = +scores[i].value.toFixed(4); });
        }
        accepted.push(...passed);
    }
    if (options.score && accepted.length) best = accepted.reduce((a, b) => ((b.score?.value ?? -Infinity) > (a.score?.value ?? -Infinity) ? b : a));
    else if (accepted.length) best = accepted.reduce((a, b) => (better(b, a) ? b : a));
    return { ...best!, attempts, tried };
}
