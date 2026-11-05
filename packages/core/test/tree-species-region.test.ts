/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tree species library weighed by shape and region (user decision, 2026-11-05), on the real index and the real
 * native loader and matcher (scripts/tree_species_match.cpp over scratchbox_tree_species.hpp, compiled with clang++):
 * the loaders (TypeScript and native) refuse every new field out of range; the same crown matches a different entry
 * in New York, Seville and Singapore; an implausible entry costs more, never past the cap, and still wins on a strong
 * shape match; the seasons follow the latitude; and the larger library loads and matches fast.
 *
 * Nothing here names an entry to the matcher: where a test needs "the entry chosen", it reads the entry's own
 * continuous fields. Nothing reaches a network or a credential.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { treeSpeciesPlaceParams, validateTreeSpeciesIndex, type TreeSpeciesEntry, type TreeSpeciesIndex } from '../src/common/spatial/tree-species-library';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const INDEX_PATH = path.join(REPO, 'assets/vegetation/species/index.json');
const INDEX = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')) as TreeSpeciesIndex;
const entry = (id: string): TreeSpeciesEntry => INDEX.entries.find(e => e.id === id)!;

interface Place { lat: number; lon: number; elevationM?: number; minWinterTempC?: number; aridityIndex?: number }
const NEW_YORK: Place = { lat: 40.7359, lon: -73.9911 };
const SEVILLE: Place = { lat: 37.39, lon: -5.99 };
const SINGAPORE: Place = { lat: 1.35, lon: 103.82 };

interface Descriptor { id: number; heightM: number; aspect: number; topShare: number; hueDeg?: number; saturation?: number }
interface MatchOutput {
    entries: number;
    regions: number;
    place: { latitude: { deg: number; signed: boolean } | null; minWinterTempC: { value: number; provenance: string } | null; aridityIndex: { value: number; provenance: string } | null; regions: { label: string; membership: number }[]; note?: string };
    crowns: number;
    nsPerCrown?: number;
    leafPresence?: Record<string, number>;
    choices: { id: number; entry: string | null; nearest: string; cost: number; placeCost: number; costs?: { entry: string; cost: number; placeCost: number }[] }[];
    histogram: Record<string, number>;
}

let work: string;
let bin: string;

function placeArgs(p?: Place): string[] {
    if (!p) return [];
    const a = ['--lat-deg', String(p.lat), '--lon-deg', String(p.lon)];
    if (p.elevationM !== undefined) a.push('--elevation-m', String(p.elevationM));
    if (p.minWinterTempC !== undefined) a.push('--min-winter-temp-c', String(p.minWinterTempC));
    if (p.aridityIndex !== undefined) a.push('--aridity-index', String(p.aridityIndex));
    return a;
}

function match(crowns: Descriptor[], place?: Place, extra: string[] = [], index = INDEX_PATH): MatchOutput {
    const file = path.join(work, `d-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(crowns));
    return JSON.parse(execFileSync(bin, ['--species-index', index, '--descriptors', file, '--costs', '1', ...placeArgs(place), ...extra], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })) as MatchOutput;
}

/** The native loader's verdict on an index: '' when it loads, else what it says is wrong. */
function nativeLoad(doc: unknown): string {
    const file = path.join(work, `i-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(doc));
    const r = spawnSync(bin, ['--species-index', file], { encoding: 'utf8' });
    return r.status === 0 ? '' : r.stderr.trim();
}

const withEntry = (patch: Record<string, unknown>, base = 'red_oak'): unknown => ({ ...INDEX, entries: [{ ...entry(base), id: 'x', ...patch }] });

beforeAll(() => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tree-species-region-')));
    bin = path.join(work, 'tree_species_match');
    execFileSync(process.env.CXX || 'clang++', ['-std=c++20', '-O2', '-w', '-I', path.join(REPO, 'packages/core/src/native/3d-engine/include'), path.join(REPO, 'scripts/tree_species_match.cpp'), '-o', bin], { stdio: 'pipe' });
}, 300_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

describe('tree species library: the grown index', () => {
    it('is valid in both loaders, 50-70 entries, every one with a source and a place', () => {
        expect(validateTreeSpeciesIndex(INDEX)).toEqual([]);
        expect(nativeLoad(INDEX)).toBe('');
        expect(INDEX.entries.length).toBeGreaterThanOrEqual(50);
        expect(INDEX.entries.length).toBeLessThanOrEqual(70);
        expect(INDEX.regions!.length).toBeGreaterThanOrEqual(20);
        for (const e of INDEX.entries) {
            expect(e.sources.length, e.id).toBeGreaterThan(0);
            // a single-stemmed tree says where it grows; the generic garden forms (many stems) grow everywhere
            if (e.stems === 1) {
                expect(e.latRangesDeg?.length, e.id).toBeGreaterThan(0);
                expect(e.usdaZones, e.id).toBeDefined();
                expect(e.aridityIndexRange, e.id).toBeDefined();
                expect(Object.keys(e.regionWeights ?? {}).length, e.id).toBeGreaterThan(0);
                expect(Math.max(...Object.values(e.regionWeights!)), e.id).toBeGreaterThanOrEqual(0.9);
                expect(e.leafRetention, e.id).toBeDefined();
                // a tree that drops all its leaves in a cold winter says when
                if (e.leafRetention === 0) expect(e.leafOutMonth, e.id).toBeDefined();
            }
        }
    });

    it('both loaders refuse every new field out of range, naming it', () => {
        const cases: [Record<string, unknown>, string][] = [
            [{ latRangesDeg: [[10, -10]] }, 'latRangesDeg'],
            [{ latRangesDeg: [[-100, 10]] }, 'latRangesDeg'],
            [{ latRangesDeg: [] }, 'latRangesDeg'],
            [{ latRangesDeg: [[0, 30]], latAbsRangeDeg: [0, 30] }, 'both latAbsRangeDeg and latRangesDeg'],
            [{ usdaZones: [9, 5] }, 'usdaZones'],
            [{ usdaZones: [0, 5] }, 'usdaZones'],
            [{ usdaZones: [5, 14] }, 'usdaZones'],
            [{ aridityIndexRange: [2, 0.5] }, 'aridityIndexRange'],
            [{ aridityIndexRange: [0, 1] }, 'aridityIndexRange'],
            [{ regionWeights: { atlantis: 1 } }, 'atlantis'],
            [{ regionWeights: { [INDEX.regions![0].id]: 1.5 } }, `regionWeights.${INDEX.regions![0].id}`],
            [{ regionWeights: [1] }, 'regionWeights'],
            [{ leafRetention: 1.2 }, 'leafRetention'],
            [{ leafOutMonth: 4.5, leafFallMonth: undefined }, 'leafOutMonth'],
            [{ leafOutMonth: 11, leafFallMonth: 4 }, 'leafFallMonth'],
            [{ leafOutMonth: 0.5, leafFallMonth: 11 }, 'leafOutMonth'],
            [{ autumnHueDeg: [30] }, 'autumnHueDeg'],
            [{ autumnHueDeg: [30, 200] }, 'autumnHueDeg'],
            [{ sources: [] }, 'sources'],
            [{ sources: undefined }, 'sources'],
            [{ sources: [''] }, 'sources'],
            [{ estimated: [3] }, 'estimated']
        ];
        for (const [patch, names] of cases) {
            const doc = withEntry(patch);
            const ts = validateTreeSpeciesIndex(doc);
            expect(ts.join('; '), `TypeScript on ${JSON.stringify(patch)}`).toContain(names);
            expect(nativeLoad(doc), `native on ${JSON.stringify(patch)}`).toContain(names);
        }
        // and the place table itself
        const region = INDEX.regions![0];
        const regionCases: [Record<string, unknown>, string][] = [
            [{ latDeg: [50, 40] }, 'latDeg'],
            [{ lonDeg: [-200, 0] }, 'lonDeg'],
            [{ minWinterTempC: [-10] }, 'minWinterTempC'],
            [{ minWinterTempC: [-10, 60] }, 'minWinterTempC'],
            [{ aridityIndex: 0 }, 'aridityIndex'],
            [{ referenceElevationM: 9000 }, 'referenceElevationM'],
            [{ label: '' }, 'label']
        ];
        for (const [patch, names] of regionCases) {
            const doc = { ...INDEX, regions: [{ ...region, ...patch }, ...INDEX.regions!.slice(1)] };
            expect(validateTreeSpeciesIndex(doc).join('; '), `TypeScript on region ${JSON.stringify(patch)}`).toContain(names);
            expect(nativeLoad(doc), `native on region ${JSON.stringify(patch)}`).toContain(names);
        }
        const twice = { ...INDEX, regions: [region, region] };
        expect(validateTreeSpeciesIndex(twice).join('; ')).toContain(`region ${region.id} is listed twice`);
        expect(nativeLoad(twice)).toContain(`region ${region.id} is listed twice`);
        for (const [k, v] of [['regionWeightElsewhere', 2], ['regionEdgeDeg', 0]] as const) {
            expect(validateTreeSpeciesIndex({ ...INDEX, [k]: v }).join('; ')).toContain(k);
            expect(nativeLoad({ ...INDEX, [k]: v })).toContain(k);
        }
    });

    it('an index written before the region fields still loads natively when its entries name a source', () => {
        const old = { schema: INDEX.schema, entries: [{ ...entry('date_palm'), latRangesDeg: undefined, usdaZones: undefined, aridityIndexRange: undefined, regionWeights: undefined, latAbsRangeDeg: [0, 33] }] };
        expect(nativeLoad(old)).toBe('');
        expect(validateTreeSpeciesIndex(old)).toEqual([]);
    });
});

describe('tree species chosen by shape and region', () => {
    // one broad green dome, 10 m tall, 4.5 m in radius: a shape many broadleaves have
    const DOME: Descriptor = { id: 7, heightM: 10, aspect: 0.45, topShare: 0.55, hueDeg: 110, saturation: 0.3 };
    // a tall bare stem under a small rounded head: a palm's shape
    const PALM: Descriptor = { id: 8, heightM: 15, aspect: 0.2, topShare: 0.5, hueDeg: 100, saturation: 0.3 };

    const regionOf = (place: Place): string => {
        // the region whose box holds the place (the test's own geometry, to read the chosen entry's weight there)
        const r = INDEX.regions!.find(g => place.lat >= g.latDeg[0] && place.lat <= g.latDeg[1] && place.lon >= g.lonDeg[0] && place.lon <= g.lonDeg[1]);
        expect(r, `a region for ${place.lat}, ${place.lon}`).toBeDefined();
        return r!.id;
    };

    it('resolves a place to an estimated climate, labelled as an estimate, and takes a measured one as given', () => {
        const ny = match([DOME], NEW_YORK).place, se = match([DOME], SEVILLE).place, sg = match([DOME], SINGAPORE).place;
        // New York about zone 7 (-18..-12 C), Seville about zone 10a (-1..2 C), Singapore frost-free; each within a zone
        expect(ny.minWinterTempC!.value).toBeGreaterThan(-20);
        expect(ny.minWinterTempC!.value).toBeLessThan(-10);
        expect(se.minWinterTempC!.value).toBeGreaterThan(-5);
        expect(se.minWinterTempC!.value).toBeLessThan(4);
        expect(sg.minWinterTempC!.value).toBeGreaterThan(15);
        expect(se.aridityIndex!.value).toBeLessThan(ny.aridityIndex!.value);
        expect(sg.aridityIndex!.value).toBeGreaterThan(ny.aridityIndex!.value);
        for (const p of [ny, se, sg]) {
            expect(p.minWinterTempC!.provenance).toBe('generated');
            expect(p.aridityIndex!.provenance).toBe('generated');
            expect(p.regions.length).toBeGreaterThan(0);
        }
        // higher up is colder, by the lapse rate
        const high = match([DOME], { ...SEVILLE, elevationM: 2000 }).place;
        expect(se.minWinterTempC!.value - high.minWinterTempC!.value).toBeCloseTo(13, 0);
        // a measured value is used as given and labelled so
        const given = match([DOME], { ...NEW_YORK, minWinterTempC: -14.2, aridityIndex: 1.1 }).place;
        expect(given.minWinterTempC).toEqual({ value: -14.2, provenance: 'given' });
        expect(given.aridityIndex).toEqual({ value: 1.1, provenance: 'given' });
        // no place: by shape alone, and it says so
        const nowhere = match([DOME]).place;
        expect(nowhere.latitude).toBeNull();
        expect(nowhere.note).toContain('shape alone');
        // the open ocean is in no region: latitude alone
        const ocean = match([DOME], { lat: -50, lon: -140 }).place;
        expect(ocean.minWinterTempC).toBeNull();
        expect(ocean.note).toContain('latitude alone');
    });

    it('the same crown matches a different entry in New York, Seville and Singapore, each one at home there', () => {
        const picks = [NEW_YORK, SEVILLE, SINGAPORE].map(place => {
            const out = match([DOME], place);
            const c = out.choices[0];
            expect(c.entry, 'matched').not.toBeNull();
            // the entry chosen is common where the build is, and plausible there
            expect(entry(c.entry!).regionWeights![regionOf(place)], `${c.entry} at ${place.lat}`).toBeGreaterThanOrEqual(0.8);
            expect(c.placeCost).toBeLessThan(0.5);
            return c.entry!;
        });
        expect(new Set(picks).size).toBe(3);
        // by region, not by seed: each city's pick costs more in the other two than at home
        for (const [i, place] of [NEW_YORK, SEVILLE, SINGAPORE].entries()) {
            const costs = match([DOME], place).choices[0].costs!;
            const at = (id: string) => costs.find(c => c.entry === id)!.placeCost;
            for (const [k, other] of picks.entries()) if (k !== i) expect(at(other), `${other} at city ${i}`).toBeGreaterThan(at(picks[i]));
        }
        // the shape is the same everywhere: the chosen entries all have that shape
        for (const id of picks) {
            expect(entry(id).crownRadiusPerHeight).toBeGreaterThan(0.3);
            expect(entry(id).crownRadiusPerHeight).toBeLessThan(0.65);
            expect(entry(id).topShare).toBeGreaterThan(0.4);
        }
        // the equator's pick is evergreen, New York's drops its leaves
        expect(entry(picks[2]).leafRetention).toBe(1);
        expect(entry(picks[0]).leafRetention).toBe(0);
    });

    it('a palm-shaped crown is a palm in Seville and Singapore and not in New York', () => {
        const palmLike = (id: string) => entry(id).crownBaseRatio >= 0.75 && entry(id).leafLengthM >= 1;
        const ny = match([PALM], NEW_YORK).choices[0], se = match([PALM], SEVILLE).choices[0], sg = match([PALM], SINGAPORE).choices[0];
        expect(palmLike(se.entry!), se.entry!).toBe(true);
        expect(palmLike(sg.entry!), sg.entry!).toBe(true);
        expect(ny.entry).not.toBeNull();
        expect(palmLike(ny.entry!), ny.entry!).toBe(false);
        // and without any place the shape alone picks a palm, as before
        expect(palmLike(match([PALM]).choices[0].entry!)).toBe(true);
        // the legacy unsigned latitude alone still keeps the palm out well past its bands (London's latitude, either
        // hemisphere); at New York's it cannot tell New York from Barcelona, so it only costs the palm more
        expect(palmLike(match([PALM], undefined, ['--lat-abs-deg', '52']).choices[0].entry!)).toBe(false);
        const legacy = match([PALM], undefined, ['--lat-abs-deg', '40.7']);
        expect(legacy.place.latitude).toEqual({ deg: 40.7, signed: false });
        expect(legacy.place.note).toContain('latitude alone');
        for (const c of legacy.choices[0].costs!.filter(x => palmLike(x.entry))) expect(c.placeCost, c.entry).toBeGreaterThan(0.5);
    });

    it('an implausible entry costs more, never past the cap, and still wins on a strong shape match', () => {
        const cap = 4.0;
        const all = (place?: Place) => match([PALM], place).choices[0].costs!;
        const palms = INDEX.entries.filter(e => e.crownBaseRatio >= 0.75 && e.leafLengthM >= 1).map(e => e.id);
        expect(palms.length).toBeGreaterThanOrEqual(3);
        for (const id of palms) {
            const none = all().find(c => c.entry === id)!, ny = all(NEW_YORK).find(c => c.entry === id)!, pole = all({ lat: 68, lon: 25 }).find(c => c.entry === id)!;
            expect(none.placeCost).toBe(0);
            expect(ny.placeCost, id).toBeGreaterThan(1);
            // further from home costs more still, and the cost is bounded: never forbidden
            expect(pole.placeCost, id).toBeGreaterThanOrEqual(ny.placeCost);
            expect(pole.placeCost, id).toBeLessThanOrEqual(cap + 1e-9);
            // the shape part of the cost does not move with the place
            expect(ny.cost - ny.placeCost).toBeCloseTo(none.cost - none.placeCost, 4);
        }
        // a library of one palm and one broad oak: in New York the palm is implausible, but its shape fits so much
        // better than the oak's that it still wins, matched
        palms.sort((a, b) => entry(a).crownRadiusPerHeight - entry(b).crownRadiusPerHeight);
        const two = { ...INDEX, entries: [entry(palms[0]), entry('red_oak')] };
        const file = path.join(work, 'two.json');
        fs.writeFileSync(file, JSON.stringify(two));
        const exact: Descriptor = { id: 1, heightM: 15, aspect: entry(palms[0]).crownRadiusPerHeight, topShare: entry(palms[0]).topShare };
        const c = match([exact], NEW_YORK, [], file).choices[0];
        expect(c.entry).toBe(palms[0]);
        expect(c.placeCost).toBeGreaterThan(1);
        expect(c.cost).toBeLessThan(6);
        expect(c.costs!.find(x => x.entry === 'red_oak')!.cost).toBeGreaterThan(c.cost);
    });

    it('the southern hemisphere is read with its sign: a species of the south costs nothing there and more in the north', () => {
        const crowns = [DOME];
        const sydney = match(crowns, { lat: -33.87, lon: 151.21 }).choices[0].costs!, tokyo = match(crowns, { lat: 35.68, lon: 139.69 }).choices[0].costs!;
        // the entry most at home in Sydney's region and absent from Tokyo's, by its own weights
        const sydneyRegion = regionOf({ lat: -33.87, lon: 151.21 }), tokyoRegion = regionOf({ lat: 35.68, lon: 139.69 });
        const southern = INDEX.entries.filter(e => (e.regionWeights?.[sydneyRegion] ?? 0) >= 1 && e.regionWeights?.[tokyoRegion] === undefined);
        expect(southern.length).toBeGreaterThan(0);
        for (const e of southern) {
            expect(sydney.find(c => c.entry === e.id)!.placeCost, e.id).toBeLessThan(0.3);
            expect(tokyo.find(c => c.entry === e.id)!.placeCost, e.id).toBeGreaterThan(1);
        }
    });

    it('leaf presence follows the season and the latitude (Hopkins), evergreens keep their leaves', () => {
        const at = (place: Place, month: number) => match([], place, ['--month', String(month)]).leafPresence!;
        const nyJan = at(NEW_YORK, 1), nyJul = at(NEW_YORK, 7), sydJan = at({ lat: -33.87, lon: 151.21 }, 1), sydJul = at({ lat: -33.87, lon: 151.21 }, 7);
        const deciduous = INDEX.entries.filter(e => e.leafRetention === 0 && e.leafOutMonth !== undefined), evergreen = INDEX.entries.filter(e => e.leafRetention === 1);
        expect(deciduous.length).toBeGreaterThan(20);
        expect(evergreen.length).toBeGreaterThan(10);
        for (const e of deciduous) {
            expect(nyJan[e.id], e.id).toBe(0);
            expect(nyJul[e.id], e.id).toBe(1);
            expect(sydJan[e.id], e.id).toBe(1);
            expect(sydJul[e.id], e.id).toBe(0);
        }
        for (const e of evergreen) for (const m of [nyJan, nyJul, sydJan, sydJul]) expect(m[e.id], e.id).toBe(1);
        // mid-April: further north the same tree has fewer leaves out
        const south = at({ lat: 35, lon: -80 }, 4.5), north = at({ lat: 47, lon: -71 }, 4.5);
        const e = deciduous.find(d => d.leafOutMonth! >= 4.4 && d.leafOutMonth! <= 4.8)!;
        expect(south[e.id]).toBeGreaterThan(north[e.id]);
    });

    it('the larger library still loads and matches fast', () => {
        const crowns: Descriptor[] = [];
        for (let i = 0; i < 5000; i++) crowns.push({ id: i, heightM: 2 + (i * 37 % 300) / 10, aspect: 0.08 + (i * 53 % 80) / 100, topShare: (i * 29 % 100) / 100, hueDeg: 80 + (i * 17 % 50), saturation: 0.2 });
        const file = path.join(work, 'many.json');
        fs.writeFileSync(file, JSON.stringify(crowns));
        const t0 = Date.now();
        const out = JSON.parse(execFileSync(bin, ['--species-index', INDEX_PATH, '--descriptors', file, '--repeat', '20', ...placeArgs(NEW_YORK)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })) as MatchOutput;
        const wallMs = Date.now() - t0;
        expect(out.crowns).toBe(5000);
        expect(out.entries).toBe(INDEX.entries.length);
        // 100,000 matches against the whole library and the index parsed, well inside a second each on any machine;
        // the matcher itself under a millisecond a crown even on a machine under heavy load (a few microseconds on an idle one)
        expect(out.nsPerCrown!).toBeLessThan(1_000_000);
        expect(wallMs).toBeLessThan(15_000);
        const loadOnly = Date.now();
        execFileSync(bin, ['--species-index', INDEX_PATH]);
        expect(Date.now() - loadOnly).toBeLessThan(3000);
        // every crown got an answer, and the choice is the same on a second run
        const again = JSON.parse(execFileSync(bin, ['--species-index', INDEX_PATH, '--descriptors', file, ...placeArgs(NEW_YORK)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })) as MatchOutput;
        expect(again.choices.map(c => c.entry)).toEqual(out.choices.map(c => c.entry));
        expect(Object.values(out.histogram).reduce((a, b) => a + b, 0)).toBe(5000);
    });
});

describe('the build passes its place to the species choice', () => {
    it('treeSpeciesPlaceParams carries the signed place, and the elevation only when it is known', () => {
        expect(treeSpeciesPlaceParams({ lat: -33.87, lng: 151.21 })).toEqual({ latAbsDeg: 33.87, latDeg: -33.87, lonDeg: 151.21 });
        expect(treeSpeciesPlaceParams({ lat: 40.7, lng: -74, elevation: 12 })).toEqual({ latAbsDeg: 40.7, latDeg: 40.7, lonDeg: -74, elevationM: 12 });
        expect(treeSpeciesPlaceParams({ lat: 40.7, lng: -74, elevation: Number.NaN })).toEqual({ latAbsDeg: 40.7, latDeg: 40.7, lonDeg: -74 });
    });

    it('the staged build gives strip and plant the same place', () => {
        const src = fs.readFileSync(path.join(REPO, 'packages/core/src/node/3d-engine/staged-location/orchestrator.ts'), 'utf8');
        expect(src).toContain('params: treeSpeciesPlaceParams(run.geoAnchor)');
        expect(src).toContain('place: treeSpeciesPlaceParams(run.geoAnchor)');
    });
});
