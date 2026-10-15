/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Python 3D Procedural Scripting Tools
 * Exposes NativePythonRunnerService to Gemini agents, allowing Blender-style
 * procedural Python scripting (import scratchbox as sb) backed by native C++20
 * Astro engine nanobind bindings to stream binary .glb directly into the viewport.
 * Supports analytical AABB dynamic camera auto-framing and geospatial shape extraction.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDeclaration, ToolHandlerOutcome } from './types';
import { NativePythonRunnerService } from '../../3d-engine/native-python-runner-service';
import { GeospatialTileExtractionBridge, ExtractedLocationManifest, type LocationExtractionResult } from '../../spatial/GeospatialTileExtractionBridge';
import type { GeoAnchor } from '../../spatial/Google3DTileBlockoutPipelineService';
import { LocationUnresolvedError, PipelineError, TileExtractionError } from '../../../common/errors/pipeline-errors';
import { assertUsableCoordinates, parseCoordinateText } from '../../../common/coordinate/parse-coordinates';
import { GeometricComplexityGate, GeometricSceneMetrics, GeometricMeshSummary, ComplexityGateReport } from '../../../common/spatial/GeometricComplexityGate';
import { analyzePartConnectivity, describeFloatingParts, glbToTriangleSoup, type PartConnectivityReport, type TriangleSoup } from '../../3d-engine/part-connectivity';
import { callVisionModel, describeVisualProblems, reviewModelVisually, type VisualReviewResult } from '../../3d-engine/visual-review';

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
 * Without a reference the model guesses common names (mesh.clone(), mesh.transform, a materials
 * module) that do not exist, and every guess costs a failed tool call. Every name here is checked
 * against the real package by python-3d-api-reference.test.ts.
 */
export const PYTHON_3D_API_REFERENCE = `Verified scratchbox API. Only use names listed here or in the system instructions; do not guess others.
- Primitives (each returns a Mesh and accepts material=): sb.create_box(width=, height=, depth=) or sb.create_box(size=(w, h, d)); sb.create_beveled_box(size=(w, h, d), bevel=0.02); sb.create_cylinder(radius=, height=, segments=24); sb.create_sphere(radius=, rings=16, sectors=32); sb.create_cone(radius=, height=); sb.create_plane(width=, height=); sb.create_lathe(profile, segments=32); sb.create_loft(slices); sb.sweep_curve_profile(path, profile_dimensions=(w, h)); sb.revolve_harmonic_solid(profile_curve=, harmonic_lobe_count=0); sb.replicate_metric_array(guide_points=, pitch_meters=, seed_geometry=).
- Mesh methods (modify the mesh in place): translate(x, y, z); rotate_x(deg); rotate_y(deg); rotate_z(deg); scale(s) or scale(x, y, z); append(other); merge(other); subtract(other); set_material(mat); subdivide(iterations); taper(factor, axis); bend(angle_deg, radius); twist(angle_deg, axis); bulge(); displace(frequency, amplitude); recompute_smooth_normals(); weld_vertices() (call before subdividing boxes, whose faces arrive unwelded and crack apart otherwise); get_positions_flat(). Properties, read without parentheses: vertex_count, triangle_count, bounds (with .min and .max).
- Reading geometry back: get_positions_flat returns float32 xyz as bytes; wrap it with Python's array module, typecode "f". Subdivision rounds and shrinks shapes and deformers move vertices, so measure positions after deforming instead of assuming the original sizes.
- Assemblies (legs, rungs, frames, struts, rails): compute the joint points first, then build each member between two joints with sb.sweep_curve_profile(path=[start, end], profile_dimensions=(r, r)). Take a connecting member's ends from points on the members it joins (a rung from lerp(top_a, foot_a, t) to lerp(top_b, foot_b, t)) so it attaches by construction; run member ends slightly into what they join. Do not place parts by rotating them about the origin and guessing offsets. Every result is checked: parts that touch nothing are listed in structuralIssues, and you must fix them.
- Meshes have no clone(), copy() or transform. To duplicate: dup = sb.geometry.Mesh(); dup.append(mesh), then position it with translate, rotate_x/y/z and scale.
- Materials: sb.PbrMaterial(base_color=(r, g, b, a), roughness=, metallic=) or presets such as sb.PbrMaterial.clay(), sb.PbrMaterial.wood_oak(), sb.PbrMaterial.chrome(), sb.PbrMaterial.glass_tinted(). There is no separate materials module.
- Scene and export: scene = sb.Scene(); scene.add_mesh(mesh); finish with sb.io.write_glb(OUTPUT_GLB_PATH, scene). A single Mesh can be written directly too.`;

export const PYTHON_3D_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'execute_3d_python_script',
        description: 'Runs a procedural Python 3 script with the Scratchbox 3D Engine (import scratchbox as sb) and opens the GLB it writes as a new studio-clay 3D scene. Choose the tool by what the user asked for: a real-world place on its own goes to google_3d_tiles_get_clay; one specific object, or an abstract form, goes to build_3d_object_from_reference; an imagined environment or landscape, a scene made of several objects, or an explicit request for a script comes here. Every call starts a new scene: nothing is carried over from the scene already on the canvas. location/coordinates stage the script\'s model on a real place: the place is resolved with Google Places, its Google 3D Tiles are extracted (raw tiles shown in studio clay, not remeshed, no trees) and mounted under the model as their own object, in metres around the place\'s centre. The script does not get the tiles\' geometry: sb.geospatial.load_location() returns only the extracted file\'s path (glb_path), its manifest path (manifest_path, JSON with the resolved address, coordinates and the tiles\' bounding box) and the query, so build only what stands on the place. If the place cannot be resolved or extracted, the call fails and the script is not run. If the script writes no GLB, or one with no geometry, the call fails.\n\n' + PYTHON_3D_API_REFERENCE,
        parameters: {
            type: 'OBJECT',
            properties: {
                script: {
                    type: 'STRING',
                    description: 'The procedural Python 3 script. Must import scratchbox as sb and write the resulting scene to OUTPUT_GLB_PATH via sb.io.write_glb(OUTPUT_GLB_PATH, scene).'
                },
                location: {
                    type: 'STRING',
                    description: 'Optional place name or address, exactly as the user wrote it, to stage the model on. It is resolved with Google Places (the result reports the address it resolved) and its Google 3D Tiles are extracted and mounted under the model.'
                },
                coordinates: {
                    type: 'ARRAY',
                    items: { type: 'NUMBER' },
                    description: 'Optional [latitude, longitude] or [latitude, longitude, elevation in metres], only when the user gave coordinates. Never supply coordinates from memory: pass the place as location instead.'
                },
                description: {
                    type: 'STRING',
                    description: 'Optional human-readable description of the 3D scene or asset being generated.'
                },
                timeoutMs: {
                    type: 'NUMBER',
                    description: 'Execution timeout in milliseconds (default 45000).'
                }
            },
            required: ['script']
        }
    }
];

interface PythonLocationRequest {
    /** What the model passed: the place text, or the coordinate pair as typed. */
    label: string;
    target: string | GeoAnchor;
}

/** True for an argument value that carries nothing: null/undefined, blank text, an empty array or object, or only nulls. */
function isBlankArgument(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.every(isBlankArgument);
    if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(isBlankArgument);
    return false;
}

/**
 * The place this call asks for, from `coordinates` (validated, never (0, 0)) or `location`; undefined when neither
 * is given. A blank `coordinates` value (null, [], {}, "", [null, null]) counts as not given: models send those for
 * an optional argument, and the script then runs unstaged. A partial or malformed value is an error.
 */
function readLocationRequest(args: Record<string, unknown>): PythonLocationRequest | undefined {
    const location = typeof args.location === 'string' ? args.location.trim() : '';
    const raw = args.coordinates;
    const shapeError = (got: string) => new LocationUnresolvedError(got, 'coordinates must be [latitude, longitude], [latitude, longitude, elevation in metres] or { lat, lng }');
    let coords: GeoAnchor | undefined;
    if (isBlankArgument(raw)) {
        coords = undefined;
    } else if (Array.isArray(raw)) {
        // An explicitly empty optional elevation ([lat, lng, null] or [lat, lng, '']) is the same as leaving it out.
        const values = raw.length === 3 && isBlankArgument(raw[2]) ? raw.slice(0, 2) : raw;
        const numbers = values.map(v => typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
        if ((numbers.length !== 2 && numbers.length !== 3) || numbers.some(n => !Number.isFinite(n))) {
            throw shapeError(JSON.stringify(raw));
        }
        coords = { lat: numbers[0], lng: numbers[1], ...(numbers.length === 3 ? { elevation: numbers[2] } : {}) };
    } else if (typeof raw === 'string') {
        const parsed = parseCoordinateText(raw);
        if (!parsed) throw shapeError(raw);
        coords = parsed;
    } else if (raw && typeof raw === 'object') {
        const rc = raw as Record<string, unknown>;
        if (typeof rc.lat !== 'number' || typeof rc.lng !== 'number' || (rc.elevation !== undefined && rc.elevation !== null && typeof rc.elevation !== 'number')) {
            throw shapeError(JSON.stringify(raw));
        }
        coords = { lat: rc.lat, lng: rc.lng, ...(typeof rc.elevation === 'number' ? { elevation: rc.elevation } : {}) };
    } else {
        throw shapeError(String(raw));
    }
    if (coords) {
        const label = `${coords.lat}, ${coords.lng}`;
        assertUsableCoordinates(coords.lat, coords.lng, label);
        if (coords.elevation !== undefined && !Number.isFinite(coords.elevation)) {
            throw new LocationUnresolvedError(label, 'the elevation must be a number of metres');
        }
        return { label: location || label, target: { ...coords, ...(location ? { landmarkName: location } : {}) } };
    }
    return location ? { label: location, target: location } : undefined;
}

function failedOutcome(error: unknown, summary: string): ToolHandlerOutcome {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
        status: 'failed',
        resultPayload: {
            success: false,
            error: err.message,
            ...(err instanceof PipelineError ? { errorCode: err.code } : {}),
            ...(err instanceof TileExtractionError ? { stage: err.stage } : {})
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

        const runner = NativePythonRunnerService.getInstance();
        const customEnv: NodeJS.ProcessEnv = { ...process.env };

        // 1. A requested place is resolved and extracted before the script runs. If that fails the call fails:
        // the script is not run and nothing is mounted in place of the location.
        let locationRequest: PythonLocationRequest | undefined;
        let extraction: LocationExtractionResult | undefined;
        try {
            locationRequest = readLocationRequest(args);
            if (locationRequest) {
                extraction = await GeospatialTileExtractionBridge.getInstance().ingestAndExtract(locationRequest.target, { mode: 'clay', ...(_ctx?.signal ? { signal: _ctx.signal } : {}) });
                if (!extraction.success || extraction.mock) {
                    throw new TileExtractionError('crawl', extraction.error || `no Google 3D Tiles were extracted for "${locationRequest.label}"`);
                }
            }
        } catch (err) {
            // What was asked for, as given: the place text, else the coordinates as JSON (not Array#toString).
            const asked = locationRequest?.label
                ?? (typeof args.location === 'string' && args.location.trim() ? args.location.trim()
                    : typeof args.coordinates === 'string' ? args.coordinates : JSON.stringify(args.coordinates));
            return failedOutcome(err, `Location "${asked}" could not be staged; the script was not run`);
        }
        const extractedManifest: ExtractedLocationManifest | undefined = extraction?.manifest;
        const extractedGlbPath: string | undefined = extraction?.glbPath;
        if (extraction && locationRequest) {
            customEnv.SCRATCHBOX_LOCATION_QUERY = extraction.manifest.resolvedAddress;
            customEnv.SCRATCHBOX_LOCATION_GLB = extraction.glbPath;
            customEnv.SCRATCHBOX_LOCATION_MANIFEST = extraction.manifestPath;
        }

        // 2. Execute Python script
        let effectiveScript = script;
        let result = await runner.runScript(effectiveScript, {
            timeoutMs,
            env: customEnv
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
                    executionTimeMs: result.executionTimeMs
                },
                summaryResult: `Python 3D execution failed: ${result.errorDetails || result.stderr || 'Non-zero exit code'}`
            };
        }

        const desc = (typeof args.description === 'string' && args.description.trim()) ? args.description.trim() : 'Procedural 3D Python Scene';

        // 3. Analytical AABB Bounding Box & Geometric Fidelity Evaluation
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

        let structureReport: PartConnectivityReport | null = null;
        let visualReview: (VisualReviewResult & { imagePaths?: string[] }) | undefined;
        if (glbBuf) {
            let soup: TriangleSoup | null = null;
            try {
                soup = glbToTriangleSoup(glbBuf);
                if (soup) structureReport = analyzePartConnectivity(soup);
            } catch (err: any) {
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

        // The scene is staged only on tiles extracted for this call; nothing comes from the scene on the canvas.
        const resolvedLocName = extractedManifest?.resolvedAddress;
        const geoAnchor = extractedManifest
            ? {
                lat: extractedManifest.lat,
                lng: extractedManifest.lng,
                ...(extractedManifest.altitudeMeters !== undefined ? { elevation: extractedManifest.altitudeMeters } : {}),
                datum: 'MSL_EGM96',
                active: true,
                landmarkName: extractedManifest.resolvedAddress
            }
            : undefined;
        const isStaged = !!extractedManifest;

        const stagedTitle = extractedManifest && !desc.toLowerCase().includes('staged')
            ? `${desc} — Staged in ${resolvedLocName}`
            : desc;
        const stagedSubtitle = extractedManifest
            ? `Real-World Geospatial Staging | ${resolvedLocName} [${extractedManifest.lat.toFixed(4)}°, ${extractedManifest.lng.toFixed(4)}°] | Studio Grey Clay Grounding`
            : `Generated 3D asset via Scratchbox Python 3 engine (${result.executionTimeMs}ms)`;

        let durableHeroUri: string | undefined = undefined;
        let locationUri: string | undefined = undefined;
        try {
            if (result.glbPath && fs.existsSync(result.glbPath) && fs.statSync(result.glbPath).size > 100) {
                durableHeroUri = publishToModels(result.glbPath);
            }
            if (extractedGlbPath) {
                locationUri = publishToModels(extractedGlbPath);
            }
        } catch (err) {
            return failedOutcome(err, 'The generated model could not be published to public/models');
        }

        const stagedObjects = [
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
            }] : []),
            ...(locationUri ? [{
                id: `staged-location-${Date.now()}`,
                content: {
                    type: '3d-model',
                    durableUri: locationUri,
                    mimeType: 'model/gltf-binary',
                    metadata: {
                        role: 'environment',
                        source: 'google_3d_tiles_clay',
                        isGround: true,
                        remeshed: false,
                        metricScale: 1.0,
                        groundDatumMeters: 0.0,
                        location: resolvedLocName
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
                vertexCount: writtenGeometry.totalVertices,
                triangleCount: writtenGeometry.totalTriangles,
                executionTimeMs: result.executionTimeMs,
                stdout: result.stdout,
                description: desc,
                overallBoundingBox: bounds,
                gateReport: gateReport,
                structureReport,
                structuralIssues: structureReport ? describeFloatingParts(structureReport) : undefined,
                visualReview,
                visualIssues: visualReview ? describeVisualProblems(visualReview) : undefined,
                locationManifest: extractedManifest,
                locationGlbPath: extractedGlbPath,
                geoAnchor,
                locationQuery: locationRequest?.label,
                resolvedAddress: resolvedLocName,
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
                    title: stagedTitle,
                    summary: stagedSubtitle,
                    data: {
                        title: stagedTitle,
                        subtitle: stagedSubtitle,
                        worldBranch: resolvedLocName ? `geospatial/${resolvedLocName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : 'procedural/python-scene',
                        sceneType: extractedManifest ? 'real_world_landmark' : 'custom',
                        renderMode: 'clay',
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
                            ground: isStaged
                        },
                        groundDatum: {
                            coordinateSystem: 'metric-enu',
                            units: 'meters',
                            scale: 1.0,
                            groundDatumMeters: 0.0,
                            groundLogic: 'shared-metric-ground'
                        },
                        ...(isStaged ? { groundTileMode: 'photoreal-clay', geoAnchor } : {}),
                        objects: stagedObjects,
                        pythonGenerator: {
                            enabled: true,
                            filename: 'procedural_scene.py',
                            sourceCode: effectiveScript,
                            glbBase64: result.glbBase64,
                            glbPath: result.glbPath,
                            lastCompiledTimeMs: Date.now()
                        }
                    }
                }
            },
            summaryResult: `Generated a 3D GLB via Python (${result.executionTimeMs}ms; ${writtenGeometry.totalVertices} vertices, ${writtenGeometry.totalTriangles} triangles). GLB framed dynamically at bounds [${bounds ? bounds.dimensions.map(d => d.toFixed(1) + 'm').join(' x ') : 'default'}]. Shared Metric Ground Logic: SI meters (1 unit = 1m), anchor ground datum Y=0.0m.${extractedManifest ? ` Staged at ${resolvedLocName} (${extractedManifest.lat.toFixed(6)}, ${extractedManifest.lng.toFixed(6)}) on raw Google 3D Tiles in studio clay (not remeshed).` : ''}${gateReport && !gateReport.passed ? ' Fidelity alerts: ' + gateReport.violations.join('; ') + ' Refine the script and run execute_3d_python_script again: revolve continuous profiles with sb.create_lathe, displace a unit high-resolution sphere for organic masses, sweep rails with sb.sweep_curve_profile, and raise segment counts.' : ''}${structureReport && !structureReport.passed ? ' ' + describeFloatingParts(structureReport) : ''}${visualReview && visualReview.verdict === 'problems' ? ' ' + describeVisualProblems(visualReview) : ''}`
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
