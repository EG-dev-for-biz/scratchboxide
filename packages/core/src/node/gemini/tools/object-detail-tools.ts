/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * object_detail_pass: weathering and decals on a generated object in the open scene, part by part
 * (object-detail-pass.ts), as a new version of the object the scene then shows.
 *
 * - Only generated objects: an object build_3d_object_from_reference built, or one a script made from no scan.
 *   Scanned and measured content (a staged place, tiles, a scan-derived structure) keeps its own photographed marks
 *   and is refused with that reason.
 * - Versions: the object as built is kept as version 1, and every pass bakes the object's whole detail recipe (its
 *   wear, part overrides and decals) onto that as-built version, so wear never compounds; a call's weathering
 *   replaces the recipe's, its decals are added (or replace them with replaceDecals). Each version is a GLB in the
 *   scene object store (kind 'object', the object's id, its own frame) and on disk under the same served path, so the
 *   viewport, the generator's glbPath and the server's own readers all find it; a recipe already baked is mounted
 *   again without baking. restoreVersion mounts any version kept.
 * - The open scene is updated in place: the object's file and metadata.detailPass, the generator's file (the viewport
 *   draws a generator's inline model under the object's file name, so the two always match) and data.objectBuild.
 * - Decals: an image given (a decal_generate asset, any picture with transparency), else one painted from a
 *   description (a billed image call each), laid on the parts named and no other.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CanvasArtifact, Scene3DData } from '../../../browser/generative-canvas/canvas-types';
import { InvalidInputError, MediaModelUnavailableError, MissingInputError } from '../../../common/errors/pipeline-errors';
import { IMAGE_MODEL_PRIORITY, resolveRequestedModels } from '../../../common/media-generation-protocol';
import { OBJECT_BUILD_SOURCE } from '../../../common/spatial/object-build-spec';
import { defaultDurableAssetStore, type DurableAssetStore } from '../../asset-store/durable-asset-store';
import { locationHashOf, objectDirOf, objectInputHash, objectKeyOf, SceneObjectStore, type ObjectFrame } from '../../asset-store/scene-object-store';
import { decalRgba, generateDecalImage } from '../../3d-engine/asset-decal';
import { exactPositionBounds, OBJECT_DETAIL_PASS_VERSION, runObjectDetailPass, type ObjectDecal, type ObjectWear, type PartWearOverride, type Rgb, type Xyz } from '../../3d-engine/object-detail-pass';
import { decodeImageInMemory, type RgbaImage8 } from '../../3d-engine/staged-location/tile-texture-transfer';
import { GoogleMediaCredentialsService } from '../../google-media-credentials-service';
import { encodePng } from '../../texture-processing';
import { loadInputImage } from './nano-banana-tools';
import type { ToolDeclaration, ToolHandler, ToolContext, ToolParameterSchema } from './types';

export const OBJECT_DETAIL_TOOL = 'object_detail_pass';
/** The scene object store's kind for these objects (an open label). */
export const OBJECT_DETAIL_KIND = 'object';
/**
 * The frame an object's GLB is in: its own (x right, y up, z towards its front, metres), not a place's; where it stands
 * is the scene's placement. It has no geodetic origin, so the frame's hash is the same for every object, and the
 * object's id tells them apart.
 */
export const OBJECT_LOCAL_FRAME: ObjectFrame = { lat: Number.NaN, lng: Number.NaN, axes: 'object-local: x right, y up, z front (metres); placement is the scene\'s' };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const vec = (v: unknown, n: number) => (Array.isArray(v) && v.length === n && v.every(x => typeof x === 'number' && Number.isFinite(x)) ? v as number[] : undefined);

const RGB_ITEMS = { type: 'ARRAY', items: { type: 'NUMBER' } } as const;
const WEAR_PROPERTIES: Record<string, ToolParameterSchema> = {
    edgeWear: { type: 'NUMBER', description: 'Wear on convex edges and corners, 0..1 (default 0.6): paint rubbed through, polish, chips; read from the geometry\'s convexity.' },
    grime: { type: 'NUMBER', description: 'Dirt in cavities, creases and sheltered places, 0..1 (default 0.5); read from occlusion by every part and the ground.' },
    streaks: { type: 'NUMBER', description: 'Run-off streaks down steep faces under whatever overhangs them, 0..1 (default 0.3).' },
    dust: { type: 'NUMBER', description: 'Dust on surfaces facing the open sky, 0..1 (default 0.25).' },
    sunFade: { type: 'NUMBER', description: 'Fading and chalking where the sky reaches, 0..1 (default 0.15).' },
    variation: { type: 'NUMBER', description: 'Large-scale patchiness of every layer, 0..1 (default 0.35).' },
    edgeWidthM: { type: 'NUMBER', description: 'How far edge wear reaches from a sharp edge, metres (default 0.25% of the object\'s size, at least two texels); a rod thinner than about 1.5 times this wears all round.' },
    creaseWidthM: { type: 'NUMBER', description: 'How far grime reaches from a concave crease, metres (default twice edgeWidthM).' },
    aoRadiusM: { type: 'NUMBER', description: 'How near a surface must be to darken a cavity, metres (default 8% of the object\'s size).' },
    streakReachM: { type: 'NUMBER', description: 'How far streaks run below an overhang, metres (default a quarter of the object\'s height).' },
    grimeColor: { ...RGB_ITEMS, description: 'Grime colour, linear RGB 0..1 (default a dark brown-grey).' },
    streakColor: { ...RGB_ITEMS, description: 'Streak colour, linear RGB 0..1.' },
    dustColor: { ...RGB_ITEMS, description: 'Dust colour, linear RGB 0..1 (default a light grey-brown); e.g. the colour of the ground it stands on.' },
    seed: { type: 'NUMBER', description: 'Seed of the noise that breaks every layer up.' }
};

export const OBJECT_DETAIL_TOOL_DECLARATIONS: ToolDeclaration[] = [{
    name: OBJECT_DETAIL_TOOL,
    description: 'Weathers a generated 3D object part by part and lays decals on its parts, as a new version of the object that the open scene shows at once. Every part keeps its own material (colour, roughness, metalness, emission, transmission, any maps); wear is added where the geometry puts it: edge wear on convex edges, grime in cavities and creases, streaks under overhangs, dust on up-facing surfaces, sun fade by exposure. Strengths are numbers, and each part can take more or less of each, and what its worn edges show (e.g. bare metal under paint). Decals (lettering, numbers, stripes, logos, labels, stains) are projected onto the parts named and no other, from an image (e.g. a decal_generate asset) or painted from a description (one billed image call each); the weathering itself makes no image call. Every pass starts from the object as built with the object\'s whole recipe (the weathering given replaces the previous one, decals are added), so wear never compounds; restoreVersion shows any earlier version again. Only for objects the app generated (build_3d_object_from_reference, or a script made from no scan): scanned or measured content is refused. Everything it adds is labelled generated.',
    parameters: {
        type: 'OBJECT',
        properties: {
            objectId: { type: 'STRING', description: 'Optional: the object in the open scene (default the object build_3d_object_from_reference built there, when there is one).' },
            weathering: { type: 'OBJECT', description: 'The wear (omit to keep the object\'s current wear; with nothing else given, the defaults). All zero removes it.', properties: WEAR_PROPERTIES },
            parts: {
                type: 'ARRAY', description: 'Optional per-part share of the wear and the finish its worn edges show; replaces the previous list.',
                items: {
                    type: 'OBJECT',
                    properties: {
                        part: { type: 'STRING', description: 'The part\'s id (its id in data.objectBuild.spec).' },
                        edgeWear: { type: 'NUMBER', description: 'Multiplier on edgeWear for this part (default 1; 0 none).' },
                        grime: { type: 'NUMBER', description: 'Multiplier on grime.' },
                        streaks: { type: 'NUMBER', description: 'Multiplier on streaks.' },
                        dust: { type: 'NUMBER', description: 'Multiplier on dust.' },
                        sunFade: { type: 'NUMBER', description: 'Multiplier on sunFade.' },
                        edgeColor: { ...RGB_ITEMS, description: 'What a worn edge shows, linear RGB (default the part\'s own colour, lightened).' },
                        edgeRoughness: { type: 'NUMBER', description: 'Roughness of a worn edge (default the part\'s own, polished).' },
                        edgeMetalness: { type: 'NUMBER', description: 'Metalness of a worn edge (default the part\'s own): 1 for bare metal under paint.' }
                    },
                    required: ['part']
                }
            },
            decals: {
                type: 'ARRAY', description: 'Optional decals to add (each on the parts it names only).',
                items: {
                    type: 'OBJECT',
                    properties: {
                        parts: { type: 'ARRAY', items: { type: 'STRING' }, description: 'The part ids it lies on.' },
                        imageUrl: { type: 'STRING', description: 'The decal image (URL, data URI or file path; transparency kept, else cut out from white). E.g. a decal_generate asset.' },
                        description: { type: 'STRING', description: 'Without imageUrl: what to paint (a billed image call), e.g. "the white stencilled number 07".' },
                        referenceImageUrl: { type: 'STRING', description: 'Optional photo the painted decal should look like.' },
                        colour: { type: 'STRING', description: 'Optional "#RRGGBB": a one-colour decal (the image gives only its shape).' },
                        facing: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'The direction [x, y, z] the decal faces out of the surface, in the object\'s frame (x right, y up, z front): e.g. [0, 0, 1] its front.' },
                        up: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Optional image up [x, y, z] (default +y).' },
                        at: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Optional [across, up]: its centre as fractions of the parts seen from `facing` (0 left/bottom, 1 right/top; default [0.5, 0.5]).' },
                        centerM: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Optional exact centre [x, y, z] in metres, instead of at.' },
                        sizeM: { type: 'ARRAY', items: { type: 'NUMBER' }, description: '[width, height] in metres.' },
                        opacity: { type: 'NUMBER', description: 'Optional 0..1 (default 1).' },
                        maxAngleDeg: { type: 'NUMBER', description: 'Optional: surfaces turned further than this from `facing` get none (default 75).' },
                        roughness: { type: 'NUMBER', description: 'Optional: the decal\'s own roughness (paint, a printed label); absent, the part\'s finish shows through.' },
                        metalness: { type: 'NUMBER', description: 'Optional: the decal\'s own metalness.' }
                    },
                    required: ['parts', 'facing', 'sizeM']
                }
            },
            replaceDecals: { type: 'BOOLEAN', description: 'Optional: the decals given replace the object\'s earlier ones (default: added to them).' },
            restoreVersion: { type: 'NUMBER', description: 'Optional: show this kept version again (1 is the object as built), baking nothing.' }
        }
    }
}];

// =============================================================================
// The recipe and the versions
// =============================================================================

interface DecalRecord {
    parts: string[]; facing: Xyz; up?: Xyz; at?: [number, number]; centerM?: Xyz; sizeM: [number, number];
    opacity?: number; maxAngleDeg?: number; roughness?: number; metalness?: number;
    image: { uri: string; sha256: string }; label: 'generated' | 'photo-inferred'; method: string;
}
export interface DetailRecipe { wear: ObjectWear | null; parts: PartWearOverride[]; decals: DecalRecord[] }
interface VersionRecord { version: number; uri: string; sha256: string; note: string; createdAtMs: number }
export interface DetailPassMetadata {
    label: 'generated';
    version: number;
    objectKey?: string;
    asBuilt: { uri: string; sha256: string };
    versions: VersionRecord[];
    recipe: DetailRecipe;
    passVersion: string;
}

export interface ObjectDetailDeps {
    /** Where served /models/ files live (default <repo>/public/models). */
    publicModelsDir?: string;
    /** The durable store (default the process's own; undefined keeps versions as files only). */
    assetStore?: () => DurableAssetStore | undefined;
    /** Texels the object's atlases share (default OBJECT_DETAIL_TARGET_TEXELS). */
    targetTexels?: number;
}

function repoRoot(): string {
    return process.env.SCRATCHBOX_ROOT || (fs.existsSync(path.resolve(process.cwd(), 'packages')) ? process.cwd() : path.resolve(process.cwd(), '..'));
}

const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');

/** Why an object cannot be weathered, or undefined when it is one the app generated. */
export function notGeneratedReason(o: any): string | undefined {
    const meta = o?.content?.metadata ?? {};
    const uri = String(o?.content?.durableUri ?? '');
    if (o?.content?.type !== '3d-model' || !/\.glb$/i.test(uri)) return `${o?.id ?? 'the object'} is not a 3D model (GLB)`;
    if (meta.detailPass || meta.source === OBJECT_BUILD_SOURCE) return undefined;
    const measured = uri.startsWith('/tiles/') || meta.layer || meta.stagedLayer || meta.structureScan || meta.facade || /measured|scan|photo-inferred|vector-modelled/.test(String(meta.provenance?.label ?? meta.provenance ?? ''));
    if (measured) return `${o.id} is scanned or measured content (${meta.layer ?? meta.source ?? 'a staged layer'}), whose own photographs carry its real marks`;
    if (meta.source === 'execute_3d_python_script') return undefined;
    return `${o.id} was not generated by the app here (its source is ${meta.source ?? 'unknown'}); only generated objects are weathered`;
}

function served(uri: string, dirs: string[], store: DurableAssetStore | undefined): string | undefined {
    const m = /^\/models\/(.+)$/.exec(uri);
    if (m) for (const dir of dirs) {
        const file = path.resolve(dir, decodeURIComponent(m[1]));
        if (file.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(file)) return file;
    }
    return store?.lookup(uri)?.file;
}

// =============================================================================
// Handler
// =============================================================================

export function createObjectDetailHandlers(deps: ObjectDetailDeps = {}): Record<string, ToolHandler> {
    return {
        [OBJECT_DETAIL_TOOL]: async (args, ctx) => runObjectDetailTool(args, ctx, deps)
    };
}

export async function runObjectDetailTool(args: Record<string, unknown>, ctx: ToolContext, deps: ObjectDetailDeps = {}) {
    const t0 = Date.now();
    const active = ctx.request?.activeArtifact as CanvasArtifact | undefined;
    if (!active || active.type !== '3d-scene' || !active.data) throw new MissingInputError(OBJECT_DETAIL_TOOL, 'activeArtifact', 'no 3D scene is open; build or open the object first');
    const scene = active.data as Scene3DData & { objectBuild?: Record<string, any>; pythonGenerator?: Record<string, any> };
    const objects: any[] = scene.objects ?? [];
    const wanted = str(args.objectId);
    const target = wanted ? objects.find(o => o?.id === wanted) : objects.find(o => o?.content?.metadata?.source === OBJECT_BUILD_SOURCE && o?.id === scene.objectBuild?.objectId) ?? objects.find(o => !notGeneratedReason(o) && o?.content?.metadata?.role === 'hero');
    if (!target) throw new MissingInputError(OBJECT_DETAIL_TOOL, 'objectId', wanted ? `no object "${wanted}" in the open scene` : 'the open scene has no generated object; name one with objectId');
    const refusal = notGeneratedReason(target);
    if (refusal) throw new InvalidInputError(OBJECT_DETAIL_TOOL, 'objectId', refusal);

    const publicModelsDir = deps.publicModelsDir ?? path.resolve(repoRoot(), 'public/models');
    const modelDirs = [...new Set([publicModelsDir, path.resolve(process.cwd(), 'public/models'), path.resolve(process.cwd(), '..', 'public/models')])];
    const store = process.env.SCRATCHBOX_OBJECT_STORE === '0' ? undefined : (deps.assetStore ?? defaultDurableAssetStore)();
    const objectStore = store ? new SceneObjectStore(store) : undefined;
    const meta = target.content.metadata ?? {};
    const prior: DetailPassMetadata | undefined = meta.detailPass;
    const identity = String(target.id);
    const objectKey = objectKeyOf(OBJECT_DETAIL_KIND, identity, locationHashOf(OBJECT_LOCAL_FRAME));
    const dirUri = objectDirOf(OBJECT_DETAIL_KIND, identity, locationHashOf(OBJECT_LOCAL_FRAME));
    const fileOf = (uri: string) => path.join(publicModelsDir, uri.replace(/^\/models\//, ''));
    const writeServed = (uri: string, bytes: Uint8Array) => {
        const file = fileOf(uri);
        if (!(fs.existsSync(file) && sha(fs.readFileSync(file)) === sha(bytes))) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
            fs.writeFileSync(tmp, bytes);
            fs.renameSync(tmp, file);
        }
        return file;
    };
    /** Without a store, the versions kept as files: the object's recorded ones and those kept in this call. */
    const fileVersions: VersionRecord[] = [...(prior?.versions ?? [])];
    /** Keeps a version: in the store when there is one (its served path), else under the same kind of path as a file. */
    const keep = (glb: Buffer, inputHash: string, note: string, inputs: Record<string, unknown>, stage: string): { version: number; uri: string; reused: boolean } => {
        if (objectStore) {
            const put = objectStore.put({
                kind: OBJECT_DETAIL_KIND, identity, frame: OBJECT_LOCAL_FRAME, inputHash, glb: () => glb, inputs,
                provenance: { labels: ['generated'], confidence: null, note }, producer: { stage, version: OBJECT_DETAIL_PASS_VERSION }, ...(ctx.workspaceRoot ? { workspace: ctx.workspaceRoot } : {})
            });
            writeServed(put.glbPath, glb);
            return { version: put.version, uri: put.glbPath, reused: put.reused };
        }
        const uri = `${dirUri}/${inputHash.slice(0, 16)}.glb`;
        const known = fileVersions.find(v => v.uri === uri);
        writeServed(uri, glb);
        if (known) return { version: known.version, uri, reused: true };
        const version = Math.max(0, ...fileVersions.map(v => v.version)) + 1;
        fileVersions.push({ version, uri, sha256: sha(glb), note, createdAtMs: Date.now() });
        return { version, uri, reused: false };
    };
    const readGlb = (uri: string): Buffer => {
        const file = served(uri, modelDirs, store);
        if (!file) throw new MissingInputError(OBJECT_DETAIL_TOOL, 'objectId', `the object's model ${uri} is not on this machine`);
        return fs.readFileSync(file);
    };

    // the object as built, kept as the first version (later passes read the kept copy); its POSITION bounds measured
    // from its data, as the store requires (the engine's writer rounds them)
    const asBuiltGlb = exactPositionBounds(readGlb(prior?.asBuilt.uri ?? String(target.content.durableUri)));
    const asBuiltSha = prior?.asBuilt.sha256 ?? sha(asBuiltGlb);
    const built = keep(asBuiltGlb, objectInputHash('as built', asBuiltSha), 'the object as built', { builtAs: String(meta.objectBuild ? 'build_3d_object_from_reference' : meta.source ?? 'generated') }, 'object-build');
    const asBuilt = { uri: built.uri, sha256: asBuiltSha };
    const versions = new Map<number, VersionRecord>((prior?.versions ?? []).map(v => [v.version, v]));
    if (!versions.has(built.version)) versions.set(built.version, { version: built.version, uri: built.uri, sha256: asBuilt.sha256, note: 'as built', createdAtMs: Date.now() });

    // restore
    const restore = num(args.restoreVersion);
    if (restore !== undefined) {
        const v = versions.get(restore) ?? (objectStore ? (() => {
            const s = objectStore.read(objectKey, restore);
            return s ? { version: restore, uri: s.row.glbPath, sha256: s.row.glbSha256, note: s.record.provenance.note ?? '', createdAtMs: s.record.createdAtMs } : undefined;
        })() : undefined);
        if (!v) throw new InvalidInputError(OBJECT_DETAIL_TOOL, 'restoreVersion', `no version ${restore} of ${identity} is kept (kept: ${[...versions.keys()].sort((a, b) => a - b).join(', ')})`);
        const glb = readGlb(v.uri);
        if (objectStore) keep(glb, objectStore.read(objectKey, restore)!.row.inputHash, v.note, {}, 'object-detail-restore');
        const recipe: DetailRecipe = v.version === built.version ? { wear: null, parts: [], decals: [] } : (objectStore?.read(objectKey, restore)?.record.inputs?.recipe as DetailRecipe | undefined) ?? prior?.recipe ?? { wear: null, parts: [], decals: [] };
        const dp: DetailPassMetadata = { label: 'generated', version: v.version, ...(objectStore ? { objectKey } : {}), asBuilt, versions: [...versions.values()].sort((a, b) => a.version - b.version), recipe, passVersion: OBJECT_DETAIL_PASS_VERSION };
        const artifact = mountVersion(active, target, v.uri, fileOf(v.uri), glb, dp);
        const summary = `Showing version ${v.version} of ${describe(target)} (${v.note || 'kept'}); versions kept: ${dp.versions.map(x => x.version).join(', ')}.`;
        return { status: 'completed' as const, summaryResult: summary, resultPayload: { success: true, objectId: identity, version: v.version, versions: dp.versions, modelUri: v.uri, glbPath: fileOf(v.uri), artifact } };
    }

    // the recipe: the earlier one with this call's changes
    const before: DetailRecipe = prior?.recipe ?? { wear: null, parts: [], decals: [] };
    const wearArg = args.weathering && typeof args.weathering === 'object' ? args.weathering as Record<string, unknown> : undefined;
    const decalArgs = Array.isArray(args.decals) ? args.decals as Record<string, unknown>[] : [];
    const partArgs = Array.isArray(args.parts) ? args.parts as Record<string, unknown>[] : undefined;
    const wear: ObjectWear | null = wearArg ? readWear(wearArg) : before.wear ?? (decalArgs.length ? null : {});
    const parts: PartWearOverride[] = partArgs ? partArgs.map(readPart) : before.parts;
    const imageCalls = { count: 0, models: new Set<string>() };
    const newDecals: DecalRecord[] = [];
    for (const [k, d] of decalArgs.entries()) newDecals.push(await readDecal(d, k, ctx, imageCalls, dirUri, writeServed, store));
    const recipe: DetailRecipe = { wear, parts, decals: [...(args.replaceDecals === true ? [] : before.decals), ...newDecals] };
    if (!recipe.wear && !recipe.decals.length) throw new InvalidInputError(OBJECT_DETAIL_TOOL, 'weathering', 'nothing to add: give weathering or decals, or restoreVersion');

    const inputHash = objectInputHash(OBJECT_DETAIL_PASS_VERSION, asBuilt.sha256, recipe);
    const existing = objectStore?.find(objectKey, inputHash);
    let glb: Buffer, report: Awaited<ReturnType<typeof runObjectDetailPass>>['report'] | undefined;
    if (existing) {
        glb = readGlb(existing.glbPath);
    } else {
        ctx.reportProgress?.('Weathering the object part by part');
        const decals: ObjectDecal[] = recipe.decals.map(d => {
            const file = served(d.image.uri, modelDirs, store);
            if (!file) throw new MissingInputError(OBJECT_DETAIL_TOOL, 'decals', `the decal image ${d.image.uri} is not on this machine`);
            const image = decodeImageInMemory(fs.readFileSync(file));
            return { parts: d.parts, image, facing: d.facing, ...(d.up ? { up: d.up } : {}), ...(d.at ? { at: d.at } : {}), ...(d.centerM ? { centerM: d.centerM } : {}), sizeM: d.sizeM,
                ...(d.opacity !== undefined ? { opacity: d.opacity } : {}), ...(d.maxAngleDeg !== undefined ? { maxAngleDeg: d.maxAngleDeg } : {}),
                ...(d.roughness !== undefined ? { roughness: d.roughness } : {}), ...(d.metalness !== undefined ? { metalness: d.metalness } : {}), label: d.label, method: d.method };
        });
        try {
            const r = await runObjectDetailPass(asBuiltGlb, { wear: recipe.wear, parts: recipe.parts, decals, ...(deps.targetTexels ? { targetTexels: deps.targetTexels } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
            glb = r.glb; report = r.report;
        } catch (err) {
            throw new InvalidInputError(OBJECT_DETAIL_TOOL, 'objectId', (err as Error).message);
        }
    }
    const kept = keep(glb, inputHash, describeRecipe(recipe), { recipe, asBuilt: asBuilt.uri }, 'object-detail-pass');
    versions.set(kept.version, { version: kept.version, uri: kept.uri, sha256: sha(glb), note: describeRecipe(recipe), createdAtMs: Date.now() });
    const dp: DetailPassMetadata = { label: 'generated', version: kept.version, ...(objectStore ? { objectKey } : {}), asBuilt, versions: [...versions.values()].sort((a, b) => a.version - b.version), recipe, passVersion: OBJECT_DETAIL_PASS_VERSION };
    const artifact = mountVersion(active, target, kept.uri, fileOf(kept.uri), glb, dp);
    const seconds = (Date.now() - t0) / 1000;
    const partLine = report ? report.parts.filter(p => p.texels > 0).map(p => `${p.part} ${pct(p.edgeWear)} edge, ${pct(p.grime)} grime${p.dust > 0.005 ? `, ${pct(p.dust)} dust` : ''}${p.decal > 0.001 ? `, ${pct(p.decal)} decal` : ''}`).join('; ') : '';
    const summary = [
        `${existing ? 'Showing the kept' : 'Made'} version ${kept.version} of ${describe(target)}: ${describeRecipe(recipe)}, each part on its own material${report ? ` (${partLine})` : ''}, labelled generated, in ${seconds.toFixed(1)} s${imageCalls.count ? ` with ${imageCalls.count} billed image call${imageCalls.count === 1 ? '' : 's'} for decals` : ', no image call'}.`,
        `Versions kept: ${dp.versions.map(v => `${v.version}${v.version === built.version ? ' (as built)' : ''}`).join(', ')}; restoreVersion shows any of them again.`
    ].join(' ');
    return {
        status: 'completed' as const,
        summaryResult: summary,
        resultPayload: {
            success: true, objectId: identity, version: kept.version, versions: dp.versions, reusedVersion: !!existing, modelUri: kept.uri, glbPath: fileOf(kept.uri),
            recipe, seconds, imageCalls: imageCalls.count, ...(imageCalls.models.size ? { imageModels: [...imageCalls.models] } : {}),
            ...(report ? { parts: report.parts, materials: report.materials, decals: report.decals, left: report.left, timings: report.timings } : {}),
            provenance: { label: 'generated' }, artifact
        }
    };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function describe(o: any): string {
    return `"${o?.content?.metadata?.description || o?.id}"`;
}

function describeRecipe(r: DetailRecipe): string {
    const w = r.wear;
    const layers = w ? (['edgeWear', 'grime', 'streaks', 'dust', 'sunFade'] as const).map(k => [k, w[k]] as const).filter(([, v]) => v === undefined || v > 0).map(([k, v]) => `${k}${v === undefined ? '' : ` ${v}`}`) : [];
    const parts = [layers.length ? `weathering (${layers.join(', ')})` : w ? 'no weathering' : '', r.decals.length ? `${r.decals.length} decal${r.decals.length === 1 ? '' : 's'}` : ''].filter(Boolean);
    return parts.join(' and ') || 'as built';
}

function readWear(a: Record<string, unknown>): ObjectWear {
    const w: ObjectWear = {};
    for (const k of ['edgeWear', 'grime', 'streaks', 'dust', 'sunFade', 'variation', 'edgeWidthM', 'creaseWidthM', 'aoRadiusM', 'streakReachM', 'seed'] as const) {
        const v = num(a[k]);
        if (v === undefined) continue;
        if (v < 0) throw new InvalidInputError(OBJECT_DETAIL_TOOL, `weathering.${k}`, 'must not be negative');
        w[k] = v;
    }
    for (const k of ['grimeColor', 'streakColor', 'dustColor'] as const) {
        if (a[k] === undefined) continue;
        const v = vec(a[k], 3);
        if (!v) throw new InvalidInputError(OBJECT_DETAIL_TOOL, `weathering.${k}`, 'must be [r, g, b], linear 0..1');
        w[k] = v as Rgb;
    }
    return w;
}

function readPart(a: Record<string, unknown>): PartWearOverride {
    const part = str(a.part);
    if (!part) throw new MissingInputError(OBJECT_DETAIL_TOOL, 'parts.part', 'name the part');
    const o: PartWearOverride = { part };
    for (const k of ['edgeWear', 'grime', 'streaks', 'dust', 'sunFade', 'edgeRoughness', 'edgeMetalness'] as const) { const v = num(a[k]); if (v !== undefined) o[k] = v; }
    if (a.edgeColor !== undefined) {
        const c = vec(a.edgeColor, 3);
        if (!c) throw new InvalidInputError(OBJECT_DETAIL_TOOL, 'parts.edgeColor', 'must be [r, g, b], linear 0..1');
        o.edgeColor = c as Rgb;
    }
    return o;
}

async function readDecal(d: Record<string, unknown>, k: number, ctx: ToolContext, calls: { count: number; models: Set<string> }, dirUri: string,
                         writeServed: (uri: string, bytes: Uint8Array) => string, store: DurableAssetStore | undefined): Promise<DecalRecord> {
    const arg = `decals[${k}]`;
    const parts = Array.isArray(d.parts) ? (d.parts as unknown[]).map(str).filter((x): x is string => !!x) : [];
    if (!parts.length) throw new MissingInputError(OBJECT_DETAIL_TOOL, `${arg}.parts`, 'name the parts the decal lies on');
    const facing = vec(d.facing, 3), sizeM = vec(d.sizeM, 2);
    if (!facing || Math.hypot(...facing) < 1e-9) throw new InvalidInputError(OBJECT_DETAIL_TOOL, `${arg}.facing`, 'give the direction [x, y, z] the decal faces');
    if (!sizeM || !(sizeM[0] > 0 && sizeM[1] > 0)) throw new InvalidInputError(OBJECT_DETAIL_TOOL, `${arg}.sizeM`, 'give [width, height] in metres');
    const cv = str(d.colour), cm = cv ? /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(cv) : null;
    if (cv && !cm) throw new InvalidInputError(OBJECT_DETAIL_TOOL, `${arg}.colour`, `"${cv}" is not a #RRGGBB colour`);
    const colour = cm ? [parseInt(cm[1], 16), parseInt(cm[2], 16), parseInt(cm[3], 16)] as [number, number, number] : undefined;
    const imageUrl = str(d.imageUrl), description = str(d.description);
    let image: RgbaImage8, label: 'generated' | 'photo-inferred', method: string;
    if (imageUrl) {
        const img = await loadInputImage(imageUrl, ctx.workspaceRoot, ctx.signal, OBJECT_DETAIL_TOOL, `${arg}.imageUrl`);
        try { image = decodeImageInMemory(new Uint8Array(img.data)); } catch (err) { throw new InvalidInputError(OBJECT_DETAIL_TOOL, `${arg}.imageUrl`, `the image is not a PNG or JPEG (${(err as Error).message})`); }
        // a decal_generate asset says in its sidecar that it was painted
        const sidecar = img.localPath ? img.localPath.replace(/\.png$/i, '.json') : undefined;
        let generated = false;
        try { generated = !!sidecar && fs.existsSync(sidecar) && JSON.parse(fs.readFileSync(sidecar, 'utf8')).label === 'generated'; } catch { generated = false; }
        label = generated ? 'generated' : 'photo-inferred';
        method = `the image ${imageUrl}`;
    } else if (description) {
        const refArg = str(d.referenceImageUrl);
        const ref = refArg ? await loadInputImage(refArg, ctx.workspaceRoot, ctx.signal, OBJECT_DETAIL_TOOL, `${arg}.referenceImageUrl`) : undefined;
        const models = resolveRequestedModels(undefined, IMAGE_MODEL_PRIORITY);
        let client: unknown;
        try { client = await new GoogleMediaCredentialsService().createClient(); } catch (err) { throw new MediaModelUnavailableError(models[0], `Google media credentials are not available (${(err as Error)?.message || err})`); }
        const painted = await generateDecalImage({ client, models, description, ...(ref ? { reference: { bytes: new Uint8Array(ref.data), mimeType: ref.mimeType } } : {}), widthM: sizeM[0], heightM: sizeM[1], ...(ctx.signal ? { signal: ctx.signal } : {}) });
        calls.count++; calls.models.add(painted.modelUsed);
        image = painted.image; label = 'generated';
        method = `${description}${refArg ? `, read from ${refArg}` : ''}, painted by ${painted.modelUsed}`;
    } else {
        throw new MissingInputError(OBJECT_DETAIL_TOOL, `${arg}.imageUrl`, 'give the decal image, or a description to paint it from');
    }
    // straight alpha: the image's own, else its distance from the white it was painted on
    const cut = decalRgba(image, 1, colour);
    const png = encodePng(cut.width, cut.height, Buffer.from(cut.rgba.buffer, cut.rgba.byteOffset, cut.rgba.byteLength));
    const digest = sha(png);
    const uri = `${dirUri}/decals/${digest.slice(0, 16)}.png`;
    const file = writeServed(uri, png);
    store?.putFile(file, { servedPath: uri, origin: 'object-detail-pass', mime: 'image/png', ...(ctx.workspaceRoot ? { workspace: ctx.workspaceRoot } : {}) });
    const at = vec(d.at, 2), up = vec(d.up, 3), centerM = vec(d.centerM, 3);
    return {
        parts, facing: facing as Xyz, ...(up ? { up: up as Xyz } : {}), ...(at ? { at: at as [number, number] } : {}), ...(centerM ? { centerM: centerM as Xyz } : {}), sizeM: sizeM as [number, number],
        ...(num(d.opacity) !== undefined ? { opacity: num(d.opacity) } : {}), ...(num(d.maxAngleDeg) !== undefined ? { maxAngleDeg: num(d.maxAngleDeg) } : {}),
        ...(num(d.roughness) !== undefined ? { roughness: num(d.roughness) } : {}), ...(num(d.metalness) !== undefined ? { metalness: num(d.metalness) } : {}),
        image: { uri, sha256: digest }, label, method
    };
}

/**
 * The open scene with `target` drawing the version at `uri`: the object's file and metadata, the generator's file (the
 * viewport draws a generator's inline model under the object's file name and skips the object that loads it, so both
 * move together; its inline copy is this version), and data.objectBuild's record of the pass.
 */
export function mountVersion(active: CanvasArtifact, target: any, uri: string, file: string, glb: Buffer, dp: DetailPassMetadata): CanvasArtifact {
    const scene = active.data as Scene3DData & { objectBuild?: Record<string, any>; pythonGenerator?: Record<string, any> };
    const oldFile = String(target.content.durableUri).split('/').pop();
    const objects = (scene.objects ?? []).map((o: any) => o === target ? {
        ...o,
        content: { ...o.content, durableUri: uri, metadata: { ...(o.content.metadata ?? {}), originalPath: file, detailPass: dp } },
        lineage: { ...(o.lineage ?? {}), version: ((o.lineage?.version as number) || 1) + 1 }
    } : o);
    const gen = scene.pythonGenerator;
    const genDrawsIt = !!gen && String(gen.glbPath ?? '').split('/').pop() === oldFile;
    const pythonGenerator = genDrawsIt ? { ...gen, glbPath: file, ...(gen!.glbBase64 ? { glbBase64: glb.toString('base64') } : {}), lastCompiledTimeMs: Date.now() } : gen;
    const objectBuild = scene.objectBuild && scene.objectBuild.objectId === target.id
        ? { ...scene.objectBuild, detailPass: { version: dp.version, versions: dp.versions.map(v => ({ version: v.version, note: v.note })), recipe: dp.recipe, label: 'generated' } }
        : scene.objectBuild;
    return {
        ...active,
        version: (active.version || 1) + 1,
        data: { ...scene, objects, ...(pythonGenerator ? { pythonGenerator } : {}), ...(objectBuild ? { objectBuild } : {}) } as Scene3DData
    };
}

export const objectDetailHandlers: Record<string, ToolHandler> = createObjectDetailHandlers();
