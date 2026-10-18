/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Puts synthesized PBR texture sets onto the parts of a GLB by box projection (see glb-box-projection.ts).
 *
 * The caller names the material of each part (`partMaterials`) or leaves parts to the request-level material. One
 * texture set is synthesized per distinct (archetype, descriptor, resolution, seed) and shared by the parts that use
 * it; the number of sets, their resolution and their total texels are capped. Everything that was decided here rather
 * than asked for (a default material, a derived tile size, a dropped vertex colour) is listed in `inferred`.
 */

import type { ContinuousMaterialDescriptor } from '../../common/adaptive-material-types';
import {
    AdaptivePbrBudgetError,
    AdaptivePbrInputError,
    AdaptivePbrMaterialSpecError,
    PbrUnknownArchetypeError,
    AdaptivePbrTextureSynthesisError
} from './adaptive-pbr-errors';
import {
    applyBoxProjectionMaterials,
    inspectScene,
    resolvePartSelections,
    BOX_PROJECTION_UV_CONVENTION,
    type BoxProjectionReport,
    type BoxProjectionTextureSet,
    type ScenePartInfo
} from './glb-box-projection';

/** Bounds on memory and time: a raw synthesized set costs about 33 bytes per texel before it is compressed to PNG. */
export const BOX_PROJECTION_CAPS = {
    maxDistinctTextureSets: 12,
    maxResolutionPx: 4096,
    minResolutionPx: 16,
    /** Sum of width x height over all distinct sets (64 Mtexel is sixteen 1K, or four 2K ... or one 8K-wide: 4096^2 x 4). */
    maxTotalTexels: 64 * 1024 * 1024
} as const;

export interface PartMaterialAssignment {
    /** Node or mesh names exactly as the scene lists them (strings) or node indices (numbers). Naming a group names what is under it. */
    nodes: Array<string | number>;
    /** A catalog archetype id, key or display name. Exact; an unknown name is an error, not a nearby material. */
    materialArchetype?: string | number;
    /** Continuous descriptor fields. Over `materialArchetype` they override it; alone they must give albedoLinear, conduction and roughnessBaseline. */
    descriptor?: Partial<ContinuousMaterialDescriptor>;
    /** Edge length of one texture tile in metres for these parts. */
    tileSizeMeters?: number;
}

export interface BoxProjectionPbrRequest {
    glb: Buffer;
    /** The material of parts no `partMaterials` entry names. Neither given: indiana_limestone, and the result says so. */
    materialArchetype?: string | number;
    descriptor?: Partial<ContinuousMaterialDescriptor>;
    /** Square texture size in pixels, per set. */
    resolutionPx: number;
    seed?: number;
    /** Tile size in metres for every part that does not give its own. Otherwise derived per group. */
    tileSizeMeters?: number;
    partMaterials?: PartMaterialAssignment[];
    preserveExistingUvs?: boolean;
    preserveVertexColors?: boolean;
}

export interface TileSizeRecord {
    meters: number;
    source: 'part' | 'request' | 'derived';
    texelsPerMeter: number;
    /** Present for 'derived'. */
    derivation?: { characteristicLengthMeters: number; fissureScale: number; formula: string };
}

export interface BoxProjectionGroupReport {
    name: string;
    /** Index into partMaterials, or null for the parts no entry names. */
    entryIndex: number | null;
    nodes: Array<{ nodeIndex: number; nodeName?: string; meshName?: string; triangles: number }>;
    textureSet: string;
    tileSize: TileSizeRecord;
}

export interface BoxProjectionTextureSetReport {
    label: string;
    resolutionPx: number;
    seed: number;
    archetypeKey?: string;
    archetypeId?: number;
    descriptor: Partial<ContinuousMaterialDescriptor>;
    /** Descriptor fields nobody set; the synthesizer applies its own defaults to them. */
    unspecifiedDescriptorFields: string[];
    materialSource: 'archetype' | 'archetype_with_descriptor_overrides' | 'descriptor';
    synthesizer: 'native-cpp20';
    /** Measured wall time of synthesizing this set, and its phases as the native service measured them. */
    synthesisMs: number;
    synthesisTimings: { compileMs: number; compileCacheHit: boolean; kernelMs: number; readbackMs: number };
    encodeMs: number;
    pngBytes: { albedo: number; normal: number; orm: number };
    usedByGroups: string[];
}

export interface BoxProjectionPbrResult {
    glbBuffer: Buffer;
    report: BoxProjectionReport;
    groups: BoxProjectionGroupReport[];
    textureSets: BoxProjectionTextureSetReport[];
    /** The encoded maps per set, for MaterialX / USDZ export. Kept apart from the JSON-safe reports. */
    texturePngs: Array<{ label: string; archetypeKey?: string; descriptor: Partial<ContinuousMaterialDescriptor>; albedo: Buffer; normal: Buffer; orm: Buffer }>;
    caps: typeof BOX_PROJECTION_CAPS;
    /** Every decision made here that the request did not specify, in plain words. */
    inferred: string[];
}

const VEC3_KEYS = ['albedoLinear', 'secondaryAlbedo'] as const;
const SCALAR_KEYS = [
    'secondaryWeight', 'conduction', 'roughnessBaseline', 'microPorosity', 'normalStrength', 'fissureScale', 'fissureDepth',
    'fbmOctaves', 'fbmGain', 'cellularWeight', 'graininess', 'anisotropyStrength', 'anisotropyAngleRad', 'aoStrength'
] as const;
const DESCRIPTOR_KEYS: readonly string[] = [...VEC3_KEYS, ...SCALAR_KEYS];
const REQUIRED_WITHOUT_ARCHETYPE = ['albedoLinear', 'conduction', 'roughnessBaseline'] as const;

const RESOLUTION_TIERS: Record<string, number> = { '1K': 1024, '2K': 2048, '4K': 4096, '8K': 8192, '12K': 12288 };

/** px of a tier name ("1K".."12K"). Unknown names are an error rather than a guess. */
export function resolutionTierToPx(tier: string): number {
    const px = RESOLUTION_TIERS[String(tier).trim().toUpperCase()];
    if (px === undefined) {
        throw new AdaptivePbrMaterialSpecError(`Unknown resolution ${JSON.stringify(tier)}; use one of ${Object.keys(RESOLUTION_TIERS).join(', ')} or a pixel count`, { resolution: tier });
    }
    return px;
}

interface ResolvedSpec {
    descriptor: Partial<ContinuousMaterialDescriptor>;
    archetypeKey?: string;
    archetypeId?: number;
    source: BoxProjectionTextureSetReport['materialSource'];
}

type NativeService = import('./native-material-pbr-service').NativeMaterialPbrService;

function validateDescriptorOverrides(where: string, raw: unknown): Partial<ContinuousMaterialDescriptor> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new AdaptivePbrMaterialSpecError(`${where}.descriptor must be an object of continuous descriptor fields (${DESCRIPTOR_KEYS.join(', ')})`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!DESCRIPTOR_KEYS.includes(key)) {
            throw new AdaptivePbrMaterialSpecError(`${where}.descriptor has the unknown field ${JSON.stringify(key)}; the fields are ${DESCRIPTOR_KEYS.join(', ')}`, { field: key });
        }
        if ((VEC3_KEYS as readonly string[]).includes(key)) {
            if (!Array.isArray(value) || value.length !== 3 || !value.every(v => typeof v === 'number' && Number.isFinite(v))) {
                throw new AdaptivePbrMaterialSpecError(`${where}.descriptor.${key} must be three finite numbers [r, g, b]`, { field: key, value });
            }
            out[key] = [value[0], value[1], value[2]];
        } else {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                throw new AdaptivePbrMaterialSpecError(`${where}.descriptor.${key} must be a finite number, got ${JSON.stringify(value)}`, { field: key, value });
            }
            out[key] = value;
        }
    }
    return out as Partial<ContinuousMaterialDescriptor>;
}

function resolveMaterialSpec(service: NativeService, where: string, archetype: unknown, descriptor: unknown): ResolvedSpec {
    let base: ContinuousMaterialDescriptor | undefined;
    let archetypeKey: string | undefined;
    let archetypeId: number | undefined;
    if (archetype !== undefined && archetype !== null) {
        if (typeof archetype !== 'string' && typeof archetype !== 'number') {
            throw new AdaptivePbrMaterialSpecError(`${where}.materialArchetype must be a catalog key, display name or id`);
        }
        const entry = service.findArchetype(archetype);
        if (!entry) {
            throw new PbrUnknownArchetypeError(archetype, service.get50Catalog().map(e => e.key), ` at ${where} (no nearby material is substituted)`);
        }
        base = service.getAnchorDescriptor(entry.archetypeId);
        archetypeKey = entry.key;
        archetypeId = entry.archetypeId;
    }
    const overrides = descriptor !== undefined && descriptor !== null ? validateDescriptorOverrides(where, descriptor) : undefined;
    if (!base && !overrides) {
        // No material is assumed: the caller reads a descriptor from the user's words (or names a catalog example).
        throw new AdaptivePbrMaterialSpecError(
            `${where}: no material given. Pass a descriptor with ${REQUIRED_WITHOUT_ARCHETYPE.join(', ')} (read from the user's description of the surface), or a materialArchetype naming a catalog example.`,
            { missing: [...REQUIRED_WITHOUT_ARCHETYPE] }
        );
    }
    if (!base) {
        const missing = REQUIRED_WITHOUT_ARCHETYPE.filter(k => (overrides as Record<string, unknown>)[k] === undefined);
        if (missing.length) {
            throw new AdaptivePbrMaterialSpecError(
                `${where}: a descriptor without a materialArchetype must give ${REQUIRED_WITHOUT_ARCHETYPE.join(', ')}; missing ${missing.join(', ')}. Name an archetype to override only some fields.`,
                { missing }
            );
        }
        return { descriptor: overrides!, source: 'descriptor' };
    }
    return { descriptor: { ...base, ...(overrides ?? {}) }, archetypeKey, archetypeId, source: overrides ? 'archetype_with_descriptor_overrides' : 'archetype' };
}

function canonicalKey(spec: ResolvedSpec, px: number, seed: number): string {
    const d = spec.descriptor as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    Object.keys(d).sort().forEach(k => { sorted[k] = d[k]; });
    return JSON.stringify({ d: sorted, px, seed });
}

function median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function safeLabel(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'material';
}

function checkPositiveMeters(where: string, value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new AdaptivePbrMaterialSpecError(`${where}.tileSizeMeters must be a positive number of metres, got ${JSON.stringify(value)}`, { value });
    }
    return value;
}

const TILE_FORMULA = 'tile = clamp(fissureScale, 1, 64) x characteristicLength / 16: the descriptor says how many fissure cells one tile holds, and a cell is taken to be 1/16 of the median part size';

export async function runBoxProjectionPbr(req: BoxProjectionPbrRequest): Promise<BoxProjectionPbrResult> {
    const caps = BOX_PROJECTION_CAPS;
    const px = req.resolutionPx;
    if (!Number.isInteger(px) || px < caps.minResolutionPx) {
        throw new AdaptivePbrMaterialSpecError(`Texture resolution must be a whole number of pixels from ${caps.minResolutionPx} to ${caps.maxResolutionPx}, got ${px}`, { resolutionPx: px });
    }
    if (px > caps.maxResolutionPx) {
        throw new AdaptivePbrBudgetError(
            `A ${px}px texture set exceeds the cap of ${caps.maxResolutionPx}px per set for mesh application (about 33 bytes of raw maps per texel are held while a set is built). Ask for ${caps.maxResolutionPx}px or less.`,
            { requested: px, maxResolutionPx: caps.maxResolutionPx }
        );
    }
    const seed = req.seed ?? 42;
    const inferred: string[] = [];

    const scene = inspectScene(req.glb);
    const geometryParts = scene.parts.filter(p => p.trianglePrimitives > 0);
    if (geometryParts.length === 0) throw new AdaptivePbrInputError('This GLB renders no triangle primitives, so there is nothing to texture.');

    const partMaterials = req.partMaterials ?? [];
    if (!Array.isArray(partMaterials) || partMaterials.some(e => e === null || typeof e !== 'object')) {
        throw new AdaptivePbrMaterialSpecError('partMaterials must be an array of { nodes, materialArchetype?, descriptor?, tileSizeMeters? } objects');
    }
    const selection = resolvePartSelections(scene, partMaterials);

    const { NativeMaterialPbrService } = await import('./native-material-pbr-service');
    const service = new NativeMaterialPbrService();

    // Groups: one per partMaterials entry that governs some geometry, plus the parts nothing names
    interface Group { name: string; entryIndex: number | null; parts: ScenePartInfo[]; spec: ResolvedSpec; setIndex: number; tile: TileSizeRecord }
    const groups: Group[] = [];
    const requestTile = checkPositiveMeters('request', req.tileSizeMeters);
    const make = (name: string, entryIndex: number | null, parts: ScenePartInfo[], spec: ResolvedSpec, explicitTile: number | undefined, tileSource: 'part' | 'request'): Group => ({
        name, entryIndex, parts, spec, setIndex: -1,
        tile: { meters: explicitTile ?? NaN, source: explicitTile !== undefined ? tileSource : 'derived', texelsPerMeter: NaN }
    });
    partMaterials.forEach((entry, i) => {
        const parts = geometryParts.filter(p => selection.entryOfNode.get(p.nodeIndex) === i);
        if (!parts.length) return;
        const where = `partMaterials[${i}]`;
        const ownTile = checkPositiveMeters(where, entry.tileSizeMeters);
        const spec = (entry.materialArchetype === undefined && entry.descriptor === undefined)
            ? resolveMaterialSpec(service, where, req.materialArchetype, req.descriptor) // names parts only: they take the request-level material
            : resolveMaterialSpec(service, where, entry.materialArchetype, entry.descriptor);
        groups.push(make(where, i, parts, spec, ownTile ?? requestTile, ownTile !== undefined ? 'part' : 'request'));
    });
    const unassigned = geometryParts.filter(p => !selection.entryOfNode.has(p.nodeIndex));
    if (unassigned.length) {
        groups.push(make('parts no partMaterials entry names', null, unassigned, resolveMaterialSpec(service, 'request', req.materialArchetype, req.descriptor), requestTile, 'request'));
    }

    // Distinct texture sets and the caps on them
    const setIndexByKey = new Map<string, number>();
    const setSpecs: Array<{ spec: ResolvedSpec; groups: Group[] }> = [];
    for (const g of groups) {
        const key = canonicalKey(g.spec, px, seed);
        let idx = setIndexByKey.get(key);
        if (idx === undefined) {
            idx = setSpecs.length;
            setIndexByKey.set(key, idx);
            setSpecs.push({ spec: g.spec, groups: [] });
        }
        setSpecs[idx].groups.push(g);
        g.setIndex = idx;
    }
    if (setSpecs.length > caps.maxDistinctTextureSets) {
        throw new AdaptivePbrBudgetError(
            `partMaterials ask for ${setSpecs.length} distinct materials (archetype + descriptor); the cap is ${caps.maxDistinctTextureSets} texture sets per call. Give parts that should look alike the same archetype and descriptor so they share one set.`,
            { distinctSets: setSpecs.length, maxDistinctTextureSets: caps.maxDistinctTextureSets }
        );
    }
    const totalTexels = setSpecs.length * px * px;
    if (totalTexels > caps.maxTotalTexels) {
        throw new AdaptivePbrBudgetError(
            `${setSpecs.length} sets of ${px}x${px} are ${totalTexels} texels; the cap is ${caps.maxTotalTexels} texels over all sets of one call. Lower the resolution or use fewer distinct materials.`,
            { totalTexels, maxTotalTexels: caps.maxTotalTexels }
        );
    }

    // Tile sizes. A derived size comes from the group's own parts and descriptor, and is labelled as derived.
    const extentOfInstance = new Map<number, number[]>();
    scene.instances.forEach((inst, i) => {
        const e = scene.instanceExtentsMeters[i];
        if (e > 0) extentOfInstance.set(inst.nodeIndex, [...(extentOfInstance.get(inst.nodeIndex) ?? []), e]);
    });
    for (const g of groups) {
        if (g.tile.source !== 'derived') {
            g.tile.texelsPerMeter = px / g.tile.meters;
            continue;
        }
        const extents = g.parts.flatMap(p => extentOfInstance.get(p.nodeIndex) ?? []);
        if (!extents.length) throw new AdaptivePbrInputError(`${g.name}: its parts have no extent, so no tile size can be derived; pass tileSizeMeters`);
        const characteristic = median(extents);
        const fissureScale = Math.min(64, Math.max(1, (g.spec.descriptor.fissureScale as number | undefined) ?? 8));
        const meters = (fissureScale * characteristic) / 16;
        g.tile = {
            meters, source: 'derived', texelsPerMeter: px / meters,
            derivation: { characteristicLengthMeters: characteristic, fissureScale, formula: TILE_FORMULA }
        };
        inferred.push(`${g.name}: tile size ${meters.toPrecision(3)} m is derived, not asked for (median part ${characteristic.toPrecision(3)} m x fissureScale ${fissureScale} / 16); pass tileSizeMeters to set it`);
    }

    // Synthesize and encode one set at a time so only one set's raw maps are in memory
    const { AdaptiveMaterialPbrService } = await import('./adaptive-material-pbr-service');
    const textureSets: BoxProjectionTextureSetReport[] = [];
    const texturePngs: BoxProjectionPbrResult['texturePngs'] = [];
    const sets: BoxProjectionTextureSet[] = [];
    for (let i = 0; i < setSpecs.length; i++) {
        const { spec, groups: users } = setSpecs[i];
        const label = `${safeLabel(spec.archetypeKey ?? 'custom_descriptor')}_set${i}`;
        const started = Date.now();
        let synthesized;
        try {
            synthesized = await service.synthesizeContinuousManifoldPbr(spec.descriptor as ContinuousMaterialDescriptor, { width: px, height: px, seed });
        } catch (err) {
            if (err instanceof AdaptivePbrTextureSynthesisError) throw err; // already typed (compile / run / output stage)
            throw new AdaptivePbrTextureSynthesisError(`Texture set "${label}" (${spec.archetypeKey ?? 'custom descriptor'}, ${px}px) could not be synthesized: ${(err as Error)?.message ?? err}`, { label, px, cause: String(err) });
        }
        const synthesisMs = Date.now() - started;
        const encodeStarted = Date.now();
        const texels = px * px;
        const sizes: Array<[string, number, number]> = [['albedoRgba', synthesized.albedoRgba?.length, texels * 4], ['normalRgba', synthesized.normalRgba?.length, texels * 4], ['ormRgba', synthesized.ormRgba?.length, texels * 4]];
        for (const [name, got, want] of sizes) {
            if (got !== want) {
                throw new AdaptivePbrTextureSynthesisError(`Texture set "${label}": the synthesizer returned ${got ?? 0} bytes of ${name} for a ${px}x${px} set (expected ${want}); it delivered an incomplete map`, { label, name, got, want });
            }
        }
        let albedo: Buffer, normal: Buffer, orm: Buffer;
        try {
            [albedo, normal, orm] = await Promise.all([
                AdaptiveMaterialPbrService.encodeFromRgba(synthesized.albedoRgba, px, px, true),
                AdaptiveMaterialPbrService.encodeFromRgba(synthesized.normalRgba, px, px, true),
                AdaptiveMaterialPbrService.encodeFromRgba(synthesized.ormRgba, px, px, true)
            ]);
        } catch (err) {
            throw new AdaptivePbrTextureSynthesisError(`Texture set "${label}": PNG encoding failed: ${(err as Error)?.message ?? err}`, { label, cause: String(err) });
        }
        const unspecified = DESCRIPTOR_KEYS.filter(k => (spec.descriptor as Record<string, unknown>)[k] === undefined);
        textureSets.push({
            label, resolutionPx: px, seed, archetypeKey: spec.archetypeKey, archetypeId: spec.archetypeId,
            descriptor: spec.descriptor, unspecifiedDescriptorFields: unspecified, materialSource: spec.source,
            synthesizer: synthesized.synthesizer, synthesisMs, synthesisTimings: synthesized.timings, encodeMs: Date.now() - encodeStarted,
            pngBytes: { albedo: albedo.length, normal: normal.length, orm: orm.length },
            usedByGroups: users.map(u => u.name)
        });
        texturePngs.push({ label, archetypeKey: spec.archetypeKey, descriptor: spec.descriptor, albedo, normal, orm });
        sets.push({
            label, width: px, height: px, albedoPng: albedo, normalPng: normal, ormPng: orm,
            extras: { archetype: spec.archetypeKey ?? null, materialSource: spec.source, seed }
        });
    }

    const nodePlan = new Map<number, { setIndex: number; tileSizeMeters: number }>();
    for (const g of groups) for (const p of g.parts) nodePlan.set(p.nodeIndex, { setIndex: g.setIndex, tileSizeMeters: g.tile.meters });

    const applied = applyBoxProjectionMaterials(req.glb, {
        nodes: nodePlan, sets, preserveExistingUvs: !!req.preserveExistingUvs, preserveVertexColors: !!req.preserveVertexColors
    });
    const dropped = applied.report.droppedAttributes;
    if (Object.keys(dropped).length) {
        inferred.push(`removed from the projected primitives: ${Object.entries(dropped).map(([k, n]) => `${k} x${n}`).join(', ')} (stale tangents belong to the old UVs; vertex colours would multiply the new base colour; pass preserveVertexColors to keep COLOR_n)`);
    }
    inferred.push('no TANGENT attribute is written; viewers derive the tangent frame from the UV derivatives, as glTF specifies when it is absent');
    inferred.push(`UV convention: ${BOX_PROJECTION_UV_CONVENTION}`);

    return {
        glbBuffer: applied.glb,
        report: applied.report,
        groups: groups.map(g => ({
            name: g.name,
            entryIndex: g.entryIndex,
            nodes: g.parts.slice(0, 200).map(p => ({ nodeIndex: p.nodeIndex, nodeName: p.nodeName, meshName: p.meshName, triangles: p.triangles })),
            textureSet: textureSets[g.setIndex].label,
            tileSize: g.tile
        })),
        textureSets,
        texturePngs,
        caps,
        inferred
    };
}
