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
 * short, subject wholly in frame), and the sheet itself must carry no dividing lines or borders (checkSheetBorders). The
 * sheet is accepted only when all of that passes; otherwise it is generated again.
 */

import type { ColmapCameraPose } from '../../common/spatial/colmap-vector-reference-types';
import { buildCharacterSheetPrompt } from '../../browser/generative-canvas/services/location-beautify-service';
import { decodePng, encodePng } from '../texture-processing';
import { SurveyStationRenderService, type StationBlockoutRender } from './SurveyStationRenderService';
import { BeautifyStationService, checkStationOutline, toStationImageAnswer, type BeautifyQc, type OutlineLimits, type StationImageGenerator } from './BeautifyStationService';

export interface CharacterSheetOptions {
    /** Width of one panel (default 1920); the panel height follows the stations' aspect, the sheet is 2 x 2 panels. */
    panelWidth?: number;
    /** Reference render: the GLB's tile photos (default) or studio clay. */
    renderMode?: 'textured' | 'clay';
    glbPath?: string;
    /** Further sheets after a rejected one (default 2). */
    maxRerolls?: number;
    outline?: OutlineLimits;
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
    modelUsed?: string;
    modelNote?: string;
}

const failing = (r: { panels: Array<{ qc: BeautifyQc }>; borders: SheetBorderCheck }) => r.panels.filter(p => !p.qc.passed).length + (r.borders.passed ? 0 : 1);
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
    let best: CharacterSheetResult | null = null;
    let attempts = 0;
    while (attempts <= maxRerolls) {
        if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : Object.assign(new Error('Character sheet was stopped'), { name: 'AbortError' });
        attempts++;
        const { png, modelUsed, modelNote } = toStationImageAnswer(await generator.generate({ prompt, blockoutPng: inputPng, aspectRatio: aspectLabel, width: SW, height: SH, imageSize: '4K', signal: options.signal }));
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
            return { station, alignedStation: aligned, blockout: blockouts[q], imagePng: encodePng(PW, PH, rgba), qc };
        });
        const borders = checkSheetBorders(out.rgba, out.width, out.height, blockouts);
        const res: CharacterSheetResult = { prompt, inputPng, sheetPng: png, panels, borders, accepted: false, attempts, modelUsed, modelNote };
        res.accepted = failing(res) === 0;
        if (!best || failing(res) < failing(best) || (failing(res) === failing(best) && outlineMiss(panels) < outlineMiss(best.panels))) best = res;
        if (res.accepted) break;
    }
    return { ...best!, attempts };
}
