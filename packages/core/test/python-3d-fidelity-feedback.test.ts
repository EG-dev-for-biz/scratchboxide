/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { python3DHandlers } from '../src/node/gemini/tools/python-3d-tools';

describe('execute_3d_python_script fidelity feedback', () => {
    it('tells the model how to refine an under-detailed hero object', async () => {
        const outcome = await python3DHandlers.execute_3d_python_script({
            script: 'import scratchbox as sb\nscene = sb.geometry.Mesh("Stub")\nscene.merge(sb.create_box(width=1, height=1, depth=1))\nsb.io.write_glb(OUTPUT_GLB_PATH, scene)',
            description: 'Under-detailed stub'
        });

        expect(outcome.status).toBe('completed');
        expect(outcome.summaryResult).toContain('Fidelity alerts');
        expect(outcome.summaryResult).toContain('sb.create_lathe');
    }, 120000);

    it('passes a form-driven build (revolved profile + displaced organic mass) without alerts', async () => {
        const outcome = await python3DHandlers.execute_3d_python_script({
            script: [
                'import scratchbox as sb',
                'scene = sb.geometry.Mesh("Hero")',
                'rock = sb.create_sphere(radius=1.0, rings=64, sectors=128)',
                'rock.displace(freq=1.1, amp=0.22)',
                'rock.taubin_smooth(iterations=4)',
                'rock.scale(11.0, 4.6, 9.0)',
                'scene.merge(rock)',
                'scene.merge(sb.create_lathe([(0.0, 4.8), (4.2, 4.8), (3.4, 6.2), (2.15, 18.6), (2.9, 19.4), (1.8, 19.6), (1.6, 23.0), (0.0, 24.1)], segments=96))',
                'scene.apply_material(sb.PbrMaterial.clay())',
                'sb.io.write_glb(OUTPUT_GLB_PATH, scene)'
            ].join('\n'),
            description: 'Form-driven hero'
        });

        expect(outcome.status).toBe('completed');
        expect(outcome.summaryResult).not.toContain('Fidelity alerts');
    }, 120000);
});
