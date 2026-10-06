/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { reclassifyMisfiledPythonGenerator } from '../src/node/gemini/artifact-synthesis';

const PY = 'import scratchbox as sb\nimport math\n\nscene = sb.geometry.Mesh("Outpost")\nsb.io.write_glb(OUTPUT_GLB_PATH, scene)\n';
const CPP = '#include "scratchbox_engine.hpp"\nint main() { return 0; }\n';

describe('reclassifyMisfiledPythonGenerator', () => {
    it('moves a scratchbox Python script out of cppGenerator into pythonGenerator', () => {
        const out = reclassifyMisfiledPythonGenerator({ cppGenerator: { sourceCode: PY, filename: 'world.cpp' } } as any);
        expect(out.cppGenerator).toBeUndefined();
        expect(out.pythonGenerator?.sourceCode).toBe(PY);
        expect(out.pythonGenerator?.enabled).toBe(true);
    });

    it('leaves real C++ and existing python generators untouched', () => {
        const cpp = { cppGenerator: { sourceCode: CPP } } as any;
        expect(reclassifyMisfiledPythonGenerator(cpp)).toBe(cpp);

        const both = { cppGenerator: { sourceCode: PY }, pythonGenerator: { sourceCode: PY, glbBase64: 'Z2xURg==' } } as any;
        expect(reclassifyMisfiledPythonGenerator(both)).toBe(both);

        expect(reclassifyMisfiledPythonGenerator(undefined)).toBeUndefined();
    });
});
