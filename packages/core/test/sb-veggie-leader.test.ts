/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * An SB-Veggie tree's leader (scratchbox_nature.hpp growSkeleton, SpaceColonizationConfig::leaderHold, set per crown by
 * scratchbox_tile_vegetation.hpp growCrownAttempt from the apical dominance it grows with), measured where it is seen:
 *
 * - the built wood of a trees GLB (level 0), traced as the trunk is seen: in each of ten height bands from the crown base
 *   to the apex, the wood nearest the band below's trunk centre; its offset from the stem's line (the stem base to the
 *   measured apex) by height. A tree whose leader holds rises straight through its crown to the apex. Without a leader the
 *   trunk ended at the crown break and the scaffold limb that gathered most twigs climbed one side of the crown while the
 *   leaves stayed centred (2.0 m, 56 % of the crown radius, on a 32 m redwood cone); excurrence straightened pointed crowns
 *   only, so a rounded crown whose species holds its leader and a leaning scan crown still climbed (birch ovoid 1.0 m,
 *   leaning scan ovoid 1.4 m);
 * - described crowns (tile_vegetation grow, as the botanical tool and the forest demo grow them) and scan-like crowns
 *   planted from strip's crowns.json (tile_vegetation plant, as a staged build plants them: the apex measured off the stem,
 *   the crown base inferred);
 * - a tree whose species' apical dominance is low still forks at its crown break: forks stay a continuous property;
 * - the skeleton (engine case): the leader is the stem's own shoot to the apex, with its laterals spread evenly around it.
 *
 * Built with clang++ (TileVegetationService, NativeCppCompilerService); nothing calls a paid service.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { parseGlb, readAccessor } from './helpers/clay-glb-render';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));

type Vec3 = [number, number, number];

interface Trunk {
    crownId: number;
    label: string;
    radiusM: number;
    leaderHold: number;
    /** the drawn trunk's offset from the stem's line in each of ten bands from the crown base to the apex (null: no wood) */
    bands: Array<number | null>;
    /** the largest of those up to 0.8 of the crown's depth */
    worstTo08M: number;
    /** the highest wood within 0.5 m of the stem's line, as a share of the crown's depth above its base */
    axisWoodTopShare: number;
}

/** The drawn trunk of every tree in a trees GLB (unquantised), from its level-0 wood. */
function trunksOf(file: string): Trunk[] {
    const { json, bin } = parseGlb(fs.readFileSync(file));
    return json.nodes.filter((n: any) => n.extras?.crownId !== undefined).map((n: any) => {
        const ex = n.extras;
        const level0 = (n.children ?? []).map((i: number) => json.nodes[i]).find((k: any) => k.extras?.sbLod?.level === 0);
        const P = readAccessor(json, bin, json.meshes[level0.mesh].primitives[0].attributes.POSITION).data;
        const [sx, sz] = ex.stem as [number, number];
        const sy = ex.supportY as number;
        const [ax, ay, az] = ex.apex as Vec3;
        const base = ex.inferred.crownBaseY as number;
        const radii = ex.sectorRadiiM as number[];
        const R = radii.reduce((a, b) => a + b, 0) / radii.length;
        const axisAt = (y: number): [number, number] => {
            const s = Math.min(1, Math.max(0, (y - sy) / (ay - sy)));
            return [sx + (ax - sx) * s, sz + (az - sz) * s];
        };
        let cx = sx, cz = sz;
        const bands: Array<number | null> = [];
        for (let k = 0; k < 10; k++) {
            const lo = base + (ay - base) * k / 10, hi = lo + (ay - base) / 10;
            const inBand: Vec3[] = [];
            for (let v = 0; v < P.length; v += 3) if (P[v + 1] >= lo && P[v + 1] < hi) inBand.push([P[v], P[v + 1], P[v + 2]]);
            if (!inBand.length) { bands.push(null); continue; }
            inBand.sort((p, q) => Math.hypot(p[0] - cx, p[2] - cz) - Math.hypot(q[0] - cx, q[2] - cz));
            const near = inBand.slice(0, Math.max(6, Math.floor(inBand.length / 4)));
            cx = near.reduce((a, p) => a + p[0], 0) / near.length;
            cz = near.reduce((a, p) => a + p[2], 0) / near.length;
            const [px, pz] = axisAt(near.reduce((a, p) => a + p[1], 0) / near.length);
            bands.push(Math.hypot(cx - px, cz - pz));
        }
        let top = -Infinity;
        for (let v = 0; v < P.length; v += 3) {
            const [px, pz] = axisAt(P[v + 1]);
            if (Math.hypot(P[v] - px, P[v + 2] - pz) < 0.5) top = Math.max(top, P[v + 1]);
        }
        return {
            crownId: ex.crownId, label: ex.label ?? '', radiusM: R, leaderHold: ex.inferred.leaderHold, bands,
            worstTo08M: Math.max(0, ...bands.slice(0, 8).filter((b): b is number => b !== null)),
            axisWoodTopShare: (top - base) / (ay - base)
        };
    });
}

const smoothstep = (lo: number, hi: number, x: number) => { const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };

function report(title: string, trunks: Trunk[]) {
    console.log(`${title}\n` + trunks.map(t => `  ${t.label.padEnd(26)} hold ${t.leaderHold.toFixed(2)}  R ${t.radiusM.toFixed(1)} m  worst to 0.8: ${t.worstTo08M.toFixed(2)} m` +
        `  axis wood to ${t.axisWoodTopShare.toFixed(2)}  | ${t.bands.map(b => b === null ? '  -  ' : b.toFixed(2).padStart(5)).join(' ')}`).join('\n'));
}

/** A tree whose leader holds: its trunk on the stem's line up to 0.8 of the crown, its wood on that line up near the apex. */
function expectStraightLeader(t: Trunk, toleranceM: number) {
    expect(t.worstTo08M, `${t.label}: drawn trunk off the stem's line`).toBeLessThanOrEqual(toleranceM);
    expect(t.axisWoodTopShare, `${t.label}: wood on the stem's line ends short of the apex`).toBeGreaterThanOrEqual(0.85);
}

let work: string;
let svc: TileVegetationService;

beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-veggie-leader-')));
    svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
    await svc.ensureBinary();
}, 900_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

describe('SB-Veggie leader', () => {
    it('grows the trunk of a described crown whose leader holds straight up through it to the apex; a low apical dominance still forks', async () => {
        const forms = [
            { label: 'redwood cone', heightM: 32, crownRadiusM: 3.6, crownBaseHeightM: 0.38 * 32, crownWidestAt: 0.18, crownTopExponent: 1.15, trunkRadiusM: 0.5 },
            { label: 'spruce cone', heightM: 18, crownRadiusM: 2.6, crownBaseHeightM: 1.8, crownWidestAt: 0.1, crownTopExponent: 1.0 },
            { label: 'birch ovoid', heightM: 15, crownRadiusM: 4, crownBaseHeightM: 4.5, crownWidestAt: 0.35, crownTopExponent: 1.6 },
            { label: 'linden ellipsoid', heightM: 16, crownRadiusM: 5, crownBaseHeightM: 4.48, crownWidestAt: 0.4, crownTopExponent: 2.0 },
            { label: 'oak dome', heightM: 14, crownRadiusM: 7, crownBaseHeightM: 4.2, crownWidestAt: 0.45, crownTopExponent: 2.2 }
        ];
        let x = 0;
        const trees = forms.map(f => { x += f.crownRadiusM + 2; const t = { ...f, position: [x, 0, 0] as Vec3 }; x += f.crownRadiusM + 2; return t; });
        const grown = await svc.grow({ trees, seed: '3e8', quantize: false });
        const trunks = trunksOf(grown.treesGlb);
        report('described crowns (tile_vegetation grow): the drawn trunk off the stem\'s line by height, crown base -> apex (m)', trunks);
        expect(trunks).toHaveLength(forms.length);

        // the leader holds by the apical dominance of the species entry each crown grew with
        const species = JSON.parse(fs.readFileSync(path.join(REPO, 'assets/vegetation/species/index.json'), 'utf8')) as { entries: Array<{ id: string; apicalDominance: number }> };
        for (const [k, t] of trunks.entries()) {
            const entry = grown.stats.perTree[k].species?.entry as string | undefined;
            if (entry) expect(t.leaderHold, t.label).toBeCloseTo(smoothstep(0.45, 0.6, species.entries.find(e => e.id === entry)!.apicalDominance), 6);
        }
        const holding = trunks.filter(t => t.leaderHold >= 0.99), forking = trunks.filter(t => t.leaderHold <= 1e-6);
        expect(holding.length).toBeGreaterThanOrEqual(2);
        expect(forking.length).toBeGreaterThanOrEqual(1);
        for (const t of holding) expectStraightLeader(t, Math.max(0.4, 0.12 * t.radiusM));
        // a crown whose leader does not hold forks into its scaffold limbs at the break: no trunk on the stem's line through it
        for (const t of forking) {
            expect(t.worstTo08M, t.label).toBeGreaterThan(0.25 * t.radiusM);
            expect(t.axisWoodTopShare, t.label).toBeLessThan(0.5);
        }
    }, 600_000);

    it('grows the trunk of a scan crown planted from crowns.json along the stem\'s line to its measured apex, leaning or upright', async () => {
        // the top surface a tile scan sees (0.7 m grid), the apex off the stem as a leaning tree's is, the crown base inferred
        const forms = [
            { label: 'scan conifer, leaning', H: 22, R: 3.0, widestAt: 0.15, n: 1.1, lean: [1.0, 0.6] },
            { label: 'scan ovoid, leaning', H: 16, R: 4.2, widestAt: 0.4, n: 1.7, lean: [0.8, -0.5] },
            { label: 'scan ovoid, upright', H: 15, R: 4.5, widestAt: 0.4, n: 1.6, lean: [0, 0] }
        ];
        let x = 0;
        const crowns = forms.map((f, id) => {
            x += f.R + 3;
            const [sx, sz] = [x, 0];
            const [ax, az] = [sx + f.lean[0], sz + f.lean[1]];
            const base = 0.35 * f.H, wy = base + f.widestAt * (f.H - base);
            const samples: Vec3[] = [];
            const k = Math.ceil(f.R / 0.7);
            for (let a = -k; a <= k; a++) {
                for (let b = -k; b <= k; b++) {
                    const u = Math.hypot(a * 0.7, b * 0.7) / f.R;
                    if (u > 1) continue;
                    samples.push([ax + a * 0.7, wy + (f.H - wy) * Math.max(0, 1 - u ** f.n) ** (1 / f.n), az + b * 0.7]);
                }
            }
            x += f.R + 3;
            return {
                id, status: 'tree', label: f.label, reachesBoundary: false, apex: [ax, f.H, az], stem: [sx, sz], supportY: 0, supportSource: 'given', terrainY: 0,
                apexAboveSupport: f.H, areaM2: Math.PI * f.R * f.R, sectorRadii: new Array(16).fill(f.R), samples
            };
        });
        const crownsPath = path.join(work, 'scan_crowns.json');
        fs.writeFileSync(crownsPath, JSON.stringify({ version: 1, frame: { frame: 'x = east, y = up, z = south (metres)' }, params: { sampleSpacing: 0.7 }, crowns }));
        const planted = await svc.plant({ crownsPath, sceneTriangleCap: 1_500_000, seed: '3e8', quantize: false, reveal: false });
        const trunks = trunksOf(planted.treesGlb);
        report('scan-like crowns (tile_vegetation plant): the drawn trunk off the stem\'s line (stem base -> measured apex) by height (m)', trunks);
        expect(trunks).toHaveLength(forms.length);
        const holding = trunks.filter(t => t.leaderHold >= 0.99);
        expect(holding.length).toBeGreaterThanOrEqual(2);
        // the trunk below the crown break leans only part of the way to the apex (trunkLeanShare), so the base band is
        // allowed the lean it has left there
        for (const t of holding) expectStraightLeader(t, Math.max(0.45, 0.15 * t.radiusM));
    }, 600_000);

    it('grows the leader as the stem\'s own shoot to the apex, with its laterals spread evenly around it', async () => {
        const compiler = new NativeCppCompilerService();
        const testCpp = `
#include "scratchbox_sb_veggie_grove.hpp"
#include <cstdio>
using namespace scratchbox;
using namespace scratchbox::tile_vegetation;
int main() {
    struct Form { const char* name; double h, r, base, widest, n, dx, dz; };
    const Form forms[] = {{"cone", 24, 3.0, 0.3, 0.15, 1.1, 0, 0}, {"ovoid", 15, 4.0, 0.3, 0.35, 1.6, 0, 0}, {"leaning_ovoid", 16, 4.2, 0.35, 0.4, 1.7, 0.8, -0.5}};
    GrowthParams G;
    G.morphology.apicalDominance = 0.6f;   // a leader that holds (no species library: every crown grows with it)
    double sx = 0, sz = 0; int n = 0;
    for (const Form& F : forms) {
        for (int s = 0; s < 4; ++s) {
            DescribedTree d;
            d.heightM = F.h; d.crownRadiusXM = d.crownRadiusZM = F.r; d.crownBaseHeightM = F.base * F.h; d.crownWidestAt = F.widest; d.crownTopExponent = F.n;
            const io::GlbJsonValue doc = json::parse(describedCrownsJson({d}));
            CrownShape c = crownShapeFromJson(doc["crowns"][0]);
            c.stemX -= F.dx; c.stemZ -= F.dz;   // the apex measured off the stem
            if (F.dx != 0 || F.dz != 0) c.crownBaseRatio = std::numeric_limits<double>::quiet_NaN();
            c.id = s;
            G.seed = 77 + s;
            const CrownGrowth g = growCrown(c, G, doc["params"]["sampleSpacing"].num);
            const auto& N = g.skeleton;
            // the leader: the stem's own shoot, the first child at every node
            std::vector<int> lead{0};
            while (!N[lead.back()].children.empty()) lead.push_back(N[lead.back()].children[0]);
            const double base = g.crownBaseY, top = c.apex.y;
            double worst = 0;
            for (int id : lead) {
                const auto& p = N[id].position;
                if (p.y < base || p.y > base + 0.8 * (top - base)) continue;
                const double t = std::clamp((p.y - c.supportY) / (top - c.supportY), 0.0, 1.0);
                worst = std::max(worst, std::hypot(p.x - (c.stemX + (c.apex.x - c.stemX) * t), p.z - (c.stemZ + (c.apex.z - c.stemZ) * t)));
            }
            // the shoots leaving it: the mean of their first segments' horizontal directions
            std::vector<uint8_t> onLead(N.size(), 0);
            for (int id : lead) onLead[id] = 1;
            double bx = 0, bz = 0; int nb = 0;
            for (int id : lead) for (int ch : N[id].children) {
                if (onLead[ch]) continue;
                const double hx = N[ch].position.x - N[id].position.x, hz = N[ch].position.z - N[id].position.z, hl = std::hypot(hx, hz);
                if (hl < 1e-6) continue;
                bx += hx / hl; bz += hz / hl; ++nb;
            }
            sx += bx; sz += bz; n += nb;
            std::printf("tree %s %d hold %.3f leaderNodes %d worst %.3f apexGap %.3f laterals %d reached %.3f\\n", F.name, s, g.leaderHold, g.colonisation.leaderNodes, worst,
                        (N[lead.back()].position - c.apex).length(), nb, g.surfaceShare());
        }
    }
    std::printf("bias %.4f %.4f %d\\n", sx / n, sz / n, n);
    return 0;
}
`;
        const result = await compiler.compileSource(testCpp, { outputBinaryName: 'test_sb_veggie_leader', optimization: '-O2' });
        expect(result.success).toBe(true);
        const run = await compiler.executeBinary(path.resolve(process.cwd(), 'build/3d-native/test_sb_veggie_leader'), [], process.cwd());
        expect(run.exitCode).toBe(0);
        console.log(run.stdout);
        const rows = [...run.stdout.matchAll(/tree (\S+) (\d+) hold (\S+) leaderNodes (\d+) worst (\S+) apexGap (\S+) laterals (\d+) reached (\S+)/g)]
            .map(m => ({ form: m[1], hold: +m[3], leaderNodes: +m[4], worst: +m[5], apexGap: +m[6], laterals: +m[7], reached: +m[8] }));
        expect(rows).toHaveLength(12);
        for (const r of rows) {
            expect(r.hold).toBe(1);
            // grown on from the crown break along the stem's line, within a step of the apex, and the crown still filled
            expect(r.leaderNodes, r.form).toBeGreaterThan(10);
            expect(r.worst, r.form).toBeLessThan(0.3);
            expect(r.apexGap, r.form).toBeLessThan(0.8);
            expect(r.laterals, r.form).toBeGreaterThan(10);
            expect(r.reached, r.form).toBeGreaterThanOrEqual(0.9);
        }
        // the shoots leaving the leader start off evenly around it: the mean of their ~700 unit directions is near 0
        const [bx, bz, nb] = run.stdout.match(/bias (\S+) (\S+) (\d+)/)!.slice(1).map(Number);
        expect(nb).toBeGreaterThan(300);
        expect(Math.abs(bx)).toBeLessThan(0.08);
        expect(Math.abs(bz)).toBeLessThan(0.08);
    }, 300_000);
});
