/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The provenance palette is accessible (design §7.4, F39), computed from the legend the viewport actually resolves:
 *  - any two distinct hues differ by ΔE76 ≥ 15 with normal vision and under deuteranopia, protanopia and tritanopia
 *    (Machado 2009, full severity); labels that share a hue are told apart by pattern, and their patterns differ;
 *  - every legend colour, the degraded hatch and the unknown-label grey keep ≥ 3:1 contrast against the provenance
 *    background #1c2026;
 *  - the remesh's displacement bands step through distinct patterns, read from the contract's bands;
 *  - overlay text keeps ≥ 4.5:1 against its panel as composited over the viewport.
 * A palette swatch sheet is saved as a screenshot.
 */

import { describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_PROVENANCE_LEGEND, DEGRADED_OUTLINE_COLOR, PROVENANCE, PROVENANCE_BACKGROUND, RECTIFY_DISPLACEMENT_BANDS, type StagedBuildState } from '../src/common/spatial/staged-location-contracts';
import {
    CVD_MATRICES,
    UNKNOWN_LABEL_COLOR,
    contrastRatio,
    deltaE76,
    hexToRgb01,
    linearToLab,
    resolveLegend,
    shadingClasses,
    simulateCvdLinear
} from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/provenanceShading';
import { stagedBuildState } from './helpers/staged-location-fixtures';
import { saveHtmlScreenshot, htmlScreenshotChrome } from './helpers/html-screenshot';
import { SHOT_DIR } from './helpers/staged-build-chrome';

/** The legend a real run resolves: the run's own entries, the contract defaults, and a label nobody listed. */
function runLegend() {
    const state: StagedBuildState = stagedBuildState();
    return resolveLegend(state, [...DEFAULT_PROVENANCE_LEGEND.map(e => e.label), 'a label nobody listed']);
}

describe('provenance palette', () => {
    test('distinct hues stay ΔE76 ≥ 15 apart under every colour-vision simulation', () => {
        const legend = runLegend();
        const hues = [...new Set([...legend.values()].map(s => s.color.toUpperCase()))];
        expect(hues.length).toBeGreaterThanOrEqual(7);
        const report: string[] = [];
        for (const kind of Object.keys(CVD_MATRICES) as Array<keyof typeof CVD_MATRICES>) {
            let min = Infinity, pair = '';
            for (let i = 0; i < hues.length; i++) for (let j = i + 1; j < hues.length; j++) {
                const d = deltaE76(linearToLab(simulateCvdLinear(hexToRgb01(hues[i]), kind)), linearToLab(simulateCvdLinear(hexToRgb01(hues[j]), kind)));
                if (d < min) { min = d; pair = `${hues[i]}~${hues[j]}`; }
            }
            report.push(`${kind}: min ΔE76 ${min.toFixed(1)} (${pair})`);
            expect(min, report.join('; ')).toBeGreaterThanOrEqual(15);
        }
        // The degraded hatch is drawn over a label colour: it must stand apart from every hue it can sit on.
        for (const kind of Object.keys(CVD_MATRICES) as Array<keyof typeof CVD_MATRICES>) {
            const lab = (h: string) => linearToLab(simulateCvdLinear(hexToRgb01(h), kind));
            for (const h of hues.filter(x => x !== DEGRADED_OUTLINE_COLOR.toUpperCase())) {
                const d = deltaE76(lab(h), lab(DEGRADED_OUTLINE_COLOR));
                if (h === '#E69F00') expect(d, `${kind}: vermillion over as-scanned orange`).toBeGreaterThanOrEqual(8);
                else expect(d, `${kind}: vermillion vs ${h}`).toBeGreaterThanOrEqual(15);
            }
        }
    });

    test('labels that share a hue are told apart by pattern', () => {
        const legend = runLegend();
        const byColor = new Map<string, string[]>();
        for (const s of legend.values()) byColor.set(s.color.toUpperCase(), [...(byColor.get(s.color.toUpperCase()) ?? []), s.pattern]);
        for (const [color, patterns] of byColor) {
            if (color === UNKNOWN_LABEL_COLOR.toUpperCase()) continue;
            expect(new Set(patterns).size, `${color}: ${patterns.join(',')}`).toBe(patterns.length);
        }
        // The remesh's displacement bands keep the remeshed hue and step through distinct patterns.
        const classes = shadingClasses(legend);
        const bands = RECTIFY_DISPLACEMENT_BANDS.map(b => classes.find(c => c.key === b.band)!);
        expect(bands.map(b => b.label)).toEqual(RECTIFY_DISPLACEMENT_BANDS.map(() => PROVENANCE.remeshed));
        expect(new Set(bands.map(b => b.patternCode)).size).toBe(RECTIFY_DISPLACEMENT_BANDS.length);
        expect(bands[0].patternCode, 'untouched (< 1 cm) is solid').toBe(0);
    });

    test('every colour keeps 3:1 against the provenance background; overlay text 4.5:1 against its panel', () => {
        const legend = runLegend();
        for (const s of legend.values()) expect(contrastRatio(s.color, PROVENANCE_BACKGROUND), `${s.label} ${s.color}`).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(DEGRADED_OUTLINE_COLOR, PROVENANCE_BACKGROUND)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(UNKNOWN_LABEL_COLOR, PROVENANCE_BACKGROUND)).toBeGreaterThanOrEqual(3);
        // Panel rgba(18,18,22,0.92) composited over the brightest viewport background it sits on (clay #b0b8c4).
        const over = hexToRgb01('#b0b8c4');
        const panel = [18, 18, 22].map((c, i) => (c / 255) * 0.92 + over[i] * 0.08) as [number, number, number];
        expect(contrastRatio('#e4e4e7', panel)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio('#b4b4bb', panel)).toBeGreaterThanOrEqual(4.5);
    });

    test.skipIf(!htmlScreenshotChrome.ok)('swatch sheet under each simulation (screenshot)', async () => {
        const legend = runLegend();
        const rows = (Object.keys(CVD_MATRICES) as Array<keyof typeof CVD_MATRICES>).map(kind => {
            const cells = [...legend.values()].map(s => {
                const lin = simulateCvdLinear(hexToRgb01(s.color), kind);
                const srgb = lin.map(c => Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255));
                return `<div style="width:112px;margin:4px;font:11px sans-serif;color:#e4e4e7"><div style="height:36px;border-radius:4px;background:rgb(${srgb.join(',')})"></div>${s.label} (${s.pattern})</div>`;
            }).join('');
            return `<div style="display:flex;align-items:center;gap:6px;padding:4px 8px"><div style="width:110px;font:12px sans-serif;color:#fff">${kind}</div>${cells}</div>`;
        }).join('');
        const shot = await saveHtmlScreenshot('staged_palette_cvd_swatches', `<div style="background:${PROVENANCE_BACKGROUND};padding:8px">${rows}</div>`, { width: 1260, height: 560, background: PROVENANCE_BACKGROUND });
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        const out = path.join(SHOT_DIR, 'palette_cvd_swatches.png');
        fs.renameSync(shot.path, out);
        expect(fs.statSync(out).size).toBeGreaterThan(1000);
    });
});
