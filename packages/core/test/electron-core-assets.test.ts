import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { copyCoreAssets } = require(path.join(REPO, 'desktop-app/scripts/copy-core-assets.cjs')) as { copyCoreAssets: (out: string) => { files: number; bytes: number } };

describe("the standalone (Electron) build carries core's run-time files", () => {
    it('is part of the desktop build script', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'desktop-app/package.json'), 'utf8'));
        expect(pkg.scripts.build).toContain('node scripts/copy-core-assets.cjs');
    });

    it('copies the geoid grid and the non-TypeScript files beside the compiled code, and no TypeScript or native source', () => {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'core-assets-'));
        try {
            const c = copyCoreAssets(out);
            expect(c.files).toBeGreaterThan(10);
            // the 3D Tiles extraction reads this grid at packages/core/data/geoid beside the compiled code
            const geoid = path.join(out, 'packages/core/data/geoid/egm96-15.pgm');
            expect(fs.statSync(geoid).size).toBe(fs.statSync(path.join(REPO, 'packages/core/data/geoid/egm96-15.pgm')).size);
            expect(fs.readFileSync(geoid).subarray(0, 2).toString('latin1')).toBe('P5');
            expect(fs.existsSync(path.join(out, 'packages/core/src/node/spatial/colosseum_mesh_elevation_grid.json'))).toBe(true);
            const copied: string[] = [];
            const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else copied.push(p); } };
            walk(out);
            expect(copied.filter(f => f.endsWith('.ts') || f.includes(`${path.sep}native${path.sep}`))).toEqual([]);
        } finally {
            fs.rmSync(out, { recursive: true, force: true });
        }
    });
});
