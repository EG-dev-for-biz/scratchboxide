/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Python 3D Procedural Scripting Tools
 * Exposes NativePythonRunnerService to Gemini agents, allowing Blender-style
 * procedural Python scripting (import scratchbox as sb) backed by native C++20
 * Astro engine nanobind bindings to stream binary .glb directly into the viewport.
 * Supports analytical AABB dynamic camera auto-framing.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDeclaration, ToolHandlerOutcome } from './types';
import { NativePythonRunnerService } from '../../3d-engine/native-python-runner-service';
import { PipelineError } from '../../../common/errors/pipeline-errors';
import { GeometricComplexityGate, GeometricSceneMetrics, GeometricMeshSummary, ComplexityGateReport } from '../../../common/spatial/GeometricComplexityGate';
import { analyzePartConnectivityAsync, ConnectivityAnalysisAbortedError, describeFloatingParts, glbToNamedTriangleSoups, glbToTriangleSoup, glbWorldBounds, isSbVeggieNearLevel, isSbVeggieNode, type PartConnectivityReport, type TriangleSoup } from '../../3d-engine/part-connectivity';
import { callVisionModel, describeVisualProblems, renderShotView, reviewModelVisually, type VisualReviewResult } from '../../3d-engine/visual-review';
import { describeShotDetailBudget, evaluateShotDetailBudget, parseShotMoves, parseShotPlan, verticalFovDeg, type ShotCamera, type ShotDetailBudgetReport } from '../../../common/spatial/shot-detail-budget';
import { cameraPoseAt, type CameraPathKey } from '../../../common/spatial/camera-path';
import { formatSbApiErrors, sbTypeCheckMetadata, typeCheckSbScript } from '../../3d-engine/sb-script-typecheck';
import { SB_API_CORE_SUMMARY, SB_API_VERSION } from '../../3d-engine/sb-api.generated';
import { firstPassRenderMode } from '../scene3d-first-pass-baseline';
import { measureSiteMassing, type SiteMassing } from '../../3d-engine/site-massing';
import { readSiteFacade, type SiteFacade } from '../../3d-engine/site-facade';
import { fitSiteCrown, type SiteCrown } from '../../3d-engine/site-crown';
import { measureSiteScan, type SiteScan } from '../../3d-engine/site-scan';
import { fetchLibrarySets } from '../../3d-engine/texture-library';
import { describeReference, measureReferencePlace, type ReferencePlace } from '../../3d-engine/reference-place';
import { findSiteGuides } from '../../3d-engine/site-guides';
import * as os from 'os';
import { StageCache, stagedWorkspaceRoot } from '../../3d-engine/staged-location/stage-cache';
import { roofPhotoFor, type StructureScanNote } from '../../3d-engine/staged-location/scan-massing';
import { encodePng } from '../../3d-engine/staged-location/png-encode';

export { roofPhotoFor, type StructureScanNote } from '../../3d-engine/staged-location/scan-massing';

/** The structure scan of the scene on the canvas when it is a staged build whose run recorded one and whose files still exist. */
export function structureScanOf(activeArtifact: unknown, cache: Pick<StageCache, 'readRunNote'> = new StageCache({ workspaceRoot: stagedWorkspaceRoot() })): { runId: string; note: StructureScanNote } | undefined {
    const a = activeArtifact as { type?: string; data?: { stagedBuild?: { runId?: unknown } } } | undefined;
    const runId = a?.type === '3d-scene' && typeof a.data?.stagedBuild?.runId === 'string' ? a.data.stagedBuild.runId : undefined;
    if (!runId || !/^[A-Za-z0-9_-]+$/.test(runId)) return undefined;
    const note = cache.readRunNote<StructureScanNote>(runId, 'structure_scan');
    if (!note?.scanGlb || !fs.existsSync(note.scanGlb)) return undefined;
    return { runId, note };
}

export interface GlbAabbBounds {
    min: [number, number, number];
    max: [number, number, number];
    center: [number, number, number];
    dimensions: [number, number, number];
    radius: number;
}

export interface GlbAnalysisResult {
    bounds: GlbAabbBounds | null;
    metrics: GeometricSceneMetrics | null;
}

/**
 * Rapidly parse glTF 2.0 JSON chunk from binary GLB buffer to extract accurate AABB
 * bounding box and geometric scene metrics (submeshes, vertex counts, polygon fidelity).
 */
export function extractGlbAnalysis(glbBuffer: Buffer): GlbAnalysisResult {
    try {
        if (!glbBuffer || glbBuffer.length < 20) return { bounds: null, metrics: null };
        const magic = glbBuffer.toString('utf8', 0, 4);
        if (magic !== 'glTF') return { bounds: null, metrics: null };

        const jsonLength = glbBuffer.readUInt32LE(12);
        const jsonStr = glbBuffer.toString('utf8', 20, 20 + jsonLength);
        const gltf = JSON.parse(jsonStr);

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let found = false;

        const accessors = Array.isArray(gltf.accessors) ? gltf.accessors : [];
        for (const acc of accessors) {
            if (acc.type === 'VEC3' && Array.isArray(acc.min) && Array.isArray(acc.max)) {
                minX = Math.min(minX, acc.min[0]);
                minY = Math.min(minY, acc.min[1]);
                minZ = Math.min(minZ, acc.min[2]);
                maxX = Math.max(maxX, acc.max[0]);
                maxY = Math.max(maxY, acc.max[1]);
                maxZ = Math.max(maxZ, acc.max[2]);
                found = true;
            }
        }

        // World bounds through the node tree (node transforms, KHR_mesh_quantization dequantisation, GPU instances): an
        // SB-Veggie trees layer stores quantised positions under node transforms, which accessor min/max alone misreads.
        let world: ReturnType<typeof glbWorldBounds> = null;
        try { world = glbWorldBounds(glbBuffer); } catch { world = null; }
        if (world && world.min.every(Number.isFinite) && world.max.every(Number.isFinite)) {
            [minX, minY, minZ] = world.min;
            [maxX, maxY, maxZ] = world.max;
            found = true;
        }
        let bounds: GlbAabbBounds | null = null;
        if (found && isFinite(minX)) {
            const center: [number, number, number] = [
                (minX + maxX) * 0.5,
                (minY + maxY) * 0.5,
                (minZ + maxZ) * 0.5
            ];
            const dimensions: [number, number, number] = [
                Math.max(0.1, maxX - minX),
                Math.max(0.1, maxY - minY),
                Math.max(0.1, maxZ - minZ)
            ];
            const radius = Math.max(0.1, Math.sqrt(dimensions[0] ** 2 + dimensions[1] ** 2 + dimensions[2] ** 2) * 0.5);
            bounds = {
                min: [minX, minY, minZ],
                max: [maxX, maxY, maxZ],
                center,
                dimensions,
                radius
            };
        }

        // Submesh and polygon metrics
        const submeshes: GeometricMeshSummary[] = [];
        let totalVertices = 0;
        let totalTriangles = 0;

        const meshes = Array.isArray(gltf.meshes) ? gltf.meshes : [];
        meshes.forEach((meshObj: any, idx: number) => {
            const meshName = meshObj.name || `Submesh_${idx}`;
            let meshVerts = 0;
            let meshTris = 0;
            let subMinX = Infinity, subMinY = Infinity, subMinZ = Infinity;
            let subMaxX = -Infinity, subMaxY = -Infinity, subMaxZ = -Infinity;

            const primitives = Array.isArray(meshObj.primitives) ? meshObj.primitives : [];
            for (const prim of primitives) {
                if (prim.attributes && typeof prim.attributes.POSITION === 'number') {
                    const posAcc = accessors[prim.attributes.POSITION];
                    if (posAcc) {
                        meshVerts += (posAcc.count || 0);
                        if (Array.isArray(posAcc.min) && Array.isArray(posAcc.max)) {
                            subMinX = Math.min(subMinX, posAcc.min[0]);
                            subMinY = Math.min(subMinY, posAcc.min[1]);
                            subMinZ = Math.min(subMinZ, posAcc.min[2]);
                            subMaxX = Math.max(subMaxX, posAcc.max[0]);
                            subMaxY = Math.max(subMaxY, posAcc.max[1]);
                            subMaxZ = Math.max(subMaxZ, posAcc.max[2]);
                        }
                    }
                }
                if (typeof prim.indices === 'number') {
                    const idxAcc = accessors[prim.indices];
                    if (idxAcc) {
                        meshTris += Math.floor((idxAcc.count || 0) / 3);
                    }
                }
            }

            totalVertices += meshVerts;
            totalTriangles += meshTris;

            let submeshBounds: GeometricMeshSummary['bounds'] | undefined = undefined;
            if (isFinite(subMinX) && isFinite(subMaxX)) {
                submeshBounds = {
                    min: [subMinX, subMinY, subMinZ],
                    max: [subMaxX, subMaxY, subMaxZ],
                    dimensions: [subMaxX - subMinX, subMaxY - subMinY, subMaxZ - subMinZ]
                };
            }

            submeshes.push({
                name: meshName,
                vertexCount: meshVerts,
                triangleCount: meshTris,
                bounds: submeshBounds,
                tag: meshName
            });
        });

        const metrics: GeometricSceneMetrics = {
            totalVertices,
            totalTriangles,
            submeshes,
            engineKernel: 'scratchbox-nanobind-c++20'
        };

        return { bounds, metrics };
    } catch {
        return { bounds: null, metrics: null };
    }
}

export function extractGlbAabb(glbBuffer: Buffer): GlbAabbBounds | null {
    return extractGlbAnalysis(glbBuffer).bounds;
}

/**
 * Without a reference the model guesses common names (mesh.clone(), mesh.transform, a materials module) that do not
 * exist, and every guess costs a failed tool call. The API listing is generated from the stubs of the live module
 * (SB_API_CORE_SUMMARY, scripts/gen_sb_stubs.py); the notes below are usage the signatures cannot express.
 */
export const PYTHON_3D_API_REFERENCE = `${SB_API_CORE_SUMMARY}
Usage notes:
- A parameter or property typed Vec2/Vec3/Vec4 (sb.math) takes that object, never a tuple or list: the native bindings convert nothing, so write color=sb.math.Vec4(r, g, b, a), not color=(r, g, b, a). Factories listed without types (sb.create_*, sb.PbrMaterial(base_color=...)) accept tuples.
- Mesh methods modify the mesh in place (and return it). vertex_count, triangle_count and bounds (with .min and .max) are properties, read without parentheses.
- Reading geometry back: get_positions_flat returns float32 xyz as bytes; wrap it with Python's array module, typecode "f". Subdivision rounds and shrinks shapes and deformers move vertices, so measure positions after deforming instead of assuming the original sizes. Call weld_vertices() before subdividing boxes, whose faces arrive unwelded and crack apart otherwise.
- Assemblies (legs, rungs, frames, struts, rails): compute the joint points first, then build each member between two joints with sb.sweep_curve_profile(path=[start, end], profile_dimensions=(r, r)). Take a connecting member's ends from points on the members it joins (a rung from lerp(top_a, foot_a, t) to lerp(top_b, foot_b, t)) so it attaches by construction; run member ends slightly into what they join. Do not place parts by rotating them about the origin and guessing offsets. Every result is checked: parts that touch nothing are listed in structuralIssues, and you must fix them.
- Meshes have no clone(), copy() or transform. To duplicate: dup = sb.geometry.Mesh(); dup.append(mesh), then position it with translate, rotate_x/y/z (degrees) and scale.
- Materials: sb.PbrMaterial(base_color=(r, g, b, a), roughness=, metallic=) or a preset such as sb.PbrMaterial.clay(). There is no separate materials module.
- Scene and export: scene = sb.Scene(); scene.add_mesh(mesh); finish with sb.io.write_glb(OUTPUT_GLB_PATH, scene). A single Mesh can be written directly too.
- A scene built for a view (a camera height, lens or frame in the request, or an environment too large to detail everywhere): declare it before building with hero = sb.shot(position=(x, y, z), target=(x, y, z), focal_mm=35, aspect=16/9, width_px=1920, name="hero") (metres, y up). The scene opens on that camera, the review looks through it, and the result reports the shot detail budget: the share of in-frame triangles under 2 px. Size detail from it: hero.resolves(size_m, at=(x, y, z)) -> bool on a feature's overall size (an opening, a balcony, a tank, a car; never its thinnest member), then hero.member_m(real_size, at=) -> metres for its bars, mullions and reveals, thickened just enough to show; hero.pixels(size_m, at=) -> px, hero.min_feature_m(at=) -> metres, hero.sees(point) -> bool, hero.frame_point(x, y, depth) -> the world point at frame position x (-1 left .. 1 right), y (-1 bottom .. 1 top), so what the request puts left of frame goes at x < 0 (looking down -z, frame left is -x), hero.right / hero.forward -> unit vectors; sb.shot_plan.resolves(size_m, at) asks every declared shot. A moving camera: sb.camera_move([(0, start_shot), (40, end_shot)], name="push-in") puts the move on the scene's timeline (path_trace_render timeSeconds renders a moment). Detail under the budget is wasted, and a frame of plain blocks is under-built: spend the triangles on what resolves, nearest the lens first.
- A real place as a reference for an imagined scene ("a street like X", "proportions of Y"): pass reference="<place>" to this tool and read sb.reference() in the script: "streets" (points, types, length_m, frontage_width_m front to front), "buildings" (loops, height_m, area_m2, centroid), "areas", "pois", "stats" (height_m, footprint_area_m2 and street_frontage_width_m as p10/p50/p90/max, built_share, grid_bearing_deg), in metres x east, z south. Take proportions from it (street widths, heights, density, the grid's bearing) or lay the scene on its streets and footprints; the scene stays imagined and in the studio.
- Trees, shrubs and any plant with a crown: sb.create_tree(position=(x, y, z), height=, crown_radius= (or (along x, along z)), crown_base_height=, crown_widest_at= (0 cone .. 0.5 round .. 0.8 umbrella), crown_top_exponent= (1 cone, 2 dome, 4 flat), trunk_radius=, leaf_color='#rrggbb', label=) returns an SB-Veggie tree described by those measurements; add it with scene.merge(tree) or world.add(tree) (world.scatter(tree, ...) plants copies) and it is grown natively when the scene is written (space colonisation, SB-Veggie leaf clusters, species and leaf textures, levels of detail). It is not a mesh: move it with translate / rotate_y / scale only. This is the only way to make vegetation: never build trees or foliage from cones, spheres, boxes, sweeps or lathes.`;

/**
 * The largest model execute_3d_python_script mounts in the viewport. Beyond it the browser tab runs out of memory
 * and crashes; set SCRATCHBOX_MAX_SCENE_VERTICES / SCRATCHBOX_MAX_SCENE_MB to move it on a bigger machine.
 */
export function viewportSceneLimits(env: NodeJS.ProcessEnv = process.env): { vertices: number; bytes: number } {
    const num = (v: string | undefined, fallback: number) => (v && Number(v) > 0 ? Number(v) : fallback);
    return { vertices: num(env.SCRATCHBOX_MAX_SCENE_VERTICES, 1_000_000), bytes: num(env.SCRATCHBOX_MAX_SCENE_MB, 96) * 1e6 };
}

export const PYTHON_3D_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'execute_3d_python_script',
        description: 'Runs a procedural Python 3 script with the Scratchbox 3D Engine (import scratchbox as sb) and opens the GLB it writes as a new 3D scene in a studio void, shown with the materials the script assigns (textured by default; studio clay only when the user asks for clay). Choose the tool by what the user asked for: a real-world place goes to google_3d_tiles_get_clay; one specific object, or an abstract form, goes to build_3d_object_from_reference (with its location when it stands at a real place); an imagined environment or landscape, a scene made of several objects, or an explicit request for a script comes here. Every call starts a new scene: nothing is carried over from the scene already on the canvas. This tool does not stage anything on a real place: a call with a location or coordinates fails without running the script. To size a building on a real one, pass site (the place): its measured massing reaches the script as sb.site(), and sb.site_tiers() turns it into create_building_parts tiers; the model still opens in the studio. If the script writes no GLB, or one with no geometry, the call fails. When the scene on the canvas is a staged 3D Building, the script can read that structure\'s isolated scan: scan = sb.massing.Scan.from_scene(); choice = sb.massing.choose(scan) builds candidate massings from the scan (a block whose walls sit on the scanned walls, lofted sections that follow tapers, legs and overhangs) and keeps the simplest that explains the scan height band by height band; print(choice.why) reports every candidate\'s coverage and precision, and choice.mesh is the result. The model it writes then joins that scene in the place\'s frame (labelled generated) instead of opening in a studio void.\n\n' + PYTHON_3D_API_REFERENCE,
        parameters: {
            type: 'OBJECT',
            properties: {
                script: {
                    type: 'STRING',
                    description: 'The procedural Python 3 script. Must import scratchbox as sb and write the resulting scene to OUTPUT_GLB_PATH via sb.io.write_glb(OUTPUT_GLB_PATH, scene).'
                },
                description: {
                    type: 'STRING',
                    description: 'Optional human-readable description of the 3D scene or asset being generated.'
                },
                timeoutMs: {
                    type: 'NUMBER',
                    description: 'Execution timeout in milliseconds (default 45000).'
                },
                site: {
                    type: 'STRING',
                    description: 'Optional: a real building (name, address or "lat, lng") whose measured massing the script should be sized from. Its footprint, setback tiers and heights (Google vector data; a modeled volume is sliced at its flat levels) are measured before the script runs and read in it with sb.site(); sb.site_tiers() turns them into create_building_parts arguments. Sizing only: the scene still opens in the studio, not at the place.'
                },
                siteFacade: {
                    type: 'BOOLEAN',
                    description: 'Optional, with site: also read the building\'s facade (storey heights, bay width, window sizes, plinth, cornice, piers, colours) so sb.site_tiers() applies it. Lower floors are read from Google Street View (photo-inferred); floors above what the street sees from AI-Beautified renders of the 3D tiles, cross-checked against the raw render (generated). Takes a few minutes the first time (tile download, image and vision calls).'
                },
                siteCrown: {
                    type: 'BOOLEAN',
                    description: 'Optional, with site: also fit the building\'s crown (whatever stands above its last full tier: a spire, mast, lantern, drums, fins) from the 3D tiles, so sb.site_crown() returns it as add-ons. The shape program writes the crown as prisms, faceted revolves, sweeps and repeats; their sizes are fitted to the tiles (measured), counts of finer detail come from an AI-Beautified close-up (generated), and the fit\'s silhouette disagreement with the tiles is reported. Takes a minute or two the first time.'
                },
                reference: {
                    type: 'STRING',
                    description: 'Optional: a real place (name, address or "lat, lng") whose ground the scene should take its proportions from, for an imagined environment "like" a real one. Google\'s vector data around it is read before the script runs and handed over as sb.reference(): street centrelines with their type codes and each street\'s width from building front to building front, building footprints with heights where Google has them, land-use and water areas, rails and points of interest, in metres (x east, z south from the place point), with their spreads (heights, footprint areas, widths), the share of ground built and the street grid\'s bearing. Reference only: the scene still opens in the studio, nothing is staged at the place (a real place itself goes to google_3d_tiles_get_clay), and geometry built from it is generated.'
                },
                referenceRadiusM: {
                    type: 'NUMBER',
                    description: 'Optional, with reference: how far around the place to read, metres (default 250, 50-1000).'
                },
                librarySets: {
                    type: 'ARRAY',
                    items: { type: 'STRING' },
                    description: 'Optional: surface material sets from the texture library (photographed and scanned ambientCG and Poly Haven PBR sets) to fetch before the script runs, by set name. Take the names from texture_library_search (search once per surface with its read colour, finish and tile size); never name a set from memory. Pass the top few results per surface: sb.library_surface() picks the one nearest a measured colour and finish, remaps it there and sizes its tile from the set\'s measured real size. Names the library lacks are reported with the closest ones it has. A set is a few hundred MB the first time (cached after).'
                },
                renderMode: {
                    type: 'STRING',
                    enum: ['pbr', 'clay'],
                    description: 'Optional: "clay" only when the user asks to see the scene in clay (untextured, a shape review); omit for the default, which shows the materials the script assigns.'
                }
            },
            required: ['script']
        }
    }
];

/** True for an argument value that carries nothing: null/undefined, blank text, an empty array or object, or only nulls. */
function isBlankArgument(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.every(isBlankArgument);
    if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(isBlankArgument);
    return false;
}

/**
 * Why this call cannot run, when it asks to stage the script on a real place. The tool used to mount the place's
 * raw Google 3D Tiles under the model; a place is now delivered only as remeshed clay with trees, by
 * google_3d_tiles_get_clay (the place) and build_3d_object_from_reference (an object standing there). Blank values
 * count as not given: models send those for arguments they leave empty.
 */
function placeArgumentError(args: Record<string, unknown>): string | undefined {
    const given = (['location', 'coordinates'] as const).filter(name => !isBlankArgument(args[name]));
    if (given.length === 0) return undefined;
    const asked = given.map(name => `${name} ${typeof args[name] === 'string' ? `"${String(args[name]).trim()}"` : JSON.stringify(args[name])}`).join(' and ');
    return `execute_3d_python_script does not stage scripts on real places (got ${asked}). For the place itself call google_3d_tiles_get_clay; for one object standing at the place call build_3d_object_from_reference with that location and a placement. Run this tool without location or coordinates for a scene in a studio void.`;
}

/** The shots a run declared with sb.shot, written beside its GLB (shot_plan.py); none when the script declared none. */
export function readShotPlan(glbPath: string | undefined): ShotCamera[] {
    return readShotFile(glbPath).shots;
}

/** The shots and camera moves a run declared (sb.shot, sb.camera_move), written beside its GLB; none when it declared none. */
export function readShotFile(glbPath: string | undefined): { shots: ShotCamera[]; moves: Array<{ name: string; keys: CameraPathKey[] }> } {
    if (!glbPath) return { shots: [], moves: [] };
    try {
        const json = JSON.parse(fs.readFileSync(`${glbPath}.shots.json`, 'utf8'));
        const shots = parseShotPlan(json);
        return { shots, moves: parseShotMoves(json, shots) };
    } catch {
        return { shots: [], moves: [] };
    }
}

function failedOutcome(error: unknown, summary: string): ToolHandlerOutcome {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
        status: 'failed',
        resultPayload: {
            success: false,
            error: err.message,
            ...(err instanceof PipelineError ? { errorCode: err.code } : {})
        },
        summaryResult: `${summary}: ${err.message}`
    };
}
export const python3DHandlers: Record<string, (args: Record<string, unknown>, _ctx?: any) => Promise<ToolHandlerOutcome>> = {
    execute_3d_python_script: async (args: Record<string, unknown>, _ctx?: any): Promise<ToolHandlerOutcome> => {
        const script = typeof args.script === 'string' ? args.script : '';
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 45000;

        if (!script.trim()) {
            return {
                status: 'failed',
                resultPayload: {
                    success: false,
                    error: 'Empty script provided. Must provide a valid Python script importing scratchbox.'
                },
                summaryResult: 'Failed: script argument was empty.'
            };
        }

        // 1. Scripts are not staged on real places: a place argument fails the call before anything runs.
        const placeError = placeArgumentError(args);
        if (placeError) {
            return {
                status: 'failed',
                resultPayload: { success: false, error: placeError },
                summaryResult: `Failed: ${placeError}`
            };
        }

        // 2. Type-check against the generated scratchbox stubs: a call to something the API does not have is returned
        // to the model to fix, without running. A check that could not finish lets the script run (logged, not "passed").
        const typeCheck = await typeCheckSbScript(script);
        const typeCheckMeta = sbTypeCheckMetadata(typeCheck);
        if (typeCheck.status === 'rejected') {
            const error = formatSbApiErrors(typeCheck.errors);
            return {
                status: 'failed',
                resultPayload: { success: false, error, apiErrors: typeCheck.errors, typeCheck: typeCheckMeta },
                summaryResult: `Python 3D script rejected before running: ${typeCheck.errors.length} call(s) to names or arguments the scratchbox API does not have (${typeCheck.durationMs}ms check). ${typeCheck.errors.slice(0, 3).map(e => `line ${e.line}: ${e.message}`).join('; ')}`
            };
        }
        if (typeCheck.status !== 'passed') {
            console.warn(`[execute_3d_python_script] scratchbox type check ${typeCheck.status} after ${typeCheck.durationMs}ms; running unchecked: ${typeCheck.note}`);
        }

        // 2b. A site to size the building on: measured before the script runs, handed over as a JSON file. A site that
        // cannot be measured fails the call with the reason (no invented massing).
        let site: SiteMassing | undefined;
        let facade: SiteFacade | undefined;
        let crown: SiteCrown | undefined;
        let scan: SiteScan | undefined;
        const siteEnv: Record<string, string> = {};
        if (typeof args.site === 'string' && args.site.trim()) {
            try {
                site = await measureSiteMassing(args.site.trim(), { workspaceRoot: _ctx?.workspaceRoot ?? process.cwd(), ...(_ctx?.signal ? { signal: _ctx.signal } : {}) });
            } catch (err) {
                return failedOutcome(err, `Could not measure the site "${args.site.trim()}"; the script did not run`);
            }
            // the building's tile scan: sb.site_tiers' source without a modeled volume, and sb.site_score's reference
            try {
                scan = await measureSiteScan(site, { workspaceRoot: _ctx?.workspaceRoot ?? process.cwd(), ...(_ctx?.signal ? { signal: _ctx.signal } : {}), ...(_ctx?.reportProgress ? { progress: _ctx.reportProgress } : {}) });
            } catch (err) {
                site.notes.push(`no tile scan of the building (sb.site_score and scan tiers unavailable): ${err instanceof Error ? err.message : String(err)}`);
            }
            if (args.siteFacade === true) {
                try {
                    facade = await readSiteFacade(site, { workspaceRoot: _ctx?.workspaceRoot ?? process.cwd(), ...(_ctx?.signal ? { signal: _ctx.signal } : {}), ...(_ctx?.reportProgress ? { progress: _ctx.reportProgress } : {}) });
                } catch (err) {
                    // the massing still sizes the building; the facade stays on the script's own values, said in the notes
                    site.notes.push(`facade not read: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (args.siteCrown === true) {
                try {
                    crown = await fitSiteCrown(site, { workspaceRoot: _ctx?.workspaceRoot ?? process.cwd(), ...(_ctx?.signal ? { signal: _ctx.signal } : {}), ...(_ctx?.reportProgress ? { progress: _ctx.reportProgress } : {}) });
                } catch (err) {
                    site.notes.push(`crown not fitted: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            const siteFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-site-json-')), 'site.json');
            // pipeline K's straightened facade photos of the building, when a 3D Building run made them: registration,
            // colours per part and the stain the weathering bake reads (sb.site_guides)
            let guides: unknown, guidesReason: string | undefined;
            if (scan?.photoGlbPath && scan.photoGroundY !== undefined) {
                try {
                    const g = findSiteGuides(site.place, scan.photoGlbPath, scan.photoGroundY);
                    if ('reason' in g) guidesReason = g.reason; else guides = g;
                } catch (err) {
                    guidesReason = `facade guides not read: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
            fs.writeFileSync(siteFile, JSON.stringify({ ...site, ...(scan ? { scan } : {}), ...(facade ? { facade } : {}), ...(crown ? { crown } : {}),
                ...(guides ? { guides } : {}), ...(guidesReason ? { guidesReason } : {}) }));
            siteEnv.SCRATCHBOX_SITE_JSON = siteFile;
        }

        // 2b'. A real place as a reference for the scene's proportions (sb.reference()), read before the script runs.
        let reference: ReferencePlace | undefined;
        const referenceEnv: Record<string, string> = {};
        if (typeof args.reference === 'string' && args.reference.trim()) {
            _ctx?.reportProgress?.(`Reading Google's map data around ${args.reference.trim()}`);
            try {
                reference = await measureReferencePlace(args.reference.trim(), {
                    workspaceRoot: _ctx?.workspaceRoot ?? process.cwd(),
                    ...(typeof args.referenceRadiusM === 'number' ? { radiusM: args.referenceRadiusM } : {}),
                    ...(_ctx?.signal ? { signal: _ctx.signal } : {})
                });
            } catch (err) {
                return failedOutcome(err, `Could not read the reference place "${args.reference.trim()}"; the script did not run`);
            }
            const referenceFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-reference-json-')), 'reference.json');
            fs.writeFileSync(referenceFile, JSON.stringify(reference));
            referenceEnv.SCRATCHBOX_REFERENCE_JSON = referenceFile;
        }

        // 2c. Texture library sets the script names, fetched into the cache and handed over as a manifest. A name the
        // library lacks is reported in the manifest (with the closest names), not a failed call; no credentials fail it.
        const libraryEnv: Record<string, string> = {};
        const librarySets = Array.isArray(args.librarySets) ? (args.librarySets as unknown[]).filter((n): n is string => typeof n === 'string' && !!n.trim()) : [];
        if (librarySets.length) {
            try {
                const repoRoot = process.env.SCRATCHBOX_ROOT || (fs.existsSync(path.resolve(process.cwd(), 'packages')) ? process.cwd() : path.resolve(process.cwd(), '..'));
                const fetched = await fetchLibrarySets(librarySets, { repoRoot, ...(_ctx?.signal ? { signal: _ctx.signal } : {}), ...(_ctx?.reportProgress ? { progress: _ctx.reportProgress } : {}) });
                const manifest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-library-json-')), 'library.json');
                fs.writeFileSync(manifest, JSON.stringify(fetched));
                libraryEnv.SCRATCHBOX_LIBRARY_JSON = manifest;
            } catch (err) {
                return failedOutcome(err, `Could not fetch the texture library sets ${librarySets.join(', ')}; the script did not run`);
            }
        }

        // 3. Execute Python script
        const runner = NativePythonRunnerService.getInstance();
        const effectiveScript = script;
        // the open staged scene's structure scan, when it has one: the script reads it (sb.massing.Scan.from_scene()) and
        // its model joins that scene in the place's frame instead of opening in a studio void
        const structureScan = structureScanOf(_ctx?.request?.activeArtifact);
        const scanEnv: Record<string, string> = structureScan ? {
            SCAN_GLB_PATH: structureScan.note.scanGlb,
            ...(structureScan.note.districtGlb && fs.existsSync(structureScan.note.districtGlb) ? { SCAN_DISTRICT_GLB_PATH: structureScan.note.districtGlb } : {}),
            SCAN_GROUND_Y: String(structureScan.note.groundY),
            SCAN_PLAN: JSON.stringify(structureScan.note.plan)
        } : {};
        if (structureScan) {
            try {
                const roof = roofPhotoFor(structureScan.note);
                if (roof) { scanEnv.SCAN_ROOF_PHOTO_PATH = roof.path; scanEnv.SCAN_ROOF_PHOTO_FRAME = JSON.stringify(roof.frame); }
            } catch (err) {
                console.warn(`[execute_3d_python_script] no roof photo for the structure scan: ${(err as Error).message}`);
            }
        }
        const result = await runner.runScript(effectiveScript, {
            timeoutMs,
            env: { ...process.env, ...siteEnv, ...scanEnv, ...libraryEnv, ...referenceEnv }
        });

        // Per User Directive: No silent fallbacks or synthetic substitutes.
        // If a script fails, let the caller see the exact error and diagnostics immediately.

        if (!result.success) {
            return {
                status: 'failed',
                resultPayload: {
                    success: false,
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    errorDetails: result.errorDetails,
                    executionTimeMs: result.executionTimeMs,
                    typeCheck: typeCheckMeta
                },
                summaryResult: `Python 3D execution failed: ${result.errorDetails || result.stderr || 'Non-zero exit code'}`
            };
        }

        const desc = (typeof args.description === 'string' && args.description.trim()) ? args.description.trim() : 'Procedural 3D Python Scene';

        // 4. Analytical AABB Bounding Box & Geometric Fidelity Evaluation
        let cameraPosition: [number, number, number] = [0, 18, 38];
        let cameraTarget: [number, number, number] = [0, 4, 0];
        const cameraFov = 50;
        let bounds: GlbAabbBounds | null = null;
        let gateReport: ComplexityGateReport | null = null;

        let glbBuf: Buffer | null = null;
        if (result.glbBase64) {
            glbBuf = Buffer.from(result.glbBase64, 'base64');
        } else if (result.glbPath && fs.existsSync(result.glbPath)) {
            glbBuf = fs.readFileSync(result.glbPath);
        }
        // The script exited cleanly but there is nothing to show: report that, not a generated scene.
        const writtenGeometry = glbBuf ? extractGlbAnalysis(glbBuf).metrics : null;
        if (!glbBuf || !writtenGeometry || writtenGeometry.totalVertices === 0) {
            const what = !glbBuf
                ? 'the script ran but wrote no GLB (finish with sb.io.write_glb(OUTPUT_GLB_PATH, scene))'
                : !writtenGeometry
                    ? 'the script wrote a file that is not a readable GLB'
                    : 'the GLB the script wrote has no geometry';
            return {
                status: 'failed',
                resultPayload: {
                    success: false,
                    error: what,
                    glbGenerated: !!glbBuf,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    executionTimeMs: result.executionTimeMs
                },
                summaryResult: `Python 3D execution produced no model: ${what}. Nothing was added to the canvas.`
            };
        }

        // A model past what the viewport can hold crashes the browser tab when mounted (a 107 MB, 1.2 M-vertex
        // Empire State Building did), losing the chat turn with it; refuse it with the numbers and how to cut them.
        const limits = viewportSceneLimits();
        if (writtenGeometry.totalVertices > limits.vertices || glbBuf.length > limits.bytes) {
            const mb = (glbBuf.length / 1e6).toFixed(0);
            const heaviest = [...writtenGeometry.submeshes].sort((a, b) => b.vertexCount - a.vertexCount).slice(0, 4)
                .map(m => `${m.name} ${m.vertexCount.toLocaleString('en-US')}`).join(', ');
            const what = `the model is ${writtenGeometry.totalVertices.toLocaleString('en-US')} vertices and ${mb} MB, past what the viewport `
                + `can load (${limits.vertices.toLocaleString('en-US')} vertices, ${(limits.bytes / 1e6).toFixed(0)} MB); heaviest meshes: ${heaviest}`;
            return {
                status: 'failed',
                resultPayload: {
                    success: false,
                    error: what,
                    glbGenerated: true,
                    totalVertices: writtenGeometry.totalVertices,
                    glbBytes: glbBuf.length,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    executionTimeMs: result.executionTimeMs
                },
                summaryResult: `Python 3D model not mounted: ${what}. Nothing was added to the canvas. Make it lighter and run again: `
                    + `trim on tall tiers is the usual bulk (pilaster_bay_stride 2-3, sills and hoods off above the first few floors, `
                    + `string courses only where they read), weather fewer receivers (weathering receivers=["wall"]), and lower SDF or lathe resolution.`
            };
        }

        const vegetation = sbVeggieOf(glbBuf);
        // The shots the script declared (sb.shot): the scene opens on the first, the review looks through it, and the
        // geometry is measured against what each lens can show.
        const { shots, moves: cameraMoves } = readShotFile(result.glbPath);
        let shotBudget: ShotDetailBudgetReport | undefined;
        if (shots.length) {
            try {
                const parts = glbToNamedTriangleSoups(glbBuf, vegetation ? { exclude: isSbVeggieNode } : {});
                if (parts) shotBudget = evaluateShotDetailBudget([...parts].map(([name, soup]) => ({ name, positions: soup.positions, indices: soup.indices })), shots);
            } catch (err: any) {
                console.warn('[execute_3d_python_script] Shot detail budget skipped:', err?.message || err);
            }
        }
        let structureReport: PartConnectivityReport | null = null;
        let visualReview: (VisualReviewResult & { imagePaths?: string[] }) | undefined;
        if (glbBuf) {
            let soup: TriangleSoup | null = null;
            try {
                // SB-Veggie trees (sb.create_tree) are grown natively and checked against their described crowns by the
                // grower; their leaf clusters are separate parts by design, so the structure check reads everything else.
                const structureSoup = vegetation ? glbToTriangleSoup(glbBuf, { exclude: isSbVeggieNode }) : glbToTriangleSoup(glbBuf);
                // the visual review sees the trees at their far level (one level, not all four stacked)
                soup = vegetation ? glbToTriangleSoup(glbBuf, { exclude: isSbVeggieNearLevel }) : structureSoup;
                // Sliced so a large model never blocks the event loop; the turn's signal stops it.
                if (structureSoup && structureSoup.indices.length > 0) structureReport = await analyzePartConnectivityAsync(structureSoup, { signal: _ctx?.signal });
            } catch (err: any) {
                if (err instanceof ConnectivityAnalysisAbortedError) throw err;
                console.warn('[execute_3d_python_script] Structural check skipped:', err?.message || err);
            }
            // Only inside a chat, where the user's request is known; renders three clay views and asks a
            // vision model for objective shape errors the structure check cannot see (e.g. legs leaning wrong).
            const userRequest = _ctx?.request?.prompt;
            if (soup && userRequest && process.env.SCRATCHBOX_3D_VISUAL_REVIEW !== 'off') {
                const reviewDesc = typeof args.description === 'string' ? args.description : '';
                const { result: review, views } = await reviewModelVisually(soup, userRequest, reviewDesc,
                    (prompt, images) => callVisionModel(prompt, images, _ctx?.request?.model),
                    shots.length ? [renderShotView(soup, shots[0])] : []);
                const imagePaths = result.glbPath ? views.map((v, i) => {
                    const p = result.glbPath!.replace(/\.glb$/i, `_review_${i}.png`);
                    try { fs.writeFileSync(p, v.png); } catch { /* best effort */ }
                    return p;
                }) : undefined;
                visualReview = { ...review, imagePaths };
            }
            const analysis = extractGlbAnalysis(glbBuf);
            bounds = analysis.bounds;
            if (analysis.metrics) {
                // Floor for a single hero prop; the result is fed back to the model so it can refine and re-run.
                gateReport = GeometricComplexityGate.evaluate(analysis.metrics, {
                    minVertexCount: 5000,
                    minTriangleCount: 3000,
                    requireMultiMeshHierarchy: false
                });
            }
        }

        if (bounds) {
            cameraTarget = [bounds.center[0], Math.max(bounds.center[1], bounds.dimensions[1] * 0.35), bounds.center[2]];
            const fovRad = (cameraFov * Math.PI) / 180;
            // Frame camera with comfortable safety margin focusing on hero height and structures
            const effectiveRadius = Math.min(bounds.radius, Math.max(bounds.dimensions[1] * 1.6, Math.min(bounds.radius, 35.0)));
            const distance = Math.max(6.0, (effectiveRadius / Math.sin(fovRad * 0.5)) * 1.2);
            // 35-degree azimuthal cinematic 3/4 perspective
            cameraPosition = [
                bounds.center[0] + distance * 0.65,
                bounds.center[1] + distance * 0.45,
                bounds.center[2] + distance * 0.85
            ];
        }

        // A declared shot is the camera the scene was built for: the scene opens on it, with its lens; with a camera move,
        // on the move's first moment, and the timeline plays the move.
        const heroShot: ShotCamera | undefined = shots[0];
        const move = cameraMoves[0];
        const moveStart = move ? cameraPoseAt(move.keys, 0) : null;
        const sceneCamera = moveStart
            ? {
                position: moveStart.position,
                target: moveStart.target,
                fov: +moveStart.verticalFovDeg.toFixed(3),
                lens: { focalLengthMm: moveStart.focalMm, sensorWidthMm: moveStart.sensorWidthMm, sensorHeightMm: +(moveStart.sensorWidthMm / moveStart.aspect).toFixed(3), depthOfField: false },
                keepPoseOnLoad: true
            }
            : heroShot
            ? {
                position: heroShot.position,
                target: heroShot.target,
                fov: +verticalFovDeg(heroShot).toFixed(3),
                lens: { focalLengthMm: heroShot.focalMm, sensorWidthMm: heroShot.sensorWidthMm, sensorHeightMm: +(heroShot.sensorWidthMm / heroShot.aspect).toFixed(3), depthOfField: false },
                keepPoseOnLoad: true
            }
            : { position: cameraPosition, target: cameraTarget, fov: cameraFov };
        const shotBudgetText = shotBudget ? describeShotDetailBudget(shotBudget) : '';

        // Nothing comes from the scene on the canvas: the new scene holds only the model this script wrote.
        const sceneSubtitle = `Generated 3D asset via Scratchbox Python 3 engine (${result.executionTimeMs}ms)`;

        let durableHeroUri: string | undefined = undefined;
        try {
            if (result.glbPath && fs.existsSync(result.glbPath) && fs.statSync(result.glbPath).size > 100) {
                durableHeroUri = publishToModels(result.glbPath);
            }
        } catch (err) {
            return failedOutcome(err, 'The generated model could not be published to public/models');
        }

        const sceneObjects = [
            ...(durableHeroUri ? [{
                id: `hero-${Date.now()}`,
                content: {
                    type: '3d-model',
                    durableUri: durableHeroUri,
                    mimeType: 'model/gltf-binary',
                    metadata: {
                        role: 'hero',
                        description: desc,
                        originalPath: result.glbPath,
                        metricScale: 1.0,
                        groundSnapped: true
                    }
                },
                space: { spatial3d: { x: 0, y: 0, z: 0 } },
                time: { startMs: 0, durationMs: 20000 },
                lineage: { version: 1 }
            }] : [])
        ];

        // A model built from the open staged scene's structure scan joins that scene, in its frame (no studio void, no
        // reframing): labelled generated (a script's output), with the scan and footprint it was built from.
        const prevScene = _ctx?.request?.activeArtifact as { id?: string; title?: string; version?: number; data?: { objects?: unknown[] } & Record<string, unknown> } | undefined;
        const joinsScene = !!(structureScan && durableHeroUri && prevScene?.data);
        const scanObject = joinsScene ? {
            id: `scan-massing-${Date.now()}`,
            content: {
                type: '3d-model',
                durableUri: durableHeroUri,
                mimeType: 'model/gltf-binary',
                metadata: {
                    // placed like the staged build's own layers: in the tile frame as written, never seated on the ground
                    // the way a hero is (that moves it off the scan it was built from)
                    role: 'environment',
                    isGround: false,
                    layer: 'massing',
                    source: 'execute_3d_python_script',
                    description: desc,
                    builtFrom: { runId: structureScan!.runId, scanGlb: structureScan!.note.scanGlb, plan: structureScan!.note.planSource ?? 'scan outline' },
                    provenance: { label: 'generated', method: 'a Python script built this from the structure\'s isolated scan (sb.massing); its fit is in the script output', measuredGeometry: false }
                }
            },
            space: { spatial3d: { x: 0, y: 0, z: 0 } },
            time: { startMs: 0, durationMs: 20000 },
            lineage: { version: 1 }
        } : undefined;
        const joinedArtifact = joinsScene ? {
            ...prevScene,
            version: (prevScene!.version || 1) + 1,
            data: { ...prevScene!.data, objects: [...(prevScene!.data!.objects ?? []), scanObject] }
        } : undefined;

        return {
            status: 'completed',
            resultPayload: {
                success: true,
                ...(joinsScene ? { joinedScene: { artifactId: prevScene!.id, objectId: scanObject!.id, scan: structureScan!.note.scanGlb } } : {}),
                glbPath: result.glbPath,
                glbGenerated: true,
                ...(site ? { site: { resolvedAs: site.place.resolvedAs, topM: site.topM, tiers: site.tiers.map(t => ({ baseM: +t.baseM.toFixed(1), topM: +t.topM.toFixed(1), areaM2: Math.round(t.areaM2), provenance: t.provenance })), notes: site.notes,
                    ...(facade ? { facade: { readings: facade.readings.map(r => ({ scope: r.scope, appliesM: [Math.round(r.appliesFromM), Math.round(r.appliesToM)], provenance: r.provenance, confidence: r.confidence, values: r.values, rejected: r.rejected, source: r.source })), notes: facade.notes } } : {}),
                    ...(crown ? { crown: { fromM: crown.fromM, toM: crown.toM, silhouetteDisagreement: crown.silhouette, silhouetteBefore: crown.silhouetteBefore, matched: crown.matched, pieces: crown.pieces.map(p => ({ id: p.id, operator: p.operator, label: p.label, provenance: p.provenance, measured: p.measured, generated: p.generated })), notes: crown.notes } } : {}) } } : {}),
                vertexCount: writtenGeometry.totalVertices,
                triangleCount: writtenGeometry.totalTriangles,
                // the scene's trees: SB-Veggie, grown natively from sb.create_tree descriptions (absent: none)
                vegetation,
                executionTimeMs: result.executionTimeMs,
                typeCheck: typeCheckMeta,
                stdout: result.stdout,
                description: desc,
                overallBoundingBox: bounds,
                gateReport: gateReport,
                structureReport,
                structuralIssues: structureReport ? describeFloatingParts(structureReport) : undefined,
                ...(reference ? { reference: { place: reference.place, radiusM: reference.radiusM, stats: reference.stats, streets: reference.streets.length, provenance: reference.provenance } } : {}),
                ...(cameraMoves.length ? { cameraMoves: cameraMoves.map(m => ({ name: m.name, keys: m.keys.length, durationS: m.keys[m.keys.length - 1].timeMs / 1000 })) } : {}),
                ...(shots.length ? { shots, shotDetailBudget: shotBudget ? { ...shotBudget, parts: undefined } : undefined } : {}),
                visualReview,
                visualIssues: visualReview ? describeVisualProblems(visualReview) : undefined,
                groundDatum: {
                    coordinateSystem: 'metric-enu',
                    units: 'meters',
                    scale: 1.0,
                    groundDatumMeters: 0.0,
                    groundLogic: 'shared-metric-ground'
                },
                artifact: joinedArtifact ?? {
                    id: `artifact-3d-${Date.now()}`,
                    type: '3d-scene',
                    title: desc,
                    summary: sceneSubtitle,
                    data: {
                        title: desc,
                        subtitle: sceneSubtitle,
                        worldBranch: 'procedural/python-scene',
                        sceneType: 'custom',
                        renderMode: args.renderMode === 'clay' ? 'clay' : firstPassRenderMode(_ctx?.request?.prompt),
                        cameraMode: 'orbit',
                        animation: 'orbit',
                        camera: sceneCamera,
                        ...(shots.length ? { shots } : {}),
                        // no isPlaying / currentTimeMs: the viewport re-applies those on every data update, which would stop playback
                        ...(move ? { timeline: { durationMs: move.keys[move.keys.length - 1].timeMs, isLooping: true, camera: { name: move.name, keys: move.keys } } } : {}),
                        environment: {
                            skybox: 'studio',
                            lighting: 'studio',
                            ground: false
                        },
                        groundDatum: {
                            coordinateSystem: 'metric-enu',
                            units: 'meters',
                            scale: 1.0,
                            groundDatumMeters: 0.0,
                            groundLogic: 'shared-metric-ground'
                        },
                        objects: sceneObjects,
                        pythonGenerator: {
                            enabled: true,
                            filename: 'procedural_scene.py',
                            sourceCode: effectiveScript,
                            glbBase64: result.glbBase64,
                            glbPath: result.glbPath,
                            lastCompiledTimeMs: Date.now(),
                            // the scratchbox API (hash of the generated stubs) the script was written and checked against
                            sbApiVersion: SB_API_VERSION,
                            typeCheck: typeCheckMeta
                        }
                    }
                }
            },
            summaryResult: `Generated a 3D GLB via Python (${result.executionTimeMs}ms; ${writtenGeometry.totalVertices} vertices, ${writtenGeometry.totalTriangles} triangles). GLB framed dynamically at bounds [${bounds ? bounds.dimensions.map(d => d.toFixed(1) + 'm').join(' x ') : 'default'}]. Shared Metric Ground Logic: SI meters (1 unit = 1m), anchor ground datum Y=0.0m.${gateReport && !gateReport.passed ? ' Fidelity alerts: ' + gateReport.violations.join('; ') + ' Refine the script and run execute_3d_python_script again: revolve continuous profiles with sb.create_lathe, displace a unit high-resolution sphere for organic masses, sweep rails with sb.sweep_curve_profile, and raise segment counts.' : ''}${reference ? ' ' + describeReference(reference) : ''}${shotBudgetText ? ' ' + shotBudgetText : ''}${move ? ` Camera move "${move.name}": ${move.keys.length} keys over ${(move.keys[move.keys.length - 1].timeMs / 1000).toFixed(1)} s on the scene's timeline (the scene opens on its first moment; path_trace_render timeSeconds renders any moment).` : ''}${structureReport && !structureReport.passed ? ' ' + describeFloatingParts(structureReport) : ''}${visualReview && visualReview.verdict === 'problems' ? ' ' + describeVisualProblems(visualReview) : ''}`
        };
    }
};

/** The SB-Veggie trees a GLB carries (its scene extras sbVeggie, written by the grower), or undefined. */
export function sbVeggieOf(glb: Buffer): { generator: 'SB-Veggie'; trees: number; triangles?: number; levelsOfDetail: boolean } | undefined {
    try {
        if (glb.length < 20 || glb.toString('utf8', 0, 4) !== 'glTF') return undefined;
        const json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
        const scene = json.scenes?.[json.scene ?? 0];
        const v = scene?.extras?.sbVeggie ?? json.extras?.sbVeggie;
        if (!v || typeof v.trees !== 'number') return undefined;
        return { generator: 'SB-Veggie', trees: v.trees, triangles: v.triangles, levelsOfDetail: !!(scene?.extras?.sbTrees ?? json.extras?.sbTrees) };
    } catch {
        return undefined;
    }
}

/** Copies a GLB into public/models (when it is not already there) and returns its /models URL; errors propagate. */
function modelsDir(): string {
    const repoRoot = process.env.SCRATCHBOX_ROOT || (fs.existsSync(path.resolve(process.cwd(), 'packages')) ? process.cwd() : path.resolve(process.cwd(), '..'));
    return path.resolve(repoRoot, 'public/models');
}

/** The file behind a `/models/<name>` URL that publishToModels gave, when it exists. */
export function publishedModelPath(url: unknown): string | undefined {
    const m = typeof url === 'string' ? /^\/models\/([^/\\?#]+\.glb)$/.exec(url) : null;
    if (!m) return undefined;
    const p = path.join(modelsDir(), m[1]);
    return fs.existsSync(p) ? p : undefined;
}

export function publishToModels(glbPath: string): string {
    const canonicalModelsDir = modelsDir();
    const fileName = path.basename(glbPath);
    const canonicalDest = path.join(canonicalModelsDir, fileName);
    if (path.resolve(glbPath) !== canonicalDest) {
        fs.mkdirSync(canonicalModelsDir, { recursive: true });
        fs.copyFileSync(glbPath, canonicalDest);
    }
    return `/models/${fileName}`;
}
