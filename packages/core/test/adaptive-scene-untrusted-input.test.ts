/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Contract fields and critic corrections come from model output. They must not be able to
 * reach the JS prototype chain, change a field's type, or escape into the generated C++.
 */

import { describe, it, expect } from 'vitest';
import { Adaptive3DSceneSynthesizer } from '../src/node/spatial/Adaptive3DSceneSynthesizer';
import { SceneCriticRefinementService } from '../src/node/spatial/SceneCriticRefinementService';
import { AdaptiveSceneChunkPlanner } from '../src/node/spatial/AdaptiveSceneChunkPlanner';

const synthesizer = new Adaptive3DSceneSynthesizer();
const baseContract = () => synthesizer.synthesizeContractFromPrompt('a stone observatory on a ridge above a pine forest');

describe('adaptive scene: untrusted model input', () => {
    it('critic corrections cannot reach the prototype chain or add keys', () => {
        const critic = new SceneCriticRefinementService(synthesizer);
        const before = Object.prototype.toString;
        const { applied, skipped } = critic.applyCorrections(baseContract(), [
            { path: 'constructor.prototype.toString', value: 1 },
            { path: '__proto__.polluted', value: 1 },
            { path: 'terrain.notAField', value: 1 }
        ] as any);
        expect(applied).toBe(0);
        expect(skipped).toHaveLength(3);
        expect(Object.prototype.toString).toBe(before);
        expect(({} as any).polluted).toBeUndefined();
    });

    it('critic corrections keep numeric fields finite numbers', () => {
        const critic = new SceneCriticRefinementService(synthesizer);
        const contract = baseContract();
        const { corrected, applied, skipped } = critic.applyCorrections(contract, [
            { path: 'terrain.ridgeCount', value: '3); system("id"); (1' },
            { path: 'terrain.peakHeight', value: Number.NaN },
            { path: 'terrain.peakHeight', value: 61 }
        ] as any);
        expect(applied).toBe(1);
        expect(skipped).toEqual(['terrain.ridgeCount', 'terrain.peakHeight']);
        expect(corrected.terrain.peakHeight).toBe(61);
        expect(corrected.terrain.ridgeCount).toBe(contract.terrain.ridgeCount);
    });

    it('generated C++ escapes relation ids and character names and rejects non-numeric counts', () => {
        const contract: any = baseContract();
        contract.relations = [{
            subjectId: 'a"); std::system("touch /tmp/pwned"); ("',
            predicate: 'on_top_of',
            targetId: 'b\\',
            parameters: {}
        }];
        contract.characters = [{
            name: 'Ann\nstd::system("id");',
            role: 'guide',
            genderBeta: 0,
            targetHeightMeters: 1.7,
            position: [1, 0, 1]
        }];
        const src = synthesizer.generateCppSource(contract);
        expect(src).not.toContain('std::system("touch');
        expect(src).toContain('solver.addConstraint("a\\042); std::system(\\042touch /tmp/pwned\\042); (\\042", "on_top_of", "b\\134"');
        expect(src).not.toMatch(/\nstd::system\("id"\);/);
        expect(src).toContain('// Character 0: Ann std::system("id"); (guide)');

        contract.terrain.ridgeCount = '3); system("id"); (1';
        expect(() => synthesizer.generateCppSource(contract)).toThrow(/ridgeCount must be a finite number/);
    });

    it('chunk planner refuses a degenerate envelope instead of returning zero chunks', () => {
        const contract: any = baseContract();
        contract.sceneGraph = { ...(contract.sceneGraph || {}), terrain: { envelope: { width: Number.NaN, depth: 100 } } };
        expect(() => new AdaptiveSceneChunkPlanner().plan(contract)).toThrow(/positive finite width and depth/);
    });

    it('exactly one chunk builds the primary structure', () => {
        const contract: any = baseContract();
        const plan = new AdaptiveSceneChunkPlanner().plan(contract);
        const owners = plan.chunks.filter(c => {
            const region = AdaptiveSceneChunkPlanner.toChunkRegion(c);
            const src = synthesizer.generateCppSource({ ...contract, chunkRegion: region });
            return src.includes('ScratchboxMesh citadelMesh = buildArchitecturalCompound();');
        });
        expect(plan.chunks.length).toBeGreaterThan(1);
        expect(owners).toHaveLength(1);
    });
});
