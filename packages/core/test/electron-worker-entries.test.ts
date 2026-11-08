import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../../..');
const CORE_SRC = path.join(REPO, 'packages/core/src');

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
}

describe('the standalone (Electron) build ships every worker entry', () => {
    // workers are started by file name ('x-worker.js' beside the pool), so nothing imports them and tsc compiles them only
    // when tsconfig.electron.json includes them: a missing one fails every build that needs it in the standalone app
    const sources = walk(CORE_SRC);
    const referenced = new Set<string>();
    for (const f of sources) {
        for (const m of fs.readFileSync(f, 'utf8').matchAll(/'([A-Za-z0-9_-]+-worker)\.(?:js|ts)'/g)) referenced.add(m[1]);
    }

    it('finds the worker entries the code starts by name', () => {
        expect(referenced.size).toBeGreaterThan(5);
        expect(referenced.has('staged-location-worker')).toBe(true);
    });

    it('has a source file for every worker started by name, under the *-worker.ts pattern the Electron build includes', () => {
        const tsconfig = JSON.parse(fs.readFileSync(path.join(REPO, 'desktop-app/tsconfig.electron.json'), 'utf8'));
        expect(tsconfig.include).toContain('../packages/core/src/**/*-worker.ts');
        const names = new Set(sources.map(f => path.basename(f, '.ts')));
        const missing = [...referenced].filter(n => !names.has(n));
        expect(missing).toEqual([]);
    });
});
