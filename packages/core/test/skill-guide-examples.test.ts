import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { python3DHandlers } from '../src/node/gemini/tools/python-3d-tools';

// The model copies these guides' examples into execute_3d_python_script; a stale example becomes a failed tool call.
const REPO = path.resolve(__dirname, '../../..');
const GUIDES = [
    '.agents/skills/python-3d-procedural-director/SKILL.md',
    '.agents/skills/complex-visual-workflows/references/3d-engine-cheat-sheet.md',
    '.agents/skills/complex-visual-workflows/SKILL.md',
    '.agents/skills/3d-artist/SKILL.md',
    '.agents/skills/google-3d-tiles-ingestion/SKILL.md'
];

const read = (guide: string) => fs.readFileSync(path.join(REPO, guide), 'utf8');
const examples = GUIDES.flatMap(guide =>
    [...read(guide).matchAll(/```python\n([\s\S]*?)```/g)]
        .map(m => m[1])
        .filter(code => code.includes('import scratchbox'))
        .map((code, i) => ({ guide, index: i + 1, code })));

describe('3D skill guide examples', () => {
    it('finds the examples it is meant to check', () => {
        expect(examples.length).toBeGreaterThanOrEqual(4);
    });

    // Run through the real tool: a failed GeometricComplexityGate sends the model back for a second, denser attempt.
    it.each(examples.map(e => [`${e.guide} example ${e.index}`, e] as const))('%s runs in execute_3d_python_script and passes the complexity gate', async (_label, example) => {
        const outcome = await python3DHandlers.execute_3d_python_script({ script: example.code, description: 'skill guide example' });
        const payload = outcome.resultPayload as any;
        expect(outcome.status, payload.stderr || payload.errorDetails).toBe('completed');
        expect(payload.glbGenerated).toBe(true);
        expect(payload.gateReport?.passed, JSON.stringify(payload.gateReport)).toBe(true);
    }, 180_000);

    it('references only sb.* names that exist', async () => {
        const names = [...new Set(GUIDES.flatMap(g => read(g).match(/\bsb\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g) || []))];
        const script = `
import json, scratchbox as sb
def exists(name):
    obj = sb
    for part in name.split('.')[1:]:
        if not hasattr(obj, part):
            return False
        obj = getattr(obj, part)
    return True
print(json.dumps([n for n in ${JSON.stringify(names)} if not exists(n)]))
`;
        const res = await NativePythonRunnerService.getInstance().runScript(script);
        expect(res.exitCode, res.stderr).toBe(0);
        expect(JSON.parse(res.stdout.trim().split('\n').pop() || '[]')).toEqual([]);
    }, 180_000);
});
