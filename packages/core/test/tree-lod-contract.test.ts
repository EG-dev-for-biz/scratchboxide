/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tree LOD structure of the trees GLB: the synthetic fixture (four levels, trees-lod/2) is valid, survives a GLB round
 * trip, an old three-level trees-lod/1 file is still valid, and each broken variant fails with one precise message. The outcome table is rendered to test-results/screenshots/tree_lod_contract.png.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { validateContract, validateTreesGlbJson } from '../src/common/spatial/staged-location-contracts';
import { buildTreesLodGltf, writeTreesLodGlb } from './helpers/synthetic-trees-lod-glb';
import { htmlScreenshotChrome, saveHtmlScreenshot } from './helpers/html-screenshot';
import { REPO_ROOT } from './helpers/requirements';

const fresh = () => buildTreesLodGltf({ crown: true, lobes: true }).json;
const tree0 = (j: any) => j.nodes.find((n: any) => n.extras?.sbTree);
const cases: Array<{ title: string; edit: (j: any) => void; expect: RegExp }> = [
    { title: 'tree with three children (trees-lod/2)', edit: j => { tree0(j).children.pop(); }, expect: /exactly 4 child nodes, has 3/ },
    { title: 'old file with four children (trees-lod/1)', edit: j => { j.extras.sbTrees.schema = 'scratchbox.trees-lod/1'; }, expect: /exactly 3 child nodes, has 4/ },
    { title: 'unknown schema', edit: j => { j.extras.sbTrees.schema = 'scratchbox.trees-lod/9'; }, expect: /schema/ },
    { title: 'two level-1 children', edit: j => { const t = j.nodes.find((n: any) => n.extras?.sbTree); j.nodes[t.children[2]].extras.sbLod.level = 1; }, expect: /two level-1 children/ },
    { title: 'far level instanced', edit: j => { const t = tree0(j); j.nodes[t.children[3]].extras.sbLod.instanced = true; }, expect: /level 3 .* not instanced/ },
    { title: 'level past the far one', edit: j => { const t = tree0(j); j.nodes[t.children[3]].extras.sbLod.level = 4; }, expect: /level|maximum/ },
    { title: 'instanced flag without clusters', edit: j => { const t = j.nodes.find((n: any) => n.extras?.sbTree); delete j.nodes[t.children[0]].children; }, expect: /no leaf-cluster child node/ },
    { title: 'cluster without instancing extension', edit: j => { const t = j.nodes.find((n: any) => n.extras?.sbTree); delete j.nodes[j.nodes[t.children[0]].children[0]].extensions; }, expect: /lacks EXT_mesh_gpu_instancing/ },
    { title: 'extension not declared', edit: j => { j.extensionsUsed = []; }, expect: /missing from extensionsUsed/ },
    { title: 'unknown cluster mesh', edit: j => { const t = j.nodes.find((n: any) => n.extras?.sbTree); j.nodes[j.nodes[t.children[0]].children[0]].extras.sbCluster.clusterMesh = 'nope'; }, expect: /not a variant of the cluster library/ },
    { title: 'cluster missing hash seed', edit: j => { const t = j.nodes.find((n: any) => n.extras?.sbTree); delete j.nodes[j.nodes[t.children[0]].children[0]].extras.sbCluster.hashSeed; }, expect: /hashSeed/ },
    { title: 'gap between level bands', edit: j => { const t = tree0(j); j.nodes[t.children[1]].extras.sbLod.minDistM = 90; }, expect: /gap between level 0/ },
    { title: 'gap between near-mid and mid', edit: j => { const t = tree0(j); j.nodes[t.children[2]].extras.sbLod.minDistM = 150; }, expect: /gap between level 1 \(to 110 m\) and level 2 \(from 150 m\)/ },
    { title: 'gap between mid and far', edit: j => { const t = tree0(j); j.nodes[t.children[3]].extras.sbLod.minDistM = 250; }, expect: /gap between level 2/ },
    { title: 'bands out of order', edit: j => { const t = tree0(j); j.nodes[t.children[2]].extras.sbLod.minDistM = 40; }, expect: /level 2 starts \(40 m\) before level 1/ },
    { title: 'psiSeason above 1', edit: j => { j.extras.sbTrees.psiSeason = 1.5; }, expect: /psiSeason/ },
    { title: 'leaf cluster claims measured', edit: j => { const t = j.nodes.find((n: any) => n.extras?.sbTree); j.nodes[j.nodes[t.children[0]].children[0]].extras.sbCluster.note = 'measured leaves'; }, expect: /no "measured" claim/ },
    { title: 'no root extras', edit: j => { delete j.extras; }, expect: /sbTrees/ },
    { title: 'lobes without a blend radius', edit: j => { const c = tree0(j).extras.sbTree.crown; delete c.lobeBlendM; }, expect: /lobeBlendM/ },
    { title: 'lobe with zero radius', edit: j => { tree0(j).extras.sbTree.crown.lobes[1][3] = 0; }, expect: /positive radius/ }
];
const outcomes: Array<{ title: string; messages: string[] }> = [];

describe('tree LOD contract', () => {
    it('accepts the synthetic fixture, in memory and after a GLB round trip', () => {
        expect(validateTreesGlbJson(fresh())).toEqual([]);
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-trees-lod-')), 'trees.glb');
        writeTreesLodGlb(file);
        const b = fs.readFileSync(file);
        expect(b.subarray(0, 4).toString()).toBe('glTF');
        const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
        expect(validateTreesGlbJson(json)).toEqual([]);
        expect(json.nodes.filter((n: any) => n.extras?.sbTree)).toHaveLength(2);
        expect(json.nodes.filter((n: any) => n.extensions?.EXT_mesh_gpu_instancing)).toHaveLength(12);   // 2 trees x 3 leaf levels x 2 clusters
        outcomes.push({ title: 'valid fixture (2 trees x 4 levels, crown lobes)', messages: [] });
    });

    it('still accepts an old three-level trees-lod/1 file', () => {
        const old = buildTreesLodGltf({ levels: 3, crown: true }).json;
        expect(old.extras.sbTrees.schema).toBe('scratchbox.trees-lod/1');
        expect(validateTreesGlbJson(old)).toEqual([]);
        expect(old.extras.sbTrees.clusterLibrary.variants[0].leavesNearMid).toBeUndefined();
        outcomes.push({ title: 'valid old file (2 trees x 3 levels, trees-lod/1)', messages: [] });
    });

    it('validates the root extras as a named contract', () => {
        expect(validateContract('TreesGlbRootExtras', fresh().extras.sbTrees)).toEqual([]);
        expect(validateContract('TreesGlbRootExtras', { schema: 'scratchbox.trees-lod/1' })).not.toEqual([]);
    });

    for (const c of cases) {
        it(`rejects: ${c.title}`, () => {
            const j = fresh();
            c.edit(j);
            const messages = validateTreesGlbJson(j);
            outcomes.push({ title: c.title, messages });
            expect(messages.length).toBeGreaterThan(0);
            expect(messages.some(m => c.expect.test(m)), messages.join(' | ')).toBe(true);
        });
    }

    it.skipIf(!htmlScreenshotChrome.ok)('renders the outcome table', async () => {
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        const rows = outcomes.map(o => `<tr><td style="padding:6px 12px;color:${o.messages.length ? '#E69F00' : '#009E73'}">${esc(o.title)}</td><td style="padding:6px 12px;font:12px monospace">${o.messages.length ? esc(o.messages[0]) : 'valid'}</td></tr>`).join('');
        const shot = await saveHtmlScreenshot('tree_lod_contract_tmp', `<h2 style="padding:12px">Tree LOD contract outcomes</h2><table>${rows}</table>`, { width: 1200, height: 820, background: '#1c2026' });
        const dir = path.join(REPO_ROOT, 'test-results', 'screenshots');
        fs.mkdirSync(dir, { recursive: true });
        fs.renameSync(shot.path, path.join(dir, 'tree_lod_contract.png'));
        expect(outcomes.length).toBe(cases.length + 2);
    });
});
