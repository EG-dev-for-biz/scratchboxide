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
 * short, subject wholly in frame). The sheet is accepted only when all four panels pass; otherwise it is generated again.
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

export interface CharacterSheetResult {
    prompt: string;
    /** The 2x2 reference sheet sent to the model, and the sheet it answered with. */
    inputPng: Buffer;
    sheetPng: Buffer;
    panels: CharacterSheetPanel[];
    accepted: boolean;
    attempts: number;
    modelUsed?: string;
    modelNote?: string;
}

const failing = (panels: Array<{ qc: BeautifyQc }>) => panels.filter(p => !p.qc.passed).length;
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
        const res: CharacterSheetResult = { prompt, inputPng, sheetPng: png, panels, accepted: failing(panels) === 0, attempts, modelUsed, modelNote };
        if (!best || failing(panels) < failing(best.panels) || (failing(panels) === failing(best.panels) && outlineMiss(panels) < outlineMiss(best.panels))) best = res;
        if (res.accepted) break;
    }
    return { ...best!, attempts };
}
