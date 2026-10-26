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
import { analyzePartConnectivityAsync, ConnectivityAnalysisAbortedError, describeFloatingParts, glbToTriangleSoup, type PartConnectivityReport, type TriangleSoup } from '../../3d-engine/part-connectivity';
import { callVisionModel, describeVisualProblems, reviewModelVisually, type VisualReviewResult } from '../../3d-engine/visual-review';
import { formatSbApiErrors, sbTypeCheckMetadata, typeCheckSbScript } from '../../3d-engine/sb-script-typecheck';
import { SB_API_CORE_SUMMARY, SB_API_VERSION } from '../../3d-engine/sb-api.generated';
import { firstPassRenderMode } from '../scene3d-first-pass-baseline';
import { measureSiteMassing, type SiteMassing } from '../../3d-engine/site-massing';
import { readSiteFacade, type SiteFacade } from '../../3d-engine/site-facade';
import { fitSiteCrown, type SiteCrown } from '../../3d-engine/site-crown';
import * as os from 'os';

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
- Scene and export: scene = sb.Scene(); scene.add_mesh(mesh); finish with sb.io.write_glb(OUTPUT_GLB_PATH, scene). A single Mesh can be written directly too.`;

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
        description: 'Runs a procedural Python 3 script with the Scratchbox 3D Engine (import scratchbox as sb) and opens the GLB it writes as a new 3D scene in a studio void, shown with the materials the script assigns (textured by default; studio clay only when the user asks for clay). Choose the tool by what the user asked for: a real-world place goes to google_3d_tiles_get_clay; one specific object, or an abstract form, goes to build_3d_object_from_reference (with its location when it stands at a real place); an imagined environment or landscape, a scene made of several objects, or an explicit request for a script comes here. Every call starts a new scene: nothing is carried over from the scene already on the canvas. This tool does not stage anything on a real place: a call with a location or coordinates fails without running the script. To size a building on a real one, pass site (the place): its measured massing reaches the script as sb.site(), and sb.site_tiers() turns it into create_building_parts tiers; the model still opens in the studio. If the script writes no GLB, or one with no geometry, the call fails.\n\n' + PYTHON_3D_API_REFERENCE,
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
        const siteEnv: Record<string, string> = {};
        if (typeof args.site === 'string' && args.site.trim()) {
            try {
                site = await measureSiteMassing(args.site.trim(), { workspaceRoot: _ctx?.workspaceRoot ?? process.cwd(), ...(_ctx?.signal ? { signal: _ctx.signal } : {}) });
            } catch (err) {
                return failedOutcome(err, `Could not measure the site "${args.site.trim()}"; the script did not run`);
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
            fs.writeFileSync(siteFile, JSON.stringify({ ...site, ...(facade ? { facade } : {}), ...(crown ? { crown } : {}) }));
            siteEnv.SCRATCHBOX_SITE_JSON = siteFile;
        }

        // 3. Execute Python script
        const runner = NativePythonRunnerService.getInstance();
        const effectiveScript = script;
        const result = await runner.runScript(effectiveScript, {
            timeoutMs,
            env: { ...process.env, ...siteEnv }
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

        let structureReport: PartConnectivityReport | null = null;
        let visualReview: (VisualReviewResult & { imagePaths?: string[] }) | undefined;
        if (glbBuf) {
            let soup: TriangleSoup | null = null;
            try {
                soup = glbToTriangleSoup(glbBuf);
                // Sliced so a large model never blocks the event loop; the turn's signal stops it.
                if (soup) structureReport = await analyzePartConnectivityAsync(soup, { signal: _ctx?.signal });
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
                    (prompt, images) => callVisionModel(prompt, images, _ctx?.request?.model));
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

        return {
            status: 'completed',
            resultPayload: {
                success: true,
                glbPath: result.glbPath,
                glbGenerated: true,
                ...(site ? { site: { resolvedAs: site.place.resolvedAs, topM: site.topM, tiers: site.tiers.map(t => ({ baseM: +t.baseM.toFixed(1), topM: +t.topM.toFixed(1), areaM2: Math.round(t.areaM2), provenance: t.provenance })), notes: site.notes,
                    ...(facade ? { facade: { readings: facade.readings.map(r => ({ scope: r.scope, appliesM: [Math.round(r.appliesFromM), Math.round(r.appliesToM)], provenance: r.provenance, confidence: r.confidence, values: r.values, rejected: r.rejected, source: r.source })), notes: facade.notes } } : {}),
                    ...(crown ? { crown: { fromM: crown.fromM, toM: crown.toM, silhouetteDisagreement: crown.silhouette, silhouetteBefore: crown.silhouetteBefore, matched: crown.matched, pieces: crown.pieces.map(p => ({ id: p.id, operator: p.operator, label: p.label, provenance: p.provenance, measured: p.measured, generated: p.generated })), notes: crown.notes } } : {}) } } : {}),
                vertexCount: writtenGeometry.totalVertices,
                triangleCount: writtenGeometry.totalTriangles,
                executionTimeMs: result.executionTimeMs,
                typeCheck: typeCheckMeta,
                stdout: result.stdout,
                description: desc,
                overallBoundingBox: bounds,
                gateReport: gateReport,
                structureReport,
                structuralIssues: structureReport ? describeFloatingParts(structureReport) : undefined,
                visualReview,
                visualIssues: visualReview ? describeVisualProblems(visualReview) : undefined,
                groundDatum: {
                    coordinateSystem: 'metric-enu',
                    units: 'meters',
                    scale: 1.0,
                    groundDatumMeters: 0.0,
                    groundLogic: 'shared-metric-ground'
                },
                artifact: {
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
                        camera: {
                            position: cameraPosition,
                            target: cameraTarget,
                            fov: cameraFov
                        },
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
            summaryResult: `Generated a 3D GLB via Python (${result.executionTimeMs}ms; ${writtenGeometry.totalVertices} vertices, ${writtenGeometry.totalTriangles} triangles). GLB framed dynamically at bounds [${bounds ? bounds.dimensions.map(d => d.toFixed(1) + 'm').join(' x ') : 'default'}]. Shared Metric Ground Logic: SI meters (1 unit = 1m), anchor ground datum Y=0.0m.${gateReport && !gateReport.passed ? ' Fidelity alerts: ' + gateReport.violations.join('; ') + ' Refine the script and run execute_3d_python_script again: revolve continuous profiles with sb.create_lathe, displace a unit high-resolution sphere for organic masses, sweep rails with sb.sweep_curve_profile, and raise segment counts.' : ''}${structureReport && !structureReport.passed ? ' ' + describeFloatingParts(structureReport) : ''}${visualReview && visualReview.verdict === 'problems' ? ' ' + describeVisualProblems(visualReview) : ''}`
        };
    }
};

/** Copies a GLB into public/models (when it is not already there) and returns its /models URL; errors propagate. */
function publishToModels(glbPath: string): string {
    const repoRoot = process.env.SCRATCHBOX_ROOT || (fs.existsSync(path.resolve(process.cwd(), 'packages')) ? process.cwd() : path.resolve(process.cwd(), '..'));
    const canonicalModelsDir = path.resolve(repoRoot, 'public/models');
    const fileName = path.basename(glbPath);
    const canonicalDest = path.join(canonicalModelsDir, fileName);
    if (path.resolve(glbPath) !== canonicalDest) {
        fs.mkdirSync(canonicalModelsDir, { recursive: true });
        fs.copyFileSync(glbPath, canonicalDest);
    }
    return `/models/${fileName}`;
}
