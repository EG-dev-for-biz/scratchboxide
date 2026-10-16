/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The measured-geometry exemption from GeometricComplexityGate's vertex floor (AGENTS.md): scan-derived layers and a
 * scan-fitted rebuild are judged by their fit to the scan, never padded. The rebuild is exempt only on a StructureFit
 * the gate validates itself; numbers a caller makes up are refused. A scanned layer is never called a JavaScript
 * fallback.
 */

import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeometricComplexityGate, measuredRebuildRefusal, type GeometricSceneMetrics } from '../src/common/spatial/GeometricComplexityGate';
import { structureFit } from './helpers/staged-location-fixtures';

const layer = (name: string, vertexCount: number, triangleCount = Math.round(vertexCount * 1.9)) => ({ name, vertexCount, triangleCount, tag: 'remeshed' });
const metrics = (submeshes: ReturnType<typeof layer>[], engineKernel = 'scratchbox-native'): GeometricSceneMetrics => ({
    totalVertices: submeshes.reduce((s, m) => s + m.vertexCount, 0), totalTriangles: submeshes.reduce((s, m) => s + m.triangleCount, 0), submeshes, engineKernel
});

describe('GeometricComplexityGate exemptions', () => {
    it('exempts a scan-derived layer from the floor, with its basis', () => {
        const r = GeometricComplexityGate.evaluate(metrics([layer('stg-90e96133-l2', 3107)]), {
            exemptions: [{ scanDerived: { submeshes: ['stg-90e96133-l2'], label: 'remeshed', leafGeometricErrorM: 2.0064 } }]
        });
        expect(r.passed).toBe(true);
        expect(r.violations).toEqual([]);
        expect(r.exemptions).toEqual(["vertex floor: scan-derived layer (3,107 vertices, the tiles' own density at leaf error 2.0 m, remeshed)"]);
        // the same layer without the exemption fails the floor, and is not called a JavaScript fallback (native kernel)
        const plain = GeometricComplexityGate.evaluate(metrics([layer('stg-90e96133-l2', 3107)]));
        expect(plain.passed).toBe(false);
        expect(plain.violations[0]).toBe('Insufficient geometric density: scene has 3,107 vertices, minimum required is 25,000 vertices.');
    });

    it('exempts a measured rebuild only on a valid, accepted StructureFit it checks itself', () => {
        const fit = structureFit();
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-gate-')), 'structure_fit.json');
        fs.writeFileSync(file, JSON.stringify(fit));
        const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        const m = metrics([layer('stg-7c1e04aa-l3b', 1124), layer('stg-7c1e04aa-l3a', 300), layer('stg-90e96133-l2', 3107)]);
        const ok = GeometricComplexityGate.evaluate(m, {
            exemptions: [
                { measuredRebuild: { submeshes: ['stg-7c1e04aa-l3b', 'stg-7c1e04aa-l3a'], structureFit: fit, structureFitSha256: sha } },
                { scanDerived: { submeshes: ['stg-90e96133-l2'], label: 'remeshed', leafGeometricErrorM: 2.0064 } }
            ]
        });
        expect(ok.passed).toBe(true);
        // the sha quoted is the file's
        expect(ok.exemptions[0]).toBe(`vertex floor: measured rebuild (1,424 vertices; StructureFit ${sha.slice(0, 8)} accepted, 3.2 cm rms over 97% of the visible scan)`);

        // made-up StructureFits are refused, and their submeshes counted
        const cases: Array<[string, (f: ReturnType<typeof structureFit>) => void, RegExp]> = [
            ['not accepted', f => { f.accepted = false; }, /was not accepted/],
            ['a failed gate', f => { f.gates[0] = { ...f.gates[0], passed: false }; }, /failed coverage/],
            ['low coverage', f => { f.metrics.coverage = 0.6; }, /coverage 60% is under 85%/],
            ['a large residual', f => { f.metrics.scanToFit.rmsM = 0.09; }, /scan→fit rms 9\.0 cm is over 6 cm/],
            ['an invalid document', f => { (f as any).primitives = 'many'; }, /is not valid/]
        ];
        for (const [, mutate, why] of cases) {
            const bad = structureFit();
            mutate(bad);
            expect(measuredRebuildRefusal(bad)).toMatch(why);
            const r = GeometricComplexityGate.evaluate(metrics([layer('stg-7c1e04aa-l3b', 1124)]), { exemptions: [{ measuredRebuild: { submeshes: ['stg-7c1e04aa-l3b'], structureFit: bad, structureFitSha256: sha } }] });
            expect(r.passed).toBe(false);
            expect(r.exemptions).toEqual([]);
            expect(r.exemptionsRefused[0]).toMatch(why);
            expect(r.violations[0]).toBe('Insufficient geometric density: scene has 1,124 vertices, minimum required is 25,000 vertices.');
        }
    });

    it('exempts SB-Veggie trees grown to measured crowns, with the crown count as its basis, and refuses a count that was made up', () => {
        // an isolated arch: the scan and 3 trees (3,418 vertices) grown to the crowns measured in it
        const m = metrics([layer('stg-90e96133-l2', 3107), { ...layer('stg-788091ab-l5', 3418), tag: 'grown to the measured crown' }]);
        const scan = { scanDerived: { submeshes: ['stg-90e96133-l2'], label: 'remeshed' as const, leafGeometricErrorM: 2.0064 } };
        const without = GeometricComplexityGate.evaluate(m, { exemptions: [scan] });
        expect(without.passed).toBe(false);
        expect(without.violations[0]).toBe('Insufficient geometric density: scene has 3,418 non-exempt vertices, minimum required is 25,000 vertices.');
        const ok = GeometricComplexityGate.evaluate(m, { exemptions: [scan, { measuredCrowns: { submeshes: ['stg-788091ab-l5'], crowns: 3 } }] });
        expect(ok.passed).toBe(true);
        expect(ok.exemptions[1]).toBe("vertex floor: SB-Veggie trees grown to 3 measured crowns (3,418 vertices; each tree's position, extent and height come from the tile scan)");
        for (const crowns of [0, -2, 1.5, NaN]) {
            const bad = GeometricComplexityGate.evaluate(m, { exemptions: [scan, { measuredCrowns: { submeshes: ['stg-788091ab-l5'], crowns } }] });
            expect(bad.passed).toBe(false);
            expect(bad.exemptions).toHaveLength(1);
            expect(bad.exemptionsRefused[0]).toMatch(/^measured crowns stg-788091ab-l5: .* is not a whole number of at least 1$/);
        }
    });

    it('counts only the submeshes no exemption covers, and keeps the banned-primitive and kernel checks', () => {
        const m = metrics([layer('stg-90e96133-l2', 3107), { name: 'statue', vertexCount: 900, triangleCount: 1700, tag: 'generated' } as any]);
        const r = GeometricComplexityGate.evaluate(m, { exemptions: [{ scanDerived: { submeshes: ['stg-90e96133-l2'], label: 'remeshed', leafGeometricErrorM: 2 } }] });
        expect(r.violations[0]).toBe('Insufficient geometric density: scene has 900 non-exempt vertices, minimum required is 25,000 vertices.');
        const banned = GeometricComplexityGate.evaluate({ ...m, submeshes: [...m.submeshes, { name: 'box', vertexCount: 24, triangleCount: 12, generatorType: 'THREE.BoxGeometry' }] },
            { exemptions: [{ scanDerived: { submeshes: ['stg-90e96133-l2'], label: 'remeshed', leafGeometricErrorM: 2 } }] });
        expect(banned.violations).toContain('Submesh "box" uses banned generator: THREE.BoxGeometry.');
        // a script kernel below the floor: that is the case the fallback sentence is for
        const js = GeometricComplexityGate.evaluate(metrics([layer('mesh', 900)], 'three.js'));
        expect(js.violations[0]).toBe('Insufficient geometric density: scene has 900 vertices, minimum required is 25,000 vertices. This indicates a prohibited low-fidelity JavaScript primitive fallback.');
    });
});
