/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    detect3DSceneTheme,
    generateDefaultCpp3DSource,
    synthesizeContextual3DScene
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { NoSceneBuiltError } from '../src/browser/generative-canvas/services/adaptive-domain-engine';
import { GLASS_FRACTURE_TOOL_DECLARATIONS, glassFractureHandlers } from '../src/node/gemini/tools/glass-fracture-tools';

describe('Bullet Glass Shatter & Ballistic Fracture System', () => {

    it('2. does not route ballistics or glass-fracture prompts on keywords (ADA rule 2)', () => {
        expect(detect3DSceneTheme('build me a scene of a bully going through a plate of glass')).toBe('general');
        expect(detect3DSceneTheme('bullet impact on glass pane')).toBe('general');
    });

    it('3. should generate compilable C++20 ballistic fracture engine source code', () => {
        const cppSource = generateDefaultCpp3DSource('glass_shatter', 'Bullet Glass Impact');
        expect(cppSource).toContain('#include "scratchbox_engine.hpp"');
        expect(cppSource).toContain('using namespace scratchbox::fracture;');
        expect(cppSource).toContain('GlassPaneConfig pane;');
        expect(cppSource).toContain('BulletConfig bullet;');
        expect(cppSource).toContain('GlassFractureGenerator::buildCompleteScene');
        expect(cppSource).toContain('scratchbox::io::GlbWriter::writeGlb');
        expect(cppSource).toContain('scratchbox::io::GlbWriter::streamChunk');
        expect(cppSource).toContain('bullet_glass_impact');
    });

    it('4. fails a glass-shatter prompt with NoSceneBuiltError instead of mounting a canned fracture template', () => {
        let error: any;
        try {
            synthesizeContextual3DScene('build me a scene of a bully going through a plate of glass');
        } catch (err) {
            error = err;
        }
        expect(error).toBeInstanceOf(NoSceneBuiltError);
        expect(error.code).toBe('NO_SCENE_BUILT');
    });

    it('5. vfx_fracture_glass_pane builds the Voronoi fracture natively, its shards driven by continuous parameters', async () => {
        const declaration = GLASS_FRACTURE_TOOL_DECLARATIONS.find(d => d.name === 'vfx_fracture_glass_pane');
        expect(declaration).toBeDefined();
        const props = (declaration!.parameters as any).properties;
        for (const name of ['paneWidth', 'paneHeight', 'radialCrackCount', 'bulletCaliber', 'bulletSpeed', 'bulletMachNumber', 'simulationTimeSec']) {
            expect(props[name]?.type, name).toBe('NUMBER');
        }

        const [, handler] = glassFractureHandlers[0];
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-glass-fracture-'));
        try {
            const run = async (file: string, radialCrackCount: number) => {
                const outputGlbPath = path.join(dir, file);
                const outcome = await handler({ outputGlbPath, radialCrackCount }, {} as any);
                expect(outcome.status, JSON.stringify(outcome.resultPayload)).toBe('completed');
                const glb = fs.readFileSync(outputGlbPath);
                expect(glb.subarray(0, 4).toString('latin1')).toBe('glTF');
                expect(glb.readUInt32LE(4)).toBe(2);
                expect(glb.readUInt32LE(8)).toBe(glb.length);
                return outcome.resultPayload as { vertices: number; triangles: number; shardCount: number };
            };

            const base = await run('base.glb', 28);
            expect(base.shardCount).toBeGreaterThanOrEqual(20);
            expect(base.vertices).toBeGreaterThan(0);
            expect(base.triangles).toBeGreaterThan(0);

            const denser = await run('denser.glb', 40);
            expect(denser.shardCount).toBeGreaterThan(base.shardCount);
            expect(denser.triangles).toBeGreaterThan(base.triangles);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
