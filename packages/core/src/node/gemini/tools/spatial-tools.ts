/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as path from 'path';
import * as THREE from 'three';
import { getGoogle3DTilesFullTexture, getGoogle3DTilesClay, runTileClayBlockoutRunner, geocode3DTilesAddress, type Google3DTile3DObjectResult } from '../../spatial/Google3DTileBlockoutPipelineService';
import { readCoordinateArgs } from '../../../common/coordinate/parse-coordinates';
import { recolor3DTilesGlb } from '../../spatial/GlbTextureRecolorService';
import {
    healPanoramaSeam,
    inpaintPanorama,
    generate360Panorama,
    generate4KMonumentalPanorama,
    auditPanoramaQuality,
    reprojectZenithPanorama,
    extractZenithRectilinearPatch,
    Google360PanoramaPipelineService
} from '../../spatial/Google360PanoramaPipelineService';
import {
    generate360Perspectives
} from '../../spatial/MultiPerspectivePanoramaSynthesisService';
import {
    UniversalTileDecompositionService,
    type UtdraSpanBox,
    type UtdraTelemetry
} from '../../3d-engine/universal-tile-decomposition-service';
import { GeneratorFailedError, MissingInputError, TileExtractionError } from '../../../common/errors/pipeline-errors';
import {
    WebXRGeospatialAnchorBridge,
    type DeviceSensorSample,
    type WebXRViewerPose
} from '../../../browser/generative-canvas/services/xr/WebXRGeospatialAnchorBridge';
import {
    GeoBoxPrecisionResectionService,
    type ImageLocationResectionRequest
} from '../../spatial/GeoBoxPrecisionResectionService';
import {
    SubPixelEdgeAlignmentOptimizer,
    computeSobelField,
    evaluateEdgeOverlap,
    meanEdgeDistancePx as measureMeanEdgeDistance,
    type CameraPose6DOF
} from '../../spatial/SubPixelEdgeAlignmentOptimizer';
import {
    SpatialPoseEstimatorService,
    type Point2D,
    type Point3D
} from '../../spatial/SpatialPoseEstimatorService';
import { VisualFeatureMatcherService } from '../../spatial/VisualFeatureMatcherService';
import { HeadlessMeshSilhouetteRenderer } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import { LocationObjectLightingService } from '../../../browser/generative-canvas/services/atmosphere';
import {
    LensDistortionEffect,
    LENS_OPTICAL_PRESETS,
    calculateBrownConradyFromFocalLength,
    computeBrownConradyUV,
    LENS_DISTORTION_SHADER,
    type LensDistortionConfig
} from '../../../browser/generative-canvas/services/optics/LensDistortionEffect';
import { VfxLensInterchangeService } from '../../../common/optics/VfxLensInterchangeService';
import { VfxPlateMatchmoveService } from '../../../browser/generative-canvas/services/video/VfxPlateMatchmoveService';
import { MediaPipePoseService } from '../../spatial/MediaPipePoseService';
import { GeminiSceneDepthService } from '../../spatial/GeminiSceneDepthService';
import { PhysicalCameraModel } from '../../../common/optics/PhysicalCameraModel';
import type {
    PhysicalCameraConfig,
    SensorFormatPreset
} from '../../../common/optics/physical-camera-protocol';
import { Dynamic4DGaussianSplatService } from '../../3d-engine/Dynamic4DGaussianSplatService';
import { HumanoidMotionBridgeService } from '../../spatial/HumanoidMotionBridgeService';
import { VideoTo4DPerformerPipelineService } from '../../spatial/VideoTo4DPerformerPipelineService';
import { SbHumanAvatarService, PbrMeshSkinAdapter } from '../../spatial/SbHumanAvatarService';
import { OffsetViewSynthesisService } from '../../spatial/OffsetViewSynthesisService';
import { PanoramaDepthService } from '../../spatial/PanoramaDepthService';
import { Splat3DTilesService } from '../../spatial/Splat3DTilesService';
import { SurveyApi } from '../../spatial/survey-router';
import { Universal3DObjectSeparationService } from '../../spatial/Universal3DObjectSeparationService';
import { SpatialVisualAlignmentVerificationService } from '../../spatial/SpatialVisualAlignmentVerificationService';
import { AnalyticalGroomSplatService } from '../../3d-engine/AnalyticalGroomSplatService';
import { SceneSpatialAssertionService } from '../../spatial/SceneSpatialAssertionService';
import { MapsImageryGroundingService } from '../../spatial/MapsImageryGroundingService';
import { createStreetViewGroundingImageService, GROUNDING_ASPECT_RATIOS, StreetViewGroundingImageService, type GooglePano, type GroundingAspectRatio } from '../../spatial/StreetViewGroundingImageService';
import { GeminiClient } from '../gemini-client';
import { GoogleVectorTileService } from '../../spatial/GoogleVectorTileService';
import { describeLocationClay, runLocationClayPipeline, type LocationClayResult } from '../../3d-engine/location-clay-pipeline';
import {
    runStagedLocationTool, STAGED_CLAY_TOOL_DESCRIPTION, STAGED_ISOLATE_DESCRIPTION, STAGED_PLACE_DESCRIPTION, STAGED_RADIUS_DESCRIPTION, STAGED_RETRY_RUN_DESCRIPTION, STAGED_RETRY_STAGE_DESCRIPTION
} from '../../3d-engine/staged-location/staged-location-tool';
import { findTileRefineRepoRoot } from '../../3d-engine/tile-refine-service';
import type { ToolContext, ToolDeclaration, ToolHandler, ToolHandlerOutcome, ToolParameterSchema, ToolResultPayload } from './types';
import { STAGED_MATERIAL_MODE_DECLARATION, STAGED_MATERIAL_MODE_TOOL, runStagedMaterialModeTool } from './staged-material-mode-tool';

function asString(val: unknown, fallback = ''): string {
    return typeof val === 'string' ? val : fallback;
}

export interface GeospatialAnchorOrigin {
    latitude: number;
    longitude: number;
    altitudeMsl?: number;
}

// ============================================================================
// Google 3D Tiles Declarations & Handlers
// ============================================================================

/** The ground an extraction covers, as its summary states it: the radius the tiles really reach, not only the one asked for. */
function describeTileExtent(result: Google3DTile3DObjectResult): string {
    const { requestedRadiusMeters: asked, coveredRadiusMeters: covered, leafTiles } = result;
    if (asked === undefined || covered === undefined) return '';
    if (!result.truncated) return ` within ${asked} m of the anchor`;
    const cap = leafTiles ? `; capped at ${leafTiles.kept} of the ${leafTiles.selected} tiles in that radius` : '';
    return `; it covers about ${covered} m around the anchor (asked for ${asked} m${cap})`;
}

export const GOOGLE_3D_TILES_TOOL_DECLARATIONS: ToolDeclaration[] = [
    STAGED_MATERIAL_MODE_DECLARATION,
    {
        name: 'google_3d_tiles_get_full_texture',
        description: 'Ingest real-world geographic coordinates or address as a photorealistic, full-texture 3D GLB object rendered from Google Maps Photorealistic 3D Tiles at highest leaf LOD quality (errorTarget <= 0.5, 4K screen-space error budget). Returns glbBuffer, glbPath, and geometric mesh statistics.',
        parameters: {
            type: 'OBJECT',
            properties: {
                query: {
                    type: 'STRING',
                    description: 'The place as the user wrote it: a place name or address (resolved with Google Places; the result reports the address it resolved), or only a "latitude, longitude" pair such as "40.748400, -73.985700". When the user gave coordinates, pass just the coordinates: text that mixes a name and numbers is looked up as a name.'
                },
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path on disk to write the exported binary .glb file'
                },
                radiusMeters: {
                    type: 'NUMBER',
                    description: 'Extraction radius in metres around the anchor (default 250). The nearest 524 leaf tiles are kept; when the radius holds more, the result reports the smaller radius actually covered (coveredRadiusMeters, truncated). A radius that selects more than 6000 leaf tiles fails.'
                },
                stageIntoActiveScene: {
                    type: 'BOOLEAN',
                    description: 'Merge the tiles into the active 3D scene as its environment, keeping its objects and settings. Set it only when the user asks to stage the current scene at this place. Default false: the tiles open as a new studio scene.'
                },
                remesh: {
                    type: 'BOOLEAN',
                    description: 'Remesh the extracted photogrammetry before returning it (default true): hidden shells culled, facades snapped to planes, cracks closed, facade relief added, in one native pass of about 10-60 s. If remeshing fails, the call fails with the reason; nothing else is shown instead. Set false only when the user asks for the raw tiles.'
                },
                isolate: {
                    type: 'BOOLEAN',
                    description: 'Return only the structure at the anchor (its whole connected footprint and everything above it, never cut, with a small ground apron) instead of the whole district. Use it when the user asks for one building or object rather than an area.'
                },
                atomicBuildingIntegrity: {
                    type: 'BOOLEAN',
                    description: 'Enforce Atomic Building Integrity rule: guarantees zero horizontal roof slicing, zero bisected building envelopes, and multi-tier zenith camera settle (defaults to true)'
                },
                enforceZeroBuildingClipping: {
                    type: 'BOOLEAN',
                    description: 'Strictly prohibit planar building clipping and skyward capping (defaults to true)'
                },
                zenithAltitudeMeters: {
                    type: 'NUMBER',
                    description: 'Altitude in meters for zenith contextual sky camera (defaults to 1800m, min 1800m)'
                }
            },
            required: ['query']
        }
    },
    {
        name: 'google_3d_tiles_get_clay',
        description: STAGED_CLAY_TOOL_DESCRIPTION,
        parameters: {
            type: 'OBJECT',
            properties: {
                query: {
                    type: 'STRING',
                    description: 'The place as the user wrote it: a place name or address (resolved with Google Places; the result reports the address it resolved), or only a "latitude, longitude" pair such as "40.748400, -73.985700". When the user gave coordinates, pass just the coordinates: text that mixes a name and numbers is looked up as a name.'
                },
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path on disk to write the exported binary .glb file'
                },
                radiusMeters: {
                    type: 'NUMBER',
                    description: STAGED_RADIUS_DESCRIPTION
                },
                stageIntoActiveScene: {
                    type: 'BOOLEAN',
                    description: 'Merge the tiles into the active 3D scene as its environment, keeping its objects and settings. Set it only when the user asks to stage the current scene at this place. Default false: the tiles open as a new studio scene.'
                },
                remesh: {
                    type: 'BOOLEAN',
                    description: 'Remesh the extracted photogrammetry before returning it (default true): hidden shells culled, facades snapped to planes, cracks closed, facade relief added, in one native pass of about 10-60 s. If remeshing fails, the raw scan is shown with its facades flattened onto fitted planes (labelled scan-flattened) or, failing that, as downloaded, its scanned trees left in it, and the result says so with the reason. Set false only when the user asks for the raw tiles.'
                },
                trees: {
                    type: 'BOOLEAN',
                    description: 'Rebuild the trees measured in the photo tiles as SB-Veggie clay trees (default true): each tree crown found in the photogrammetry is regrown in its measured place, height and spread, and taken out of the remeshed ground, within a triangle budget. A tree whose regrown SB-Veggie tree would not fill its measured crown is not taken out: it stays as scanned, and the result names it with the reason ("N of M trees rebuilt as SB-Veggie; K left as scanned: ..."). The result also names, by crown, any rebuilt tree whose leaves do not fill its crown within the budget and any whose trunk does not meet the mounted ground. Low roof plantings, and crowns cut by the extraction edge (their tops outside it), stay as scanned unless a cut crown is joined to a removed tree, when it goes with it unrebuilt; the result says how many of each, and what was added to close the ground. If the tree stage fails, the scanned trees are put back, labelled as scanned, and the result says so with the reason. For isolate, only trees that could stand on the structure or its apron are measured. Set false only when the user asks for no trees. Needs remesh (raw tiles keep their scanned trees).'
                },
                treeTriangleBudget: {
                    type: 'NUMBER',
                    description: 'Total triangles all rebuilt trees together may use. Default: sized from the measured trees, a budget per tree that grows with its crown and covers the leaf masses its measured crown needs (never under 120 triangles), all within a cap of 1,500,000 triangles for the trees of a scene. A budget too small for the leaves of a tree to fill its crown is reported for that tree. Set it when the user gives a budget, or when the result says the trees were put back as scanned because the measured trees need more than the cap (it says how many they need; a smaller radiusMeters also has fewer trees).'
                },
                isolate: {
                    type: 'BOOLEAN',
                    description: STAGED_ISOLATE_DESCRIPTION
                },
                atomicBuildingIntegrity: {
                    type: 'BOOLEAN',
                    description: 'Enforce Atomic Building Integrity rule: guarantees zero horizontal roof slicing, zero bisected building envelopes, and multi-tier zenith camera settle (defaults to true)'
                },
                enforceZeroBuildingClipping: {
                    type: 'BOOLEAN',
                    description: 'Strictly prohibit planar building clipping and skyward capping (defaults to true)'
                },
                zenithAltitudeMeters: {
                    type: 'NUMBER',
                    description: 'Altitude in meters for zenith contextual sky camera (defaults to 1800m, min 1800m)'
                }
                ,place: {
                    type: 'OBJECT',
                    description: STAGED_PLACE_DESCRIPTION,
                    properties: {
                        lat: { type: 'NUMBER' }, lng: { type: 'NUMBER' }, formattedAddress: { type: 'STRING' }, placeId: { type: 'STRING' }, elevation: { type: 'NUMBER' },
                        alternatives: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, formattedAddress: { type: 'STRING' }, lat: { type: 'NUMBER' }, lng: { type: 'NUMBER' }, placeId: { type: 'STRING' } } } }
                    }
                },
                retryRunId: {
                    type: 'STRING',
                    description: STAGED_RETRY_RUN_DESCRIPTION
                },
                retryStage: {
                    type: 'STRING',
                    description: STAGED_RETRY_STAGE_DESCRIPTION
                }
            },
            required: ['query']
        }
    },
    {
        name: 'google_3d_tiles_clay_blockout_runner',
        description: 'Execute the canonical Google Maps 3D Tile Clay Blockout Runner. Headlessly streams real-world 3D tiles in studio grey clay PBR, runs collision-avoided 6-DoF camera flight (cinematic_arc, orbit_360, or canyon_push), and exports <VIDEO_REF_0> (MP4/WebM), startFramePngPath (Frame 0 PNG for AI Beautify -> <IMAGE_REF_0>), and volumetric .glb mesh.',
        parameters: {
            type: 'OBJECT',
            properties: {
                query: {
                    type: 'STRING',
                    description: 'The place as the user wrote it: a place name or address (resolved with Google Places; the result reports the address it resolved), or only a "latitude, longitude" pair such as "40.748400, -73.985700". When the user gave coordinates, pass just the coordinates: text that mixes a name and numbers is looked up as a name.'
                },
                trajectoryPreset: {
                    type: 'STRING',
                    description: 'Camera trajectory preset: "cinematic_arc" (default), "orbit_360", or "canyon_push"'
                },
                clayPreset: {
                    type: 'STRING',
                    description: 'Clay shading preset: "studio-grey" (default), "warm-clay", or "alabaster"'
                },
                outputVideoPath: {
                    type: 'STRING',
                    description: 'Optional path on disk to write the exported <VIDEO_REF_0> blockout MP4'
                },
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path on disk to write the exported binary .glb file'
                },
                firstFramePngPath: {
                    type: 'STRING',
                    description: 'Optional path on disk to write Frame 0 PNG for AI Beautify'
                },
                atomicBuildingIntegrity: {
                    type: 'BOOLEAN',
                    description: 'Enforce Atomic Building Integrity rule: guarantees zero horizontal roof slicing, zero bisected building envelopes, and multi-tier zenith camera settle (defaults to true)'
                },
                enforceZeroBuildingClipping: {
                    type: 'BOOLEAN',
                    description: 'Strictly prohibit planar building clipping and skyward capping (defaults to true)'
                },
                zenithAltitudeMeters: {
                    type: 'NUMBER',
                    description: 'Altitude in meters for zenith contextual sky camera (defaults to 1800m, min 1800m)'
                }
            },
            required: ['query']
        }
    },
    {
        name: 'google_3d_tiles_recolor_glb',
        description: 'Recolor a 3D Tile GLB model using the Sophisticated v2 Architecture 2 offline texture atlas re-grading engine. Performs hue-aware semantic segmentation (protecting green foliage and slate asphalt from turning terracotta), intrinsic shadow de-lighting, and PBR normal/roughness map synthesis. Geometry bufferViews are copied unchanged and verified byte-identical on the output; textures that fail are left unchanged and listed in failedTextures.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputGlbPath: {
                    type: 'STRING',
                    description: 'Path on disk to source photogrammetric 3D Tile .glb model'
                },
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path on disk to write the recolored PBR .glb model. Defaults to <input>_recolored.glb.'
                },
                palettePreset: {
                    type: 'STRING',
                    description: 'Lighting and mood preset: "dusk_twilight" (default), "golden_hour", "cyberpunk_neon", or "monochrome_noir"'
                },
                customPalette: {
                    type: 'OBJECT',
                    description: 'Optional custom color hex swatches { shadowHex, midtoneHex, highlightHex, accentHex }'
                },
                protectFoliage: {
                    type: 'BOOLEAN',
                    description: 'Preserve natural green foliage / trees (default true)'
                },
                protectAsphalt: {
                    type: 'BOOLEAN',
                    description: 'Preserve neutral asphalt roads and pavements (default true)'
                },
                generatePbrNormals: {
                    type: 'BOOLEAN',
                    description: 'Synthesize tangent-space normal maps from photogrammetry albedo (default true)'
                },
                generatePbrRoughness: {
                    type: 'BOOLEAN',
                    description: 'Synthesize metallic-roughness PBR maps (default true)'
                },
                normalStrength: {
                    type: 'NUMBER',
                    description: 'Normal map surface relief strength multiplier (default 2.0)'
                },
                shadowLift: {
                    type: 'NUMBER',
                    description: 'Shadow de-lighting lift intensity from 0.0 to 1.0 (default 0.7)'
                }
            },
            required: ['inputGlbPath']
        }
    },
    {
        name: 'spatial_separate_3d_objects',
        description: 'Separates a 3D mesh (.glb: Google 3D Tiles, photogrammetry, CAD) into groups by geometry alone, each with an AABB and a PCA oriented bounding box and its real vertex/triangle counts (or the sample size, when the vertex clustering sampled the mesh). "macro" groups whole submeshes by bounding-box shape (broad low ground, tall structures, low structures near the ground, other structures); the vertex modes split the ground, the structure at the anchor, building envelopes and the remainder. It names nothing geometry cannot show: no trees, vehicles, monuments, ruins or styles (google_3d_tiles_get_clay measures and rebuilds a location\'s trees from its photo tiles).',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: {
                    type: 'STRING',
                    description: 'Path to input 3D model (.glb file)'
                },
                granularity: {
                    type: 'STRING',
                    description: 'Separation granularity mode: "macro" (default), "detailed", "total" or "all"',
                    enum: ['macro', 'detailed', 'total', 'all']
                },
                geoAnchor: {
                    type: 'OBJECT',
                    description: 'Optional geodetic anchor coordinates (name, lat, lng, altitudeMeters)',
                    properties: {
                        name: { type: 'STRING' },
                        lat: { type: 'NUMBER' },
                        lng: { type: 'NUMBER' },
                        altitudeMeters: { type: 'NUMBER' }
                    }
                }
            },
            required: ['glbPath']
        }
    },
    {
        name: 'spatial_verify_visual_alignment',
        description: 'Audits an alignment from measurements you supply: computes the scale, translation and ground snap that fit the source model\'s dimensions to the reference\'s, checks the measured edge overlap and residual (from geobox_closed_loop_edge_align) against VFX thresholds, and, when the camera depth, the object\'s 2D box and the camera intrinsics are given, the pinhole height (H3D = h_px * d / fy). Nothing is assumed: missing dimensions or measurements are refused, and a check whose inputs are not given is reported as not measured.',
        parameters: {
            type: 'OBJECT',
            properties: {
                modelName: {
                    type: 'STRING',
                    description: 'Name of the 3D entity or model being verified'
                },
                sourceDimensions: {
                    type: 'ARRAY',
                    description: 'Measured source 3D model dimensions [width, height, depth] in meters',
                    items: { type: 'NUMBER' }
                },
                targetDimensions: {
                    type: 'ARRAY',
                    description: 'Real-world reference dimensions [width, height, depth] in meters',
                    items: { type: 'NUMBER' }
                },
                groundSnap: {
                    type: 'BOOLEAN',
                    description: 'Whether to snap foundation base to reference ground datum (default: true)'
                },
                overlapScorePercent: {
                    type: 'NUMBER',
                    description: 'Edge overlap percentage (0-100) measured by geobox_closed_loop_edge_align'
                },
                residualErrorPx: {
                    type: 'NUMBER',
                    description: 'Edge residual in pixels measured by geobox_closed_loop_edge_align'
                },
                cameraDepthMeters: {
                    type: 'NUMBER',
                    description: 'Optional, for the pinhole check: distance from the camera optical center to the object in meters'
                },
                box2dNormalized: {
                    type: 'ARRAY',
                    description: 'Optional, for the pinhole check: the object\'s 2D box [ymin, xmin, ymax, xmax] on a 0-1000 scale',
                    items: { type: 'NUMBER' }
                },
                imageHeightPx: {
                    type: 'NUMBER',
                    description: 'For the pinhole check: the image height in pixels'
                },
                focalLengthPx: {
                    type: 'NUMBER',
                    description: 'For the pinhole check: the vertical focal length fy in pixels'
                }
            },
            required: ['modelName', 'sourceDimensions', 'targetDimensions', 'overlapScorePercent', 'residualErrorPx']
        }
    },
    {
        name: 'sb_assert_scene_contacts',
        description: 'Scans all nodes in a 3D scene (.glb), tests bounding volumes for floating air gaps or illegal mesh interpenetrations, and returns actionable constraint repair telemetry.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: {
                    type: 'STRING',
                    description: 'Path on disk to the standardized binary glTF 2.0 (.glb) file'
                },
                maxAllowedGapMeters: {
                    type: 'NUMBER',
                    description: 'Maximum allowable air gap in meters before reporting floating geometry (default: 0.05m)'
                },
                maxAllowedPenetrationMeters: {
                    type: 'NUMBER',
                    description: 'Maximum allowable bounding overlap in meters before reporting penetration (default: 0.02m)'
                }
            },
            required: ['glbPath']
        }
    },
    {
        name: 'sb_audit_scene_hierarchy',
        description: 'Audits a 3D scene (.glb) against the 70-20-10 Form Hierarchy and geometric complexity floors (minimum 25,000 vertices for full scenes, 5,000 for props).',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: {
                    type: 'STRING',
                    description: 'Path on disk to the standardized binary glTF 2.0 (.glb) file'
                },
                minVertices: {
                    type: 'NUMBER',
                    description: 'Minimum vertex count threshold (default: 25000 for scenes, 5000 for props)'
                },
                minTriangles: {
                    type: 'NUMBER',
                    description: 'Minimum triangle count threshold (default: 15000)'
                }
            },
            required: ['glbPath']
        }
    }
];


/** Previous environment layers of a scene the tiles are staged into: replaced, never stacked. */
function isLocationLayer(o: any): boolean {
    const s = (o.content?.metadata?.source || '').toLowerCase();
    const role = (o.content?.metadata?.role || '').toLowerCase();
    return s === 'google3dtilesclay' || s === 'google_3d_tiles_clay' || s === 'google3dtilesfulltexture' || s === 'google_3d_tiles_full_texture'
        || s === 'googlevectortileservice' || s === 'google_vector_tile_service' || s === 'sb-veggie' || role === 'environment' || role === 'vegetation';
}

function modelUri(mountPath: string): string {
    return mountPath.includes('/public/models/')
        ? `/models/${path.basename(mountPath)}`
        : (mountPath.startsWith('/') && !mountPath.startsWith('/models/') ? `/models/${path.basename(mountPath)}` : mountPath);
}

/**
 * A location request: the tiles at the query, remeshed (google_3d_tiles_get_clay: with the trees measured in the photo
 * tiles rebuilt as SB-Veggie trees) unless the user asked for raw tiles. Every stage either does what was asked or
 * fails the call with its reason; nothing else is mounted in its place.
 */
async function extractLocation(toolName: string, args: Record<string, unknown>, ctx: ToolContext, flavour: 'clay' | 'textured'): Promise<ToolHandlerOutcome> {
    // The clay tool, remeshing: the staged build. Each stage commits as it finishes, a failing stage drops to a simpler
    // version of the same real data and says so, and a retry rebuilds one stage from the recorded run.
    if (flavour === 'clay' && args.remesh !== false) return runStagedLocationTool(toolName, args, ctx);
    const query = asString(args.query);
    if (!query) throw new MissingInputError(toolName, 'query', 'a place name, address or "lat, lng"');
    const remeshing = args.remesh !== false;
    if (!remeshing && args.trees === true) {
        throw new MissingInputError(toolName, 'remesh true to rebuild trees', 'trees are rebuilt as part of remeshing, and with remesh false the raw tiles keep their scanned trees. Ask again with remesh true, or without trees');
    }
    const trees = flavour === 'clay' && remeshing && args.trees !== false;
    let treeTriangleBudget: number | undefined;
    if (args.treeTriangleBudget !== undefined && args.treeTriangleBudget !== null) {
        treeTriangleBudget = Number(args.treeTriangleBudget);
        if (!Number.isFinite(treeTriangleBudget) || treeTriangleBudget < 1) {
            throw new MissingInputError(toolName, 'a treeTriangleBudget of at least 1 triangle', `got ${JSON.stringify(args.treeTriangleBudget)}`);
        }
    }
    const options = {
        outputGlbPath: asString(args.outputGlbPath) || undefined,
        atomicBuildingIntegrity: typeof args.atomicBuildingIntegrity === 'boolean' ? args.atomicBuildingIntegrity : undefined,
        enforceZeroBuildingClipping: typeof args.enforceZeroBuildingClipping === 'boolean' ? args.enforceZeroBuildingClipping : undefined,
        zenithAltitudeMeters: typeof args.zenithAltitudeMeters === 'number' ? args.zenithAltitudeMeters : undefined,
        radiusMeters: typeof args.radiusMeters === 'number' && args.radiusMeters > 0 ? args.radiusMeters : undefined,
        // a stopped chat stops the crawl and its tile downloads too (honoured where the extraction supports it)
        signal: ctx?.signal
    };
    // Remeshing reads window and pier relief from the photographs, and the trees are measured in them, so whenever
    // remeshing runs the photo-textured tiles are extracted; the clay tool still shows the result as clay.
    const extract = flavour === 'textured' || remeshing ? getGoogle3DTilesFullTexture : getGoogle3DTilesClay;
    const result = await extract(query, options);
    if (result.mock) throw new TileExtractionError('download', new Error(`${toolName}: the extraction returned placeholder tiles, not Google 3D Tiles, so nothing is shown.`));

    const pipeline: LocationClayResult | undefined = remeshing
        ? await runLocationClayPipeline({
            rawTilePath: result.glbPath,
            workspaceRoot: findTileRefineRepoRoot(),
            isolate: args.isolate === true,
            trees,
            flavour,
            treeTriangleBudget,
            publishBase: path.basename(result.glbPath).replace(/\.glb$/i, ''),
            signal: ctx?.signal,
            reportProgress: message => ctx?.reportProgress?.(message)
        })
        : undefined;
    const mountPath = pipeline ? pipeline.url : result.glbPath;
    const place = result.resolvedAddress || query;
    // counts of what is mounted: the remeshed model when remeshing ran, else the extraction itself
    const mounted = pipeline
        ? { vertexCount: pipeline.mounted.vertices, triangleCount: pipeline.mounted.triangles }
        : { vertexCount: result.mesh?.vertexCount, triangleCount: result.mesh?.triangleCount };
    const source = flavour === 'clay' ? 'Google3DTilesClay' : 'Google3DTilesFullTexture';
    const stamp = Date.now();
    const tileObject = {
        id: `tile-${flavour === 'clay' ? 'clay' : 'texture'}-${stamp}`,
        content: {
            type: '3d-model',
            durableUri: modelUri(mountPath),
            mimeType: 'model/gltf-binary',
            metadata: {
                source,
                role: 'environment',
                isGround: true,
                metricScale: 1.0,
                groundDatumMeters: 0.0,
                resolvedAddress: place,
                rawGlbPath: result.glbPath,
                remeshed: !!pipeline,
                // the measured trees were taken out of this model (and rebuilt in the trees model beside it)
                treesRemoved: (pipeline?.trees?.strip.removedTriangles ?? 0) > 0,
                vertexCount: mounted.vertexCount,
                triangleCount: mounted.triangleCount,
                ...(pipeline ? { rawVertexCount: result.mesh?.vertexCount, rawTriangleCount: result.mesh?.triangleCount } : {}),
                boundingBox: result.mesh?.boundingBox
            }
        },
        space: { spatial3d: { x: 0, y: 0, z: 0 } },
        time: { startMs: 0, durationMs: 20000 },
        lineage: { version: 1 }
    };
    const t = pipeline?.trees;
    // The trees are part of the location layer: role 'environment', so the viewer mounts them where they were measured
    // (the tile frame, at the same origin as the remeshed tile) instead of seating them on whatever stands at the anchor.
    // They are not ground: isGround false, so nothing placed under a crown stands on top of it.
    const treesObject = t?.url ? {
        id: `tile-trees-${stamp}`,
        content: {
            type: '3d-model',
            durableUri: t.url,
            mimeType: 'model/gltf-binary',
            metadata: {
                source: 'SB-Veggie',
                role: 'environment',
                layer: 'vegetation',
                isGround: false,
                generator: 'space colonisation from the measured crowns',
                resolvedAddress: place,
                treeCount: t.count,
                // measured trees left in the scan (the regrown tree would not fill their crown): not in this model
                treesLeftAsScanned: t.notRegrowable,
                triangleCount: t.triangles,
                // the measured crowns these trees were grown into
                canopyAreaM2: t.treeCanopyAreaM2,
                measuredFrom: result.glbPath
            }
        },
        space: { spatial3d: { x: 0, y: 0, z: 0 } },
        time: { startMs: 0, durationMs: 20000 },
        lineage: { version: 1 }
    } : undefined;
    const newObjects = treesObject ? [tileObject, treesObject] : [tileObject];
    const counts = `${(mounted.vertexCount ?? 0).toLocaleString()} vertices, ${(mounted.triangleCount ?? 0).toLocaleString()} triangles`;
    const groundDatum = { coordinateSystem: 'metric-enu', units: 'meters', scale: 1.0, groundDatumMeters: 0.0, groundLogic: 'shared-metric-ground' };

    // The tiles join the active scene only when asked to; otherwise they open as a new studio scene, so an unrelated
    // scene's objects and sky never carry over.
    let mountedArtifact: any;
    if (args.stageIntoActiveScene === true && ctx.request?.activeArtifact?.type === '3d-scene') {
        const prevArtifact = ctx.request.activeArtifact;
        const prevData = (prevArtifact.data as any) || {};
        const rawObjects = Array.isArray(prevData.objects) ? prevData.objects : [];
        const keptObjects = rawObjects.filter((o: any) => !isLocationLayer(o));
        mountedArtifact = {
            ...prevArtifact,
            version: (prevArtifact.version || 1) + 1,
            title: `${prevArtifact.title || '3D Scene'} — Staged at ${place}`,
            summary: flavour === 'clay'
                ? `Staged active 3D asset at ${place} with Google 3D Tiles in studio grey clay (${counts})${t?.measured || t?.notOnStructure ? `; ${t.outcome}` : ''}. Shared metric coordinate frame: SI meters (1 unit = 1m), anchor ground datum Y=0.0m.`
                : `Staged active 3D asset at ${place} with Google 3D Tiles full photogrammetric textures (${counts}).`,
            data: {
                ...prevData,
                ...(flavour === 'clay' ? { renderMode: 'clay', groundDatum } : {}),
                groundTileMode: flavour === 'clay' ? 'photoreal-clay' : 'photoreal-textured',
                geoAnchor: result.geoAnchor,
                objects: [...keptObjects, ...newObjects]
            }
        };
    } else {
        mountedArtifact = {
            id: `artifact-3d-${stamp}`,
            type: '3d-scene',
            title: flavour === 'clay' ? `${place} (Studio Grey Clay 3D Tiles)` : `${place} (Photorealistic 3D Tiles)`,
            summary: flavour === 'clay'
                ? `Google 3D Tiles for ${place} in Studio Grey Clay (${counts})${t?.measured || t?.notOnStructure ? `; ${t.outcome}` : ''}. Shared metric coordinate frame: SI meters (1 unit = 1m), anchor ground datum Y=0.0m.`
                : `Google 3D Tiles in full photogrammetric texture for ${place} (${counts}). Shared metric coordinate frame: SI meters (1 unit = 1m), anchor ground datum Y=0.0m.`,
            version: 1,
            data: {
                title: flavour === 'clay' ? `${place} — 3D Real-World Clay Model` : `${place} — Photorealistic 3D Model`,
                subtitle: flavour === 'clay'
                    ? `Google 3D Tiles photogrammetry in 18% Studio Grey Clay (${counts}).`
                    : `Google 3D Tiles photogrammetry in full photogrammetric texture (${counts}).`,
                renderMode: flavour === 'clay' ? 'clay' : 'shaded',
                ...(flavour === 'clay' ? { clayPreset: 'studio-grey' } : {}),
                cameraMode: 'orbit',
                environment: { skybox: 'studio', lighting: 'studio', ground: false },
                groundDatum,
                groundTileMode: flavour === 'clay' ? 'photoreal-clay' : 'photoreal-textured',
                geoAnchor: result.geoAnchor,
                objects: newObjects
            }
        };
    }

    const box = result.mesh?.boundingBox;
    const elevation = flavour === 'clay' && box && Number.isFinite(box.min?.[1]) && Number.isFinite(box.max?.[1])
        ? ` [elevation: ${box.min[1].toFixed(1)}m to ${box.max[1].toFixed(1)}m]`
        : '';
    return {
        resultPayload: {
            success: result.success,
            mode: result.mode,
            geoAnchor: result.geoAnchor,
            resolvedAddress: result.resolvedAddress,
            glbPath: result.glbPath,
            remesh: pipeline ? { ok: true, url: pipeline.url, isolate: pipeline.isolate, ...pipeline.remesh } : undefined,
            ...(pipeline?.trees ? { trees: pipeline.trees } : {}),
            ...(pipeline ? { timingsMs: pipeline.timingsMs } : {}),
            requestedRadiusMeters: result.requestedRadiusMeters,
            coveredRadiusMeters: result.coveredRadiusMeters,
            truncated: result.truncated,
            leafTiles: result.leafTiles,
            mesh: result.mesh,
            groundDatum: {
                ...groundDatum,
                bounds: result.mesh?.boundingBox,
                elevationRange: result.mesh?.boundingBox ? { minY: result.mesh.boundingBox.min[1], maxY: result.mesh.boundingBox.max[1] } : undefined
            },
            quality: result.quality,
            render: result.render,
            artifact: mountedArtifact
        } as unknown as ToolResultPayload,
        summaryResult: `Google 3D Tiles ingested ${flavour === 'clay' ? 'in studio grey clay' : 'in full texture'} for ${place}${describeTileExtent(result)}. Exported the extracted tiles to ${result.glbPath} (${result.mesh.vertexCount} vertices, ${result.mesh.triangleCount} triangles).${describeLocationClay(pipeline, flavour)} Shared Metric Ground Logic: SI meters (1 unit = 1m), anchor ground datum Y=0.0m${elevation}. Built objects share this coordinate frame and automatically snap to the tile ground surface by default.`
    };
}

export const google3DTilesHandlers: Record<string, ToolHandler> = {
    sb_assert_scene_contacts: async (args, _ctx) => {
        const glbPath = asString(args.glbPath);
        if (!glbPath) throw new Error('sb_assert_scene_contacts: "glbPath" argument is required.');
        const maxAllowedGapMeters = typeof args.maxAllowedGapMeters === 'number' ? args.maxAllowedGapMeters : 0.05;
        const maxAllowedPenetrationMeters = typeof args.maxAllowedPenetrationMeters === 'number' ? args.maxAllowedPenetrationMeters : 0.02;

        const result = SceneSpatialAssertionService.auditContacts(glbPath, maxAllowedGapMeters, maxAllowedPenetrationMeters);
        return {
            resultPayload: result as unknown as ToolResultPayload,
            summaryResult: result.summary
        };
    },

    sb_audit_scene_hierarchy: async (args, _ctx) => {
        const glbPath = asString(args.glbPath);
        if (!glbPath) throw new Error('sb_audit_scene_hierarchy: "glbPath" argument is required.');
        const minVertices = typeof args.minVertices === 'number' ? args.minVertices : 25000;
        const minTriangles = typeof args.minTriangles === 'number' ? args.minTriangles : 15000;

        const result = SceneSpatialAssertionService.auditHierarchy(glbPath, minVertices, minTriangles);
        return {
            resultPayload: result as unknown as ToolResultPayload,
            summaryResult: result.summary
        };
    },

    google_3d_tiles_get_full_texture: (args, ctx) => extractLocation('google_3d_tiles_get_full_texture', args, ctx, 'textured'),

    google_3d_tiles_get_clay: (args, ctx) => extractLocation('google_3d_tiles_get_clay', args, ctx, 'clay'),

    [STAGED_MATERIAL_MODE_TOOL]: (args, ctx) => runStagedMaterialModeTool(args, ctx),

    google_3d_tiles_clay_blockout_runner: async (args, _ctx) => {
        const query = asString(args.query);
        if (!query) throw new Error('google_3d_tiles_clay_blockout_runner: "query" argument is required.');
        const trajectoryPreset = asString(args.trajectoryPreset) as any;
        const clayPreset = asString(args.clayPreset) as any;
        const outputVideoPath = asString(args.outputVideoPath) || undefined;
        const outputGlbPath = asString(args.outputGlbPath) || undefined;
        const firstFramePngPath = asString(args.firstFramePngPath) || undefined;
        const atomicBuildingIntegrity = typeof args.atomicBuildingIntegrity === 'boolean' ? args.atomicBuildingIntegrity : undefined;
        const enforceZeroBuildingClipping = typeof args.enforceZeroBuildingClipping === 'boolean' ? args.enforceZeroBuildingClipping : undefined;
        const zenithAltitudeMeters = typeof args.zenithAltitudeMeters === 'number' ? args.zenithAltitudeMeters : undefined;

        const result = await runTileClayBlockoutRunner({
            query,
            trajectoryPreset,
            clayPreset,
            outputVideoPath,
            outputGlbPath,
            firstFramePngPath,
            atomicBuildingIntegrity,
            enforceZeroBuildingClipping,
            zenithAltitudeMeters
        });

        return {
            resultPayload: {
                success: result.success,
                videoRef: result.videoRef,
                blockoutVideoPath: result.blockoutVideoPath,
                webmVideoPath: result.webmVideoPath,
                startFramePngPath: result.startFramePngPath,
                firstFramePath: result.firstFramePath,
                clayGlbPath: result.clayGlbPath,
                geoAnchor: result.geoAnchor,
                resolvedAddress: result.resolvedAddress,
                frameCount: result.frameCount,
                fps: result.fps,
                durationSec: result.durationSec,
                meshStats: result.meshStats,
                collisionAudit: result.collisionAudit
            },
            summaryResult: `Clay Blockout Runner completed for ${result.resolvedAddress || query}. Generated <VIDEO_REF_0> (${result.blockoutVideoPath}), Frame 0 PNG (${result.startFramePngPath}), and GLB massing (${result.clayGlbPath}, ${result.meshStats.vertexCount} vertices).`
        };
    },

    google_3d_tiles_recolor_glb: async (args, _ctx) => {
        const inputGlbPath = asString(args.inputGlbPath);
        if (!inputGlbPath) throw new Error('google_3d_tiles_recolor_glb: "inputGlbPath" argument is required.');
        const outputGlbPath = asString(args.outputGlbPath) || undefined;
        const palettePreset = (asString(args.palettePreset) || undefined) as any;
        const customPalette = typeof args.customPalette === 'object' && args.customPalette !== null
            ? (args.customPalette as any)
            : undefined;
        const protectFoliage = typeof args.protectFoliage === 'boolean' ? args.protectFoliage : true;
        const protectAsphalt = typeof args.protectAsphalt === 'boolean' ? args.protectAsphalt : true;
        const generateNormalMaps = typeof args.generatePbrNormals === 'boolean' ? args.generatePbrNormals : true;
        const generateRoughnessMaps = typeof args.generatePbrRoughness === 'boolean' ? args.generatePbrRoughness : true;
        const normalStrength = typeof args.normalStrength === 'number' ? args.normalStrength : 2.0;
        const shadowLift = typeof args.shadowLift === 'number' ? args.shadowLift : 0.7;

        const result = await recolor3DTilesGlb({
            inputGlb: inputGlbPath,
            outputGlbPath,
            palettePreset,
            customPalette,
            segmentation: {
                enableSegmentation: true,
                protectFoliage,
                protectAsphalt
            },
            pbr: {
                generateNormalMaps,
                normalStrength,
                generateRoughnessMaps
            },
            shadowLift
        });

        return {
            resultPayload: {
                success: result.success,
                inputGlbPath: result.inputGlbPath,
                outputGlbPath: result.outputGlbPath,
                textureCount: result.textureCount,
                normalMapCount: result.normalMapCount,
                roughnessMapCount: result.roughnessMapCount,
                originalByteLength: result.originalByteLength,
                recoloredByteLength: result.recoloredByteLength,
                failedTextures: result.failedTextures,
                geometryBytesIdentical: result.geometryBytesIdentical,
                durationMs: result.durationMs,
                paletteUsed: result.paletteUsed,
                summary: result.summary
            },
            status: result.success ? 'completed' : 'failed',
            summaryResult: result.summary
        };
    },

    spatial_separate_3d_objects: async (args, _ctx) => {
        const glbPath = asString(args.glbPath);
        if (!glbPath) throw new Error('spatial_separate_3d_objects: "glbPath" argument is required.');
        const granularity = (asString(args.granularity) || 'macro') as any;
        const geoAnchor = args.geoAnchor as any;

        const service = new Universal3DObjectSeparationService();
        const scene = await service.separate({
            glbPath,
            granularity,
            geoAnchor
        });

        return {
            status: 'completed',
            summaryResult: `Separated ${scene.objects.length} discrete 3D spatial entities from "${scene.modelName}" (${scene.totalVertices.toLocaleString()} vertices). Categories: ${JSON.stringify(scene.objectCounts)}.`,
            resultPayload: {
                success: true,
                modelName: scene.modelName,
                totalVertices: scene.totalVertices,
                totalSubmeshes: scene.totalSubmeshes,
                overallBoundingBox: scene.overallBoundingBox,
                objectsCount: scene.objects.length,
                objectCounts: scene.objectCounts,
                objects: scene.objects.map(o => ({
                    id: o.id,
                    name: o.name,
                    category: o.category,
                    dimensions: o.orientedBoundingBox.dimensions,
                    center: o.orientedBoundingBox.center,
                    yawDeg: o.orientedBoundingBox.yawDeg,
                    tightnessGainPercent: o.tightnessGainPercent,
                    vertexCount: o.vertexCount,
                    triangleCount: o.triangleCount,
                    ...(o.sampledVertexCount !== undefined ? { sampledVertexCount: o.sampledVertexCount } : {}),
                    routingRecommendation: o.routingRecommendation
                }))
            }
        };
    },

    spatial_verify_visual_alignment: async (args, _ctx) => {
        // Every number the audit reports is one the caller measured; nothing is defaulted.
        const tool = 'spatial_verify_visual_alignment';
        const modelName = asString(args.modelName);
        if (!modelName) throw new MissingInputError(tool, 'modelName');
        const dimensions = (key: 'sourceDimensions' | 'targetDimensions'): [number, number, number] => {
            const v = args[key];
            if (!Array.isArray(v) || v.length !== 3 || !v.every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)) {
                throw new MissingInputError(tool, key, `three positive sizes [width, height, depth] in meters (got ${JSON.stringify(v)})`);
            }
            return v as [number, number, number];
        };
        const measured = (key: 'overlapScorePercent' | 'residualErrorPx'): number => {
            const v = args[key];
            if (typeof v !== 'number' || !Number.isFinite(v)) {
                throw new MissingInputError(tool, key, 'the value measured by geobox_closed_loop_edge_align; no overlap or residual is assumed');
            }
            return v;
        };
        const srcDims = dimensions('sourceDimensions');
        const tgtDims = dimensions('targetDimensions');
        const overlapScore = measured('overlapScorePercent');
        const residualPx = measured('residualErrorPx');
        const groundSnap = args.groundSnap !== false;
        const cameraDepth = typeof args.cameraDepthMeters === 'number' ? args.cameraDepthMeters : undefined;
        const box2d = Array.isArray(args.box2dNormalized) ? (args.box2dNormalized as [number, number, number, number]) : undefined;
        const imageHeight = typeof args.imageHeightPx === 'number' ? args.imageHeightPx : undefined;
        const fy = typeof args.focalLengthPx === 'number' ? args.focalLengthPx : undefined;
        const opticalInputs = [cameraDepth, box2d, imageHeight, fy];
        if (opticalInputs.some(v => v !== undefined) && opticalInputs.some(v => v === undefined)) {
            throw new MissingInputError(tool, 'cameraDepthMeters, box2dNormalized, imageHeightPx and focalLengthPx',
                'the pinhole check needs all four (the camera\'s own intrinsics); none is assumed');
        }
        if (box2d && (box2d.length !== 4 || !box2d.every(n => typeof n === 'number' && Number.isFinite(n)))) {
            throw new MissingInputError(tool, 'box2dNormalized', `[ymin, xmin, ymax, xmax] on a 0-1000 scale (got ${JSON.stringify(box2d)})`);
        }

        const service = new SpatialVisualAlignmentVerificationService();
        const alignReport = service.verifyAlignment({
            sourceBoundingBox: {
                min: [-srcDims[0] / 2, 0, -srcDims[2] / 2],
                max: [srcDims[0] / 2, srcDims[1], srcDims[2] / 2],
                dimensions: srcDims,
                centroid: [0, srcDims[1] / 2, 0]
            },
            targetReferenceBox: {
                min: [-tgtDims[0] / 2, 0, -tgtDims[2] / 2],
                max: [tgtDims[0] / 2, tgtDims[1], tgtDims[2] / 2],
                dimensions: tgtDims,
                centroid: [0, tgtDims[1] / 2, 0]
            },
            groundSnap,
            // Only fy, the image height and the depth enter the pinhole check; the principal point is not used.
            cameraContext: cameraDepth !== undefined && fy !== undefined && imageHeight !== undefined ? {
                fx: fy,
                fy,
                cx: Number.NaN,
                cy: Number.NaN,
                imageWidth: Number.NaN,
                imageHeight,
                cameraDepthToObject: cameraDepth
            } : undefined,
            box2dNormalized: box2d
        });

        const cert = service.certifyMetrology({
            modelName,
            sourceDimensions: srcDims,
            overlapScorePercent: overlapScore,
            residualErrorPx: residualPx,
            opticalDiscrepancyPercent: alignReport.opticalDiscrepancyPercent
        });

        return {
            status: 'completed',
            summaryResult: `Visual alignment audit for ${modelName} from the measurements given: [${cert.auditStatus}] (Overlap: ${cert.metrics.overlapScorePercent.toFixed(1)}%, Residual: ${cert.metrics.residualErrorPx.toFixed(3)}px, Optical Scale: ${cert.metrics.opticalDiscrepancyPercent === undefined ? 'not measured' : `${cert.metrics.opticalDiscrepancyPercent.toFixed(1)}%`}). Fitting the source to the reference needs scale ${alignReport.scale[1].toFixed(4)}.`,
            resultPayload: {
                success: cert.isCertified,
                certificate: cert,
                alignment: alignReport
            }
        };
    }
};

// ============================================================================
// Panorama Declarations & Handlers
// ============================================================================

/** The `maxModelUpscale` parameter of the panorama edit tools. */
const PANORAMA_MAX_UPSCALE_PARAMETER: ToolParameterSchema = {
    type: 'NUMBER',
    description: 'Largest factor (>= 1, default 2) the model\'s answer may be enlarged by to cover the panorama. The image size (1K, 2K or 4K) is asked for so the answer covers the panorama within this factor; a panorama too large for that even at 4K is refused before any model call unless this is raised. The result states the size the model answered at and how far it was enlarged.'
};

/** The `model` parameter of the panorama image tools: one named model, or the default list when omitted. */
const PANORAMA_IMAGE_MODEL_PARAMETER: ToolParameterSchema = {
    type: 'STRING',
    description: 'Image model id. When given, only that model is used; omit it to try the default image models in order. The result names the model that answered and, if it was not the first, why each earlier one was skipped.'
};

export const PANORAMA_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'synthesize_adaptive_particle_system',
        description: 'Assemble an AdaptiveParticleContract (the continuous physical description the particle renderer runs) for any particulate substance: fluids, dust, plasma, steam, sparks, spores, anything. You choose every value from the substance the user described, in physical units; the tool keeps no vocabulary of substances and fills in nothing, and a missing or out-of-range value fails the call with the list of fields to fix. manifoldWeights blend six flow shapes [buoyant plume, cyclone funnel, fountain jet, spherical shockwave, accretion disk, lateral gale] and are normalised to sum to 1.',
        parameters: {
            type: 'OBJECT',
            properties: {
                subject: { type: 'STRING', description: 'Short name of the substance and its situation, e.g. "methane geyser spray with bioluminescent spores".' },
                narrativeContext: { type: 'STRING', description: 'Optional one-line description of the scene the particles are in.' },
                kinematics: {
                    type: 'OBJECT',
                    properties: {
                        linearVelocity: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Bulk ejection velocity [x, y, z] in m/s.' },
                        vorticityTensor: { type: 'NUMBER', description: 'Rotation shear in rad/s.' },
                        radialDivergence: { type: 'NUMBER', description: 'Outward expansion (+) or sink (-).' },
                        ambientWind: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Wind [x, y, z] in m/s.' },
                        windGustiness: { type: 'NUMBER', description: 'Turbulent eddy amplitude (>= 0).' },
                        gravity: { type: 'NUMBER', description: 'Vertical acceleration in m/s^2 (negative pulls down).' },
                        substanceMass: { type: 'NUMBER', description: 'Normalised particle inertia (> 0): ~0.05 smoke or dust to ~4.5 molten metal.' },
                        dragCoefficient: { type: 'NUMBER', description: 'Aerodynamic drag (>= 0).' },
                        restitution: { type: 'NUMBER', description: 'Bounce on contact, 0..1.' },
                        friction: { type: 'NUMBER', description: 'Contact friction (>= 0).' }
                    },
                    required: ['linearVelocity', 'vorticityTensor', 'radialDivergence', 'ambientWind', 'windGustiness', 'gravity', 'substanceMass', 'dragCoefficient', 'restitution', 'friction']
                },
                manifoldWeights: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Six non-negative weights [plume, cyclone, fountain, shockwave, disk, gale] with a positive sum.' },
                manifoldScale: { type: 'NUMBER', description: 'Spatial scale of the flow shape (> 0).' },
                advectionCurlScale: { type: 'NUMBER', description: 'Curl-noise frequency (>= 0).' },
                material: {
                    type: 'OBJECT',
                    properties: {
                        emissionModel: { type: 'STRING', description: 'Free-text label for how the particles make or carry light (shown in diagnostics; the renderer reads the numbers).' },
                        coreRadiance: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Hottest/brightest colour [r, g, b] (>= 0).' },
                        midRadiance: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Body colour [r, g, b] (>= 0).' },
                        outerRadiance: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Edge / dissipation colour [r, g, b] (>= 0).' },
                        opticalExtinction: { type: 'NUMBER', description: 'Beer-Lambert extinction (>= 0).' },
                        specularGloss: { type: 'NUMBER', description: 'Highlight sharpness, 0..1.' },
                        colorTemperatureK: { type: 'NUMBER', description: 'Blackbody temperature, 1000..40000 K.' },
                        particleSizePx: { type: 'NUMBER', description: 'Sprite diameter in pixels (> 0).' },
                        particleCount: { type: 'NUMBER', description: 'Particle budget (>= 1).' }
                    },
                    required: ['emissionModel', 'coreRadiance', 'midRadiance', 'outerRadiance', 'opticalExtinction', 'specularGloss', 'colorTemperatureK', 'particleSizePx', 'particleCount']
                },
                optics: {
                    type: 'OBJECT',
                    properties: {
                        bloomMultiplier: { type: 'NUMBER', description: 'HDR glare (>= 0).' },
                        diffusionBlurRadius: { type: 'NUMBER', description: 'Atmospheric blur (>= 0).' },
                        thermalMirageHaze: { type: 'NUMBER', description: 'Heat shimmer (>= 0).' },
                        chromaticDispersion: { type: 'NUMBER', description: 'Wavelength splitting (>= 0).' }
                    },
                    required: ['bloomMultiplier', 'diffusionBlurRadius', 'thermalMirageHaze', 'chromaticDispersion']
                },
                acoustics: {
                    type: 'OBJECT',
                    properties: {
                        subBassHertz: { type: 'NUMBER', description: 'Fundamental rumble in Hz.' },
                        resonantCenterHertz: { type: 'NUMBER', description: 'Resonance peak in Hz.' },
                        impulseRate: { type: 'NUMBER', description: 'Crackle / impact events per second.' }
                    },
                    required: ['subBassHertz', 'resonantCenterHertz', 'impulseRate']
                }
            },
            required: ['subject', 'kinematics', 'manifoldWeights', 'manifoldScale', 'advectionCurlScale', 'material', 'optics', 'acoustics']
        }
    },
    {
        name: 'adaptive_world_style_deconstruct',
        description: 'Have a Gemini vision model read a reference image into an adaptive continuous contract of styling, lighting, grading, detail and NPR parameters. Fails when no vision model can read the image; nothing is guessed from the hint text.',
        parameters: {
            type: 'OBJECT',
            properties: {
                referenceImagePath: {
                    type: 'STRING',
                    description: 'Path on disk to the input reference image (Nano Banana, concept art, photo, etc.).'
                },
                cameraPose: {
                    type: 'OBJECT',
                    properties: {
                        position: { type: 'ARRAY', items: { type: 'NUMBER' }, description: '[x, y, z] camera position' },
                        target: { type: 'ARRAY', items: { type: 'NUMBER' }, description: '[x, y, z] camera target' },
                        fov: { type: 'NUMBER', description: 'Camera Field of View in degrees' }
                    },
                    description: 'Optional camera pose used when rendering/projecting'
                },
                fidelity: {
                    type: 'STRING',
                    description: 'Which vision model reads the image: "balanced" (Gemini 2.5 Flash, default) or "deep-multimodal" (Gemini 2.5 Pro).'
                },
                promptHint: {
                    type: 'STRING',
                    description: 'Optional aesthetic style modifier/intent to guide extraction (e.g. "sunset golden hour", "neon cyberpunk").'
                }
            },
            required: ['referenceImagePath']
        }
    },
    {
        name: 'adaptive_world_style_apply',
        description: 'Read an image\'s style with a Gemini vision model and apply it to a 3D Tile GLB: the contract the model reads is mapped to a CIELAB palette and the GLB\'s textures are re-graded offline (vertex data is not modified). Fails when no vision model can read the image.',
        parameters: {
            type: 'OBJECT',
            properties: {
                referenceImagePath: {
                    type: 'STRING',
                    description: 'Path on disk to the input style reference image.'
                },
                inputGlbPath: {
                    type: 'STRING',
                    description: 'Path on disk to source photogrammetric 3D Tile .glb model'
                },
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path on disk to write the styled .glb model. Defaults to <input>_styled.glb.'
                },
                fidelity: {
                    type: 'STRING',
                    description: 'Which vision model reads the image: "balanced" (Gemini 2.5 Flash, default) or "deep-multimodal" (Gemini 2.5 Pro).'
                },
                promptHint: {
                    type: 'STRING',
                    description: 'Optional aesthetic style modifier/intent to guide style extraction.'
                },
                protectFoliage: {
                    type: 'BOOLEAN',
                    description: 'Protect green foliage from extreme color grading tinting (default: true)'
                },
                protectAsphalt: {
                    type: 'BOOLEAN',
                    description: 'Protect asphalt pavement from extreme color grading tinting (default: true)'
                }
            },
            required: ['referenceImagePath', 'inputGlbPath']
        }
    },
    {
        name: 'panorama_heal_seam',
        description: 'Heal the vertical boundary seam of a 360 equirectangular panorama by Gemini image-model inpainting over a 50% horizontally rolled canvas with soft-edge quadratic gradient masking. Guarantees 100% bit-exact pixel fidelity outside the seam width band. Fails (no procedural substitute) when no image model inpaints the seam; the result names the model that answered.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputImagePath: {
                    type: 'STRING',
                    description: 'Absolute or relative file path to the input 360 equirectangular panorama PNG/JPEG image.'
                },
                prompt: {
                    type: 'STRING',
                    description: 'Optional guidance prompt describing the scene context for inpainting the boundary seam.'
                },
                seamWidth: {
                    type: 'NUMBER',
                    description: 'Width in pixels of the vertical inpaint band centered on the seam (default: 128).'
                },
                outputImagePath: {
                    type: 'STRING',
                    description: 'Optional output file path to write the healed seamless panorama.'
                },
                model: PANORAMA_IMAGE_MODEL_PARAMETER,
                maxModelUpscale: PANORAMA_MAX_UPSCALE_PARAMETER
            },
            required: ['inputImagePath']
        }
    },
    {
        name: 'panorama_inpaint',
        description: 'Inpaint or remove objects (such as nadir camera rigs, tripods, drone shadows, or unwanted floaters) on a 360 equirectangular panorama with a Gemini image model. Fails when no image model inpaints it; the result names the model that answered.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputImagePath: {
                    type: 'STRING',
                    description: 'Absolute or relative file path to the input 360 panorama image.'
                },
                maskImagePath: {
                    type: 'STRING',
                    description: 'Optional file path to a black-and-white inpaint mask image.'
                },
                nadirOnly: {
                    type: 'BOOLEAN',
                    description: 'If true, automatically generates a south polar nadir mask covering the camera rig/tripod.'
                },
                nadirRatio: {
                    type: 'NUMBER',
                    description: 'Fraction of image height from bottom to cover for nadir removal (default: 0.15).'
                },
                ceilingOnly: {
                    type: 'BOOLEAN',
                    description: 'If true, automatically generates a north polar ceiling mask covering the sky/ceiling dome.'
                },
                ceilingRatio: {
                    type: 'NUMBER',
                    description: 'Fraction of image height from top to cover for ceiling infill (default: 0.20).'
                },
                inpaintBothPolar: {
                    type: 'BOOLEAN',
                    description: 'If true, automatically generates a dual polar mask covering both ceiling (top) and nadir/floor (bottom).'
                },
                prompt: {
                    type: 'STRING',
                    description: 'Inpainting prompt describing what should replace the masked area (e.g. clean pavement, grass).'
                },
                outputImagePath: {
                    type: 'STRING',
                    description: 'Optional output file path to write the inpainted panorama.'
                },
                model: PANORAMA_IMAGE_MODEL_PARAMETER,
                maxModelUpscale: PANORAMA_MAX_UPSCALE_PARAMETER
            },
            required: ['inputImagePath']
        }
    },
    {
        name: 'panorama_generate_360',
        description: 'Synthesize a 360 equirectangular panoramic image from prompt (plain text description or structured JSON prompt) with a Gemini image model and automatic boundary seam healing. Fails when no image model produces it; the result names the model that answered.',
        parameters: {
            type: 'OBJECT',
            properties: {
                prompt: {
                    type: 'STRING',
                    description: 'Text description or structured JSON prompt of the 360 panoramic environment to generate.'
                },
                structuredPrompt: {
                    type: 'OBJECT',
                    description: 'Optional structured 360 prompt schema containing image_meta, scene_context, rendering_style, and constraints.'
                },
                style: {
                    type: 'STRING',
                    description: 'Optional aesthetic style modifier (e.g. "photorealistic daylight", "cyberpunk neon night").'
                },
                width: {
                    type: 'NUMBER',
                    description: 'Panorama width in pixels (default: 2048).'
                },
                height: {
                    type: 'NUMBER',
                    description: 'Panorama height in pixels (default: 1024).'
                },
                healSeam: {
                    type: 'BOOLEAN',
                    description: 'Whether to automatically perform seam-healing pass (default: true).'
                },
                inpaintNadir: {
                    type: 'BOOLEAN',
                    description: 'Whether to automatically clean the nadir region (default: false).'
                },
                outputImagePath: {
                    type: 'STRING',
                    description: 'Optional output file path to write the generated panorama.'
                },
                model: PANORAMA_IMAGE_MODEL_PARAMETER,
                maxModelUpscale: PANORAMA_MAX_UPSCALE_PARAMETER,
                invertSphericalCurvature: {
                    type: 'BOOLEAN',
                    description: 'Whether to invert spherical curvature so that the panorama wraps concavely towards the user at the lateral edges rather than bowing away convexly (default: false).'
                }
            },
            required: ['prompt']
        }
    },
    {
        name: 'panorama_generate_4k',
        description: 'Synthesize a monumental 4K UHD 360 equirectangular panorama (4096x2048, 8.38 MP) from text prompt with a Gemini image model, Laplacian 2-band frequency separation seam equalization, clean photographic ceiling/ground preservation (zero artificial polar discs/rings), single-pixel polar singularity collapse, and an automated QC audit. Fails when no image model produces it; the result names the model that answered.',
        parameters: {
            type: 'OBJECT',
            properties: {
                prompt: {
                    type: 'STRING',
                    description: 'Text prompt describing the 360 panoramic environment or monumental architecture.'
                },
                style: {
                    type: 'STRING',
                    description: 'Optional aesthetic style modifier (e.g. "monumental architecture", "cyberpunk neon night", "gothic fan vault").'
                },
                width: {
                    type: 'NUMBER',
                    description: 'Panorama width in pixels (default: 4096).'
                },
                height: {
                    type: 'NUMBER',
                    description: 'Panorama height in pixels (default: 2048).'
                },
                seamEqualization: {
                    type: 'STRING',
                    description: 'Seam equalization method across boundary meridian: "laplacian_2band" (default), "linear_smoothstep", or "none".'
                },
                seamWidth: {
                    type: 'NUMBER',
                    description: 'Width of seam blending margin in pixels (default: 128 for 4K).'
                },
                enablePolarCaps: {
                    type: 'BOOLEAN',
                    description: 'Whether to apply artificial Street View circular polar discs (default: false — clean photographic ceiling & ground).'
                },
                enforcePolarSingularity: {
                    type: 'BOOLEAN',
                    description: 'Whether to collapse infinitesimal polar coordinate singularities at row 0 and row H-1 (default: true).'
                },
                outputImagePath: {
                    type: 'STRING',
                    description: 'Optional output file path to write the generated 4K PNG panorama.'
                },
                model: PANORAMA_IMAGE_MODEL_PARAMETER
            },
            required: ['prompt']
        }
    },
    {
        name: 'panorama_reproject_zenith',
        description: 'Reproject a 1:1 rectilinear ceiling image into a 360 equirectangular panorama (Option A). Uses inverse gnomonic raycasting with smooth radial feathering and illumination balancing to eliminate polar pinching singularities on domes, vaults, and oculi.',
        parameters: {
            type: 'OBJECT',
            properties: {
                baseImagePath: {
                    type: 'STRING',
                    description: 'Path to base 360 equirectangular panorama image file.'
                },
                patchImagePath: {
                    type: 'STRING',
                    description: 'Path to 1:1 rectilinear ceiling image file looking straight up at zenith.'
                },
                outputImagePath: {
                    type: 'STRING',
                    description: 'Optional path to write the reprojected 360 panorama output.'
                },
                fovDegrees: {
                    type: 'NUMBER',
                    description: 'Field of view of the rectilinear ceiling patch in degrees (default: 90).'
                },
                headingDegrees: {
                    type: 'NUMBER',
                    description: 'Azimuthal rotation angle in degrees to align patch with panorama orientation (default: 0).'
                },
                blendInnerRadius: {
                    type: 'NUMBER',
                    description: 'Normalized radius inside which patch has 100% weight (default: 0.65).'
                },
                blendOuterRadius: {
                    type: 'NUMBER',
                    description: 'Normalized radius beyond which base panorama has 100% weight (default: 0.95).'
                },
                matchIllumination: {
                    type: 'BOOLEAN',
                    description: 'Whether to equalize exposure and chrominance across the overlap ring band (default: true).'
                }
            },
            required: ['baseImagePath', 'patchImagePath']
        }
    },
    {
        name: 'panorama_extract_zenith',
        description: 'Extract a 1:1 rectilinear perspective square image looking straight up at zenith (+Y, elevation +90°) from an equirectangular panorama.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputImagePath: {
                    type: 'STRING',
                    description: 'Path to 360 equirectangular panorama image file.'
                },
                outputImagePath: {
                    type: 'STRING',
                    description: 'Optional path to write the extracted 1:1 square ceiling image.'
                },
                fovDegrees: {
                    type: 'NUMBER',
                    description: 'Field of view in degrees (default: 90).'
                },
                patchResolution: {
                    type: 'NUMBER',
                    description: 'Resolution in pixels for square patch (default: 1024).'
                }
            },
            required: ['inputImagePath']
        }
    },
    {
        name: 'panorama_generate_perspectives',
        description: 'Generate 6 discrete rectilinear perspective camera plates (Front, Right, Back, Left, Top [Zenith], Bottom [Nadir]) from an input 2D image or panorama to extend 360-degree coverage and vertical coverage, and stitch them into a seamless 360 equirectangular environment.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputImagePath: {
                    type: 'STRING',
                    description: 'Path on disk to the input 2D perspective photo or equirectangular panorama image.'
                },
                faceResolution: {
                    type: 'NUMBER',
                    description: 'Square pixel resolution of each individual perspective camera face (default: 512).'
                },
                equirectangularWidth: {
                    type: 'NUMBER',
                    description: 'Stitched 360 equirectangular panorama width (default: 2048).'
                },
                equirectangularHeight: {
                    type: 'NUMBER',
                    description: 'Stitched 360 equirectangular panorama height (default: 1024).'
                },
                styleHint: {
                    type: 'STRING',
                    description: 'Optional style or scene hint to guide the image model generating the perspectives.'
                },
                prompt: {
                    type: 'STRING',
                    description: 'Optional guidance prompt describing the scene context to condition Nano Banana 2 perspective generation.'
                },
                model: {
                    type: 'STRING',
                    description: 'Image model id for the 5 surrounding perspectives. When given, only that model is used; omit it to try the default list in order (gemini-3.1-flash-image, i.e. Nano Banana 2, first). The result names the model that answered and why any earlier one was skipped.'
                },
                outputDir: {
                    type: 'STRING',
                    description: 'Optional output directory to write all 6 perspective camera plates and stitched panorama.'
                }
            },
            required: ['inputImagePath']
        }
    },
    {
        name: 'panorama_audit_quality',
        description: 'Perform automated Quality Control (QC) audit on a 360 panorama equirectangular image, mathematically measuring meridian boundary continuity, polar rotational invariance at zenith and nadir, and ceiling horizon seam discontinuities. Returns 0-100 quality score, Pass/Fail status, detected violations, and actionable remediation hints.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputImagePath: {
                    type: 'STRING',
                    description: 'Path to equirectangular 360 panorama image to audit (.png or .jpg).'
                },
                maxAllowedMeridianRms: {
                    type: 'NUMBER',
                    description: 'Maximum allowable RMS color error across meridian boundary (default: 2.0 / 255).'
                },
                maxAllowedPolarStdDev: {
                    type: 'NUMBER',
                    description: 'Maximum allowable azimuthal standard deviation at polar apex rows (default: 1.0 / 255).'
                },
                maxAllowedDiscontinuity: {
                    type: 'NUMBER',
                    description: 'Maximum allowable mean color jump across ceiling rows (default: 3.0 / 255).'
                }
            },
            required: ['inputImagePath']
        }
    },
    {
        name: 'panorama_to_3dgs',
        description: 'Generate a walkable 3DGS world from a single 360 equirectangular panorama. Measures per-pixel metric depth with the local Depth Anything V2 Metric model (the call fails when it cannot run), synthesizes offset viewpoints whose disocclusions are inpainted by a Gemini image model (the run fails rather than splatting un-inpainted holes; a panorama too large for the image model is refused before the depth run), and compiles a merged .SPLAT and Niantic NGSP v2 .SPZ. The result reports the capture height and how it was obtained.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputImagePath: {
                    type: 'STRING',
                    description: 'Absolute path to the input 360 equirectangular panorama.'
                },
                sceneType: {
                    type: 'STRING',
                    description: 'Scene type to guide the metric depth model (indoor or outdoor, default: outdoor).'
                },
                eyeHeight: {
                    type: 'NUMBER',
                    description: 'Camera height above the floor in meters, when known. Omitted, it is measured from the metric floor in the depth map, and the call fails when there is too little floor to measure it.'
                },
                radius: {
                    type: 'NUMBER',
                    description: 'Offset ring radius in meters for Walk Mode disocclusion fill (default: 1.25).'
                },
                numPoses: {
                    type: 'NUMBER',
                    description: 'Number of camera poses to synthesize around the ring (default: 6).'
                },
                voxelSize: {
                    type: 'NUMBER',
                    description: 'Voxel size in meters for final splat decimation merge (default: 0.04).'
                },
                skipOffsets: {
                    type: 'BOOLEAN',
                    description: 'Fast path skipping multi-perspective offset synthesis (default: false).'
                },
                prompt: {
                    type: 'STRING',
                    description: 'Inpainting prompt describing the hidden background scenery for the image model.'
                },
                model: PANORAMA_IMAGE_MODEL_PARAMETER,
                maxModelUpscale: PANORAMA_MAX_UPSCALE_PARAMETER
            },
            required: ['inputImagePath']
        }
    },
    {
        name: 'single_image_to_3dgs',
        description: 'Convert a single 2D photo or render into 3D Gaussian Splats (.splat and Niantic .spz). Per-pixel metric depth comes from the Depth Anything V2 Metric model (local sidecar); each pixel is lifted along its pinhole ray at that depth, with normals from neighbouring depths. Fails when the depth model cannot run (nothing is guessed from colour or image rows). Directly loadable into Scene3DPrimitive via splatUrl.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputImagePath: {
                    type: 'STRING',
                    description: 'Absolute path to the input 2D image (PNG, JPG, or WebP).'
                },
                fovDegrees: {
                    type: 'NUMBER',
                    description: 'Vertical field of view of the photo in degrees. Give the real lens when known; when omitted 65 is assumed and the result says so.'
                },
                sceneType: {
                    type: 'STRING',
                    description: '"indoor" or "outdoor" (default): which Depth Anything V2 Metric model reads the depth.'
                },
                stride: {
                    type: 'NUMBER',
                    description: 'Pixel stride for Gaussian subsampling (default: 2, where 1 is full resolution).'
                },
                minDepth: {
                    type: 'NUMBER',
                    description: 'Minimum metric distance in meters (default: 0.2).'
                },
                maxDepth: {
                    type: 'NUMBER',
                    description: 'Maximum metric distance in meters (default: 150.0).'
                },
                outDir: {
                    type: 'STRING',
                    description: 'Output directory to store .splat and .spz files (default: public/splats).'
                }
            },
            required: ['inputImagePath']
        }
    },
    {
        name: 'splat_to_3dtiles',
        description: 'Convert a Gaussian splat cloud (.splat or Niantic .spz) into an OGC 3D Tiles 1.1 tileset: native C++20 Morton octree with LOD simplification, per-tile GLB using KHR_gaussian_splatting + KHR_gaussian_splatting_compression_spz_2, and an optional WGS-84 root transform (from a lat/lng/alt anchor via the ENU tangent plane) so the splats overlay Google Photorealistic 3D Tiles in any 3D Tiles viewer.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputPath: { type: 'STRING', description: 'Path to the input .splat or .spz file.' },
                outDir: { type: 'STRING', description: 'Output directory for tileset.json and tiles/ (default: build/splat_tiles/<name>).' },
                latitude: { type: 'NUMBER', description: 'Geodetic latitude of the splat frame origin (degrees). Omit for a local-metres tileset.' },
                longitude: { type: 'NUMBER', description: 'Geodetic longitude of the splat frame origin (degrees).' },
                altitude: { type: 'NUMBER', description: 'Altitude of the splat frame origin in metres (default 0).' },
                headingDeg: { type: 'NUMBER', description: 'Yaw of the splat frame relative to true north, degrees clockwise (default 0).' },
                maxDepth: { type: 'NUMBER', description: 'Maximum octree depth (default 5).' },
                leafCapacity: { type: 'NUMBER', description: 'Maximum splats per leaf tile (default 65536).' },
                interiorBudget: { type: 'NUMBER', description: 'Maximum simplified splats per interior LOD tile (default 32768).' }
            },
            required: ['inputPath']
        }
    },
    {
        name: 'plan_adaptive_survey_rig',
        description: 'Adaptive Scene-Aware Survey Rig Planning (ADA): derives photogrammetric camera station placements directly from real 3D mesh geometry (OBB, surface normals, ground elevation, and architectural dimensions). Eliminates hardcoded presets and underground cameras. Enforces ground clearance (Y >= terrain + 1.8m), optimal GSD standoff, facade normal targeting, and strict depth bounding to eliminate floating sky splats.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Path to target 3D model (.glb) to analyze and survey.' },
                latitude: { type: 'NUMBER', description: 'Latitude (degrees) of the model\'s origin; stations get WGS-84 coordinates from it.' },
                longitude: { type: 'NUMBER', description: 'Longitude (degrees) of the model\'s origin.' },
                elevationMeters: { type: 'NUMBER', description: 'Ground elevation above sea level (metres) at the model\'s origin.' },
                headingDeg: { type: 'NUMBER', description: 'Heading of the model\'s -Z axis, degrees clockwise from north (default 0).' },
                cameraBudget: { type: 'NUMBER', description: 'Maximum number of camera stations to synthesize (default: 40).' },
                targetResolutionMm: { type: 'NUMBER', description: 'Desired Ground Sampling Distance in mm/pixel (e.g. 2.0 mm for tactile travertine pores). Auto-calculates optimal standoff.' },
                mode: { type: 'STRING', description: "Survey mode: 'facade-perimeter' (default), 'interior-cavity', 'multitier-complete', or 'inspection-macro'." },
                focalLengthMm: { type: 'NUMBER', description: 'Base camera focal length in mm (default: 35mm full frame).' },
                minGroundClearanceMeters: { type: 'NUMBER', description: 'Minimum ground clearance in meters (default: 1.8m). Stations will NEVER be placed lower than local terrain + clearance.' },
                standoffMeters: { type: 'NUMBER', description: 'Explicit camera standoff override in meters (if omitted, derived from targetResolutionMm and sensor optics).' },
                focusCentroid: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Target structure centroid [x, y, z] in local ENU to isolate from wide urban terrain.' },
                cropRadius: { type: 'NUMBER', description: 'Radius in meters around focusCentroid to isolate target structure (default: 120-140m).' },
                outJsonPath: { type: 'STRING', description: 'Optional path to persist the synthesized stations JSON.' }
            },
            required: ['glbPath', 'latitude', 'longitude', 'elevationMeters']
        }
    },
    {
        name: 'survey_synthesize_stations',
        description: 'Survey Synthesis: procedurally place 6-DoF camera stations around a geodetic anchor (orbital-multi-tier, facade-lawnmower, street-corridor, nadir-grid) in the local ENU frame with WGS-84 coordinates, lens fov and frustum footprints. Optionally enrich each station against a GLB (standoff, horizon row, sky fraction, mesh coverage, sun azimuth/elevation) and rank the best stations for AI Beautify. These stations are the single camera truth for blockout rendering, buildBeautifyPrompt and depth-to-splat baking.',
        parameters: {
            type: 'OBJECT',
            properties: {
                latitude: { type: 'NUMBER', description: 'Anchor latitude (degrees).' },
                longitude: { type: 'NUMBER', description: 'Anchor longitude (degrees).' },
                elevationMeters: { type: 'NUMBER', description: 'Anchor ground elevation ASL (metres). Required: no elevation is assumed.' },
                headingDeg: { type: 'NUMBER', description: 'Anchor / corridor heading, degrees clockwise from north (default 0).' },
                pattern: { type: 'STRING', description: "'orbital-multi-tier' | 'facade-lawnmower' | 'street-corridor' | 'nadir-grid'" },
                radiusMeters: { type: 'NUMBER', description: 'Orbit radius / facade standoff / corridor scale (metres).' },
                cameraCount: { type: 'NUMBER', description: 'Number of stations (>= 3).' },
                focalLengthMm: { type: 'NUMBER', description: 'Full-frame equivalent focal length (default 35).' },
                cameraHeightMeters: { type: 'NUMBER', description: 'Street-corridor camera height (e.g. 1.7 for eye level).' },
                lookAtOffsetLocalENU: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Orbit look-at point [east, up, south] in metres (default [0, 20, 0]).' },
                glbPath: { type: 'STRING', description: 'Optional anchored GLB (e.g. Google 3D Tiles clay) to enrich stations against.' },
                isoDate: { type: 'STRING', description: 'ISO-8601 UTC instant for the sun ephemeris (default now).' },
                rankMaxCount: { type: 'NUMBER', description: 'If set, also return the ids of the best stations for beautify.' },
                outJsonPath: { type: 'STRING', description: 'Optional path to write the stations JSON.' }
            },
            required: ['latitude', 'longitude', 'elevationMeters', 'pattern', 'radiusMeters', 'cameraCount']
        }
    },
    {
        name: 'survey_rank_stations',
        description: 'Rank enriched survey stations for AI Beautify: drops stations with low mesh coverage or too much sky, then picks a set with maximal angular spread.',
        parameters: {
            type: 'OBJECT',
            properties: {
                stationsJsonPath: { type: 'STRING', description: 'Path to a stations JSON written by survey_synthesize_stations.' },
                maxCount: { type: 'NUMBER', description: 'How many stations to keep (default 8).' },
                minMeshCoverage: { type: 'NUMBER', description: 'Minimum footprint coverage of the mesh (default 0.6).' },
                maxSkyFraction: { type: 'NUMBER', description: 'Maximum empty-sky fraction (default 0.6).' }
            },
            required: ['stationsJsonPath']
        }
    },
    {
        name: 'survey_export_colmap',
        description: 'Export survey stations as COLMAP cameras.txt / images.txt (camera-from-world convention) for external Gaussian splat trainers or SfM tools.',
        parameters: {
            type: 'OBJECT',
            properties: {
                stationsJsonPath: { type: 'STRING', description: 'Path to a stations JSON.' },
                outDir: { type: 'STRING', description: 'Directory to write cameras.txt and images.txt.' },
                width: { type: 'NUMBER', description: 'Image width in px (default 1920).' },
                height: { type: 'NUMBER', description: 'Image height in px (default 1080).' }
            },
            required: ['stationsJsonPath', 'outDir']
        }
    },
    {
        name: 'survey_render_station',
        description: 'Render a pose-exact clay blockout of a GLB from one survey station (pure Node software rasterizer): PNG plus pinhole intrinsics and metric depth statistics. This is the <IMAGE_REF_0> precursor for buildBeautifyPrompt at that station.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Anchored GLB to render.' },
                stationsJsonPath: { type: 'STRING', description: 'Stations JSON containing the station.' },
                stationId: { type: 'NUMBER', description: 'Station id to render.' },
                width: { type: 'NUMBER', description: 'Render width (default 1920; height follows the station aspect).' },
                outPngPath: { type: 'STRING', description: 'Where to write the PNG.' }
            },
            required: ['glbPath', 'stationsJsonPath', 'stationId', 'outPngPath']
        }
    },
    {
        name: 'survey_beautify_station',
        description: 'AI Beautify one survey station: pose-exact clay blockout of the GLB -> buildBeautifyPrompt grounded in the station (coordinates, yaw, pitch, lens fov, standoff, horizon, sun) -> Nano Banana image -> geometric QC by closed-loop edge alignment against the mesh (rejects recomposed frames) -> aligned pose. Returns the image path and QC report.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Anchored GLB (e.g. Google 3D Tiles clay).' },
                stationsJsonPath: { type: 'STRING', description: 'Stations JSON from survey_synthesize_stations.' },
                stationId: { type: 'NUMBER', description: 'Station to beautify.' },
                locationName: { type: 'STRING', description: 'Location name for the prompt.' },
                moodPromptContext: { type: 'STRING', description: 'Optional mood/lighting sentence(s) for the prompt.' },
                styleSuffix: { type: 'STRING', description: 'Optional style suffix appended verbatim.' },
                width: { type: 'NUMBER', description: 'Render/generation width (default 1920).' },
                outDir: { type: 'STRING', description: 'Output directory for blockout + beautified PNGs.' }
            },
            required: ['glbPath', 'stationsJsonPath', 'stationId', 'locationName']
        }
    },
    {
        name: 'survey_beautify_to_splats',
        description: 'Full Survey -> Beautify -> Gaussian splat 3D Tiles pipeline: ranks stations against the GLB, beautifies each (chained: every accepted image is warped into the next station as a consistency reference), bakes each accepted image onto the mesh depth as oriented splats (native C++20), fuses across stations, and emits a KHR_gaussian_splatting 3D Tiles tileset with a WGS-84 root transform plus tileset.meta.json (crop box, prompts, QC).',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Anchored GLB.' },
                stationsJsonPath: { type: 'STRING', description: 'Stations JSON (with anchor) from survey_synthesize_stations.' },
                locationName: { type: 'STRING', description: 'Location name for prompts.' },
                moodPromptContext: { type: 'STRING', description: 'Mood/lighting sentence(s), identical for all stations.' },
                styleSuffix: { type: 'STRING', description: 'Style suffix appended verbatim.' },
                mode: { type: 'STRING', description: "'chained' (default, consistent) or 'fanout' (parallel-friendly)." },
                maxStations: { type: 'NUMBER', description: 'Keep only the best N ranked stations.' },
                width: { type: 'NUMBER', description: 'Render/generation width (default 1920).' },
                bakeStride: { type: 'NUMBER', description: 'Pixel stride when baking (default 1).' },
                outDir: { type: 'STRING', description: 'Output directory (default public/tilesets/survey_<ts>).' }
            },
            required: ['glbPath', 'stationsJsonPath', 'locationName']
        }
    },
    {
        name: 'survey_beautify_to_texture',
        description: 'Survey-to-Atlas Inverse Projection (SAIP): Back-projects generative AI Beautify camera station plates directly into the model\'s consolidated UV atlas with MaxRects packing, analytical metric-depth occlusion testing, orthogonal normal weighting, and PBR decomposition (Scharr normals, Toksvig AA roughness, HBAO, dielectric glass classification, and NOAA solar de-lighting when isoDate is given and the stations file has anchor coordinates). The result says whether de-lighting was applied.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Input GLB mesh model. Every primitive must have its own UVs (TEXCOORD_0): the texture is baked into them, and a mesh without UVs is refused before any station image is generated.' },
                stationsJsonPath: { type: 'STRING', description: 'Stations JSON (with anchor) from survey_synthesize_stations.' },
                locationName: { type: 'STRING', description: 'Location name for prompts.' },
                moodPromptContext: { type: 'STRING', description: 'Mood/lighting sentence(s), identical for all stations.' },
                styleSuffix: { type: 'STRING', description: 'Style suffix appended verbatim.' },
                resolution: { type: 'NUMBER', description: 'Atlas texture resolution (default 4096).' },
                depthTolerance: { type: 'NUMBER', description: 'Occlusion test depth tolerance in meters (default 0.20).' },
                minCosIncidence: { type: 'NUMBER', description: 'Drop glancing incidence angles below this cos theta (default 0.08).' },
                isoDate: { type: 'STRING', description: 'UTC time whose sun lit the station images (the time of day their mood describes), for NOAA solar de-lighting. Without it nothing is de-lit.' },
                outGlbPath: { type: 'STRING', description: 'Target output path for enhanced GLB (default <workspace>/public/models/survey_pbr_<ts>.glb).' }
            },
            required: ['glbPath', 'stationsJsonPath', 'locationName']
        }
    },
    {
        name: 'location_generate_3dgs',
        description: 'Generate a photorealistic 3D Gaussian Splatting (3DGS) radiance field and OGC 3D Tileset for any real-world location or landmark. Automatically orchestrates Google 3D Tiles blockout ingestion, multi-tier survey camera synthesis, Nano Banana multi-view restyling with closed-loop Sobel edge QC, and native C++20 metric depth unprojection and octree voxel fusion.',
        parameters: {
            type: 'OBJECT',
            properties: {
                location: { type: 'STRING', description: 'Location name or landmark (e.g. "Rome Colosseum", "Empire State Building", "Grand Army Plaza", "Eiffel Tower").' },
                lat: { type: 'NUMBER', description: 'Geodetic latitude in degrees (optional if named landmark).' },
                lng: { type: 'NUMBER', description: 'Geodetic longitude in degrees (optional if named landmark).' },
                elevation: { type: 'NUMBER', description: 'Elevation in meters above sea level.' },
                glbPath: { type: 'STRING', description: 'Optional: the clay GLB of this place already extracted (e.g. by google_3d_tiles_get_clay). Without it the place\'s Google 3D Tiles are extracted fresh in clay; a failed extraction fails the call.' },
                stylePreset: { type: 'STRING', description: 'Era or visual style preset (e.g. "cinematic-film", "oil-painting").' },
                mood: { type: 'STRING', description: 'Diurnal lighting mood ("dawn", "golden-hour", "midday", "dusk", "night").' },
                cameraCount: { type: 'NUMBER', description: 'Number of survey camera stations (default: 6-12).' },
                outDir: { type: 'STRING', description: 'Output directory for splat and tileset files.' },
                forceRebake: { type: 'BOOLEAN', description: 'Default true: the image model paints every station image. false reuses station images (and the splats baked from them) already in outDir once each passes geometry QC against the mesh again; a station without a usable image is still painted by the image model.' },
                draft: { type: 'BOOLEAN', description: 'Fast draft mode (Nano Banana Lite, 1K resolution, empty style suffix for later prompt customization).' },
                styleSuffix: { type: 'STRING', description: 'Optional style suffix to append to prompt. Leave empty to allow prompt entry later.' }
            },
            required: ['location']
        }
    },
    {
        name: 'spatial_ai_render_scene',
        description: 'Renders and restyles the active 3D scene from the current camera pose using our native AI render engine.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Input GLB mesh model path.' },
                pose: { type: 'OBJECT', description: '6-DOF camera pose (x, y, z, targetX, targetY, targetZ, fov, etc.).' },
                prompt: { type: 'STRING', description: 'Visual style description prompt for Nano Banana.' },
                stylePreset: { type: 'STRING', description: 'Style preset or suffix to append.' },
                width: { type: 'NUMBER', description: 'Render viewport width.' },
                height: { type: 'NUMBER', description: 'Render viewport height.' }
            },
            required: ['glbPath', 'pose', 'prompt']
        }
    },
    {
        name: 'spatial_smart_point_inpaint',
        description: 'Inpaints a localized region of an image of the scene: projects a 3D point into the image with the camera pose, has an image model edit a feathered region around it (at the image\'s own aspect ratio; an answer at another ratio is refused), and keeps every pixel outside that region. A point behind the camera, outside the image, or hidden behind the mesh (its rendered depth) is refused before any model call. The result names the model that answered.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: { type: 'STRING', description: 'Path to base image.' },
                glbPath: { type: 'STRING', description: 'Input GLB mesh model path.' },
                pose: { type: 'OBJECT', description: '6-DOF camera pose of the viewport.' },
                smartPoint: { type: 'ARRAY', items: { type: 'NUMBER' }, description: '3D coordinate [X, Y, Z] to project and edit.' },
                prompt: { type: 'STRING', description: 'Prompt describing what to add or edit at the smart point region.' },
                radiusPx: { type: 'NUMBER', description: 'Pixel radius of the feathered mask around the projected point.' },
                width: { type: 'NUMBER', description: 'Optional: the image width; it must match the image (the point is projected at the image\'s own size).' },
                height: { type: 'NUMBER', description: 'Optional: the image height; it must match the image.' },
                model: { type: 'STRING', description: 'Optional image model id; when given only that model is used, otherwise the image models are tried in priority order and the result names the one that answered.' }
            },
            required: ['imagePath', 'glbPath', 'pose', 'smartPoint', 'prompt']
        }
    },
    {
        name: 'spatial_keyframe_video_interpolation',
        description: 'Interpolates between two 3D camera poses to generate a continuous Gemini Omni 1.1 / Veo video.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Input GLB mesh model path.' },
                startPose: { type: 'OBJECT', description: 'Start camera pose (6-DOF).' },
                endPose: { type: 'OBJECT', description: 'End camera pose (6-DOF).' },
                prompt: { type: 'STRING', description: 'Atmospheric scene prompt describing the video subject and kinematics.' },
                width: { type: 'NUMBER', description: 'Keyframe render width (default 1280). The video model answers 16:9 or 9:16, so the keyframes are rendered at whichever is nearer: landscape keeps this width, portrait keeps the height.' },
                height: { type: 'NUMBER', description: 'Keyframe render height (default 720).' },
                durationSeconds: { type: 'NUMBER', description: 'Output video duration in seconds.' }
            },
            required: ['glbPath', 'startPose', 'endPose', 'prompt']
        }
    },
    {
        name: 'mesh_bake_ai_textures',
        description: 'Texture a mesh from its six axis-aligned views: each view is rendered from the mesh, restyled by an image model to the style prompt (six image-model calls), and projected back onto the mesh\'s existing UVs (TEXCOORD_0) with depth occlusion into a base colour texture. Writes a textured copy of the GLB (the input is not changed) and reports which model made the views, any view that could not be used, and how much of the surface no view saw (those texels keep the mesh\'s own colour). A GLB without UVs, or with accessors that cannot be read, is refused; the bake fails, writing nothing, when any primitive is painted by none of the views.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Input GLB mesh with UVs (TEXCOORD_0).' },
                stylePrompt: { type: 'STRING', description: 'Style or material prompt (e.g. "medieval weathered cobblestone").' },
                width: { type: 'NUMBER', description: 'Render and image size per view in pixels (default 512).' },
                height: { type: 'NUMBER', description: 'Render and image size per view in pixels (default 512).' },
                resolution: { type: 'NUMBER', description: 'Texture size per primitive (default: its current base colour texture size, else 1024).' },
                outGlbPath: { type: 'STRING', description: 'Where to write the textured GLB (default: public/models/baked_<name>_<time>.glb in the workspace).' }
            },
            required: ['glbPath', 'stylePrompt']
        }
    },
    {
        name: 'streetview_grounding_image',
        description: 'Fetch a redacted Google Street View image that is permitted as input to image and video generation (Maps Imagery Grounding API, RetrieveGroundingImage). Use this, never ordinary Street View images, whenever Street View imagery will be sent to a generative model. Give a panoId, or lat/lng to use the nearest Google-captured panorama (user photospheres are not eligible). Saves the JPEG in the workspace and returns its path.',
        parameters: {
            type: 'OBJECT',
            properties: {
                panoId: { type: 'STRING', description: 'Google Street View panorama ID (must be a Google capture).' },
                lat: { type: 'NUMBER', description: 'Latitude to find the nearest Google-captured panorama, when no panoId is given.' },
                lng: { type: 'NUMBER', description: 'Longitude to find the nearest Google-captured panorama, when no panoId is given.' },
                headingDegree: { type: 'NUMBER', description: 'View heading, degrees clockwise from north (0 = north, 90 = east). Default 0.' },
                pitchDegree: { type: 'NUMBER', description: 'View pitch, degrees in the grounding API sign: POSITIVE looks DOWN, NEGATIVE looks UP (+90 straight down, -90 straight up; verified against the live endpoint). Default 0.' },
                fovDegree: { type: 'NUMBER', description: 'Horizontal field of view, 1-90 degrees. Default 90.' },
                aspectRatio: { type: 'STRING', enum: ['RATIO_1X1', 'RATIO_2X3', 'RATIO_3X2', 'RATIO_3X4', 'RATIO_4X3', 'RATIO_4X5', 'RATIO_5X4', 'RATIO_9X16', 'RATIO_16X9', 'RATIO_21X9'], description: 'Output aspect ratio; defaults to the source image ratio.' }
            }
        }
    },
    {
        name: 'maps_imagery_grounding_pano',
        description: 'Ground a natural language landmark prompt or direct Google Street View Pano ID to official Street View imagery using Vertex AI Maps Imagery Grounding (MIG). Retrieves perspective cubic faces, projects to a 2:1 ERP equirectangular canvas buffer, and returns the panorama path and grounding metadata.',
        parameters: {
            type: 'OBJECT',
            properties: {
                prompt: { type: 'STRING', description: 'Natural language landmark prompt to ground (e.g. "Times Square facing south", "Shibuya Crossing scramble").' },
                panoId: { type: 'STRING', description: 'Direct Google Street View Pano ID if already known (e.g. "CAoSF0NJSE0wb2dLRUlDQWdJRHE4NkMtbXdF").' },
                lat: { type: 'NUMBER', description: 'Optional geographic latitude.' },
                lng: { type: 'NUMBER', description: 'Optional geographic longitude.' },
                canvasWidth: { type: 'NUMBER', description: 'Width of equirectangular output canvas in pixels (default: 2048).' },
                canvasHeight: { type: 'NUMBER', description: 'Height of equirectangular output canvas in pixels (default: 1024).' },
                outputImagePath: { type: 'STRING', description: 'Optional custom disk path to write the projected panorama PNG.' }
            }
        }
    },
    {
        name: 'stage_3d_vector_world',
        description: 'Stage a 3D world from Google vector tiles at zoom 16 (building prisms seated and sized from the Google Solar DSM fused with Google vector heights, 5-tier road cross-sections with curbs and sidewalks, streetlamps, water basins), in 18% Studio Grey Clay, packaged as a binary .glb for staging around hero models. Buildings with no height data are drawn as flat footprints and counted, never given a guessed height. Traffic vehicles are synthetic and only placed when includeTraffic is true.',
        parameters: {
            type: 'OBJECT',
            properties: {
                latitude: { type: 'NUMBER', description: 'Geodetic latitude of the target center, in degrees.' },
                longitude: { type: 'NUMBER', description: 'Geodetic longitude of the target center, in degrees.' },
                zoom: { type: 'NUMBER', description: 'Vector tile zoom level (default: 16).' },
                radiusTiles: { type: 'NUMBER', description: 'Neighbor tile radius around center (default: 1 for a 3x3 tile grid).' },
                style: { type: 'STRING', description: 'Material styling mode (default: "studio_clay" for 18% Studio Grey Clay).' },
                populate: { type: 'BOOLEAN', description: 'Whether to add sidewalks, curbs and streetlamps (default: true; traffic only with includeTraffic). No trees are placed: a location\'s trees are measured from its photo tiles by google_3d_tiles_get_clay.' },
                includeTraffic: { type: 'BOOLEAN', description: 'Place SYNTHETIC background vehicles in lanes from a seeded PRNG (default: false). They are not observed traffic and are labelled synthetic in the result.' },
                includeStreetlamps: { type: 'BOOLEAN', description: 'Include curbside streetlamps (default: true).' },
                includeSidewalks: { type: 'BOOLEAN', description: 'Include elevated sidewalks with beveled granite curbs (default: true).' },
                heroStaging: {
                    type: 'OBJECT',
                    description: 'Optional query to solve exact lane/sidewalk placement coordinates for a hero asset.',
                    properties: {
                        type: { type: 'STRING', description: 'Placement surface: "lane" or "sidewalk" or "plaza".' },
                        laneIndex: { type: 'NUMBER', description: 'Lane index (0-indexed).' },
                        distanceAlongM: { type: 'NUMBER', description: 'Distance along road corridor in meters.' },
                        roadName: { type: 'STRING', description: 'Optional road name filter.' },
                        side: { type: 'STRING', description: 'Sidewalk side: "left" or "right".' }
                    }
                },
                outputGlbPath: { type: 'STRING', description: 'Optional custom output file path for the generated binary .glb.' }
            },
            required: ['latitude', 'longitude']
        }
    },
    {
        name: 'query_spatial_vector_data',
        description: 'Query rich 2D vector roadmap and cadastral parcel data (kinematic road corridors with lane centerlines, building footprints with verified heights, bridge/tunnel vertical layers, landuse surface friction, POIs) co-registered with Google 3D Photorealistic Tiles via LocalTangentPlane. Enforces Universal Spatial Identifiers (urn:scratchbox:spatial:<layer>:<geohash>:<id>) and the Zero-Fake-Trees invariant.',
        parameters: {
            type: 'OBJECT',
            properties: {
                latitude: { type: 'NUMBER', description: 'Target geodetic latitude, in degrees.' },
                longitude: { type: 'NUMBER', description: 'Target geodetic longitude, in degrees.' },
                elevation: { type: 'NUMBER', description: 'Anchor ground elevation in meters ASL/MSL (default: 0.0).' },
                radiusMeters: { type: 'NUMBER', description: 'Search radius in meters (default: 250).' },
                layers: {
                    type: 'ARRAY',
                    description: 'Specific layers to query: "building", "road", "water", "landuse", "poi". Omit for all.',
                    items: { type: 'STRING' }
                },
                queryType: {
                    type: 'STRING',
                    description: 'Specialized query mode: "overview" (default summary & feature lists), "staging_anchors" (intelligently solve authentic scene placement coordinates & headings), "building_at_point" (identify building at local ENU point), "nearest_road" (find closest lane and heading for point), "excavation_stencil" (generate 3D tile clipping boundary for building), "kinematic_graph" (road network nodes & edges), or "semantic_annotations" (3D HUD billboard labels).'
                },
                mobilityAffinity: {
                    type: 'STRING',
                    description: 'Mobility/circulation hint for staging anchors: "flow" (kinetic road lanes & traffic heading), "stagnation" (civic plazas & open architectural ground), or "perimeter" (sidewalks, curb offsets & setbacks).'
                },
                footprintRadiusM: {
                    type: 'NUMBER',
                    description: 'Minimum horizontal clearance radius in meters for staging anchors (default: 3.0m).'
                },
                preferredSurface: {
                    type: 'STRING',
                    description: 'Preferred surface type hint: "road_lane", "sidewalk", "plaza", "park", or "rooftop".'
                },
                localPoint: {
                    type: 'ARRAY',
                    description: 'Local metric ENU coordinate [x, y, z] in meters for targeted spatial queries ("building_at_point" or "nearest_road") or reference point for "staging_anchors".',
                    items: { type: 'NUMBER' }
                },
                targetFeatureId: {
                    type: 'STRING',
                    description: 'Universal Spatial ID (e.g. "urn:scratchbox:spatial:building:...") for stencil generation or feature lookup.'
                }
            },
            required: ['latitude', 'longitude']
        }
    }
];

/**
 * Adapts the (fraction, message) progress callbacks of the survey services to the chat's progress report. Once the
 * chat has stopped the call (Stop or its time limit), the next report throws, so the pipeline ends at its next
 * checkpoint (the next station) instead of generating and billing the rest in the background.
 */
function chatProgress(ctx: ToolContext | undefined): (fraction: number, message?: string) => void {
    return (fraction, message) => {
        if (ctx?.signal?.aborted) {
            throw Object.assign(new Error('Stopped by the chat before it finished'), { name: 'AbortError' });
        }
        ctx?.reportProgress?.(message || 'Working', fraction);
    };
}

/**
 * Station image generator for the survey, AI render, bake, keyframe and location tools: Nano Banana / Gemini image
 * models via the workspace's Google media credentials. There is no stand-in generator: without credentials the first
 * generation fails with the credential error.
 */
async function resolveStationImageGenerator(ctx: { workspaceRoot: string }): Promise<import('../../spatial/BeautifyStationService').StationImageGenerator> {
    const { createGoogleStationImageGenerator } = await import('../../spatial/BeautifyStationService');
    const { GoogleMediaGenerationService } = await import('../../google-media-generation-service');
    const { GoogleMediaCredentialsService } = await import('../../google-media-credentials-service');
    const { MediaAssetStore } = await import('../../media-asset-store');
    const assetStore = new MediaAssetStore();
    const credentials = new GoogleMediaCredentialsService();
    const mediaService = new GoogleMediaGenerationService(assetStore, () => credentials.createClient());
    return createGoogleStationImageGenerator({ mediaService, assetStore, workspaceRoot: ctx.workspaceRoot || process.cwd() });
}

export const panoramaHandlers: Record<string, ToolHandler> = {
    synthesize_adaptive_particle_system: async (args, _ctx) => {
        const { AdaptiveDomainParticleService } = await import('../../../browser/generative-canvas/services/spatial/AdaptiveDomainParticleService');
        // Every value is the model's own choice; a missing or out-of-range one fails the call (MissingInputError).
        const contract = AdaptiveDomainParticleService.buildContract(args as any);
        return {
            resultPayload: contract as any,
            summaryResult: `Assembled the particle contract for "${contract.subject}" from the values given: emission ${contract.material.emissionModel}, mass ${contract.kinematics.substanceMass}, restitution ${contract.kinematics.restitution}, gravity ${contract.kinematics.gravity} m/s², wind [${contract.kinematics.ambientWind.join(', ')}] m/s, ${contract.material.particleCount} particles.`
        };
    },

    adaptive_world_style_deconstruct: async (args, ctx) => {
        const referenceImagePath = asString(args.referenceImagePath);
        if (!referenceImagePath) throw new Error('adaptive_world_style_deconstruct: "referenceImagePath" argument is required.');
        const fidelity = (asString(args.fidelity) || 'balanced') as any;
        const promptHint = asString(args.promptHint) || undefined;
        
        let cameraPoseObj: any = undefined;
        if (args.cameraPose && typeof args.cameraPose === 'object') {
            const cp = args.cameraPose as any;
            if (Array.isArray(cp.position) && Array.isArray(cp.target) && typeof cp.fov === 'number') {
                cameraPoseObj = {
                    position: cp.position,
                    target: cp.target,
                    fov: cp.fov
                };
            }
        }

        const { AdaptiveStyleDeconstructionService } = await import('../../spatial/AdaptiveStyleDeconstructionService');
        const service = new AdaptiveStyleDeconstructionService();
        const { contract, modelUsed } = await service.deconstructStyle(referenceImagePath, cameraPoseObj, {
            fidelity,
            promptHint
        });

        return {
            resultPayload: { ...contract, modelUsed } as any,
            summaryResult: `${modelUsed} read the style of ${referenceImagePath}: color temperature ${contract.photometric.colorTemperatureK} K, shadow lift ${contract.photometric.shadowLift}, micro-detail scale ${contract.microSurface.normalPerturbationScale}.`
        };
    },

    adaptive_world_style_apply: async (args, ctx) => {
        const referenceImagePath = asString(args.referenceImagePath);
        if (!referenceImagePath) throw new Error('adaptive_world_style_apply: "referenceImagePath" argument is required.');
        const inputGlbPath = asString(args.inputGlbPath);
        if (!inputGlbPath) throw new Error('adaptive_world_style_apply: "inputGlbPath" argument is required.');
        
        const outputGlbPath = asString(args.outputGlbPath) || undefined;
        const fidelity = (asString(args.fidelity) || 'balanced') as any;
        const promptHint = asString(args.promptHint) || undefined;
        const protectFoliage = typeof args.protectFoliage === 'boolean' ? args.protectFoliage : true;
        const protectAsphalt = typeof args.protectAsphalt === 'boolean' ? args.protectAsphalt : true;

        // 1. Deconstruct style
        const { AdaptiveStyleDeconstructionService } = await import('../../spatial/AdaptiveStyleDeconstructionService');
        const deconstruction = new AdaptiveStyleDeconstructionService();
        const { contract, modelUsed } = await deconstruction.deconstructStyle(referenceImagePath, undefined, {
            fidelity,
            promptHint
        });

        // 2. Convert to LAB palette and run offline re-grader
        const { AdaptiveDomainStyleService } = await import('../../../browser/generative-canvas/services/spatial/AdaptiveDomainStyleService');
        const palette = AdaptiveDomainStyleService.contractToGlbPalette(contract);

        const { recolor3DTilesGlb } = await import('../../spatial/GlbTextureRecolorService');
        const result = await recolor3DTilesGlb({
            inputGlb: inputGlbPath,
            outputGlbPath,
            customPalette: palette,
            segmentation: {
                enableSegmentation: true,
                protectFoliage,
                protectAsphalt
            },
            pbr: {
                generateNormalMaps: true,
                generateRoughnessMaps: true,
                normalStrength: 2.0
            },
            shadowLift: contract.photometric.shadowLift,
            highlightCompress: contract.photometric.highlightCompress
        });

        return {
            resultPayload: {
                success: result.success,
                contract,
                modelUsed,
                palette,
                inputGlbPath: result.inputGlbPath,
                outputGlbPath: result.outputGlbPath,
                textureCount: result.textureCount,
                failedTextures: result.failedTextures,
                geometryBytesIdentical: result.geometryBytesIdentical,
                originalByteLength: result.originalByteLength,
                recoloredByteLength: result.recoloredByteLength
            } as any,
            status: result.success ? 'completed' : 'failed',
            summaryResult: `Re-graded ${result.textureCount} texture(s) of ${inputGlbPath} to the style ${modelUsed} read from ${referenceImagePath}${result.failedTextures.length ? ` (${result.failedTextures.length} failed and left unchanged)` : ''}; geometry bytes ${result.geometryBytesIdentical ? 'verified unchanged' : 'DIFFER from the input'}. Output: ${result.outputGlbPath}.`
        };
    },

    spatial_ai_render_scene: async (args, ctx) => {
        const glbPath = asString(args.glbPath);
        const pose = args.pose as CameraPose6DOF;
        const prompt = asString(args.prompt);
        const stylePreset = asString(args.stylePreset);
        const width = typeof args.width === 'number' ? args.width : 640;
        const height = typeof args.height === 'number' ? args.height : 480;

        if (!glbPath) throw new Error('spatial_ai_render_scene: "glbPath" argument is required.');
        if (!pose) throw new Error('spatial_ai_render_scene: "pose" argument is required.');
        if (!prompt) throw new Error('spatial_ai_render_scene: "prompt" argument is required.');

        const { NativeAiRenderEngineService } = await import('../../spatial/NativeAiRenderEngineService');
        const { HeadlessMeshSilhouetteRenderer } = await import('../../spatial/HeadlessMeshSilhouetteRenderer');

        const generator = await resolveStationImageGenerator(ctx);
        const service = new NativeAiRenderEngineService({ generator, workspaceRoot: ctx.workspaceRoot });
        const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(glbPath);

        const result = await service.renderAiBeautyFrame({
            mesh,
            pose,
            prompt,
            stylePreset,
            width,
            height
        });

        const fs = await import('fs-extra');
        // Written into the workspace (the server's cwd is not the workspace in the desktop app).
        const fileName = `ai_rendered_frame_${Date.now()}.png`;
        const imagePath = path.join(ctx.workspaceRoot || process.cwd(), 'public', 'models', fileName);
        await fs.ensureDir(path.dirname(imagePath));
        await fs.writeFile(imagePath, result.image);

        return {
            resultPayload: {
                imagePath,
                imageUrl: `/models/${fileName}`,
                width: result.width,
                height: result.height,
                stylePrompt: prompt,
                modelUsed: result.modelUsed,
                imageSource: result.imageSource
            },
            summaryResult: `Viewport AI render written to ${imagePath} (${result.width}x${result.height} blockout restyled). ${result.imageSource}`
        };
    },
    spatial_smart_point_inpaint: async (args, ctx) => {
        const imagePath = asString(args.imagePath);
        const glbPath = asString(args.glbPath);
        const pose = args.pose as CameraPose6DOF;
        const smartPoint = args.smartPoint as [number, number, number];
        const prompt = asString(args.prompt);
        const radiusPx = typeof args.radiusPx === 'number' ? args.radiusPx : 20;

        if (!imagePath) throw new MissingInputError('spatial_smart_point_inpaint', 'imagePath');
        if (!glbPath) throw new MissingInputError('spatial_smart_point_inpaint', 'glbPath');
        if (!pose) throw new MissingInputError('spatial_smart_point_inpaint', 'pose');
        if (!smartPoint) throw new MissingInputError('spatial_smart_point_inpaint', 'smartPoint');
        if (!prompt) throw new MissingInputError('spatial_smart_point_inpaint', 'prompt');

        const { SpatialSmartPointInpaintService } = await import('../../spatial/SpatialSmartPointInpaintService');
        const { HeadlessMeshSilhouetteRenderer } = await import('../../spatial/HeadlessMeshSilhouetteRenderer');
        const { GoogleMediaCredentialsService } = await import('../../google-media-credentials-service');
        const { readImageDimensions } = await import('../../image-codec-ffmpeg');
        const fs = await import('fs-extra');

        // The point is projected into the image the edit is made on, at that image's own size.
        const baseImage = await fs.readFile(imagePath);
        const dims = readImageDimensions(baseImage);
        if (!dims) throw new MissingInputError('spatial_smart_point_inpaint', 'imagePath', `the size of ${imagePath} cannot be read (PNG, JPEG or WebP expected)`);
        for (const [key, value, own] of [['width', args.width, dims.width], ['height', args.height, dims.height]] as const) {
            if (typeof value === 'number' && value !== own) {
                throw new MissingInputError('spatial_smart_point_inpaint', key, `${imagePath} is ${dims.width}x${dims.height}; the point is projected at the image's own size (got ${key} ${value})`);
            }
        }

        if (!(await fs.pathExists(glbPath))) throw new MissingInputError('spatial_smart_point_inpaint', 'glbPath', `${glbPath} does not exist`);
        // The point is checked against the image before any model call: in front of the camera, inside the frame,
        // and not hidden behind the mesh.
        const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(glbPath);
        const maskRes = new SpatialSmartPointInpaintService().projectSmartPointToMask(mesh, pose, smartPoint, radiusPx, dims.width, dims.height);
        const client = await new GoogleMediaCredentialsService().createClient();
        const service = new SpatialSmartPointInpaintService({ client });
        const result = await service.executeSpatialInpaint({
            image: baseImage,
            mask: maskRes.mask,
            prompt,
            model: asString(args.model) || undefined,
            signal: ctx?.signal
        });

        const fileName = `smart_inpainted_${Date.now()}.png`;
        const outPath = path.join(ctx?.workspaceRoot || process.cwd(), 'public', 'models', fileName);
        await fs.ensureDir(path.dirname(outPath));
        await fs.writeFile(outPath, result.image);

        return {
            resultPayload: {
                inpaintedImagePath: outPath,
                imageUrl: `/models/${fileName}`,
                projectedX: maskRes.x,
                projectedY: maskRes.y,
                pointDepth: maskRes.depth,
                surfaceDepth: maskRes.surfaceDepth,
                maskedPixels: maskRes.maskedPixels,
                modelUsed: result.modelUsed,
                skippedModels: result.skippedModels,
                modelNote: result.modelNote
            },
            summaryResult: `Smart point inpainting written to ${outPath}: the 3D point projects to (${maskRes.x.toFixed(1)}, ${maskRes.y.toFixed(1)}) in the ${dims.width}x${dims.height} image, ${maskRes.depth.toFixed(2)} from the camera and ${maskRes.surfaceDepth === undefined ? 'with no mesh surface at that pixel' : `not hidden by the mesh (surface at ${maskRes.surfaceDepth.toFixed(2)})`}; ${maskRes.maskedPixels} pixels within ${radiusPx}px of it were blended from the model's edit and every other pixel is unchanged. ${result.modelNote} The model answered at ${result.answerWidth}x${result.answerHeight}${result.sentRegion ? ` for the ${result.sentRegion.width}x${result.sentRegion.height} region at ${result.sentRegion.x},${result.sentRegion.y} (sent instead of the whole image)` : ''}.`
        };
    },
    spatial_keyframe_video_interpolation: async (args, ctx) => {
        const glbPath = asString(args.glbPath);
        const startPose = args.startPose as CameraPose6DOF;
        const endPose = args.endPose as CameraPose6DOF;
        const prompt = asString(args.prompt);
        const width = typeof args.width === 'number' ? args.width : 1280;
        const height = typeof args.height === 'number' ? args.height : 720;
        const durationSeconds = typeof args.durationSeconds === 'number' ? args.durationSeconds : 6;

        if (!glbPath) throw new Error('spatial_keyframe_video_interpolation: "glbPath" argument is required.');
        if (!startPose) throw new Error('spatial_keyframe_video_interpolation: "startPose" argument is required.');
        if (!endPose) throw new Error('spatial_keyframe_video_interpolation: "endPose" argument is required.');
        if (!prompt) throw new Error('spatial_keyframe_video_interpolation: "prompt" argument is required.');

        const { SceneKeyframeVideoService } = await import('../../spatial/SceneKeyframeVideoService');
        const { HeadlessMeshSilhouetteRenderer } = await import('../../spatial/HeadlessMeshSilhouetteRenderer');
        const { GoogleMediaCredentialsService } = await import('../../google-media-credentials-service');

        const credentials = new GoogleMediaCredentialsService();
        const client = credentials.createClient();
        const generator = await resolveStationImageGenerator(ctx);

        const service = new SceneKeyframeVideoService({ client, generator, workspaceRoot: ctx.workspaceRoot });
        const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(glbPath);

        const result = await service.synthesizeKeyframeInterpolationVideo({
            mesh,
            startPose,
            endPose,
            prompt,
            width,
            height,
            durationSeconds,
            signal: ctx.signal
        });

        const outVideoPath = `public/models/keyframe_interpolation_${Date.now()}.mp4`;
        const fs = await import('fs-extra');
        await fs.ensureDir('public/models');
        await fs.writeFile(outVideoPath, result.video);

        return {
            resultPayload: {
                videoPath: outVideoPath,
                durationSeconds,
                videoModel: result.videoModel,
                keyframeImageSources: result.imageSources,
                aspectRatio: result.aspectRatio,
                keyframeWidth: result.width,
                keyframeHeight: result.height
            },
            summaryResult: `Keyframe video written to ${outVideoPath}: start and end renders (${result.width}x${result.height}, ${result.aspectRatio}) restyled (${result.imageSources.join(' ')}), video interpolated by ${result.videoModel}.`
        };
    },
    mesh_bake_ai_textures: async (args, ctx) => {
        const glbPath = asString(args.glbPath);
        const stylePrompt = asString(args.stylePrompt);
        const width = typeof args.width === 'number' ? args.width : 512;
        const height = typeof args.height === 'number' ? args.height : 512;
        if (!glbPath) throw new MissingInputError('mesh_bake_ai_textures', 'glbPath');
        if (!stylePrompt) throw new MissingInputError('mesh_bake_ai_textures', 'stylePrompt');

        const { MeshAiTextureBakingService } = await import('../../spatial/MeshAiTextureBakingService');
        const workspaceRoot = ctx.workspaceRoot || process.cwd();
        const outGlbPath = asString(args.outGlbPath)
            || path.join(workspaceRoot, 'public', 'models', `baked_${path.basename(glbPath, path.extname(glbPath))}_${Date.now()}.glb`);
        const generator = await resolveStationImageGenerator(ctx);
        const service = new MeshAiTextureBakingService({ generator, workspaceRoot });
        const result = await service.bakeMeshTexturesWithAi({
            glbPath,
            stylePrompt,
            width,
            height,
            outGlbPath,
            resolution: typeof args.resolution === 'number' ? args.resolution : undefined,
            signal: ctx.signal,
            onProgress: (message, fraction) => ctx.reportProgress?.(message, fraction)
        });

        const covered = result.metrics.coveredMeshTexels;
        const unseen = covered > 0 ? (result.unobservedTexels / covered) * 100 : 0;
        return {
            resultPayload: {
                outGlbPath: result.outGlbPath,
                bakedViews: result.views.map(v => v.name),
                rejectedViews: result.rejectedViews,
                stylePrompt,
                coveredMeshTexels: covered,
                unobservedTexels: result.unobservedTexels,
                stationContributions: result.metrics.stationContributions,
                modelsUsed: result.modelsUsed,
                imageSources: result.imageSources
            },
            summaryResult: `Textured ${glbPath} from ${result.views.length} restyled view(s) (${result.views.map(v => v.name).join(', ')}) to match "${stylePrompt}" -> ${result.outGlbPath}. `
                + `Every primitive was painted; ${unseen.toFixed(1)}% of the covered texels were seen by no view and keep the mesh's own colour.`
                + (result.rejectedViews.length ? ` Left out: ${result.rejectedViews.map(v => `${v.name} (${v.reason})`).join('; ')}.` : '')
                + ` ${result.imageSources.join(' ')}`
        };
    },
    panorama_audit_quality: async (args, _ctx) => {
        const inputImagePath = asString(args.inputImagePath);
        if (!inputImagePath) throw new Error('panorama_audit_quality: "inputImagePath" argument is required.');
        const maxMeridianRms = typeof args.maxAllowedMeridianRms === 'number' ? args.maxAllowedMeridianRms : undefined;
        const maxZenithStdDev = typeof args.maxAllowedPolarStdDev === 'number' ? args.maxAllowedPolarStdDev : undefined;
        const maxZenithMeridianDiscontinuity = typeof args.maxAllowedDiscontinuity === 'number' ? args.maxAllowedDiscontinuity : undefined;

        const result = await auditPanoramaQuality({
            inputImagePath,
            maxMeridianRms,
            maxZenithStdDev,
            maxZenithMeridianDiscontinuity
        });

        return {
            resultPayload: {
                pass: result.pass,
                qualityScore: result.qualityScore,
                metrics: result.metrics,
                violations: result.violations,
                remediationHints: result.remediationHints,
                summary: result.summary
            },
            summaryResult: result.summary
        };
    },

    panorama_heal_seam: async (args, ctx) => {
        const inputImagePath = asString(args.inputImagePath);
        if (!inputImagePath) throw new Error('panorama_heal_seam: "inputImagePath" argument is required.');
        const prompt = asString(args.prompt) || undefined;
        const seamWidth = typeof args.seamWidth === 'number' ? args.seamWidth : undefined;
        const outputImagePath = asString(args.outputImagePath) || undefined;
        const model = asString(args.model) || undefined;

        const result = await healPanoramaSeam({
            inputImagePath,
            prompt,
            seamWidth,
            outputImagePath,
            model,
            maxModelUpscale: typeof args.maxModelUpscale === 'number' ? args.maxModelUpscale : undefined,
            signal: ctx?.signal
        });

        return {
            resultPayload: {
                success: result.success,
                width: result.width,
                height: result.height,
                seamWidth: result.seamWidth,
                outputImagePath: result.outputImagePath,
                modelUsed: result.modelUsed,
                skippedModels: result.skippedModels,
                modelNote: result.modelNote,
                summary: result.summary
            } as unknown as ToolResultPayload,
            summaryResult: result.summary
        };
    },

    panorama_inpaint: async (args, ctx) => {
        const inputImagePath = asString(args.inputImagePath);
        if (!inputImagePath) throw new Error('panorama_inpaint: "inputImagePath" argument is required.');
        const maskImagePath = asString(args.maskImagePath) || undefined;
        const nadirOnly = typeof args.nadirOnly === 'boolean' ? args.nadirOnly : undefined;
        const nadirRatio = typeof args.nadirRatio === 'number' ? args.nadirRatio : undefined;
        const ceilingOnly = typeof args.ceilingOnly === 'boolean' ? args.ceilingOnly : undefined;
        const ceilingRatio = typeof args.ceilingRatio === 'number' ? args.ceilingRatio : undefined;
        const inpaintBothPolar = typeof args.inpaintBothPolar === 'boolean' ? args.inpaintBothPolar : undefined;
        const prompt = asString(args.prompt) || undefined;
        const outputImagePath = asString(args.outputImagePath) || undefined;
        const model = asString(args.model) || undefined;

        const result = await inpaintPanorama({
            inputImagePath,
            maskImagePath,
            nadirOnly,
            nadirRatio,
            ceilingOnly,
            ceilingRatio,
            inpaintBothPolar,
            prompt,
            outputImagePath,
            model,
            maxModelUpscale: typeof args.maxModelUpscale === 'number' ? args.maxModelUpscale : undefined,
            signal: ctx?.signal
        });

        return {
            resultPayload: {
                success: result.success,
                width: result.width,
                height: result.height,
                outputImagePath: result.outputImagePath,
                modelUsed: result.modelUsed,
                skippedModels: result.skippedModels,
                modelNote: result.modelNote,
                summary: result.summary
            } as unknown as ToolResultPayload,
            summaryResult: result.summary
        };
    },

    panorama_generate_360: async (args, ctx) => {
        let prompt = args.prompt;
        const structuredPrompt = typeof args.structuredPrompt === 'object' && args.structuredPrompt !== null
            ? args.structuredPrompt as any
            : undefined;

        if (!prompt && !structuredPrompt) {
            throw new Error('panorama_generate_360: "prompt" or "structuredPrompt" argument is required.');
        }

        const style = asString(args.style) || undefined;
        const width = typeof args.width === 'number' ? args.width : undefined;
        const height = typeof args.height === 'number' ? args.height : undefined;
        const healSeam = typeof args.healSeam === 'boolean' ? args.healSeam : undefined;
        const inpaintNadir = typeof args.inpaintNadir === 'boolean' ? args.inpaintNadir : undefined;
        const outputImagePath = asString(args.outputImagePath) || undefined;
        const model = asString(args.model) || undefined;
        const invertSphericalCurvature = typeof args.invertSphericalCurvature === 'boolean' ? args.invertSphericalCurvature : undefined;

        const result = await generate360Panorama({
            prompt: (prompt as any) || structuredPrompt,
            structuredPrompt,
            style,
            width,
            height,
            healSeam,
            inpaintNadir,
            outputImagePath,
            model,
            invertSphericalCurvature,
            maxModelUpscale: typeof args.maxModelUpscale === 'number' ? args.maxModelUpscale : undefined,
            signal: ctx?.signal
        });

        return {
            resultPayload: {
                success: result.success,
                width: result.width,
                height: result.height,
                seamHealed: result.seamHealed,
                outputImagePath: result.outputImagePath,
                modelUsed: result.modelUsed,
                skippedModels: result.skippedModels,
                modelNote: result.modelNote,
                structuredPrompt: result.structuredPrompt,
                summary: result.summary
            } as unknown as ToolResultPayload,
            summaryResult: result.summary
        };
    },

    panorama_generate_4k: async (args, ctx) => {
        const prompt = asString(args.prompt);
        if (!prompt) throw new Error('panorama_generate_4k: "prompt" argument is required.');

        const style = asString(args.style) || undefined;
        const width = typeof args.width === 'number' ? args.width : 4096;
        const height = typeof args.height === 'number' ? args.height : 2048;
        const seamEqualization = (args.seamEqualization === 'linear_smoothstep' || args.seamEqualization === 'none')
            ? args.seamEqualization
            : 'laplacian_2band';
        const seamWidth = typeof args.seamWidth === 'number' ? args.seamWidth : undefined;
        const enablePolarCaps = typeof args.enablePolarCaps === 'boolean' ? args.enablePolarCaps : false;
        const enforcePolarSingularity = typeof args.enforcePolarSingularity === 'boolean' ? args.enforcePolarSingularity : true;
        const outputImagePath = asString(args.outputImagePath) || undefined;
        const model = asString(args.model) || undefined;

        const result = await generate4KMonumentalPanorama({
            prompt,
            style,
            width,
            height,
            seamEqualization,
            seamWidth,
            enablePolarCaps,
            enforcePolarSingularity,
            outputImagePath,
            model,
            signal: ctx?.signal
        });

        return {
            resultPayload: {
                success: result.success,
                width: result.width,
                height: result.height,
                seamEqualized: result.seamEqualized,
                polarCapsRemoved: result.polarCapsRemoved,
                polarSingularityCollapsed: result.polarSingularityCollapsed,
                qualityScore: result.qualityScore,
                qcPass: result.qcReport.pass,
                metrics: result.qcReport.metrics,
                outputImagePath: result.outputImagePath,
                modelUsed: result.modelUsed,
                skippedModels: result.skippedModels,
                modelNote: result.modelNote,
                structuredPrompt: result.structuredPrompt,
                summary: result.summary
            } as unknown as ToolResultPayload,
            summaryResult: result.summary
        };
    },

    panorama_reproject_zenith: async (args, _ctx) => {
        const baseImagePath = asString(args.baseImagePath);
        if (!baseImagePath) throw new Error('panorama_reproject_zenith: "baseImagePath" argument is required.');
        const patchImagePath = asString(args.patchImagePath);
        if (!patchImagePath) throw new Error('panorama_reproject_zenith: "patchImagePath" argument is required.');

        const outputImagePath = asString(args.outputImagePath) || undefined;
        const fovDegrees = typeof args.fovDegrees === 'number' ? args.fovDegrees : undefined;
        const headingDegrees = typeof args.headingDegrees === 'number' ? args.headingDegrees : undefined;
        const blendInnerRadius = typeof args.blendInnerRadius === 'number' ? args.blendInnerRadius : undefined;
        const blendOuterRadius = typeof args.blendOuterRadius === 'number' ? args.blendOuterRadius : undefined;
        const matchIllumination = typeof args.matchIllumination === 'boolean' ? args.matchIllumination : undefined;

        const result = await reprojectZenithPanorama({
            baseImagePath,
            patchImagePath,
            outputImagePath,
            fovDegrees,
            headingDegrees,
            blendInnerRadius,
            blendOuterRadius,
            matchIllumination,
            auditQuality: true
        });

        return {
            resultPayload: {
                success: result.success,
                width: result.width,
                height: result.height,
                outputImagePath: result.outputImagePath,
                qualityAudit: result.qualityAudit,
                summary: result.summary
            },
            summaryResult: result.summary
        };
    },

    panorama_extract_zenith: async (args, _ctx) => {
        const inputImagePath = asString(args.inputImagePath);
        if (!inputImagePath) throw new Error('panorama_extract_zenith: "inputImagePath" argument is required.');
        const outputImagePath = asString(args.outputImagePath) || undefined;
        const fovDegrees = typeof args.fovDegrees === 'number' ? args.fovDegrees : 90;
        const patchResolution = typeof args.patchResolution === 'number' ? args.patchResolution : 1024;

        const fs = await import('fs/promises');
        const path = await import('path');
        const { decodePng, encodePng } = await import('../../texture-processing');

        const fileBuf = await fs.readFile(inputImagePath);
        const dec = decodePng(fileBuf);
        const patchRgba = extractZenithRectilinearPatch(dec.rgba, dec.width, dec.height, {
            fovDegrees,
            patchResolution
        });

        const patchPng = encodePng(patchResolution, patchResolution, patchRgba);
        if (outputImagePath) {
            await fs.mkdir(path.dirname(outputImagePath), { recursive: true });
            await fs.writeFile(outputImagePath, patchPng);
        }

        return {
            resultPayload: {
                success: true,
                patchResolution,
                fovDegrees,
                outputImagePath
            },
            summaryResult: `Extracted ${patchResolution}x${patchResolution} zenith rectilinear patch (FOV: ${fovDegrees}°) from ${inputImagePath}`
        };
    },

    panorama_to_3dgs: async (args, ctx) => {
        const inputImagePath = asString(args.inputImagePath);
        if (!inputImagePath) throw new Error('panorama_to_3dgs: "inputImagePath" argument is required.');

        const sceneType = (args.sceneType === 'indoor' || args.sceneType === 'outdoor') ? args.sceneType : 'outdoor';
        // Unknown for AI panoramas: infer from the metric floor unless the caller knows the rig height
        const eyeHeightArg: number | 'auto' = typeof args.eyeHeight === 'number' ? args.eyeHeight : 'auto';
        const radius = typeof args.radius === 'number' ? args.radius : 1.25;
        const numPoses = typeof args.numPoses === 'number' ? args.numPoses : 6;
        const voxelSize = typeof args.voxelSize === 'number' ? args.voxelSize : 0.04;
        const skipOffsets = typeof args.skipOffsets === 'boolean' ? args.skipOffsets : false;
        // The depth model and the disocclusion inpainting always run for real here; their mock modes are for service tests.
        const mockExecution = false;
        const prompt = asString(args.prompt) || undefined;
        const model = asString(args.model) || undefined;
        const maxModelUpscale = typeof args.maxModelUpscale === 'number' ? args.maxModelUpscale : undefined;

        // The offset views are inpainted at the panorama's own size: when the image model cannot answer that large
        // within the allowed enlargement, refuse now, before the depth run and before any model call.
        if (!skipOffsets) {
            const fsMod = await import('fs-extra');
            const { readImageDimensions } = await import('../../image-codec-ffmpeg');
            const dims = readImageDimensions(await fsMod.readFile(inputImagePath));
            if (!dims) throw new MissingInputError('panorama_to_3dgs', 'inputImagePath', `the size of ${inputImagePath} cannot be read (PNG, JPEG or WebP expected)`);
            Google360PanoramaPipelineService.editImageSize(dims.width, dims.height, maxModelUpscale);
        }

        console.log(`[panorama_to_3dgs] Launching full end-to-end 3DGS pipeline for ${inputImagePath}`);

        // Step 1: Extract real per-pixel geometry
        const depthService = new PanoramaDepthService();
        const depthRes = await depthService.generatePanoramaDepth(inputImagePath, {
            sceneType,
            eyeHeight: eyeHeightArg,
            mock: mockExecution
        });

        if (!depthRes.success) {
            throw new Error(`Failed to generate depth map for panorama: ${inputImagePath}`);
        }
        const eyeHeight = depthRes.eyeHeight;

        // Step 2: Run multi-perspective offset view synthesis and inpainting
        const offsetService = new OffsetViewSynthesisService();
        const synthesisRes = await offsetService.synthesizeOffsetViews(inputImagePath, depthRes.depthPath, {
            radius,
            numPoses,
            prompt,
            eyeHeight,
            voxelSize,
            skipOffsets,
            mockExecution,
            sceneType,
            model,
            maxModelUpscale,
            signal: ctx?.signal
        });

        return {
            resultPayload: {
                success: synthesisRes.success,
                fusedSplatPath: synthesisRes.fusedSplatPath,
                fusedSpzPath: synthesisRes.fusedSpzPath,
                originalSplatPath: synthesisRes.originalSplatPath,
                numOriginalSplats: synthesisRes.numOriginalSplats,
                numFusedSplats: synthesisRes.numFusedSplats,
                activePoses: synthesisRes.activePoses,
                eyeHeight,
                eyeHeightInferred: depthRes.eyeHeightInferred,
                floorFitApplied: depthRes.floorFitApplied,
                depthScaleCorrection: depthRes.scaleCorrection,
                depthModel: depthRes.modelUsed,
                metaPath: synthesisRes.metaPath
            } as unknown as ToolResultPayload,
            summaryResult: `Built walkable 3DGS world: ${synthesisRes.numFusedSplats} fused Gaussians across ${synthesisRes.activePoses.length + 1} perspectives (original: ${synthesisRes.numOriginalSplats}). Capture height ${eyeHeight.toFixed(2)} m (${depthRes.eyeHeightInferred ? 'measured from the metric floor' : 'supplied'}), depth: ${depthRes.modelUsed}${depthRes.floorFitApplied ? (depthRes.scaleCorrection !== 1 ? `, rescaled ${depthRes.scaleCorrection.toFixed(3)}x to the floor` : '') : ' at the model\'s own scale (too few floor pixels to fit)'}. Wrote .splat, NGSP v2 .spz and .meta.json sidecar.`
        };
    },

    single_image_to_3dgs: async (args, ctx) => {
        const inputImagePath = asString(args.inputImagePath);
        if (!inputImagePath) throw new Error('single_image_to_3dgs: "inputImagePath" argument is required.');

        const fsMod = await import('fs-extra');
        if (!fsMod.existsSync(inputImagePath)) {
            throw new Error(`single_image_to_3dgs: input image does not exist: ${inputImagePath}`);
        }

        const fovGiven = args.fovDegrees !== undefined && args.fovDegrees !== null;
        if (fovGiven && !(typeof args.fovDegrees === 'number' && args.fovDegrees > 1 && args.fovDegrees < 179)) {
            throw new MissingInputError('single_image_to_3dgs', 'fovDegrees', `must be a vertical field of view between 1 and 179 degrees (got ${JSON.stringify(args.fovDegrees)})`);
        }
        const fovDegrees = fovGiven ? (args.fovDegrees as number) : 65.0;
        const sceneType = args.sceneType === 'indoor' ? 'indoor' : 'outdoor';
        const stride = typeof args.stride === 'number' ? Math.max(1, Math.round(args.stride)) : 2;
        const minDepth = typeof args.minDepth === 'number' ? args.minDepth : 0.2;
        const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : 150.0;

        const pathMod = await import('path');
        const childProcess = await import('child_process');
        const osMod = await import('os');
        const { decodePng } = await import('../../texture-processing');
        const { ImageToSplatService } = await import('../../3d-engine/image-to-splat-service');
        const { SplatService } = await import('../../3d-engine/splat-service');

        const workspaceRoot = ctx?.workspaceRoot || process.cwd();
        const baseName = pathMod.basename(inputImagePath, pathMod.extname(inputImagePath));
        const ext = pathMod.extname(inputImagePath).toLowerCase();

        let pngBuf: Buffer;
        if (ext === '.png') {
            pngBuf = await fsMod.readFile(inputImagePath);
        } else {
            const tmpPng = pathMod.join(osMod.tmpdir(), `s4d_splat_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
            childProcess.execFileSync('ffmpeg', ['-y', '-i', inputImagePath, tmpPng], { stdio: 'pipe' });
            pngBuf = await fsMod.readFile(tmpPng);
            try { await fsMod.unlink(tmpPng); } catch {}
        }

        const decoded = decodePng(pngBuf);
        // Depth from the depth model, or the call fails (GeneratorFailedError); no depth is guessed from the pixels.
        const depth = await new PanoramaDepthService().generateImageDepth(inputImagePath, {
            sceneType,
            outDir: pathMod.join(osMod.tmpdir(), 'sbx-image-depth')
        });
        if (depth.width !== decoded.width || depth.height !== decoded.height) {
            throw new GeneratorFailedError('python', `the depth map is ${depth.width}x${depth.height}, but ${inputImagePath} decodes to ${decoded.width}x${decoded.height}`);
        }
        const metricDepths = ImageToSplatService.planarToRayDepths(depth.depths, decoded.width, decoded.height, fovDegrees);
        const splats = ImageToSplatService.convertSingleImageToSplat({
            rgbPixels: new Uint8Array(decoded.rgba),
            width: decoded.width,
            height: decoded.height,
            channels: 4,
            metricDepths,
            fovDegrees,
            stride,
            minDepth,
            maxDepth
        });
        if (splats.length === 0) {
            throw new GeneratorFailedError('python', `no pixel of ${inputImagePath} has a depth between ${minDepth} and ${maxDepth} m (the model measured ${depth.minDepth.toFixed(2)}-${depth.maxDepth.toFixed(2)} m)`);
        }

        const splatBuffer = SplatService.serializeSplatBuffer(splats);
        const spzBuffer = SplatService.serializeSpzBuffer(splats);

        const targetDir = asString(args.outDir) || pathMod.join(workspaceRoot, 'public', 'splats');
        await fsMod.mkdirp(targetDir);

        const splatPath = pathMod.join(targetDir, `${baseName}.splat`);
        const spzPath = pathMod.join(targetDir, `${baseName}.spz`);

        await fsMod.writeFile(splatPath, splatBuffer);
        await fsMod.writeFile(spzPath, spzBuffer);

        const splatUrl = `/splats/${baseName}.splat`;
        const spzUrl = `/splats/${baseName}.spz`;

        return {
            resultPayload: {
                success: true,
                splatPath,
                spzPath,
                splatUrl,
                spzUrl,
                splatCount: splats.length,
                width: decoded.width,
                height: decoded.height,
                fovDegrees,
                fovAssumed: !fovGiven,
                depthModel: depth.modelUsed,
                depthRangeMeters: [depth.minDepth, depth.maxDepth],
                depthPath: depth.depthPath,
                suggestedScene3DData: {
                    splatUrl,
                    camera: {
                        position: [0, 1.6, 0],
                        target: [0, 1.6, -5]
                    }
                }
            } as unknown as ToolResultPayload,
            summaryResult: `Built ${splats.length.toLocaleString()} 3D Gaussian splats from ${inputImagePath} with depth from ${depth.modelUsed} (${depth.minDepth.toFixed(2)}-${depth.maxDepth.toFixed(2)} m), ${fovGiven ? `vertical FOV ${fovDegrees} deg` : 'an assumed vertical FOV of 65 deg (pass fovDegrees for the real lens)'}. Saved .splat (${(splatBuffer.length / 1024 / 1024).toFixed(2)} MB) and .spz (${(spzBuffer.length / 1024 / 1024).toFixed(2)} MB) to ${splatPath}.`
        };
    },

    splat_to_3dtiles: async (args, _ctx) => {
        const inputPath = asString(args.inputPath);
        if (!inputPath) throw new Error('splat_to_3dtiles: "inputPath" argument is required.');
        const pathMod = await import('path');
        const outDir = asString(args.outDir) || pathMod.resolve(process.cwd(), 'build/splat_tiles', pathMod.basename(inputPath).replace(/\.(splat|spz)$/i, ''));
        const hasOrigin = typeof args.latitude === 'number' && typeof args.longitude === 'number';

        const service = new Splat3DTilesService();
        const res = await service.convert({
            inputPath,
            outDir,
            origin: hasOrigin ? { lat: args.latitude as number, lng: args.longitude as number, alt: typeof args.altitude === 'number' ? args.altitude : 0 } : undefined,
            headingDeg: typeof args.headingDeg === 'number' ? args.headingDeg : 0,
            maxDepth: typeof args.maxDepth === 'number' ? args.maxDepth : undefined,
            leafCapacity: typeof args.leafCapacity === 'number' ? args.leafCapacity : undefined,
            interiorBudget: typeof args.interiorBudget === 'number' ? args.interiorBudget : undefined
        });
        if (!res.success) throw new Error(`splat_to_3dtiles failed: ${res.error}`);

        return {
            resultPayload: {
                success: true,
                tilesetPath: res.tilesetPath,
                tileCount: res.tileCount,
                levels: res.levels,
                numSplats: res.numSplats,
                tileBytes: res.tileBytes,
                geodeticallyPlaced: !!res.rootTransform,
                durationMs: res.durationMs
            } as unknown as ToolResultPayload,
            summaryResult: `Tiled ${res.numSplats.toLocaleString()} splats into ${res.tileCount} KHR_gaussian_splatting tiles (${res.levels} LOD levels, ${(res.tileBytes / 1048576).toFixed(1)} MB) in ${res.durationMs} ms${res.rootTransform ? ', placed on WGS-84' : ' (local metres)'}. tileset.json: ${res.tilesetPath}`
        };
    },

    plan_adaptive_survey_rig: async (args, _ctx) => {
        const api = new SurveyApi({ workspaceRoot: process.cwd() });
        const res = await api.planAdaptive({
            glbPath: asString(args.glbPath),
            anchor: { lat: args.latitude, lng: args.longitude, elevationMeters: args.elevationMeters, headingDeg: typeof args.headingDeg === 'number' ? args.headingDeg : 0 },
            cameraBudget: typeof args.cameraBudget === 'number' ? args.cameraBudget : undefined,
            targetResolutionMm: typeof args.targetResolutionMm === 'number' ? args.targetResolutionMm : undefined,
            mode: asString(args.mode) as any,
            focalLengthMm: typeof args.focalLengthMm === 'number' ? args.focalLengthMm : undefined,
            minGroundClearanceMeters: typeof args.minGroundClearanceMeters === 'number' ? args.minGroundClearanceMeters : undefined,
            standoffMeters: typeof args.standoffMeters === 'number' ? args.standoffMeters : undefined,
            focusCentroid: Array.isArray(args.focusCentroid) && args.focusCentroid.length === 3 ? (args.focusCentroid as [number, number, number]) : undefined,
            cropRadius: typeof args.cropRadius === 'number' ? args.cropRadius : undefined
        });
        const outJsonPath = asString(args.outJsonPath);
        if (outJsonPath) {
            const fsMod = await import('fs-extra');
            await fsMod.outputJson(outJsonPath, res.poses, { spaces: 2 });
        }
        return {
            resultPayload: {
                success: true,
                stationCount: res.poses.length,
                obb: res.obb,
                groundDatumY: res.groundDatumY,
                standoffMeters: res.standoffMeters,
                tiers: res.tiers,
                stats: res.stats,
                outJsonPath: outJsonPath || undefined,
                stations: res.poses.map(p => ({
                    id: p.id,
                    name: p.name,
                    yaw: p.yawDegrees,
                    pitch: p.pitchDegrees,
                    fov: p.fovDegrees,
                    positionLocalENU: p.positionLocalENU,
                    maxDepth: (p as any).maxDepth,
                    dropSky: (p as any).dropSky
                }))
            } as unknown as ToolResultPayload,
            summaryResult: `Adaptive Rig planned ${res.poses.length} stations across ${res.tiers.length} tiers. Ground datum: ${res.groundDatumY.toFixed(1)}m. Structure size: [${res.obb.dimensions.map(d => d.toFixed(1)).join(' x ')}]m. Standoff: ${res.standoffMeters.toFixed(1)}m${outJsonPath ? ` -> ${outJsonPath}` : ''}`
        };
    },

    survey_synthesize_stations: async (args, _ctx) => {
        const api = new SurveyApi({ workspaceRoot: process.cwd() });
        const res = await api.synthesize({
            anchor: { lat: args.latitude, lng: args.longitude, elevationMeters: args.elevationMeters, headingDeg: typeof args.headingDeg === 'number' ? args.headingDeg : 0 },
            config: {
                type: asString(args.pattern), targetRadiusMeters: args.radiusMeters, cameraCount: args.cameraCount,
                focalLengthMm: typeof args.focalLengthMm === 'number' ? args.focalLengthMm : 35,
                cameraHeightMeters: typeof args.cameraHeightMeters === 'number' ? args.cameraHeightMeters : undefined,
                lookAtOffsetLocalENU: Array.isArray(args.lookAtOffsetLocalENU) && args.lookAtOffsetLocalENU.length === 3 ? args.lookAtOffsetLocalENU : undefined,
                corridorHeadingDeg: typeof args.headingDeg === 'number' ? args.headingDeg : undefined
            },
            glbPath: asString(args.glbPath) || undefined,
            isoDate: asString(args.isoDate) || undefined,
            rankMaxCount: typeof args.rankMaxCount === 'number' ? args.rankMaxCount : undefined
        });
        const outJsonPath = asString(args.outJsonPath);
        if (outJsonPath) {
            const fsMod = await import('fs-extra');
            await fsMod.outputJson(outJsonPath, { anchor: res.anchor, poses: res.poses, rankedStationIds: res.rankedStationIds }, { spaces: 2 });
        }
        return {
            resultPayload: { success: true, stationCount: res.poses.length, enriched: res.enriched, rankedStationIds: res.rankedStationIds, stats: res.stats, outJsonPath: outJsonPath || undefined, stations: res.poses.map(p => ({ id: p.id, name: p.name, yaw: p.yawDegrees, pitch: p.pitchDegrees, fov: p.fovDegrees, positionLocalENU: p.positionLocalENU, wgs84: p.coordinatesWGS84, beautify: p.beautify })) } as unknown as ToolResultPayload,
            summaryResult: `Synthesized ${res.poses.length} ${asString(args.pattern)} stations (radius ${res.stats.boundingRadiusMeters} m)${res.enriched ? ', enriched against the mesh' : ''}${res.rankedStationIds ? `; best for beautify: [${res.rankedStationIds.join(', ')}]` : ''}${outJsonPath ? ` -> ${outJsonPath}` : ''}`
        };
    },

    survey_rank_stations: async (args, _ctx) => {
        const fsMod = await import('fs-extra');
        const data = await fsMod.readJson(asString(args.stationsJsonPath));
        const api = new SurveyApi({ workspaceRoot: process.cwd() });
        const res = api.rank({ poses: data.poses, maxCount: args.maxCount, minMeshCoverage: args.minMeshCoverage, maxSkyFraction: args.maxSkyFraction });
        return {
            resultPayload: { success: true, rankedStationIds: res.rankedStationIds, ranked: res.ranked.map(p => ({ id: p.id, name: p.name, rankScore: p.beautify?.rankScore, skyFraction: p.beautify?.skyFraction, meshCoverage: p.beautify?.meshCoverageFraction })) } as unknown as ToolResultPayload,
            summaryResult: `Ranked ${res.ranked.length} of ${data.poses.length} stations for beautify: [${res.rankedStationIds.join(', ')}]`
        };
    },

    survey_export_colmap: async (args, _ctx) => {
        const fsMod = await import('fs-extra');
        const pathMod = await import('path');
        const data = await fsMod.readJson(asString(args.stationsJsonPath));
        const api = new SurveyApi({ workspaceRoot: process.cwd() });
        const out = api.exportColmap({ poses: data.poses, width: args.width, height: args.height });
        const outDir = asString(args.outDir);
        await fsMod.outputFile(pathMod.join(outDir, 'cameras.txt'), out.camerasText);
        await fsMod.outputFile(pathMod.join(outDir, 'images.txt'), out.imagesText);
        return {
            resultPayload: { success: true, camerasPath: pathMod.join(outDir, 'cameras.txt'), imagesPath: pathMod.join(outDir, 'images.txt'), stationCount: data.poses.length } as unknown as ToolResultPayload,
            summaryResult: `Exported ${data.poses.length} stations as COLMAP text to ${outDir}`
        };
    },

    survey_render_station: async (args, _ctx) => {
        const fsMod = await import('fs-extra');
        const data = await fsMod.readJson(asString(args.stationsJsonPath));
        const station = (data.poses as any[]).find(p => p.id === args.stationId);
        if (!station) throw new Error(`survey_render_station: station ${args.stationId} not found in ${args.stationsJsonPath}`);
        const api = new SurveyApi({ workspaceRoot: process.cwd() });
        const res = await api.renderStation({ glbPath: asString(args.glbPath), station, width: typeof args.width === 'number' ? args.width : 1920, outPath: asString(args.outPngPath) });
        return {
            resultPayload: { success: true, stationId: res.stationId, width: res.width, height: res.height, intrinsics: res.intrinsics, depthKind: res.depthKind, depthStats: res.depthStats, outPngPath: asString(args.outPngPath) } as unknown as ToolResultPayload,
            summaryResult: `Rendered station ${res.stationId} blockout ${res.width}x${res.height} (fx ${res.intrinsics.fx.toFixed(1)} px, ${(res.depthStats.filledFraction * 100).toFixed(0)}% mesh coverage) -> ${asString(args.outPngPath)}`
        };
    },

    survey_beautify_station: async (args, ctx) => {
        const fsMod = await import('fs-extra');
        const data = await fsMod.readJson(asString(args.stationsJsonPath));
        const station = (data.poses as any[]).find(p => p.id === args.stationId);
        if (!station) throw new Error(`survey_beautify_station: station ${args.stationId} not found`);
        const generator = await resolveStationImageGenerator(ctx);
        const { registerBeautifyHandlers } = await import('../../spatial/survey-router');
        const deps = registerBeautifyHandlers({}, generator, process.cwd());
        const res = await deps.beautifyStation!({ ...args, station, anchor: data.anchor, glbPath: asString(args.glbPath), signal: ctx.signal }, chatProgress(ctx));
        const { imageBase64, ...rest } = res;
        return {
            resultPayload: { success: true, ...rest } as unknown as ToolResultPayload,
            summaryResult: `Station ${res.stationId} ${res.accepted ? 'accepted' : 'rejected (' + res.qc.reason + ')'} after ${res.attempts} attempt(s): yaw drift ${res.qc.deltaYawDeg.toFixed(2)} deg -> ${res.imagePath}. ${res.imageSource}`
        };
    },

    survey_beautify_to_splats: async (args, ctx) => {
        const fsMod = await import('fs-extra');
        const data = await fsMod.readJson(asString(args.stationsJsonPath));
        const generator = await resolveStationImageGenerator(ctx);
        const { registerBeautifyHandlers } = await import('../../spatial/survey-router');
        const deps = registerBeautifyHandlers({}, generator, process.cwd());
        // ctx.signal (the chat's Stop or the time limit) goes down to every station's image-model call and the baker.
        const res = await deps.beautifyToSplats!({ ...args, stations: data.poses, anchor: data.anchor, glbPath: asString(args.glbPath), signal: ctx.signal }, chatProgress(ctx));
        const accepted = res.stations.filter((s: any) => s.accepted).length;
        const imageSources = Array.from(new Set(res.stations.map((s: any) => s.imageSource).filter(Boolean))) as string[];
        return {
            resultPayload: { success: true, tilesetPath: res.tilesetPath, tilesetUrl: res.tilesetUrl, metaPath: res.metaPath, fusedSplatCount: res.fusedSplatCount, acceptedStations: accepted, totalStations: res.stations.length, cropBox: res.cropBox, durationMs: res.durationMs, imageSources } as unknown as ToolResultPayload,
            summaryResult: `Beautified ${accepted}/${res.stations.length} stations, baked ${res.fusedSplatCount.toLocaleString()} fused splats into a 3D Tiles tileset in ${(res.durationMs / 1000).toFixed(0)} s -> ${res.tilesetPath}. ${imageSources.join(' ')}`
        };
    },

    survey_beautify_to_texture: async (args, ctx) => {
        const fsMod = await import('fs-extra');
        const pathMod = await import('path');
        const tool = 'survey_beautify_to_texture';
        const stationsJsonPath = asString(args.stationsJsonPath);
        const glbPath = asString(args.glbPath);
        const locationName = asString(args.locationName);
        if (!glbPath) throw new MissingInputError(tool, 'glbPath');
        if (!(await fsMod.pathExists(glbPath))) throw new MissingInputError(tool, 'glbPath', `${glbPath} does not exist`);
        if (!stationsJsonPath) throw new MissingInputError(tool, 'stationsJsonPath', 'the stations JSON written by survey_synthesize_stations');
        if (!(await fsMod.pathExists(stationsJsonPath))) throw new MissingInputError(tool, 'stationsJsonPath', `${stationsJsonPath} does not exist`);
        if (!locationName) throw new MissingInputError(tool, 'locationName', 'the stations are generated for a named place; no placeholder name is used');
        const data = await fsMod.readJson(stationsJsonPath);
        const stations = data.poses || data.stations;
        if (!Array.isArray(stations) || stations.length === 0) throw new MissingInputError(tool, 'stationsJsonPath', `${stationsJsonPath} lists no stations`);
        const generator = await resolveStationImageGenerator(ctx);
        const { SurveyTextureUnprojector } = await import('../../spatial/SurveyTextureUnprojector');

        const resolution = typeof args.resolution === 'number' ? args.resolution : 4096;
        const outGlbPath = asString(args.outGlbPath) || pathMod.join(ctx.workspaceRoot || process.cwd(), 'public', 'models', `survey_pbr_${Date.now()}.glb`);
        // De-lighting needs the sun the images were lit by: the stations' anchor and the date the caller gives. The
        // run's own clock is not that date, so without one (or without anchor coordinates) nothing is de-lit.
        const lat = typeof data.anchor?.lat === 'number' ? data.anchor.lat : undefined;
        const lng = typeof data.anchor?.lng === 'number' ? data.anchor.lng : undefined;
        const isoDate = asString(args.isoDate) || undefined;
        const delightRequested = lat !== undefined && lng !== undefined && isoDate !== undefined;

        const result = await SurveyTextureUnprojector.processGlbWithSurveyStations({
            glbPath,
            anchor: data.anchor,
            stations,
            generator,
            beautifyContext: {
                locationName,
                moodPromptContext: asString(args.moodPromptContext),
                styleSuffix: asString(args.styleSuffix)
            },
            options: {
                resolution,
                depthTolerance: typeof args.depthTolerance === 'number' ? args.depthTolerance : 0.20,
                minCosIncidence: typeof args.minCosIncidence === 'number' ? args.minCosIncidence : 0.08,
                solarDelighting: delightRequested ? { lat, lng, isoDate } : undefined,
                outGlbPath
            },
            onProgress: (message, fraction) => ctx.reportProgress?.(message, fraction),
            signal: ctx.signal
        });
        const delit = (result.submeshes || []).some(sub => sub.solarDelightingApplied === true);
        const delightNote = delit
            ? `with NOAA solar de-lighting for ${isoDate} at ${lat}, ${lng}`
            : `without solar de-lighting (${delightRequested ? 'the PBR decomposition did not apply it' : `it needs ${isoDate === undefined ? 'the isoDate the images depict' : 'anchor coordinates in the stations file'}`})`;

        return {
            resultPayload: {
                success: result.success,
                outGlbPath: result.outGlbPath,
                resolution: result.metrics.resolution,
                fillRate: result.metrics.fillRate,
                coveredMeshTexels: result.metrics.coveredMeshTexels,
                directlyPaintedTexels: result.metrics.directlyPaintedTexels,
                stationContributions: result.metrics.stationContributions,
                durationMs: result.metrics.durationMs,
                solarDelightingApplied: delit,
                modelsUsed: result.modelsUsed,
                imageSources: result.imageSources,
                rejectedStations: result.rejectedStations,
                unobservedTexels: result.unobservedTexels
            } as unknown as ToolResultPayload,
            summaryResult: `Unprojected ${result.metrics.stationContributions.length} survey stations into ${resolution}x${resolution} UV atlas (${(result.metrics.fillRate * 100).toFixed(1)}% fill) ${delightNote}, with PBR maps -> ${result.outGlbPath}.`
                + (result.rejectedStations.length ? ` Left out ${result.rejectedStations.length} station(s) whose image failed geometry QC (${result.rejectedStations.map(r => `${r.stationId}: ${r.reason}`).join('; ')}).` : '')
                + (result.unobservedTexels > 0 && result.metrics.coveredMeshTexels > 0 ? ` ${((result.unobservedTexels / result.metrics.coveredMeshTexels) * 100).toFixed(1)}% of the mesh's texels were seen by no station and keep the mesh's own colour.` : '')
                + ` ${result.imageSources.join(' ')}`
        };
    },

    location_generate_3dgs: async (args, ctx) => {
        const { Location3DGaussianSplatService } = await import('../../spatial/Location3DGaussianSplatService');
        const service = new Location3DGaussianSplatService({ workspaceRoot: ctx?.workspaceRoot || process.cwd() });
        // The service throws when the survey pipeline fails; a failed run is never reported as a built splat world.
        const res = await service.generate({
            location: asString(args.location),
            lat: typeof args.lat === 'number' ? args.lat : undefined,
            lng: typeof args.lng === 'number' ? args.lng : undefined,
            elevation: typeof args.elevation === 'number' ? args.elevation : undefined,
            glbPath: asString(args.glbPath) || undefined,
            stylePreset: asString(args.stylePreset) || undefined,
            mood: asString(args.mood) as any,
            cameraCount: typeof args.cameraCount === 'number' ? args.cameraCount : undefined,
            width: typeof args.width === 'number' ? args.width : undefined,
            bakeStride: typeof args.bakeStride === 'number' ? args.bakeStride : undefined,
            outDir: asString(args.outDir) || undefined,
            forceRebake: typeof args.forceRebake === 'boolean' ? args.forceRebake : undefined,
            draft: typeof args.draft === 'boolean' ? args.draft : undefined,
            styleSuffix: typeof args.styleSuffix === 'string' ? args.styleSuffix : undefined,
            onProgress: chatProgress(ctx),
            // The chat's Stop or the time limit ends the run down to the station image-model calls.
            signal: ctx?.signal
        });

        return {
            resultPayload: {
                success: res.success,
                locationName: res.locationName,
                geoAnchor: res.geoAnchor,
                splatUrl: res.splatUrl,
                splatPath: res.splatPath,
                tilesetUrl: res.tilesetUrl,
                tilesetPath: res.tilesetPath,
                splatCount: res.splatCount,
                stationCount: res.stationCount,
                acceptedStations: res.acceptedStations,
                glbPath: res.glbPath,
                cropBox: res.cropBox,
                scene3DData: res.scene3DData,
                durationMs: res.durationMs,
                modelsUsed: res.modelsUsed,
                imageSources: res.imageSources
            } as unknown as ToolResultPayload,
            summaryResult: `Generated a 3DGS radiance field for ${res.locationName}: ${res.splatCount.toLocaleString()} splats from ${res.acceptedStations}/${res.stationCount} accepted station image(s) of the clay tiles ${res.glbPath} in ${(res.durationMs / 1000).toFixed(1)}s -> ${res.splatUrl}. ${res.imageSources.join(' ')}`
        };
    },

    panorama_generate_perspectives: async (args, ctx) => {
        const inputImagePath = asString(args.inputImagePath);
        if (!inputImagePath) throw new Error('panorama_generate_perspectives: "inputImagePath" argument is required.');
        const faceResolution = typeof args.faceResolution === 'number' ? args.faceResolution : undefined;
        const equirectangularWidth = typeof args.equirectangularWidth === 'number' ? args.equirectangularWidth : undefined;
        const equirectangularHeight = typeof args.equirectangularHeight === 'number' ? args.equirectangularHeight : undefined;
        const styleHint = asString(args.styleHint) || undefined;
        const prompt = asString(args.prompt) || undefined;
        const model = asString(args.model) || undefined;
        const outputDir = asString(args.outputDir) || undefined;

        const result = await generate360Perspectives({
            inputImagePath,
            faceResolution,
            equirectangularWidth,
            equirectangularHeight,
            styleHint,
            prompt,
            model,
            outputDir,
            signal: ctx?.signal
        });

        const perspectivesSummary = Object.keys(result.perspectives).map(p => {
            const frame = result.perspectives[p as keyof typeof result.perspectives];
            return `${p.toUpperCase()} (${frame.cameraConfig.yawDeg}°, ${frame.cameraConfig.pitchDeg}°) [${frame.isSynthesized ? 'synthesized' : 'original'}]`;
        }).join(', ');

        return {
            resultPayload: {
                success: result.success,
                perspectivesGenerated: Object.keys(result.perspectives),
                coverageAngleDegrees: result.coverageAngleDegrees,
                stitchedDimensions: `${result.stitchedEquirectangular.width}x${result.stitchedEquirectangular.height}`,
                stitchedOutputPath: result.stitchedEquirectangular.outputPath,
                modelUsed: result.modelUsed,
                skippedModels: result.skippedModels,
                modelNote: result.modelNote,
                summary: `${result.summary} Perspectives: ${perspectivesSummary}`
            } as unknown as ToolResultPayload,
            summaryResult: `${result.summary} Perspectives: ${perspectivesSummary}`
        };
    }
};

// ============================================================================
// UTDRA Declarations & Handlers
// ============================================================================

const UTDRA_INPUT_GLB_PARAMETER: ToolParameterSchema = {
    type: 'STRING',
    description: 'Path on disk to the input .glb tile file (required; the tool fails rather than process a stand-in mesh).'
};

const UTDRA_SPAN_PARAMETER: ToolParameterSchema = {
    type: 'OBJECT',
    description: 'The elevated deck\'s footprint and the heights of the ground under it and of the deck, in the tile\'s own coordinates (metres; read them from utdra_probe_tile bounds or get them from the user). Required.',
    properties: {
        minX: { type: 'NUMBER', description: 'Footprint minimum X.' },
        maxX: { type: 'NUMBER', description: 'Footprint maximum X.' },
        minZ: { type: 'NUMBER', description: 'Footprint minimum Z.' },
        maxZ: { type: 'NUMBER', description: 'Footprint maximum Z.' },
        groundY: { type: 'NUMBER', description: 'Elevation of the ground under the deck.' },
        deckY: { type: 'NUMBER', description: 'Elevation of the deck.' }
    },
    required: ['minX', 'maxX', 'minZ', 'maxZ', 'groundY', 'deckY']
};

export const UTDRA_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'utdra_probe_tile',
        description: 'Measure a 3D tile mesh (.glb) without changing it: bounds, relief (ΔY), surface area, the share of that area by slope band (horizontal < 15°, inclined 15-45°, steep 45-75°, vertical ≥ 75°), the dominant wall orientation, and a vertex-colour green index when the tile has vertex colours. It does not classify the tile or report a confidence; interpret the measurements yourself.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputGlbPath: UTDRA_INPUT_GLB_PARAMETER
            },
            required: ['inputGlbPath']
        }
    },
    {
        name: 'utdra_slice_elevation',
        description: 'Keep the part of a 3D tile mesh above an elevation and remove the rest, clipping triangles that straddle the plane exactly (Sutherland-Hodgman), so no hole opens along the cut. Use it to prune below-ground geometry; a cut above ground also removes the lower parts of buildings.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputGlbPath: UTDRA_INPUT_GLB_PARAMETER,
                cutoffY: {
                    type: 'NUMBER',
                    description: 'Elevation of the cut plane in the tile\'s coordinates (Y axis, metres).'
                },
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path on disk to write the sliced binary .glb file.'
                }
            },
            required: ['inputGlbPath', 'cutoffY']
        }
    },
    {
        name: 'utdra_carve_bridge_voids',
        description: 'Remove the near-vertical triangles (photogrammetric curtain walls) inside a span box you give: the footprint of an elevated deck between the ground under it and the deck. It does not find bridges itself: every near-vertical triangle wholly inside the box is removed, including any building wall that falls inside it, and the count is reported. Geometry outside the box is untouched.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputGlbPath: UTDRA_INPUT_GLB_PARAMETER,
                span: UTDRA_SPAN_PARAMETER,
                minVoidHeightMeters: {
                    type: 'NUMBER',
                    description: 'Optional: refuse a span whose clearance (deckY - groundY) is below this many metres.'
                },
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path on disk to write the carved binary .glb file.'
                }
            },
            required: ['inputGlbPath', 'span']
        }
    }
];

/** The input tile must exist on disk; no benchmark mesh stands in for a missing one. */
async function requireInputGlb(tool: string, value: unknown): Promise<string> {
    const inputGlbPath = asString(value);
    if (!inputGlbPath) {
        throw new MissingInputError(tool, 'inputGlbPath', 'give the path of the .glb to process; no benchmark mesh is substituted');
    }
    const fsMod = await import('fs-extra');
    if (!(await fsMod.pathExists(inputGlbPath))) {
        throw new MissingInputError(tool, 'inputGlbPath', `${inputGlbPath} does not exist`);
    }
    return inputGlbPath;
}

function describeTileMeasurements(t: UtdraTelemetry): string {
    const pct = (f: number) => `${(f * 100).toFixed(1)}%`;
    const b = (v: [number, number, number]) => `[${v.map(n => Number(n.toFixed(2))).join(', ')}]`;
    return `bounds ${b(t.boundsMin)} to ${b(t.boundsMax)}, relief ΔY=${t.reliefMeters.toFixed(2)} m, surface ${t.surfaceAreaM2.toFixed(1)} m², `
        + `area by slope: horizontal ${pct(t.slopeAreaFractions.horizontal)}, inclined ${pct(t.slopeAreaFractions.inclined)}, steep ${pct(t.slopeAreaFractions.steep)}, vertical ${pct(t.slopeAreaFractions.vertical)}`
        + (t.dominantWallYawDeg !== undefined ? `, walls mostly at ${t.dominantWallYawDeg.toFixed(1)}° (mod 90)` : ', no vertical faces')
        + (t.vertexGreenIndex !== undefined ? `, vertex-colour green index ${t.vertexGreenIndex.toFixed(3)}` : ', no vertex colours')
        + `, ${t.outputTriangles} triangles`;
}

export const utdraHandlers: Record<string, ToolHandler> = {
    utdra_probe_tile: async (args, _ctx) => {
        const inputGlbPath = await requireInputGlb('utdra_probe_tile', args.inputGlbPath);
        const telemetry = await new UniversalTileDecompositionService().probeTile(inputGlbPath);
        return {
            resultPayload: {
                success: true,
                mode: 'probe',
                telemetry
            },
            summaryResult: `UTDRA measured ${inputGlbPath}: ${describeTileMeasurements(telemetry)}. These are measurements, not a classification.`
        };
    },

    utdra_slice_elevation: async (args, _ctx) => {
        if (typeof args.cutoffY !== 'number' || !Number.isFinite(args.cutoffY)) {
            throw new MissingInputError('utdra_slice_elevation', 'cutoffY', 'give the elevation of the cut plane in meters');
        }
        const cutoffY = args.cutoffY;
        const inputGlbPath = await requireInputGlb('utdra_slice_elevation', args.inputGlbPath);
        const outputGlbPath = asString(args.outputGlbPath) || undefined;

        const result = await new UniversalTileDecompositionService().sliceElevation(inputGlbPath, cutoffY, { outputGlbPath });
        return {
            resultPayload: {
                success: result.success,
                mode: result.mode,
                telemetry: result.telemetry,
                outputGlbPath: result.outputGlbPath
            },
            summaryResult: `Kept the part of ${inputGlbPath} above y=${cutoffY} m (${result.telemetry.inputTriangles} -> ${result.telemetry.outputTriangles} triangles, straddling triangles clipped). Result: ${describeTileMeasurements(result.telemetry)}. Output GLB: ${result.outputGlbPath}.`
        };
    },

    utdra_carve_bridge_voids: async (args, _ctx) => {
        const inputGlbPath = await requireInputGlb('utdra_carve_bridge_voids', args.inputGlbPath);
        const span = args.span as UtdraSpanBox | undefined;
        const minVoidHeightMeters = typeof args.minVoidHeightMeters === 'number' ? args.minVoidHeightMeters : undefined;
        const outputGlbPath = asString(args.outputGlbPath) || undefined;
        if (!span || typeof span !== 'object') {
            throw new MissingInputError('utdra_carve_bridge_voids', 'span', 'give the deck footprint and heights {minX, maxX, minZ, maxZ, groundY, deckY}; the carver does not find bridges itself');
        }

        const result = await new UniversalTileDecompositionService().carveBridgeUnderpass(inputGlbPath, span, { minVoidHeightMeters, outputGlbPath });
        const removed = result.telemetry.removedTriangles;
        return {
            resultPayload: {
                success: result.success,
                mode: result.mode,
                span,
                removedTriangles: removed,
                telemetry: result.telemetry,
                outputGlbPath: result.outputGlbPath
            },
            summaryResult: removed > 0
                ? `Removed ${removed} near-vertical triangle(s) inside the span x ${span.minX}..${span.maxX}, z ${span.minZ}..${span.maxZ}, y ${span.groundY}..${span.deckY} of ${inputGlbPath} (${result.telemetry.inputTriangles} -> ${result.telemetry.outputTriangles} triangles). Everything outside the span is unchanged. Output GLB: ${result.outputGlbPath}.`
                : `No near-vertical triangle lies wholly inside the span x ${span.minX}..${span.maxX}, z ${span.minZ}..${span.maxZ}, y ${span.groundY}..${span.deckY} of ${inputGlbPath}; nothing was removed (output written unchanged to ${result.outputGlbPath}).`
        };
    }
};

// ============================================================================
// WebXR Geospatial Declarations & Handlers
// ============================================================================

export const WEBXR_GEOSPATIAL_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'webxr_geospatial_align_coordinates',
        description: 'Bidirectionally convert coordinates between WGS-84 geodetic GPS (latitude, longitude, altitude) and WebXR metric space (meters, where +Y is gravity-aligned Up), or convert between compass headings and WebXR quaternions.',
        parameters: {
            type: 'OBJECT',
            properties: {
                originAnchor: {
                    type: 'OBJECT',
                    description: 'Reference geodetic anchor origin',
                    properties: {
                        latitude: { type: 'NUMBER', description: 'Latitude in decimal degrees' },
                        longitude: { type: 'NUMBER', description: 'Longitude in decimal degrees' },
                        altitudeMsl: { type: 'NUMBER', description: 'Optional altitude above mean sea level in meters, only when known. Without it heights are relative to the origin\'s level: no sea-level altitude is reported, and a target altitudeMsl is an error.' }
                    },
                    required: ['latitude', 'longitude']
                },
                targetGeodetic: {
                    type: 'OBJECT',
                    description: 'Optional geodetic coordinate to convert into WebXR metric space',
                    properties: {
                        latitude: { type: 'NUMBER', description: 'Target latitude in decimal degrees' },
                        longitude: { type: 'NUMBER', description: 'Target longitude in decimal degrees' },
                        altitudeMsl: { type: 'NUMBER', description: 'Optional target altitude above mean sea level in meters (needs the origin\'s altitudeMsl). Without it the target is level with the origin.' }
                    },
                    required: ['latitude', 'longitude']
                },
                webXRPosition: {
                    type: 'ARRAY',
                    description: 'Optional WebXR metric [x, y, z] position in meters to inverse-convert into WGS-84 geodetic coordinates',
                    items: { type: 'NUMBER' }
                },
                headingDeg: {
                    type: 'NUMBER',
                    description: 'Optional compass heading in degrees clockwise from True North (0 = North, 90 = East, 180 = South, 270 = West) to convert to a WebXR rotation quaternion'
                },
                quaternion: {
                    type: 'ARRAY',
                    description: 'Optional WebXR orientation quaternion [x, y, z, w] to convert to compass heading in degrees',
                    items: { type: 'NUMBER' }
                },
                headingOffsetDeg: {
                    type: 'NUMBER',
                    description: 'Optional heading calibration offset in degrees (default: 0)'
                },
                translationOffset: {
                    type: 'ARRAY',
                    description: 'Optional translation offset [x, y, z] in meters (default: [0, 0, 0])',
                    items: { type: 'NUMBER' }
                }
            },
            required: ['originAnchor']
        }
    },
    {
        name: 'webxr_geospatial_calibrate',
        description: 'Calibrate geodetic-to-WebXR coordinate alignment via anchor origin, autonomous sensor fusion (device GPS + compass heading + WebXR viewer pose), or optical manual pin to eliminate GPS drift.',
        parameters: {
            type: 'OBJECT',
            properties: {
                originAnchor: {
                    type: 'OBJECT',
                    description: 'Reference geodetic anchor origin',
                    properties: {
                        latitude: { type: 'NUMBER', description: 'Latitude in decimal degrees' },
                        longitude: { type: 'NUMBER', description: 'Longitude in decimal degrees' },
                        altitudeMsl: { type: 'NUMBER', description: 'Optional altitude above mean sea level in meters' }
                    },
                    required: ['latitude', 'longitude']
                },
                mode: {
                    type: 'STRING',
                    description: 'Calibration mode: "anchor-origin" (sets anchor at WebXR 0,0,0 with optional heading), "sensors" (autonomous sensor fusion of GPS + compass + viewer pose), or "manual-pin" (aligns against a known landmark position).'
                },
                headingOffsetDeg: {
                    type: 'NUMBER',
                    description: 'Heading offset in degrees for anchor-origin mode.'
                },
                sensorSample: {
                    type: 'OBJECT',
                    description: 'Sensor data for "sensors" mode',
                    properties: {
                        latitude: { type: 'NUMBER', description: 'Device GPS latitude' },
                        longitude: { type: 'NUMBER', description: 'Device GPS longitude' },
                        altitudeMsl: { type: 'NUMBER', description: 'Device GPS altitude' },
                        accuracyMeters: { type: 'NUMBER', description: 'GPS accuracy in meters' },
                        headingDeg: { type: 'NUMBER', description: 'Compass heading in degrees' }
                    },
                    required: ['latitude', 'longitude']
                },
                viewerPose: {
                    type: 'OBJECT',
                    description: 'WebXR viewer pose for "sensors" mode',
                    properties: {
                        position: {
                            type: 'ARRAY',
                            description: 'Viewer position [x, y, z] in WebXR space',
                            items: { type: 'NUMBER' }
                        },
                        quaternion: {
                            type: 'ARRAY',
                            description: 'Viewer quaternion [x, y, z, w] in WebXR space',
                            items: { type: 'NUMBER' }
                        }
                    },
                    required: ['position']
                },
                contract: {
                    type: 'OBJECT',
                    description: 'Optional GeoAnchorDeploymentContract for manual-pin mode.'
                },
                targetEntityId: {
                    type: 'STRING',
                    description: 'Target ARPlacementEntity id in the deployment contract for manual-pin mode.'
                },
                measuredWebXRPosition: {
                    type: 'ARRAY',
                    description: 'User-observed/pinned WebXR position [x, y, z] in meters for manual-pin mode.',
                    items: { type: 'NUMBER' }
                }
            },
            required: ['originAnchor', 'mode']
        }
    },
    {
        name: 'webxr_geospatial_project_vectors',
        description: 'Project Google Maps Platform road centerlines or parcel boundaries into WebXR 3D metric lines and extruded volume massing coordinates.',
        parameters: {
            type: 'OBJECT',
            properties: {
                originAnchor: {
                    type: 'OBJECT',
                    description: 'Reference geodetic anchor origin',
                    properties: {
                        latitude: { type: 'NUMBER', description: 'Latitude in decimal degrees' },
                        longitude: { type: 'NUMBER', description: 'Longitude in decimal degrees' },
                        altitudeMsl: { type: 'NUMBER', description: 'Optional altitude above mean sea level in meters' }
                    },
                    required: ['latitude', 'longitude']
                },
                roadCorridors: {
                    type: 'ARRAY',
                    description: 'Array of road corridor objects with id, name, type, and coordinatesWGS84',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            id: { type: 'STRING' },
                            name: { type: 'STRING' },
                            type: { type: 'STRING' },
                            coordinatesWGS84: {
                                type: 'ARRAY',
                                items: {
                                    type: 'ARRAY',
                                    items: { type: 'NUMBER' }
                                }
                            }
                        },
                        required: ['id', 'coordinatesWGS84']
                    }
                },
                parcels: {
                    type: 'ARRAY',
                    description: 'Array of parcel objects with id, name, heightMeters, isLandmark, and polygonWGS84',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            id: { type: 'STRING' },
                            name: { type: 'STRING' },
                            heightMeters: { type: 'NUMBER' },
                            isLandmark: { type: 'BOOLEAN' },
                            polygonWGS84: {
                                type: 'ARRAY',
                                items: {
                                    type: 'ARRAY',
                                    items: { type: 'NUMBER' }
                                }
                            }
                        },
                        required: ['id', 'polygonWGS84']
                    }
                }
            },
            required: ['originAnchor']
        }
    }
];

export const webxrGeospatialHandlers: Record<string, ToolHandler> = {
    webxr_geospatial_align_coordinates: (args, _ctx) => {
        const originObj = args.originAnchor as any;
        if (!originObj || typeof originObj.latitude !== 'number' || typeof originObj.longitude !== 'number') {
            throw new Error('webxr_geospatial_align_coordinates: "originAnchor" with latitude and longitude is required.');
        }

        const originAnchor: GeospatialAnchorOrigin = {
            latitude: originObj.latitude,
            longitude: originObj.longitude,
            altitudeMsl: typeof originObj.altitudeMsl === 'number' ? originObj.altitudeMsl : undefined
        };

        const bridge = new WebXRGeospatialAnchorBridge({
            origin: {
                lat: originAnchor.latitude,
                lng: originAnchor.longitude,
                alt: originAnchor.altitudeMsl
            }
        });

        if (typeof args.headingOffsetDeg === 'number') {
            bridge.adjustHeading(args.headingOffsetDeg);
        }
        if (Array.isArray(args.translationOffset) && args.translationOffset.length === 3) {
            bridge.adjustTranslation(
                args.translationOffset[0],
                args.translationOffset[2]
            );
            bridge.adjustElevation(args.translationOffset[1]);
        }

        let webXRPosition: { x: number; y: number; z: number } | undefined;
        let convertedGeodetic: { latitude: number; longitude: number; altitudeMsl?: number; heightAboveOriginMeters: number } | undefined;
        let quaternion: [number, number, number, number] | undefined;
        let headingFromQuaternionDeg: number | undefined;

        // Target geodetic -> WebXR
        if (args.targetGeodetic && typeof (args.targetGeodetic as any).latitude === 'number') {
            const tgt = args.targetGeodetic as any;
            const pos = bridge.geodeticToWebXR({
                lat: tgt.latitude,
                lng: tgt.longitude,
                alt: typeof tgt.altitudeMsl === 'number' ? tgt.altitudeMsl : undefined
            });
            webXRPosition = { x: pos.x, y: pos.y, z: pos.z };
        }

        // WebXR position -> Geodetic
        if (Array.isArray(args.webXRPosition) && args.webXRPosition.length === 3) {
            const inputPos = new THREE.Vector3(args.webXRPosition[0], args.webXRPosition[1], args.webXRPosition[2]);
            const geo = bridge.webXRToGeodetic(inputPos);
            convertedGeodetic = {
                latitude: geo.lat,
                longitude: geo.lng,
                ...(geo.alt !== undefined ? { altitudeMsl: geo.alt } : {}),
                heightAboveOriginMeters: geo.heightAboveOriginMeters
            };
        }

        // Heading -> Quaternion
        if (typeof args.headingDeg === 'number') {
            const q = bridge.geodeticHeadingToWebXRQuaternion(args.headingDeg);
            quaternion = [q.x, q.y, q.z, q.w];
        }

        // Quaternion -> Heading
        if (Array.isArray(args.quaternion) && args.quaternion.length === 4) {
            const inputQ = new THREE.Quaternion(args.quaternion[0], args.quaternion[1], args.quaternion[2], args.quaternion[3]);
            headingFromQuaternionDeg = bridge.webXRQuaternionToGeodeticHeading(inputQ);
        }

        const state = bridge.getAlignmentState();

        return {
            resultPayload: {
                success: true,
                originAnchor,
                alignmentState: {
                    isAligned: state.isAligned,
                    calibrationSource: state.calibrationSource,
                    headingOffsetDeg: state.headingOffsetDeg,
                    translationOffset: [state.translationOffset[0], state.translationOffset[1], state.translationOffset[2]]
                },
                webXRPosition,
                convertedGeodetic,
                quaternion,
                headingFromQuaternionDeg
            },
            summaryResult: `Aligned geospatial coordinates with anchor origin (${originAnchor.latitude.toFixed(6)}, ${originAnchor.longitude.toFixed(6)}${originAnchor.altitudeMsl !== undefined ? `, ${originAnchor.altitudeMsl} m MSL` : '; no origin altitude was given, so heights are relative to the origin\'s level and no sea-level altitude is reported'}).`
        };
    },

    webxr_geospatial_calibrate: (args, _ctx) => {
        const originObj = args.originAnchor as any;
        if (!originObj || typeof originObj.latitude !== 'number' || typeof originObj.longitude !== 'number') {
            throw new Error('webxr_geospatial_calibrate: "originAnchor" with latitude and longitude is required.');
        }

        const originAnchor: GeospatialAnchorOrigin = {
            latitude: originObj.latitude,
            longitude: originObj.longitude,
            altitudeMsl: typeof originObj.altitudeMsl === 'number' ? originObj.altitudeMsl : undefined
        };

        const bridge = new WebXRGeospatialAnchorBridge({
            origin: {
                lat: originAnchor.latitude,
                lng: originAnchor.longitude,
                alt: originAnchor.altitudeMsl
            }
        });
        const mode = asString(args.mode, 'anchor-origin');

        if (mode === 'anchor-origin') {
            const headingOffset = typeof args.headingOffsetDeg === 'number' ? args.headingOffsetDeg : 0;
            bridge.calibrateAnchorOrigin(headingOffset);
        } else if (mode === 'sensors') {
            const sampleObj = args.sensorSample as any;
            const poseObj = args.viewerPose as any;
            if (!sampleObj || !poseObj || !Array.isArray(poseObj.position)) {
                throw new Error('webxr_geospatial_calibrate: "sensorSample" and "viewerPose" are required for sensors mode.');
            }
            const sample: DeviceSensorSample = {
                lat: sampleObj.latitude ?? sampleObj.lat,
                lng: sampleObj.longitude ?? sampleObj.lng,
                alt: sampleObj.altitudeMsl ?? sampleObj.alt,
                accuracyMeters: sampleObj.accuracyMeters,
                headingDeg: sampleObj.headingDeg
            };
            const viewerPose: WebXRViewerPose = {
                position: [poseObj.position[0], poseObj.position[1], poseObj.position[2]],
                quaternion: Array.isArray(poseObj.quaternion) && poseObj.quaternion.length === 4
                    ? [poseObj.quaternion[0], poseObj.quaternion[1], poseObj.quaternion[2], poseObj.quaternion[3]]
                    : undefined
            };
            bridge.calibrateSensors(sample, viewerPose);
        } else if (mode === 'manual-pin') {
            const entityId = asString(args.targetEntityId);
            const posArr = args.measuredWebXRPosition as number[];
            if (!entityId || !Array.isArray(posArr) || posArr.length !== 3) {
                throw new Error('webxr_geospatial_calibrate: "targetEntityId" and "measuredWebXRPosition" are required for manual-pin mode.');
            }
            if (args.contract) {
                bridge.loadContract(args.contract as any);
            }
            bridge.calibrateManualPin(entityId, new THREE.Vector3(posArr[0], posArr[1], posArr[2]));
        } else {
            throw new Error(`webxr_geospatial_calibrate: Unknown mode "${mode}". Supported: anchor-origin, sensors, manual-pin.`);
        }

        const state = bridge.getAlignmentState();

        return {
            resultPayload: {
                success: true,
                mode,
                originAnchor,
                alignmentState: {
                    isAligned: state.isAligned,
                    calibrationSource: state.calibrationSource,
                    headingOffsetDeg: state.headingOffsetDeg,
                    translationOffset: state.translationOffset,
                    matrixElements: state.alignmentMatrix.elements
                }
            },
            summaryResult: `Calibrated WebXR geospatial alignment via ${mode} mode (source: ${state.calibrationSource}, heading offset: ${state.headingOffsetDeg.toFixed(2)}°, translation: [${state.translationOffset[0].toFixed(2)}, ${state.translationOffset[1].toFixed(2)}, ${state.translationOffset[2].toFixed(2)}]).`
        };
    },

    webxr_geospatial_project_vectors: (args, _ctx) => {
        const originObj = args.originAnchor as any;
        if (!originObj || typeof originObj.latitude !== 'number' || typeof originObj.longitude !== 'number') {
            throw new Error('webxr_geospatial_project_vectors: "originAnchor" with latitude and longitude is required.');
        }

        const originAnchor: GeospatialAnchorOrigin = {
            latitude: originObj.latitude,
            longitude: originObj.longitude,
            altitudeMsl: typeof originObj.altitudeMsl === 'number' ? originObj.altitudeMsl : undefined
        };

        const bridge = new WebXRGeospatialAnchorBridge({
            origin: {
                lat: originAnchor.latitude,
                lng: originAnchor.longitude,
                alt: originAnchor.altitudeMsl
            }
        });

        const roadCorridors = Array.isArray(args.roadCorridors) ? args.roadCorridors as any[] : [];
        const parcels = Array.isArray(args.parcels) ? args.parcels as any[] : [];

        const roadLines = bridge.projectRoadCorridorsToWebXR(roadCorridors);
        const parcelGroup = bridge.projectParcelsToWebXR(parcels);
        const parcelMeshes = parcelGroup.children as THREE.Mesh[];

        const projectedRoads = roadLines.map((line, idx) => {
            const positions: [number, number, number][] = [];
            const posAttr = line.geometry.getAttribute('position');
            for (let i = 0; i < posAttr.count; i++) {
                positions.push([posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)]);
            }
            const corridorSource = roadCorridors[idx] || {};
            return {
                id: corridorSource.id || line.name,
                name: corridorSource.name || line.name,
                type: corridorSource.type,
                pointCount: posAttr.count,
                samplePoints: positions.slice(0, 5)
            };
        });

        const projectedParcels = parcelMeshes.map((mesh, idx) => {
            mesh.geometry.computeBoundingBox();
            const bbox = mesh.geometry.boundingBox;
            const parcelSource = parcels[idx] || {};
            return {
                id: parcelSource.id || mesh.name,
                name: parcelSource.name || mesh.name,
                heightMeters: parcelSource.heightMeters,
                isLandmark: parcelSource.isLandmark,
                bounds: bbox ? {
                    min: [bbox.min.x, bbox.min.y, bbox.min.z],
                    max: [bbox.max.x, bbox.max.y, bbox.max.z]
                } : undefined
            };
        });

        return {
            resultPayload: {
                success: true,
                originAnchor,
                roadCount: roadLines.length,
                parcelCount: parcelMeshes.length,
                projectedRoads,
                projectedParcels
            },
            summaryResult: `Projected ${roadLines.length} road corridors and ${parcelMeshes.length} parcels into WebXR metric space relative to anchor (${originAnchor.latitude.toFixed(6)}, ${originAnchor.longitude.toFixed(6)}).`
        };
    }
};

// ============================================================================
// GeoBox Precision Declarations & Handlers
// ============================================================================

/** Bounds on the edge alignment search, so one call cannot hold the server for hours. Out-of-range values fail the call. */
const EDGE_ALIGN_LIMITS = { maxIterations: 50, minAnalysisSide: 32, maxAnalysisSide: 640, minSeconds: 5, maxSeconds: 240 } as const;

/**
 * Closed-loop edge alignment of a photograph against a given 3D model (the same tool under three names). The model is
 * rendered at each trial pose and its silhouette/depth edges are correlated with the photograph's edges.
 */
function EDGE_ALIGNMENT_DECLARATION(name: string): ToolDeclaration {
    return {
        name,
        description: 'Refine a camera pose so a given 3D model (.glb) lines up with a photograph: the model is rendered at each trial pose and its silhouette and depth edges are correlated with the photo\'s edges (coordinate descent from initialPose). Reports the edge correlation before and after, whether the target was reached, and the mean pixel distance from the model\'s edges to the nearest strong photo edge. It does not certify an alignment it did not measure; a poor match stays poor.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: { type: 'STRING', description: 'The photograph or video frame to align to (PNG, JPEG or WebP).' },
                glbPath: { type: 'STRING', description: 'The 3D model (.glb) seen in the photograph, in its own coordinate frame.' },
                initialPose: {
                    type: 'OBJECT',
                    description: 'Starting camera in the model\'s frame: position x, y, z, look-at target targetX, targetY, targetZ, and vertical fov in degrees. Required: no pose is assumed.',
                    properties: {
                        x: { type: 'NUMBER' },
                        y: { type: 'NUMBER' },
                        z: { type: 'NUMBER' },
                        targetX: { type: 'NUMBER' },
                        targetY: { type: 'NUMBER' },
                        targetZ: { type: 'NUMBER' },
                        fov: { type: 'NUMBER' }
                    },
                    required: ['x', 'y', 'z', 'targetX', 'targetY', 'targetZ', 'fov']
                },
                maxIterations: { type: 'NUMBER', description: `Maximum coordinate-descent passes, 1-${EDGE_ALIGN_LIMITS.maxIterations} (default 25).` },
                targetEdgeCorrelation: { type: 'NUMBER', description: 'Stop once the edge correlation (0-100) reaches this (default 95).' },
                analysisMaxSide: { type: 'NUMBER', description: `Longest side, in pixels, at which edges are compared, ${EDGE_ALIGN_LIMITS.minAnalysisSide}-${EDGE_ALIGN_LIMITS.maxAnalysisSide} (default 320).` },
                timeBudgetSeconds: { type: 'NUMBER', description: `Stop after this long with the best pose so far, ${EDGE_ALIGN_LIMITS.minSeconds}-${EDGE_ALIGN_LIMITS.maxSeconds} s (default 120). Each trial renders the whole model, so large models get few trials; the result says why it stopped.` }
            },
            required: ['imagePath', 'glbPath', 'initialPose']
        }
    };
}

export const GEOBOX_PRECISION_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'geobox_resect_image_location',
        description: 'Computes where a photograph was taken from: the camera\'s latitude, longitude and altitude, compass heading, pitch, standoff distance, horizontal FOV (from the lens), view frustum and a Google 3D Tiles camera config. It does not analyse the photo\'s pixels and runs no edge alignment (geobox_optimize_edge_alignment aligns a 3D model to a photo and reports what it measured). The location of what the photo shows comes from targetCoords, or from targetLandmarkName (else promptHint) resolved with Google Places. The pose needs evidence, and missing evidence is an error: 2D-3D point correspondences (points2D/points3D with imageWidthPx/imageHeightPx), the camera position (cameraOpticalCenter or knownCoords, with alt), or headingDeg with pitchDeg and standoffDistanceMeters. The result says which evidence was used.',
        parameters: {
            type: 'OBJECT',
            properties: geoboxResectionProperties()
        }
    },
    {
        name: 'geobox_resect_camera_pose',
        description: 'Same as geobox_resect_image_location: computes the camera position, heading, pitch, FOV, frustum and Google 3D Tiles camera config for a photo or video frame. It does not analyse the photo\'s pixels and runs no edge alignment (geobox_optimize_edge_alignment aligns a 3D model to a photo and reports what it measured). The location of what the photo shows comes from targetCoords, or from targetLandmarkName (else promptHint) resolved with Google Places. The pose needs evidence, and missing evidence is an error: 2D-3D point correspondences (points2D/points3D with imageWidthPx/imageHeightPx), the camera position (cameraOpticalCenter or knownCoords, with alt), or headingDeg with pitchDeg and standoffDistanceMeters. The result says which evidence was used.',
        parameters: {
            type: 'OBJECT',
            properties: geoboxResectionProperties()
        }
    },
    {
        name: 'geobox_harmonize_location_lighting',
        description: 'Computes photogrammetric de-lighting shader uniforms (shadow lift, highlight compression, stone albedo, sky irradiance, ground bounce, terrain de-wash), scene lighting with the key light at the NOAA sun for the place and isoDate, and a sky gradient for a 3D location mesh. Window/portal backlighting is added only for portals the caller locates on the model.',
        parameters: {
            type: 'OBJECT',
            properties: {
                landmarkName: { type: 'STRING', description: 'Place name, resolved with Google Places when latitude/longitude are not given (e.g. "Colosseum, Rome")' },
                preset: {
                    type: 'STRING',
                    description: 'Look preset: "civil_twilight_dusk", "golden_hour", "midday_clear", "blue_hour", "night_monumental". Chosen from the computed sun elevation when omitted.'
                },
                latitude: { type: 'NUMBER', description: 'Geographic latitude' },
                longitude: { type: 'NUMBER', description: 'Geographic longitude' },
                isoDate: { type: 'STRING', description: 'ISO 8601 instant the sun is computed for (required; no date is assumed)' },
                stoneType: {
                    type: 'STRING',
                    description: 'Stone albedo profile: "travertine", "limestone", "sandstone", "granite", "terracotta", "marble", "concrete"'
                },
                portals: {
                    type: 'ARRAY',
                    description: 'Window/portal openings located on the model, in scene metres (Y up, -Z north). A backlighting spot is placed behind each one; with none given, no backlighting is added. Unset kelvinTemperature/intensity/distance/decay/angle/penumbra use a 2850 K incandescent fixture and are reported in portalDefaultsApplied.',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            position: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Light position [x, y, z] behind the opening' },
                            targetPosition: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Point [x, y, z] outside the opening the light aims at' },
                            name: { type: 'STRING' },
                            kelvinTemperature: { type: 'NUMBER' },
                            intensity: { type: 'NUMBER' },
                            distance: { type: 'NUMBER' },
                            decay: { type: 'NUMBER' },
                            angle: { type: 'NUMBER' },
                            penumbra: { type: 'NUMBER' }
                        },
                        required: ['position', 'targetPosition']
                    }
                },
                customDelightParams: {
                    type: 'OBJECT',
                    description: 'Custom override parameters for de-lighting uniforms'
                }
            },
            required: ['isoDate']
        }
    },
    EDGE_ALIGNMENT_DECLARATION('geobox_optimize_edge_alignment'),
    {
        name: 'spatial_solve_pnp',
        description: 'Analytically solves Perspective-n-Point (solvePnP / solvePnPRansac) using Direct Linear Transform (DLT) and Levenberg-Marquardt non-linear optimization to recover 6-DOF camera pose and focal length from 2D-to-3D point correspondences.',
        parameters: {
            type: 'OBJECT',
            properties: {
                points2D: {
                    type: 'ARRAY',
                    description: 'Array of 2D image coordinates [{ u: number, v: number }]',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            u: { type: 'NUMBER' },
                            v: { type: 'NUMBER' }
                        },
                        required: ['u', 'v']
                    }
                },
                points3D: {
                    type: 'ARRAY',
                    description: 'Array of corresponding 3D world coordinates [{ x: number, y: number, z: number }]',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            x: { type: 'NUMBER' },
                            y: { type: 'NUMBER' },
                            z: { type: 'NUMBER' }
                        },
                        required: ['x', 'y', 'z']
                    }
                },
                imageWidth: { type: 'NUMBER', description: 'Image width in pixels (e.g. 1920)' },
                imageHeight: { type: 'NUMBER', description: 'Image height in pixels (e.g. 1080)' },
                focalLengthPx: { type: 'NUMBER', description: 'Optional initial focal length estimate in pixels' },
                useRansac: { type: 'BOOLEAN', description: 'Whether to use RANSAC outlier rejection (default: true)' },
                ransacReprojThresholdPx: { type: 'NUMBER', description: 'RANSAC inlier threshold in pixels (default: 3.0)' }
            },
            required: ['points2D', 'points3D', 'imageWidth', 'imageHeight']
        }
    },
    {
        name: 'spatial_match_features_2d_3d',
        description: 'Matches a photograph against a render of the 3D scene: detects Harris corner keypoints with 128-D gradient descriptors in both images, then matches them with the Lowe ratio test and an optional mutual cross-check. Returns pixel correspondences (photo point, render point) in each image\'s own pixel coordinates; lift the render points to 3D with that render\'s depth before solving the pose (spatial_solve_pnp).',
        parameters: {
            type: 'OBJECT',
            properties: {
                queryImagePath: { type: 'STRING', description: 'Path to the photograph (PNG, JPEG or WebP).' },
                renderImagePath: { type: 'STRING', description: 'Path to the rendered reference image of the 3D scene (PNG, JPEG or WebP).' },
                maxKeypoints: { type: 'NUMBER', description: 'Maximum keypoints to detect per image (default: 500)' },
                loweRatio: { type: 'NUMBER', description: "Lowe's ratio test threshold (default: 0.75)" },
                crossCheck: { type: 'BOOLEAN', description: 'Bidirectional mutual nearest neighbor verification (default: true)' }
            },
            required: ['queryImagePath', 'renderImagePath']
        }
    },
    EDGE_ALIGNMENT_DECLARATION('geobox_closed_loop_edge_align'),
    EDGE_ALIGNMENT_DECLARATION('spatial_closed_loop_edge_align'),
    {
        name: 'spatial_resect_image_location',
        description: 'Same as geobox_resect_image_location: computes the camera position, heading, pitch, FOV, frustum and Google 3D Tiles camera config for a photo or video frame. It does not analyse the photo\'s pixels and runs no edge alignment (geobox_optimize_edge_alignment aligns a 3D model to a photo and reports what it measured). The location of what the photo shows comes from targetCoords, or from targetLandmarkName (else promptHint) resolved with Google Places. The pose needs evidence, and missing evidence is an error: 2D-3D point correspondences (points2D/points3D with imageWidthPx/imageHeightPx), the camera position (cameraOpticalCenter or knownCoords, with alt), or headingDeg with pitchDeg and standoffDistanceMeters. The result says which evidence was used.',
        parameters: {
            type: 'OBJECT',
            properties: geoboxResectionProperties()
        }
    }
];

/** Longest side, in pixels, at which keypoints are detected; larger images are box-averaged down to it. */
const FEATURE_ANALYSIS_MAX_SIDE = 1024;

/**
 * Reads and decodes an image for feature matching into grayscale at analysis size. `scale` maps an analysis
 * pixel coordinate back to the source image (x_source = x * scale). Fails when the file is missing or undecodable.
 */
async function loadFeatureImage(tool: string, arg: string, imagePath: string, maxSide = FEATURE_ANALYSIS_MAX_SIDE): Promise<{
    gray: Float32Array; width: number; height: number; scale: number; sourceWidth: number; sourceHeight: number;
}> {
    const fsMod = await import('fs-extra');
    if (!(await fsMod.pathExists(imagePath))) {
        throw new MissingInputError(tool, arg, `${imagePath} does not exist`);
    }
    const { decodeImageToRgba } = await import('../../image-codec-ffmpeg');
    const image = await decodeImageToRgba(await fsMod.readFile(imagePath));
    const factor = Math.max(1, Math.ceil(Math.max(image.width, image.height) / maxSide));
    const width = Math.max(1, Math.floor(image.width / factor));
    const height = Math.max(1, Math.floor(image.height / factor));
    const gray = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let dy = 0; dy < factor; dy++) {
                const row = (y * factor + dy) * image.width;
                for (let dx = 0; dx < factor; dx++) {
                    const i = (row + x * factor + dx) * 4;
                    sum += 0.2126 * image.rgba[i] + 0.7152 * image.rgba[i + 1] + 0.0722 * image.rgba[i + 2];
                }
            }
            gray[y * width + x] = sum / (factor * factor);
        }
    }
    return { gray, width, height, scale: factor, sourceWidth: image.width, sourceHeight: image.height };
}

/** A number argument within [min, max], its default when omitted; anything else is a MissingInputError. */
function boundedNumber(tool: string, arg: string, value: unknown, fallback: number, min: number, max: number): number {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new MissingInputError(tool, arg, `must be a number from ${min} to ${max} (got ${JSON.stringify(value)})`);
    }
    return value;
}

/**
 * Closed-loop edge alignment of a photograph against a given model (see EDGE_ALIGNMENT_DECLARATION). The search runs
 * cooperatively: it yields to the event loop between renders, stops with an AbortError when the chat stops the call,
 * and returns the best pose so far when its time budget runs out.
 */
async function alignModelEdgesToPhoto(tool: string, args: Record<string, unknown>, ctx?: ToolContext) {
    const imagePath = asString(args.imagePath);
    if (!imagePath) throw new MissingInputError(tool, 'imagePath', 'give the photograph to align to');
    const glbPath = asString(args.glbPath) || asString(args.renderedGlbPath);
    if (!glbPath) throw new MissingInputError(tool, 'glbPath', 'give the 3D model (.glb) seen in the photograph; no proxy shape is used');
    const fsMod = await import('fs-extra');
    if (!(await fsMod.pathExists(glbPath))) throw new MissingInputError(tool, 'glbPath', `${glbPath} does not exist`);
    const raw = (args.initialPose || {}) as Record<string, unknown>;
    const keys = ['x', 'y', 'z', 'targetX', 'targetY', 'targetZ', 'fov'] as const;
    const missing = keys.filter(k => typeof raw[k] !== 'number' || !Number.isFinite(raw[k] as number));
    if (missing.length) throw new MissingInputError(tool, 'initialPose', `give ${missing.join(', ')}; no starting pose is assumed`);
    const initialPose = Object.fromEntries(keys.map(k => [k, raw[k] as number])) as unknown as CameraPose6DOF;
    if (!(initialPose.fov > 1 && initialPose.fov < 179)) throw new MissingInputError(tool, 'initialPose.fov', 'must be a vertical field of view in degrees between 1 and 179');
    const standoff = Math.hypot(initialPose.x - initialPose.targetX, initialPose.y - initialPose.targetY, initialPose.z - initialPose.targetZ);
    if (!(standoff > 0)) throw new MissingInputError(tool, 'initialPose', 'the camera position and target must differ');

    const L = EDGE_ALIGN_LIMITS;
    const maxIterations = Math.round(boundedNumber(tool, 'maxIterations', args.maxIterations, 25, 1, L.maxIterations));
    const target = boundedNumber(tool, 'targetEdgeCorrelation', args.targetEdgeCorrelation, 95, 0, 100);
    const maxSide = Math.round(boundedNumber(tool, 'analysisMaxSide', args.analysisMaxSide, 320, L.minAnalysisSide, L.maxAnalysisSide));
    const timeBudgetMs = 1000 * boundedNumber(tool, 'timeBudgetSeconds', args.timeBudgetSeconds, 120, L.minSeconds, L.maxSeconds);

    const photo = await loadFeatureImage(tool, 'imagePath', imagePath, maxSide);
    const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(glbPath);
    if (!mesh.indices || mesh.indices.length < 3) throw new MissingInputError(tool, 'glbPath', `${glbPath} has no triangles`);
    const { width, height } = photo;
    const queryField = computeSobelField(width, height, photo.gray);
    const render = (pose: CameraPose6DOF) => HeadlessMeshSilhouetteRenderer.renderEdgeField(mesh, pose, width, height);

    const initialField = render(initialPose);
    if (!(initialField.meanMagnitude > 0)) throw new MissingInputError(tool, 'initialPose', `the model in ${glbPath} is not in view from initialPose`);
    const initial = evaluateEdgeOverlap(queryField, initialField);
    const started = Date.now();
    // Step sizes scale with the camera's distance to its target, so the search means the same at any model scale.
    const opt = await SubPixelEdgeAlignmentOptimizer.optimizePoseAsync(initialPose, queryField, render, {
        maxIterations,
        targetOverlapScore: target,
        subpixelTolerancePx: Number.POSITIVE_INFINITY,
        stepSizes: { pos: standoff * 0.02, target: standoff * 0.01, fov: 1.0 },
        signal: ctx?.signal,
        timeBudgetMs,
        initialField,
        onRender: (renders, best) => ctx?.reportProgress?.(`Edge alignment: ${renders} renders, best correlation ${best.toFixed(1)}%`,
            Math.min(0.99, (Date.now() - started) / timeBudgetMs))
    });
    const finalEval = evaluateEdgeOverlap(queryField, opt.finalField);
    const distance = measureMeanEdgeDistance(queryField, opt.finalField);
    const meanEdgeDistancePx = distance.meanPx * photo.scale;
    const p = opt.finalPose;
    const reached = finalEval.overlapScorePercent >= target;
    return {
        resultPayload: {
            imagePath,
            glbPath,
            imageSize: [photo.sourceWidth, photo.sourceHeight],
            analysisSize: [width, height],
            initialPose,
            finalPose: { x: p.x, y: p.y, z: p.z, targetX: p.targetX, targetY: p.targetY, targetZ: p.targetZ, fov: p.fov },
            initialEdgeCorrelationPct: initial.overlapScorePercent,
            finalEdgeCorrelationPct: finalEval.overlapScorePercent,
            targetEdgeCorrelationPct: target,
            reachedTarget: reached,
            iterations: opt.iterations,
            renders: opt.renders,
            stoppedBy: opt.stoppedBy,
            elapsedSeconds: (Date.now() - started) / 1000,
            meanEdgeDistancePx,
            modelEdgePixels: distance.modelEdgePixels,
            modelTriangles: mesh.indices.length / 3,
            edgeDefinition: 'model edges: at least 25% of the render\'s largest gradient; photo edges: top 10% of the photo\'s gradient magnitudes'
        } as unknown as ToolResultPayload,
        summaryResult: `Aligned ${glbPath} to ${imagePath}: edge correlation ${initial.overlapScorePercent.toFixed(1)}% -> ${finalEval.overlapScorePercent.toFixed(1)}% in ${opt.iterations} pass(es), ${opt.renders} render(s) (target ${target}% ${reached ? 'reached' : 'not reached'}; stopped: ${opt.stoppedBy}). The model's edges lie ${Number.isFinite(meanEdgeDistancePx) ? meanEdgeDistancePx.toFixed(1) : 'n/a'} px on average from the nearest strong photo edge. Final camera: position [${[p.x, p.y, p.z].map(v => v.toFixed(2)).join(', ')}], target [${[p.targetX, p.targetY, p.targetZ].map(v => v.toFixed(2)).join(', ')}], fov ${p.fov.toFixed(1)} deg.`
    };
}

export const geoboxPrecisionHandlers: Record<string, ToolHandler> = {
    geobox_resect_image_location: async (args, _ctx) => {
        const service = new GeoBoxPrecisionResectionService();
        const request: ImageLocationResectionRequest = {
            imagePath: typeof args.imagePath === 'string' ? args.imagePath : undefined,
            videoPath: typeof args.videoPath === 'string' ? args.videoPath : undefined,
            promptHint: typeof args.promptHint === 'string' ? args.promptHint : undefined,
            targetLandmarkName: typeof args.targetLandmarkName === 'string' ? args.targetLandmarkName : undefined,
            targetCoords: args.targetCoords as any,
            cameraOpticalCenter: args.cameraOpticalCenter as any,
            knownCoords: args.knownCoords as any,
            headingDeg: typeof args.headingDeg === 'number' ? args.headingDeg : undefined,
            pitchDeg: typeof args.pitchDeg === 'number' ? args.pitchDeg : undefined,
            rollDeg: typeof args.rollDeg === 'number' ? args.rollDeg : undefined,
            standoffDistanceMeters: typeof args.standoffDistanceMeters === 'number' ? args.standoffDistanceMeters : undefined,
            glbPath: typeof args.glbPath === 'string' ? args.glbPath : undefined,
            points2D: Array.isArray(args.points2D) ? args.points2D : undefined,
            points3D: Array.isArray(args.points3D) ? args.points3D : undefined,
            imageWidthPx: typeof args.imageWidthPx === 'number' ? args.imageWidthPx : undefined,
            imageHeightPx: typeof args.imageHeightPx === 'number' ? args.imageHeightPx : undefined,
            sensorFocalMm: typeof args.sensorFocalMm === 'number' ? args.sensorFocalMm : undefined,
            sensorWidthMm: typeof args.sensorWidthMm === 'number' ? args.sensorWidthMm : undefined
        };

        const result = await service.resectImageLocation(request);
        const located = result.landmark.resolvedFrom === 'google_places' ? 'resolved with Google Places' : `from ${result.landmark.resolvedFrom}`;
        return {
            resultPayload: result as unknown as ToolResultPayload,
            summaryResult: `Camera pose for ${result.landmark.name} (${located}): camera at (${result.cameraOpticalCenter.lat.toFixed(6)}, ${result.cameraOpticalCenter.lng.toFixed(6)}, ${result.cameraOpticalCenter.elevationMslMeters.toFixed(1)} m), heading ${result.cameraAttitude.headingDeg.toFixed(1)}°, pitch ${result.cameraAttitude.pitchDeg.toFixed(1)}°, ${result.cameraOpticalCenter.standoffDistanceMeters.toFixed(1)} m from the target, horizontal FOV ${result.googleMapTiles3DConfig.fov}°. Pose from ${result.poseSource}. The photo's pixels were not analysed and no edge alignment was run.`
        };
    },
    geobox_resect_camera_pose: async (args, ctx) => {
        return geoboxPrecisionHandlers.geobox_resect_image_location(args, ctx);
    },
    geobox_harmonize_location_lighting: async (args, _ctx) => {
        // The sun needs coordinates: the given ones, else the landmark name resolved with Google Places.
        const landmarkName = typeof args.landmarkName === 'string' && args.landmarkName.trim() ? args.landmarkName.trim() : undefined;
        let latitude = typeof args.latitude === 'number' ? args.latitude : undefined;
        let longitude = typeof args.longitude === 'number' ? args.longitude : undefined;
        let resolvedName = landmarkName;
        if ((latitude === undefined || longitude === undefined) && landmarkName) {
            const place = await geocode3DTilesAddress(landmarkName);
            latitude = place.lat;
            longitude = place.lng;
            resolvedName = place.formattedAddress || place.landmarkName || landmarkName;
        }
        const result = LocationObjectLightingService.harmonizeLocationObjectAtmosphere({
            landmarkName: resolvedName,
            preset: typeof args.preset === 'string' ? (args.preset as any) : undefined,
            latitude,
            longitude,
            isoDate: typeof args.isoDate === 'string' ? args.isoDate : undefined,
            stoneType: typeof args.stoneType === 'string' ? (args.stoneType as any) : undefined,
            portals: Array.isArray(args.portals) ? (args.portals as any[]) : undefined,
            customDelightParams: typeof args.customDelightParams === 'object' && args.customDelightParams !== null ? (args.customDelightParams as any) : undefined
        });

        return {
            resultPayload: result as unknown as ToolResultPayload,
            summaryResult: `Harmonized location 3D lighting for ${result.landmarkContext?.name} (${latitude!.toFixed(6)}, ${longitude!.toFixed(6)}; NOAA sun at ${result.landmarkContext?.isoDate}: elevation ${result.solarElevationDeg}°, azimuth ${result.solarAzimuthDeg}°) with the ${result.preset} look preset (diurnal: ${result.diurnalPhase}). De-lighting preset values (shadow lift: ${result.delightUniforms.uShadowLift}, highlight compress: ${result.delightUniforms.uHighlightCompress}, ground de-wash: ${result.delightUniforms.uGroundDeWash}), scene lights (ambient: ${result.sceneLighting.ambientLight.intensity}, hemi: ${result.sceneLighting.hemiLight.intensity}, sun: ${result.sceneLighting.sunLight.intensity}, placed at the computed sun). ${result.architecturalFixtures.length ? `${result.architecturalFixtures.length} portal backlighting fixtures at the given openings${result.portalDefaultsApplied?.length ? ` (fixture defaults used for ${result.portalDefaultsApplied.join(', ')})` : ''}.` : 'No portal backlighting (no window/portal openings were given).'}`
        };
    },
    geobox_optimize_edge_alignment: async (args, ctx) => alignModelEdgesToPhoto('geobox_optimize_edge_alignment', args, ctx),
    spatial_solve_pnp: async (args, _ctx) => {
        const rawPoints2D = Array.isArray(args.points2D) ? args.points2D : [];
        const rawPoints3D = Array.isArray(args.points3D) ? args.points3D : [];

        const points2D: Point2D[] = rawPoints2D.map((p: any) => {
            if (Array.isArray(p)) return [Number(p[0]), Number(p[1])];
            return [Number(p?.x ?? p?.u ?? 0), Number(p?.y ?? p?.v ?? 0)];
        });
        const points3D: Point3D[] = rawPoints3D.map((p: any) => {
            if (Array.isArray(p)) return [Number(p[0]), Number(p[1]), Number(p[2])];
            return [Number(p?.x ?? 0), Number(p?.y ?? 0), Number(p?.z ?? 0)];
        });

        const imageWidth = typeof args.imageWidth === 'number' ? args.imageWidth : 1920;
        const imageHeight = typeof args.imageHeight === 'number' ? args.imageHeight : 1080;
        const focalLengthPx = typeof args.focalLengthPx === 'number' ? args.focalLengthPx : (imageWidth * 1.2);
        const useRansac = args.useRansac !== false;
        const threshold = typeof args.ransacReprojThresholdPx === 'number' ? args.ransacReprojThresholdPx : 3.0;

        if (points2D.length < 4 || points3D.length < 4 || points2D.length !== points3D.length) {
            throw new Error(`spatial_solve_pnp requires >= 4 matched 2D-3D point pairs (got ${points2D.length} 2D points and ${points3D.length} 3D points).`);
        }

        const intrinsics = {
            fx: focalLengthPx,
            fy: focalLengthPx,
            cx: imageWidth / 2,
            cy: imageHeight / 2,
            width: imageWidth,
            height: imageHeight
        };

        if (useRansac) {
            const ransacResult = SpatialPoseEstimatorService.solvePnPRansac(points3D, points2D, intrinsics, {
                inlierThresholdPx: threshold,
                maxRansacIterations: 100
            });
            const p = ransacResult.pose;
            return {
                resultPayload: ransacResult as unknown as ToolResultPayload,
                summaryResult: `Analytically solved 6-DOF camera pose via solvePnPRansac (${ransacResult.inlierCount}/${points2D.length} inliers): camera pos [${p.cameraCenterWorld.map((v: number) => v.toFixed(2)).join(', ')}], attitude (heading: ${p.attitude.headingDeg.toFixed(1)}°, pitch: ${p.attitude.pitchDeg.toFixed(1)}°, roll: ${p.attitude.rollDeg.toFixed(1)}°), fov: ${p.fovYDeg.toFixed(1)}°, mean residual: ${p.meanReprojectionErrorPx.toFixed(3)}px.`
            };
        } else {
            const p = SpatialPoseEstimatorService.solvePnP(points3D, points2D, intrinsics);
            return {
                resultPayload: p as unknown as ToolResultPayload,
                summaryResult: `Analytically solved 6-DOF camera pose via solvePnP: camera pos [${p.cameraCenterWorld.map((v: number) => v.toFixed(2)).join(', ')}], attitude (heading: ${p.attitude.headingDeg.toFixed(1)}°, pitch: ${p.attitude.pitchDeg.toFixed(1)}°, roll: ${p.attitude.rollDeg.toFixed(1)}°), fov: ${p.fovYDeg.toFixed(1)}°, mean residual: ${p.meanReprojectionErrorPx.toFixed(3)}px.`
            };
        }
    },
    spatial_match_features_2d_3d: async (args, _ctx) => {
        const queryImagePath = asString(args.queryImagePath);
        if (!queryImagePath) throw new MissingInputError('spatial_match_features_2d_3d', 'queryImagePath', 'give the photograph to match');
        const renderImagePath = asString(args.renderImagePath);
        if (!renderImagePath) throw new MissingInputError('spatial_match_features_2d_3d', 'renderImagePath', 'give the rendered reference image to match against');
        const maxKeypoints = typeof args.maxKeypoints === 'number' ? args.maxKeypoints : 500;
        const loweRatio = typeof args.loweRatio === 'number' ? args.loweRatio : 0.75;
        const crossCheck = args.crossCheck !== false;

        const query = await loadFeatureImage('spatial_match_features_2d_3d', 'queryImagePath', queryImagePath);
        const render = await loadFeatureImage('spatial_match_features_2d_3d', 'renderImagePath', renderImagePath);
        const k1 = VisualFeatureMatcherService.extractKeypoints(query.gray, query.width, query.height, { maxKeypoints });
        const k2 = VisualFeatureMatcherService.extractKeypoints(render.gray, render.width, render.height, { maxKeypoints });
        // Keypoints are found on the analysis-size images and reported in each source image's pixel coordinates.
        const matches = VisualFeatureMatcherService.matchKeypoints(k1, k2, { loweRatio, crossCheck }).map(m => ({
            ...m,
            point1: [m.point1[0] * query.scale, m.point1[1] * query.scale] as Point2D,
            point2: [m.point2[0] * render.scale, m.point2[1] * render.scale] as Point2D
        }));

        return {
            resultPayload: {
                queryImagePath,
                renderImagePath,
                queryImageSize: [query.sourceWidth, query.sourceHeight],
                renderImageSize: [render.sourceWidth, render.sourceHeight],
                queryKeypointsCount: k1.length,
                referenceKeypointsCount: k2.length,
                matchesCount: matches.length,
                matches
            } as unknown as ToolResultPayload,
            summaryResult: `Matched ${queryImagePath} against ${renderImagePath}: ${k1.length} photo keypoints, ${k2.length} render keypoints, ${matches.length} 2D correspondences (Lowe ratio ${loweRatio}${crossCheck ? ', cross-checked' : ''}). Lift the render points with the render's depth to get 3D points for spatial_solve_pnp.`
        };
    },
    geobox_closed_loop_edge_align: async (args, ctx) => alignModelEdgesToPhoto('geobox_closed_loop_edge_align', args, ctx),
    spatial_closed_loop_edge_align: async (args, ctx) => alignModelEdgesToPhoto('spatial_closed_loop_edge_align', args, ctx),
    spatial_resect_image_location: async (args, ctx) => {
        return geoboxPrecisionHandlers.geobox_resect_image_location(args, ctx);
    }
};

// ============================================================================
// Optics Lens Distortion Declarations & Handlers
// ============================================================================

export const OPTICS_LENS_DISTORTION_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'optics_configure_lens_distortion',
        description: 'Configures Brown-Conrady and VFX optical lens distortion shader parameters from an explicit lens (a presetId, a focalLengthMm, or customParams coefficients), calculates overscan margin, evaluates UV coordinate displacement, or outputs production GLSL shader code. One of presetId, focalLengthMm or customParams is required; no lens is assumed.',
        parameters: {
            type: 'OBJECT',
            properties: {
                focalLengthMm: { type: 'NUMBER', description: 'Lens focal length in mm (e.g. 14, 18, 24, 26, 50, 85). Used when presetId is not given.' },
                presetId: {
                    type: 'STRING',
                    description: 'Lens preset id; an unknown id is an error (e.g. smartphone_wide_26mm, ultrawide_14mm, action_cam_fisheye, cinema_anamorphic_2x, standard_prime_50mm, telephoto_portrait_85mm, drone_surveying_lens, cooke_s4_wide_18mm, arri_ultra_prime_24mm, panavision_c_series_anamorphic_50mm)'
                },
                mode: {
                    type: 'STRING',
                    description: 'Operational distortion mode: "redistort" (distorts 3D render to match camera plate), "undistort" (straightens curved camera plate), or "stmap" (renders UV STMap)'
                },
                edgeMode: {
                    type: 'STRING',
                    description: 'Edge handling outside optical sensor bounds: "letterbox" (matte color), "clamp", or "transparent"'
                },
                filterQuality: {
                    type: 'STRING',
                    description: 'Texture sampling filter: "bilinear" (standard) or "bicubic" (Mitchell-Netravali high-fidelity)'
                },
                customParams: {
                    type: 'OBJECT',
                    description: 'Explicit parameters (k1, k2, k3, k4, p1, p2, opticalCenter, chromaticAberration, anamorphicSqueeze). Override the preset / focal-length values; on their own they must include at least one of k1..k4, p1, p2.',
                    properties: {
                        k1: { type: 'NUMBER' },
                        k2: { type: 'NUMBER' },
                        k3: { type: 'NUMBER' },
                        k4: { type: 'NUMBER' },
                        p1: { type: 'NUMBER' },
                        p2: { type: 'NUMBER' },
                        opticalCenter: {
                            type: 'ARRAY',
                            items: { type: 'NUMBER' }
                        },
                        chromaticAberration: { type: 'NUMBER' },
                        anamorphicSqueeze: { type: 'NUMBER' }
                    }
                },
                sampleUvs: {
                    type: 'ARRAY',
                    description: 'Optional list of [u, v] normalized coordinates to calculate distorted positions for',
                    items: {
                        type: 'ARRAY',
                        items: { type: 'NUMBER' }
                    }
                },
                aspectRatio: { type: 'NUMBER', description: 'Viewport aspect ratio width / height (default: 1.777778)' },
                includeGlslShader: { type: 'BOOLEAN', description: 'Whether to return the production GLSL vertex and fragment shader sources' }
            }
        }
    },
    {
        name: 'optics_export_lens_distortion',
        description: 'Exports lens distortion parameters to industry-standard VFX formats: 3DEqualizer 4 (.lens), Foundry Nuke LensDistortion (.nk), OpenCV camera calibration matrix, or STMap raw specifications. The lens must be given as a presetId or customParams coefficients; no lens is assumed.',
        parameters: {
            type: 'OBJECT',
            properties: {
                format: {
                    type: 'STRING',
                    description: 'Target export format: "3dequalizer", "nuke", "opencv", "stmap", or "all"'
                },
                presetId: {
                    type: 'STRING',
                    description: 'Lens preset id (e.g. cooke_s4_wide_18mm, arri_ultra_prime_24mm, cinema_anamorphic_2x); an unknown id is an error. Required unless customParams carries the coefficients.'
                },
                customParams: {
                    type: 'OBJECT',
                    description: 'Custom distortion parameters (k1, k2, k3, k4, p1, p2, anamorphicSqueeze, opticalCenter). Override the preset; on their own they must include at least one of k1..k4, p1, p2.',
                    properties: {
                        k1: { type: 'NUMBER' },
                        k2: { type: 'NUMBER' },
                        k3: { type: 'NUMBER' },
                        k4: { type: 'NUMBER' },
                        p1: { type: 'NUMBER' },
                        p2: { type: 'NUMBER' },
                        anamorphicSqueeze: { type: 'NUMBER' },
                        opticalCenter: {
                            type: 'ARRAY',
                            items: { type: 'NUMBER' }
                        }
                    }
                },
                metadata: {
                    type: 'OBJECT',
                    description: 'Camera and lens production metadata',
                    properties: {
                        lensName: { type: 'STRING' },
                        cameraBody: { type: 'STRING' },
                        focalLengthMm: { type: 'NUMBER' },
                        filmBackWidthMm: { type: 'NUMBER' },
                        filmBackHeightMm: { type: 'NUMBER' },
                        resolutionWidth: { type: 'NUMBER' },
                        resolutionHeight: { type: 'NUMBER' },
                        outputMode: { type: 'STRING' }
                    }
                }
            },
            required: ['format']
        }
    }
];

const LENS_COEFFICIENT_KEYS = ['k1', 'k2', 'k3', 'k4', 'p1', 'p2'] as const;

function hasLensCoefficients(customParams: unknown): boolean {
    if (!customParams || typeof customParams !== 'object') return false;
    const cp = customParams as Record<string, unknown>;
    return LENS_COEFFICIENT_KEYS.some(k => typeof cp[k] === 'number' && Number.isFinite(cp[k] as number));
}

/** Resolves the preset the caller named; an unknown id is an error rather than a silent stand-in lens. */
function requireKnownLensPreset(tool: string, presetId: unknown): LensDistortionConfig | undefined {
    if (presetId === undefined || presetId === null || presetId === '') return undefined;
    if (typeof presetId !== 'string' || !LENS_OPTICAL_PRESETS[presetId]) {
        throw new MissingInputError(tool, 'a known presetId', `"${String(presetId)}" is not one of ${Object.keys(LENS_OPTICAL_PRESETS).join(', ')}`);
    }
    return { ...LENS_OPTICAL_PRESETS[presetId].config };
}

export const opticsLensDistortionHandlers: Record<string, ToolHandler> = {
    optics_configure_lens_distortion: async (args, _ctx) => {
        const TOOL = 'optics_configure_lens_distortion';
        let config: LensDistortionConfig;

        const preset = requireKnownLensPreset(TOOL, args.presetId);
        if (preset) {
            config = preset;
        } else if (typeof args.focalLengthMm === 'number' && Number.isFinite(args.focalLengthMm) && args.focalLengthMm > 0) {
            config = calculateBrownConradyFromFocalLength(args.focalLengthMm);
        } else if (hasLensCoefficients(args.customParams)) {
            config = {};
        } else {
            throw new MissingInputError(TOOL, 'a lens: presetId, focalLengthMm, or customParams with distortion coefficients', 'no default lens is assumed');
        }

        if (args.customParams && typeof args.customParams === 'object') {
            const cp = args.customParams as Record<string, any>;
            if (typeof cp.k1 === 'number') config.k1 = cp.k1;
            if (typeof cp.k2 === 'number') config.k2 = cp.k2;
            if (typeof cp.k3 === 'number') config.k3 = cp.k3;
            if (typeof cp.k4 === 'number') config.k4 = cp.k4;
            if (typeof cp.p1 === 'number') config.p1 = cp.p1;
            if (typeof cp.p2 === 'number') config.p2 = cp.p2;
            if (Array.isArray(cp.opticalCenter) && cp.opticalCenter.length === 2) {
                config.opticalCenter = [cp.opticalCenter[0], cp.opticalCenter[1]];
            }
            if (typeof cp.chromaticAberration === 'number') config.chromaticAberration = cp.chromaticAberration;
            if (typeof cp.anamorphicSqueeze === 'number') config.anamorphicSqueeze = cp.anamorphicSqueeze;
        }

        if (typeof args.mode === 'string') {
            config.mode = args.mode as any;
        }
        if (typeof args.edgeMode === 'string') {
            config.edgeMode = args.edgeMode as any;
        }
        if (typeof args.filterQuality === 'string') {
            config.filterQuality = args.filterQuality as any;
        }

        const aspectRatio = typeof args.aspectRatio === 'number' ? args.aspectRatio : 16 / 9;
        const distortedSamples: Array<{ uv: [number, number]; distortedUv: [number, number] }> = [];

        if (Array.isArray(args.sampleUvs)) {
            for (const sample of args.sampleUvs) {
                if (Array.isArray(sample) && sample.length >= 2) {
                    const uv: [number, number] = [sample[0], sample[1]];
                    const distorted = computeBrownConradyUV(
                        uv,
                        {
                            k1: config.k1 ?? 0,
                            k2: config.k2 ?? 0,
                            k3: config.k3 ?? 0,
                            k4: config.k4 ?? 0,
                            p1: config.p1 ?? 0,
                            p2: config.p2 ?? 0,
                            opticalCenter: config.opticalCenter as [number, number],
                            anamorphicSqueeze: config.anamorphicSqueeze ?? 1.0
                        },
                        aspectRatio
                    );
                    distortedSamples.push({ uv, distortedUv: distorted });
                }
            }
        }

        // Calculate overscan margin for production frame padding
        const overscanMargin = LensDistortionEffect.calculateOverscanMargin(
            {
                k1: config.k1 ?? 0,
                k2: config.k2 ?? 0,
                k3: config.k3 ?? 0,
                k4: config.k4 ?? 0,
                p1: config.p1 ?? 0,
                p2: config.p2 ?? 0,
                anamorphicSqueeze: config.anamorphicSqueeze ?? 1.0,
                opticalCenter: config.opticalCenter as [number, number]
            },
            aspectRatio,
            config.mode === 'undistort' ? 'undistort' : 'redistort'
        );

        const result: Record<string, any> = {
            config,
            aspectRatio,
            overscanMargin,
            overscanResolutionHint: {
                widthFactor: 1.0 + overscanMargin * 2,
                heightFactor: 1.0 + overscanMargin * 2
            },
            distortedSamples: distortedSamples.length > 0 ? distortedSamples : undefined,
            availablePresets: Object.keys(LENS_OPTICAL_PRESETS)
        };

        if (args.includeGlslShader === true) {
            result.shader = {
                vertexShader: LENS_DISTORTION_SHADER.vertexShader,
                fragmentShader: LENS_DISTORTION_SHADER.fragmentShader
            };
        }

        return {
            resultPayload: result as unknown as ToolResultPayload,
            summaryResult: `Configured Brown-Conrady lens distortion (k1: ${config.k1?.toFixed(4)}, k2: ${config.k2?.toFixed(4)}, mode: ${config.mode ?? 'redistort'}, overscanMargin: ${(overscanMargin * 100).toFixed(1)}%) with ${distortedSamples.length} sampled points.`
        };
    },

    optics_export_lens_distortion: async (args, _ctx) => {
        const TOOL = 'optics_export_lens_distortion';
        let params: any = requireKnownLensPreset(TOOL, args.presetId);
        if (!params) {
            if (!hasLensCoefficients(args.customParams)) {
                throw new MissingInputError(TOOL, 'a lens: presetId or customParams with distortion coefficients', 'no default lens is assumed');
            }
            params = {};
        }

        if (args.customParams && typeof args.customParams === 'object') {
            Object.assign(params, args.customParams);
        }

        const metadata = (args.metadata as any) || {};
        const format = String(args.format || 'all').toLowerCase();
        const exportResult: Record<string, any> = {};

        if (format === '3dequalizer' || format === 'all') {
            exportResult.threeDEqualizerLensFile = VfxLensInterchangeService.export3DEqualizerLensFile(params, metadata);
        }

        if (format === 'nuke' || format === 'all') {
            exportResult.nukeScript = VfxLensInterchangeService.exportNukeLensDistortionScript(params, metadata);
        }

        if (format === 'opencv' || format === 'all') {
            const width = metadata.resolutionWidth ?? 3840;
            const height = metadata.resolutionHeight ?? 2160;
            exportResult.openCvCalibration = VfxLensInterchangeService.exportOpenCvCameraMatrix(params, width, height, metadata.filmBackWidthMm ?? 36.0);
        }

        if (format === 'stmap' || format === 'all') {
            const width = metadata.resolutionWidth ?? 3840;
            const height = metadata.resolutionHeight ?? 2160;
            const overscan = LensDistortionEffect.calculateOverscanMargin(params, width / height, metadata.outputMode === 'undistort' ? 'undistort' : 'redistort');
            exportResult.stMapInfo = {
                width,
                height,
                overscanMargin: overscan,
                channels: 'RGBA Float32',
                recommendedOverscanWidth: Math.round(width * (1.0 + overscan * 2)),
                recommendedOverscanHeight: Math.round(height * (1.0 + overscan * 2))
            };
        }

        return {
            resultPayload: exportResult as unknown as ToolResultPayload,
            summaryResult: `Successfully exported lens distortion calibration to ${format.toUpperCase()} format(s).`
        };
    }
};

export const POSE_DEPTH_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'mediapipe_detect_pose',
        description: 'Detects 3D metric human body pose landmarks, anatomical Euler joint rotations, and ground elevation offset from an image using Google MediaPipe PoseLandmarker.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: {
                    type: 'STRING',
                    description: 'Absolute path to image file, data URL, or base64 string.'
                },
                modelQuality: {
                    type: 'STRING',
                    enum: ['lite', 'full', 'heavy'],
                    description: 'Quality model tier for MediaPipe pose estimation (default: full).'
                },
                minConfidence: {
                    type: 'NUMBER',
                    description: 'Minimum detection confidence threshold between 0.0 and 1.0 (default: 0.5).'
                }
            },
            required: ['imagePath']
        }
    },
    {
        name: 'gemini_estimate_scene_depth',
        description: 'Asks Gemini to place the main scene parts of an image in depth (an estimate from monocular cues, not a measurement) and can interpolate a coarse depth buffer from those parts. Images are downscaled to 1024 px on the long edge before sending. Fails with a coded error if the image cannot be read or the model answer is unusable.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: {
                    type: 'STRING',
                    description: 'Absolute path to image file, data URL, or base64 string.'
                },
                fovDegrees: {
                    type: 'NUMBER',
                    description: 'Camera field of view in degrees (default: 50).'
                },
                generateDepthMap: {
                    type: 'BOOLEAN',
                    description: 'Whether to synthesize a continuous metric depth buffer (Float32Array) for 3D Gaussian Splats or mesh reconstruction.'
                },
                depthMapWidth: {
                    type: 'NUMBER',
                    description: 'Width in pixels for synthesized depth map buffer (default: 128).'
                },
                depthMapHeight: {
                    type: 'NUMBER',
                    description: 'Height in pixels for synthesized depth map buffer (default: 72).'
                }
            },
            required: ['imagePath']
        }
    }
];

export const poseDepthHandlers: Record<string, ToolHandler> = {
    async mediapipe_detect_pose(args) {
        const imagePath = String(args.imagePath ?? '');
        if (!imagePath) {
            return {
                resultPayload: { error: 'imagePath is required' } as unknown as ToolResultPayload,
                summaryResult: 'Failed: imagePath is required for mediapipe_detect_pose'
            };
        }

        const poseService = new MediaPipePoseService();
        const result = await poseService.estimatePoseFromImage({
            image: imagePath,
            modelQuality: (args.modelQuality as any) ?? 'full',
            minConfidence: typeof args.minConfidence === 'number' ? args.minConfidence : 0.5
        });

        return {
            resultPayload: result as unknown as ToolResultPayload,
            summaryResult: result.success
                ? `Detected human pose with confidence ${(result.confidence * 100).toFixed(1)}%, ${result.groundedYOffsetMeters === undefined ? 'no foot visible, so no ground offset was measured' : `grounded Y-offset (hip to the lowest visible foot): ${result.groundedYOffsetMeters.toFixed(3)}m`}.`
                : `Pose detection failed: ${result.error ?? 'Unknown error'}`
        };
    },

    async gemini_estimate_scene_depth(args) {
        const imagePath = String(args.imagePath ?? '');
        if (!imagePath) {
            return {
                resultPayload: { error: 'imagePath is required' } as unknown as ToolResultPayload,
                summaryResult: 'Failed: imagePath is required for gemini_estimate_scene_depth'
            };
        }

        const depthService = new GeminiSceneDepthService();
        const generateDepthMap = Boolean(args.generateDepthMap);
        const depthMapWidth = typeof args.depthMapWidth === 'number' ? args.depthMapWidth : 128;
        const depthMapHeight = typeof args.depthMapHeight === 'number' ? args.depthMapHeight : 72;

        let result;
        try {
            result = await depthService.analyzeSceneDepth({
                image: imagePath,
                fovDegrees: typeof args.fovDegrees === 'number' ? args.fovDegrees : 50,
                generateDepthMap,
                depthMapResolution: { width: depthMapWidth, height: depthMapHeight }
            });
        } catch (err: any) {
            const message = err?.message ?? String(err);
            return {
                status: 'failed',
                resultPayload: { success: false, error: message, ...(typeof err?.code === 'string' ? { code: err.code } : {}) } as unknown as ToolResultPayload,
                summaryResult: `Scene depth estimation failed: ${message}`
            };
        }

        const partCount = result.annotation ? Object.keys(result.annotation.parts).length : 0;
        return {
            resultPayload: {
                success: result.success,
                sceneType: result.annotation?.sceneType,
                partCount,
                parts: result.enriched?.parts,
                zRanges: result.enriched?.z_ranges,
                depthMapStats: result.depthMap ? {
                    width: result.depthMap.width,
                    height: result.depthMap.height,
                    minDepth: result.depthMap.minDepth,
                    maxDepth: result.depthMap.maxDepth
                } : undefined,
                explanation: result.explanation
            } as unknown as ToolResultPayload,
            summaryResult: `Estimated scene depth across ${partCount} semantic layers (Gemini estimate; the depth map is interpolated from those layers, not measured).`
        };
    }
};

// ============================================================================
// Physical Camera & Dynamic Depth-of-Field Tracking Tools
// ============================================================================

export const PHYSICAL_CAMERA_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'configure_physical_camera',
        description: 'Configures real-world physical camera optical parameters (sensor format, focal length, aperture f-stop, anamorphic squeeze, focus distance) and computes exact optical frustum FOV, Zeiss hyperfocal distance, depth of field limits, and circle of confusion blur diameters.',
        parameters: {
            type: 'OBJECT',
            properties: {
                sensorFormat: {
                    type: 'STRING',
                    enum: [
                        'full_frame_35mm',
                        'super_35',
                        'imax_70mm',
                        'medium_format_fuji',
                        'aps_c',
                        'micro_four_thirds',
                        'smartphone_1_inch',
                        'smartphone_type_1_128',
                        'custom'
                    ],
                    description: 'Standard film/sensor format preset (default: full_frame_35mm).'
                },
                sensorWidthMm: {
                    type: 'NUMBER',
                    description: 'Custom sensor width in millimeters (used if sensorFormat is custom).'
                },
                sensorHeightMm: {
                    type: 'NUMBER',
                    description: 'Custom sensor height in millimeters (used if sensorFormat is custom).'
                },
                focalLengthMm: {
                    type: 'NUMBER',
                    description: 'Lens focal length in millimeters (e.g. 24, 35, 50, 85, 135).'
                },
                apertureFStop: {
                    type: 'NUMBER',
                    description: 'Lens aperture f-number (e.g. 1.4, 2.0, 2.8, 4.0, 8.0).'
                },
                focusDistanceMeters: {
                    type: 'NUMBER',
                    description: 'Subject optical plane distance from camera in meters.'
                },
                anamorphicRatio: {
                    type: 'NUMBER',
                    description: 'Anamorphic horizontal squeeze ratio (e.g. 1.0 for spherical, 1.33, 1.5, or 2.0 for anamorphic).'
                },
                enableDepthOfField: {
                    type: 'BOOLEAN',
                    description: 'Whether post-processing depth of field and bokeh blurring is enabled.'
                }
            },
            required: ['focalLengthMm', 'apertureFStop']
        }
    },
    {
        name: 'camera_track_focus_target',
        description: 'Continuously evaluates the 3D metric distance between a physical camera and a designated hero target point/building in 3D space, computes exponential damping rack focus transitions, and calculates near/far sharp depth of field limits.',
        parameters: {
            type: 'OBJECT',
            properties: {
                cameraPosition: {
                    type: 'ARRAY',
                    items: { type: 'NUMBER' },
                    description: 'Camera position [X, Y, Z] in 3D metric coordinates.'
                },
                targetPosition: {
                    type: 'ARRAY',
                    items: { type: 'NUMBER' },
                    description: 'Focus target / landmark position [X, Y, Z] in 3D metric coordinates.'
                },
                currentFocusDistanceMeters: {
                    type: 'NUMBER',
                    description: 'Previous frame camera focus plane distance in meters (for smooth rack focus interpolation).'
                },
                deltaTimeSec: {
                    type: 'NUMBER',
                    description: 'Time elapsed since previous frame in seconds (default: 1/24).'
                },
                dampingLambda: {
                    type: 'NUMBER',
                    description: 'Rack focus exponential damping coefficient (higher = snappier, default: 8.0).'
                },
                focalLengthMm: {
                    type: 'NUMBER',
                    description: 'Lens focal length in millimeters (default: 50).'
                },
                apertureFStop: {
                    type: 'NUMBER',
                    description: 'Lens aperture f-stop (default: 2.8).'
                },
                sensorFormat: {
                    type: 'STRING',
                    description: 'Sensor format preset (default: full_frame_35mm).'
                }
            },
            required: ['cameraPosition', 'targetPosition']
        }
    }
];

export const physicalCameraHandlers: Record<string, ToolHandler> = {
    async configure_physical_camera(args) {
        const focalLengthMm = Number(args.focalLengthMm ?? 50);
        const apertureFStop = Number(args.apertureFStop ?? 2.8);
        const focusDistanceMeters = args.focusDistanceMeters !== undefined ? Number(args.focusDistanceMeters) : 5.0;
        const sensorFormat = (args.sensorFormat as SensorFormatPreset) ?? 'full_frame_35mm';
        const anamorphicRatio = args.anamorphicRatio !== undefined ? Number(args.anamorphicRatio) : 1.0;
        const enableDepthOfField = args.enableDepthOfField !== undefined ? Boolean(args.enableDepthOfField) : true;

        const config: PhysicalCameraConfig = {
            sensorFormatPreset: sensorFormat,
            sensorWidthMm: args.sensorWidthMm ? Number(args.sensorWidthMm) : undefined,
            sensorHeightMm: args.sensorHeightMm ? Number(args.sensorHeightMm) : undefined,
            focalLengthMm,
            apertureFStop,
            focusDistanceMeters,
            anamorphicRatio,
            enableDepthOfField
        };

        const frustum = PhysicalCameraModel.calculateFrustum(config);
        const hyperfocal = PhysicalCameraModel.calculateHyperfocalDistance(
            focalLengthMm,
            apertureFStop,
            frustum.sensorDimensions.diagonalMm
        );
        const dof = PhysicalCameraModel.calculateDepthOfField(
            focalLengthMm,
            apertureFStop,
            focusDistanceMeters,
            frustum.sensorDimensions.diagonalMm
        );

        return {
            resultPayload: {
                config,
                frustum: {
                    verticalFovDeg: Number(frustum.verticalFovDeg.toFixed(2)),
                    horizontalFovDeg: Number(frustum.horizontalFovDeg.toFixed(2)),
                    diagonalFovDeg: Number(frustum.diagonalFovDeg.toFixed(2)),
                    aspectRatio: Number(frustum.aspectRatio.toFixed(3)),
                    sensorDimensions: frustum.sensorDimensions
                },
                hyperfocalDistanceMeters: Number(hyperfocal.toFixed(3)),
                depthOfField: {
                    nearFocusLimitMeters: Number(dof.nearFocusLimitMeters.toFixed(3)),
                    farFocusLimitMeters: Number(dof.farFocusLimitMeters.toFixed(3)),
                    dofThicknessMeters: Number(dof.dofThicknessMeters.toFixed(3)),
                    hyperfocalDistanceMeters: Number(dof.hyperfocalDistanceMeters.toFixed(3)),
                    isInfinitelyDeep: dof.isInfinitelyDeep
                }
            } as unknown as ToolResultPayload,
            summaryResult: `Configured physical camera (${focalLengthMm}mm, f/${apertureFStop}, ${sensorFormat}): Vertical FOV ${frustum.verticalFovDeg.toFixed(1)}°, Focus ${focusDistanceMeters.toFixed(1)}m, Sharp DoF: [${dof.nearFocusLimitMeters.toFixed(2)}m - ${dof.isInfinitelyDeep ? '∞' : dof.farFocusLimitMeters.toFixed(2) + 'm'}].`
        };
    },

    async camera_track_focus_target(args) {
        const camPos = args.cameraPosition as [number, number, number];
        const targetPos = args.targetPosition as [number, number, number];

        if (!Array.isArray(camPos) || camPos.length < 3 || !Array.isArray(targetPos) || targetPos.length < 3) {
            return {
                resultPayload: { error: 'cameraPosition and targetPosition must be [x, y, z] vectors' } as unknown as ToolResultPayload,
                summaryResult: 'Failed: invalid cameraPosition or targetPosition vectors'
            };
        }

        const focalLengthMm = Number(args.focalLengthMm ?? 50);
        const apertureFStop = Number(args.apertureFStop ?? 2.8);
        const sensorFormat = (args.sensorFormat as SensorFormatPreset) ?? 'full_frame_35mm';
        const deltaTimeSec = Number(args.deltaTimeSec ?? 1.0 / 24.0);
        const dampingLambda = Number(args.dampingLambda ?? 8.0);

        const dx = camPos[0] - targetPos[0];
        const dy = camPos[1] - targetPos[1];
        const dz = camPos[2] - targetPos[2];
        const euclideanDist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        let smoothedFocusDist = euclideanDist;
        if (args.currentFocusDistanceMeters !== undefined) {
            const currentDist = Number(args.currentFocusDistanceMeters);
            const state = PhysicalCameraModel.updateDynamicFocusTracking(
                camPos,
                targetPos,
                currentDist,
                deltaTimeSec,
                dampingLambda
            );
            smoothedFocusDist = state.currentFocusDistanceMeters;
        }

        const sensorDims = PhysicalCameraModel.getSensorDimensions(sensorFormat);
        const dof = PhysicalCameraModel.calculateDepthOfField(
            focalLengthMm,
            apertureFStop,
            smoothedFocusDist,
            sensorDims.diagonalMm
        );

        return {
            resultPayload: {
                evaluatedDistanceMeters: Number(euclideanDist.toFixed(3)),
                smoothedFocusDistanceMeters: Number(smoothedFocusDist.toFixed(3)),
                depthOfField: {
                    nearFocusLimitMeters: Number(dof.nearFocusLimitMeters.toFixed(3)),
                    farFocusLimitMeters: Number(dof.farFocusLimitMeters.toFixed(3)),
                    dofThicknessMeters: Number(dof.dofThicknessMeters.toFixed(3)),
                    isInfinitelyDeep: dof.isInfinitelyDeep
                }
            } as unknown as ToolResultPayload,
            summaryResult: `Tracked focus target at ${euclideanDist.toFixed(2)}m (smoothed ${smoothedFocusDist.toFixed(2)}m). Sharp DoF range: [${dof.nearFocusLimitMeters.toFixed(2)}m - ${dof.isInfinitelyDeep ? '∞' : dof.farFocusLimitMeters.toFixed(2) + 'm'}].`
        };
    }
};

// ============================================================================
// Google DeepMind TAPIR Point Tracking & 4DGS Deformation Declarations & Handlers
// ============================================================================

/**
 * No TAPIR / 4DGS tools are offered: tapir_track_video_points and build_4dgs_from_video took no video and tracked
 * frames they synthesized themselves. TapirTrackingService and GaussianSplat4DService remain for callers that have
 * real frames. The empty pack keeps the registry wiring stable.
 */
export const TAPIR_4DGS_TOOL_DECLARATIONS: ToolDeclaration[] = [];

export const AVATAR_4DGS_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'avatar_4dgs_list',
        description: 'Lists all available Performer 4D Gaussian Splatting dynamic humanoid avatars discovered in the local catalog.',
        parameters: {
            type: 'OBJECT',
            properties: {}
        }
    },
    {
        name: 'avatar_4dgs_get',
        description: 'Retrieves metadata, skeletal joint hierarchy, and geospatial anchoring info for a Performer 4DGS humanoid avatar.',
        parameters: {
            type: 'OBJECT',
            properties: {
                avatarId: {
                    type: 'STRING',
                    description: 'Avatar identifier (e.g., "2785536")'
                }
            },
            required: ['avatarId']
        }
    },
    {
        name: 'avatar_4dgs_animate',
        description: 'Animates and deforms a Performer 4DGS humanoid avatar at a specific motion frame index via skeletal Linear Blend Skinning (LBS).',
        parameters: {
            type: 'OBJECT',
            properties: {
                avatarId: {
                    type: 'STRING',
                    description: 'Avatar identifier (e.g., "2785536")'
                },
                frameIndex: {
                    type: 'NUMBER',
                    description: 'Motion frame index to evaluate (0-indexed)'
                },
                exportSplat: {
                    type: 'BOOLEAN',
                    description: 'Whether to serialize and return the deformed 32-byte .splat binary buffer (default: false)'
                }
            },
            required: ['avatarId', 'frameIndex']
        }
    },
    {
        name: 'avatar_4dgs_retarget',
        description: 'Retargets a recorded motion track onto a 22-joint SB-Human skeletal avatar with ground-contact altitude clamping. The track is the JSON that vfx_mediapipe_track_video_motion writes to its outputJsonPath (per-frame MediaPipe world landmarks or joint angles); the call fails without one, and a dry-run track is refused.',
        parameters: {
            type: 'OBJECT',
            properties: {
                avatarId: {
                    type: 'STRING',
                    description: 'Target avatar identifier'
                },
                motionTrackPath: {
                    type: 'STRING',
                    description: 'Path to the motion track JSON written by vfx_mediapipe_track_video_motion (outputJsonPath).'
                },
                outputMotionPath: {
                    type: 'STRING',
                    description: 'Where to write the retargeted avatar motion JSON (default: next to the track, <track>_retargeted_<avatarId>.json).'
                },
                groundAltitudeMeters: {
                    type: 'NUMBER',
                    description: 'Target floor/ground altitude in meters (default: 0.0)'
                },
                pinFeetToGround: {
                    type: 'BOOLEAN',
                    description: 'Whether to pin lowest foot to ground altitude to prevent penetration (default: true)'
                },
                smoothingWindow: {
                    type: 'NUMBER',
                    description: 'Temporal moving average window size for joint smoothing (default: 3)'
                }
            },
            required: ['avatarId', 'motionTrackPath']
        }
    },
    {
        name: 'performer_4d_create_from_video',
        description: 'Builds a dynamic 4D Gaussian Splatting performer avatar from a monocular video (or a hero image) with tracked motion (GVHMR or MediaPipe), 4-bone LBS skinning, video texture backprojection and foot-contact ground clamping. Geographic venue anchoring happens only when venueId is given. Fails with a typed error when the input is missing/unreadable, no hero frame can be decoded, or no motion can be tracked (unless allowSyntheticIdleMotion is set, in which case the motion is a labelled synthetic idle sway).',
        parameters: {
            type: 'OBJECT',
            properties: {
                videoPath: {
                    type: 'STRING',
                    description: 'Path to an existing, readable performer video (MP4/MOV/WebM/...) or JPEG/PNG hero frame image'
                },
                characterId: {
                    type: 'STRING',
                    description: 'Optional custom character identifier (e.g., "performer_red_rocks_01")'
                },
                targetHeightMeters: {
                    type: 'NUMBER',
                    description: 'Performer height in meters (default: 1.78)'
                },
                numGaussians: {
                    type: 'NUMBER',
                    description: 'Number of surface Gaussians to sample (default: 35000)'
                },
                venueId: {
                    type: 'STRING',
                    description: 'Optional venue id for geodetic stage anchoring (e.g. "red_rocks", "hollywood_bowl", "the_gorge"). Omit for no venue; an unknown id is an error.'
                },
                allowSyntheticIdleMotion: {
                    type: 'BOOLEAN',
                    description: 'Accept a procedural idle sway (labelled synthetic_idle) when no motion can be tracked, e.g. for a still image. Default false: the tool fails instead.'
                },
                fps: {
                    type: 'NUMBER',
                    description: 'Motion tracking sampling framerate (default: 25)'
                }
            },
            required: ['videoPath']
        }
    }
];

export const HUMANOID_AVATAR_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'humanoid_avatar_list',
        description: 'Lists all available humanoid avatars (performer demos, SB-Human models) with their available skinning modalities (PBR polygonal mesh, Melanin-calibrated PBR, 4DGS splats, 2D planar surfels).',
        parameters: {
            type: 'OBJECT',
            properties: {}
        }
    },
    {
        name: 'humanoid_avatar_get',
        description: 'Retrieves comprehensive metadata, skeletal joint hierarchy, available skinning adapters, and bounding dimensions for a humanoid avatar.',
        parameters: {
            type: 'OBJECT',
            properties: {
                actorId: {
                    type: 'STRING',
                    description: 'Humanoid actor identifier (e.g. "2785536", "sbhuman_neutral")'
                }
            },
            required: ['actorId']
        }
    },
    {
        name: 'humanoid_avatar_skin',
        description: 'Evaluates, skins, or exports a humanoid avatar using the chosen skinning modality (pbr-standard, pbr-melanin, 4dgs-radiance, 2dgs-planar-surfel). Can export rigged GLB, SPLAT binary, or PLY.',
        parameters: {
            type: 'OBJECT',
            properties: {
                actorId: {
                    type: 'STRING',
                    description: 'Humanoid actor identifier (e.g. "2785536")'
                },
                modality: {
                    type: 'STRING',
                    description: 'Skinning modality: "pbr-standard", "pbr-melanin", "4dgs-radiance", "2dgs-planar-surfel"'
                },
                melaninFraction: {
                    type: 'NUMBER',
                    description: 'Melanin pigmentation fraction [0.0 = pale, 1.0 = deep dark] for biophysical PBR skin'
                },
                pheomelaninRatio: {
                    type: 'NUMBER',
                    description: 'Pheomelanin warm/reddish ratio [0.0 = neutral/eumelanin, 1.0 = warm/pheomelanin]'
                },
                frameIndex: {
                    type: 'NUMBER',
                    description: 'Optional motion frame index to evaluate (0-indexed)'
                },
                format: {
                    type: 'STRING',
                    description: 'Optional export format: "glb", "splat", "ply"'
                }
            },
            required: ['actorId']
        }
    },
    {
        name: 'humanoid_avatar_animate',
        description: 'Poses a humanoid avatar at one frame of its motion track (motion.json) with 22-joint SB-Human 4-bone Linear Blend Skinning, on the PBR mesh, 4DGS splats or 2DGS triangle surfels. Reports the posed bounds/centroid and where the motion came from (motionSource; "synthetic_idle" means procedural motion, not tracked). Fails if the actor has no motion track or skin weights, the frame is out of range, or the modality has no adapter.',
        parameters: {
            type: 'OBJECT',
            properties: {
                actorId: {
                    type: 'STRING',
                    description: 'Humanoid actor identifier'
                },
                frameIndex: {
                    type: 'NUMBER',
                    description: 'Motion frame index to evaluate (0-indexed)'
                },
                modality: {
                    type: 'STRING',
                    description: 'Skinning modality ("pbr-standard", "pbr-melanin", "pbr-video-projected", "4dgs-radiance", "2dgs-planar-surfel"; default: "pbr-standard")'
                },
            },
            required: ['actorId', 'frameIndex']
        }
    }
];

export const tapir4dgsHandlers: Record<string, ToolHandler> = {};

/**
 * Reads a motion track JSON (VideoMotionTrackResult, as vfx_mediapipe_track_video_motion writes it). Fails when the
 * file is missing, is a dry run, or has a frame with neither world landmarks nor joint angles.
 */
async function readMotionTrack(tool: string, value: unknown): Promise<import('../../video/MediaPipeVideoDirectorService').VideoMotionTrackResult> {
    const trackPath = asString(value);
    if (!trackPath) throw new MissingInputError(tool, 'motionTrackPath', 'give the motion track JSON from vfx_mediapipe_track_video_motion (outputJsonPath); no motion is assumed');
    const fsMod = await import('fs-extra');
    if (!(await fsMod.pathExists(trackPath))) throw new MissingInputError(tool, 'motionTrackPath', `${trackPath} does not exist`);
    let track: any;
    try {
        track = await fsMod.readJson(trackPath);
    } catch (err: any) {
        throw new MissingInputError(tool, 'motionTrackPath', `${trackPath} is not JSON (${err?.message || err})`);
    }
    if (track?.dryRun) throw new MissingInputError(tool, 'motionTrackPath', `${trackPath} is a dry-run plan, not a tracked motion`);
    if (track?.success === false) throw new MissingInputError(tool, 'motionTrackPath', `${trackPath} records a failed tracking run${track.error ? `: ${track.error}` : ''}`);
    const frames = Array.isArray(track?.frames) ? track.frames : [];
    if (!frames.length) throw new MissingInputError(tool, 'motionTrackPath', `${trackPath} has no frames`);
    // Every frame must be a MediaPipe detection: tracks written before detections were marked (which filled frames
    // with no person with a canned standing pose) and frames without a solved pose are refused.
    const undetected = frames.findIndex((f: any) => f?.detected !== true);
    if (undetected >= 0) {
        throw new MissingInputError(tool, 'motionTrackPath', `frame ${undetected} of ${trackPath} is not marked as a MediaPipe detection (a stand-in pose, or a track written before detections were recorded); track the video again with vfx_mediapipe_track_video_motion`);
    }
    const unusable = frames.findIndex((f: any) => !((f?.worldLandmarks?.length ?? 0) >= 33
        || (f?.angles && typeof f.angles === 'object' && Object.keys(f.angles).length > 0)));
    if (unusable >= 0) throw new MissingInputError(tool, 'motionTrackPath', `frame ${unusable} of ${trackPath} has neither 33 world landmarks nor joint angles`);
    if (!(Number(track.sampleFps) > 0)) throw new MissingInputError(tool, 'motionTrackPath', `${trackPath} does not record its sampleFps`);
    return track;
}

export const avatar4dgsHandlers: Record<string, ToolHandler> = {
    async avatar_4dgs_list(_args) {
        const service = new Dynamic4DGaussianSplatService();
        const avatars = service.listAvatars();
        return {
            resultPayload: {
                totalAvatars: avatars.length,
                avatars
            } as unknown as ToolResultPayload,
            summaryResult: `Found ${avatars.length} Performer 4DGS avatars (${avatars.map(a => a.id).join(', ')}).`
        };
    },

    async avatar_4dgs_get(args) {
        // The avatar is the one named; there is no demo avatar to load instead.
        const avatarId = asString(args.avatarId);
        if (!avatarId) throw new MissingInputError('avatar_4dgs_get', 'avatarId', 'name the avatar (avatar_4dgs_list lists them)');
        const service = new Dynamic4DGaussianSplatService();
        const { details, motion } = service.loadAvatar(avatarId);
        return {
            resultPayload: {
                details,
                joints: motion.joints_name,
                canonicalJoints: motion.canonical_joints,
                kintreeParents: motion.kintree_parents,
                numFrames: motion.num_frames,
                fps: motion.fps
            } as unknown as ToolResultPayload,
            summaryResult: `Loaded Performer avatar "${details.title}" (${avatarId}): ${details.numSplats} Gaussians, ${details.numFrames} frames @ ${details.fps} FPS, ${details.numJoints} joints.`
        };
    },

    async avatar_4dgs_animate(args) {
        const avatarId = asString(args.avatarId);
        if (!avatarId) throw new MissingInputError('avatar_4dgs_animate', 'avatarId', 'name the avatar (avatar_4dgs_list lists them)');
        if (typeof args.frameIndex !== 'number' || !Number.isInteger(args.frameIndex) || args.frameIndex < 0) {
            throw new MissingInputError('avatar_4dgs_animate', 'frameIndex', `a frame index of 0 or more (got ${JSON.stringify(args.frameIndex)})`);
        }
        const frameIndex = args.frameIndex;
        const exportSplat = Boolean(args.exportSplat ?? false);

        const service = new Dynamic4DGaussianSplatService();
        const frame = service.animateFrame(avatarId, frameIndex);

        let splatBase64: string | undefined;
        let splatByteLength: number | undefined;
        if (exportSplat) {
            const splatBuf = service.exportSplatBuffer(avatarId, frameIndex);
            splatBase64 = splatBuf.toString('base64');
            splatByteLength = splatBuf.byteLength;
        }

        return {
            resultPayload: {
                avatarId: frame.avatarId,
                frameIndex: frame.frameIndex,
                timestamp: frame.timestamp,
                numSplats: frame.numSplats,
                bounds: frame.bounds,
                centroid: frame.centroid,
                rootTranslation: frame.rootTranslation,
                rootRotation: frame.rootRotation,
                splatByteLength,
                splatBase64Preview: splatBase64 ? splatBase64.slice(0, 100) + '...' : undefined
            } as unknown as ToolResultPayload,
            summaryResult: `Animated avatar ${avatarId} at frame ${frame.frameIndex} (t=${frame.timestamp.toFixed(2)}s): ${frame.numSplats} deformed Gaussians, bounds=[${frame.bounds.min.map(v => v.toFixed(2)).join(',')} to ${frame.bounds.max.map(v => v.toFixed(2)).join(',')}]${splatByteLength ? `, exported ${splatByteLength} bytes .splat` : ''}.`
        };
    },

    async avatar_4dgs_retarget(args) {
        const avatarId = asString(args.avatarId);
        if (!avatarId) throw new MissingInputError('avatar_4dgs_retarget', 'avatarId', 'name the avatar to retarget onto (avatar_4dgs_list lists them)');
        const track = await readMotionTrack('avatar_4dgs_retarget', args.motionTrackPath);
        const groundAlt = Number(args.groundAltitudeMeters ?? 0.0);
        const pinFeet = args.pinFeetToGround !== undefined ? Boolean(args.pinFeetToGround) : true;
        const smoothingWindow = Number(args.smoothingWindow ?? 3);

        const splatService = new Dynamic4DGaussianSplatService();
        const { motion } = splatService.loadAvatar(avatarId);

        const bridgeService = new HumanoidMotionBridgeService();
        const retargeted = bridgeService.retargetVideoMotionTrack(track, motion.canonical_joints, {
            groundAltitudeMeters: groundAlt,
            pinFeetToGround: pinFeet,
            smoothingWindow
        });
        const landmarkFrames = track.frames.filter(f => (f.worldLandmarks?.length ?? 0) >= 33).length;
        const trackPath = asString(args.motionTrackPath);
        const outputMotionPath = asString(args.outputMotionPath)
            || path.join(path.dirname(trackPath), `${path.basename(trackPath, path.extname(trackPath))}_retargeted_${avatarId}.json`);
        const fsMod = await import('fs-extra');
        await fsMod.outputJson(outputMotionPath, retargeted);

        return {
            resultPayload: {
                avatarId,
                motionTrackPath: trackPath,
                numFramesRetargeted: retargeted.num_frames,
                sampleFps: track.sampleFps,
                framesFromWorldLandmarks: landmarkFrames,
                framesFromJointAngles: track.frames.length - landmarkFrames,
                trackAverageConfidence: track.averageConfidence,
                groundAltitudeMeters: groundAlt,
                feetPinned: pinFeet,
                firstFrameJoint0: retargeted.frames[0]?.joint_positions_3d[0],
                firstFrameFootY: Math.min(
                    retargeted.frames[0]?.joint_positions_3d[10][1] ?? 0,
                    retargeted.frames[0]?.joint_positions_3d[11][1] ?? 0
                ),
                outputMotionPath
            } as unknown as ToolResultPayload,
            summaryResult: `Retargeted ${retargeted.num_frames} frame(s) of ${trackPath} onto avatar ${avatarId} (${landmarkFrames} from world landmarks, ${track.frames.length - landmarkFrames} from joint angles)${pinFeet ? `, feet pinned to ${groundAlt} m` : ''}.`
                + (Array.isArray(track.undetectedFrames) && track.undetectedFrames.length ? ` ${track.undetectedFrames.length} sampled frame(s) had no detected person and are not in the motion.` : '')
                + ` Wrote the avatar motion (SB-Human 22-joint) to ${outputMotionPath}.`
        };
    },

    async performer_4d_create_from_video(args) {
        const videoPath = asString(args.videoPath);
        const characterId = args.characterId ? asString(args.characterId) : undefined;
        const targetHeightMeters = args.targetHeightMeters ? Number(args.targetHeightMeters) : undefined;
        const numGaussians = args.numGaussians ? Number(args.numGaussians) : undefined;
        const venueId = args.venueId ? asString(args.venueId) : undefined;
        const fps = args.fps ? Number(args.fps) : undefined;
        const allowSyntheticIdleMotion = args.allowSyntheticIdleMotion === true;
        VideoTo4DPerformerPipelineService.assertReadableInput(videoPath);

        const pipeline = new VideoTo4DPerformerPipelineService();
        const result = await pipeline.executePipeline({
            videoPath,
            characterId,
            targetHeightMeters,
            numGaussians,
            venueId,
            fps,
            allowSyntheticIdleMotion
        });

        const motionSource = result.telemetry.motionSource ?? 'unlabelled';
        const motionText = result.telemetry.syntheticMotion
            ? `${result.numFrames} motion frames of SYNTHETIC procedural idle sway (not tracked from the input)`
            : `${result.numFrames} motion frames (source: ${motionSource})`;
        const venueText = result.venueAnchor
            ? `, anchored at ${result.venueAnchor.venueName} (alt: ${result.venueAnchor.altitudeMsl}m MSL)`
            : ', no venue anchor';
        return {
            resultPayload: result as unknown as ToolResultPayload,
            summaryResult: `Built 4D performer "${result.characterId}": ${result.numGaussians} Gaussians rigged with 4-bone LBS, ${motionText}${venueText}. PLY: ${result.plyPath}, SPLAT: ${result.splatPath}${result.glbPath ? `, Rigged PBR GLB: ${result.glbPath}` : ''}`
        };
    }
};

/** The actor a humanoid tool acts on: the one named, never a demo actor. */
function requiredActorId(tool: string, args: Record<string, unknown>): string {
    const actorId = asString(args.actorId || args.avatarId);
    if (!actorId) throw new MissingInputError(tool, 'actorId', 'name the actor (humanoid_avatar_list lists them)');
    return actorId;
}

export const humanoidAvatarHandlers: Record<string, ToolHandler> = {
    async humanoid_avatar_list(_args) {
        const service = new SbHumanAvatarService();
        const actors = await service.listActors();
        return {
            resultPayload: {
                totalActors: actors.length,
                actors
            } as unknown as ToolResultPayload,
            summaryResult: `Found ${actors.length} humanoid actors (${actors.map(a => a.actorId).join(', ')}) with pluggable multi-modality skinning support.`
        };
    },

    async humanoid_avatar_get(args) {
        const actorId = requiredActorId('humanoid_avatar_get', args);
        const service = new SbHumanAvatarService();
        const actor = await service.getActor(actorId);
        if (!actor) {
            throw new MissingInputError('humanoid_avatar_get', 'actorId', `no actor "${actorId}" is installed (humanoid_avatar_list lists them)`);
        }
        return {
            resultPayload: {
                actor
            } as unknown as ToolResultPayload,
            summaryResult: `Retrieved actor "${actor.name}" (${actorId}): modalities=[${actor.availableModalities.join(', ')}], joints=${actor.canonicalJoints.length}, frames=${actor.frameCount}.`
        };
    },

    async humanoid_avatar_skin(args) {
        const actorId = requiredActorId('humanoid_avatar_skin', args);
        const modality = asString(args.modality, 'pbr-standard') as any;
        const melaninFraction = args.melaninFraction !== undefined ? Number(args.melaninFraction) : undefined;
        const pheomelaninRatio = args.pheomelaninRatio !== undefined ? Number(args.pheomelaninRatio) : undefined;
        const frameIndex = args.frameIndex !== undefined ? Number(args.frameIndex) : 0;
        const format = args.format ? asString(args.format, 'glb') as any : undefined;

        const service = new SbHumanAvatarService();
        const adapter = await service.getSkinAdapter(actorId, modality);

        let artifactBuffer: Buffer | Uint8Array | undefined;
        if (format || args.exportArtifact) {
            artifactBuffer = await adapter.exportArtifact({
                modality,
                format,
                frameIndex,
                melaninFraction,
                pheomelaninRatio
            });
        }

        // Without a frameIndex a PBR actor reports its rest mesh; a posed frame needs its motion track.
        let frameResult: { vertexCount?: number; gaussianCount?: number };
        let evaluated: string;
        if (args.frameIndex === undefined && adapter instanceof PbrMeshSkinAdapter) {
            const rest = await adapter.loadRestMesh();
            frameResult = { vertexCount: rest.positions.length / 3 };
            evaluated = 'rest pose';
        } else {
            frameResult = await adapter.evaluateFrame(frameIndex);
            evaluated = `motion frame ${frameIndex}`;
        }
        return {
            resultPayload: {
                actorId,
                modality,
                frameIndex: evaluated === 'rest pose' ? undefined : frameIndex,
                pose: evaluated,
                vertexCount: frameResult.vertexCount,
                gaussianCount: frameResult.gaussianCount,
                artifactBytes: artifactBuffer ? artifactBuffer.byteLength : undefined,
                artifactBase64Preview: artifactBuffer ? Buffer.from(artifactBuffer).subarray(0, 64).toString('hex') : undefined
            } as unknown as ToolResultPayload,
            summaryResult: `Evaluated actor "${actorId}" (${evaluated}) with skin modality "${modality}": ${frameResult.vertexCount ?? frameResult.gaussianCount ?? 0} geometric elements${artifactBuffer ? `, exported ${artifactBuffer.byteLength} bytes (${format || 'artifact'})` : ''}.`
        };
    },

    async humanoid_avatar_animate(args) {
        const actorId = requiredActorId('humanoid_avatar_animate', args);
        if (typeof args.frameIndex !== 'number' || !Number.isInteger(args.frameIndex) || args.frameIndex < 0) {
            throw new MissingInputError('humanoid_avatar_animate', 'frameIndex', `a frame index of 0 or more (got ${JSON.stringify(args.frameIndex)})`);
        }
        const frameIndex = args.frameIndex;
        const modality = asString(args.modality, 'pbr-standard') as any;
        const service = new SbHumanAvatarService();
        const frame = await service.evaluateActorFrame(actorId, frameIndex, modality);
        const synthetic = frame.motionSource === 'synthetic_idle';
        const fmt = (v: number[] | undefined) => (v ? v.map(x => x.toFixed(3)).join(',') : '?');

        return {
            resultPayload: {
                actorId,
                frameIndex: frame.frameIndex,
                timestamp: frame.timestamp,
                modality,
                motionSource: frame.motionSource,
                syntheticMotion: synthetic,
                vertexCount: frame.vertexCount,
                gaussianCount: frame.gaussianCount,
                bounds: frame.bounds,
                centroid: frame.centroid
            } as unknown as ToolResultPayload,
            summaryResult: `LBS-posed actor "${actorId}" at motion frame ${frame.frameIndex}${frame.timestamp !== undefined ? ` (t=${frame.timestamp.toFixed(2)}s)` : ''} with modality "${modality}": ${frame.vertexCount ?? frame.gaussianCount ?? 0} elements, bounds=[${fmt(frame.bounds?.min)} to ${fmt(frame.bounds?.max)}]; motion source: ${frame.motionSource ?? 'unlabelled'}${synthetic ? ' (SYNTHETIC procedural motion, not tracked from video)' : ''}.`
        };
    }
};

// Merge humanoid avatar handlers into avatar4dgsHandlers for transparent unified routing
Object.assign(avatar4dgsHandlers, humanoidAvatarHandlers);

// ============================================================================
// Analytical Hair Groom & 3D Gaussian Splat Declarations & Handlers
// ============================================================================

export const ANALYTICAL_GROOM_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'splat_synthesize_analytical_groom',
        description: 'Synthesize biophysical hair grooming and forward-project into anisotropic 3D Gaussian Splats (.spz, .ply, .glb) using native C++20 Astro hair and SPZ engines. Takes continuous descriptors only (fill them from your reading of the request; nothing is inferred from words): the harmonic surface r(theta, phi) (baseRadius, harmonicFrequency, harmonicAmplitude, axialTaper), strand length, and pigment as Marschner melanin (eumelanin + pheomelanin) or an explicit baseColorRgb are required. Curl, wave, clumping and taper left out are neutral (none). Missing required descriptors fail with an error naming them.',
        parameters: {
            type: 'OBJECT',
            properties: {
                baseRadius: {
                    type: 'NUMBER',
                    description: 'Metric base radius in meters (> 0).'
                },
                harmonicFrequency: {
                    type: 'NUMBER',
                    description: 'Integer azimuthal harmonic frequency m >= 0: the number of radial lobes (0 = rotationally smooth).'
                },
                harmonicAmplitude: {
                    type: 'NUMBER',
                    description: 'Lobe modulation amplitude A in [0, 1] (0 = no lobes).'
                },
                axialTaper: {
                    type: 'NUMBER',
                    description: 'Vertical axial taper in [-1, 1] (default 0, none; positive narrows the top pole).'
                },
                strandCount: {
                    type: 'NUMBER',
                    description: 'Number of dense synthesized strands (default: 4096)'
                },
                guideCount: {
                    type: 'NUMBER',
                    description: 'Number of sparse guide curves (default: 64)'
                },
                length: {
                    type: 'NUMBER',
                    description: 'Physical strand length in meters (> 0).'
                },
                clumping: {
                    type: 'NUMBER',
                    description: 'Voronoi cluster tip clumping factor in [0, 1] (default 0, none).'
                },
                curlRadius: {
                    type: 'NUMBER',
                    description: 'Helical curl radius in meters (default 0, straight).'
                },
                curlFrequency: {
                    type: 'NUMBER',
                    description: 'Curl frequency along strand length (default 0).'
                },
                waveAmplitude: {
                    type: 'NUMBER',
                    description: 'Planar wave amplitude in meters (default 0, none).'
                },
                waveFrequency: {
                    type: 'NUMBER',
                    description: 'Planar wave frequency along strand length (default 0).'
                },
                eumelanin: {
                    type: 'NUMBER',
                    description: 'Marschner dark brown/black pigment in [0, 1]. Give with pheomelanin, or give baseColorRgb instead.'
                },
                pheomelanin: {
                    type: 'NUMBER',
                    description: 'Marschner red/auburn pigment in [0, 1]. Give with eumelanin, or give baseColorRgb instead.'
                },
                baseColorRgb: {
                    type: 'ARRAY',
                    description: 'Custom follicle root RGB [r, g, b] in [0, 1] (overrides melanin; uniform root to tip unless tipColorRgb is given)',
                    items: { type: 'NUMBER' }
                },
                tipColorRgb: {
                    type: 'ARRAY',
                    description: 'Optional custom strand tip RGB [r, g, b] in [0, 1] (needs baseColorRgb)',
                    items: { type: 'NUMBER' }
                },
                splatScaleMultiplier: {
                    type: 'NUMBER',
                    description: 'Anisotropic splat thickness scaling multiplier (default: 1.0)'
                },
                exportFormat: {
                    type: 'STRING',
                    description: 'Export format: "spz", "ply", "glb", or "all" (default: "spz")',
                    enum: ['spz', 'ply', 'glb', 'all']
                }
            },
            required: ['baseRadius', 'harmonicFrequency', 'harmonicAmplitude', 'length']
        }
    }
];

export const analyticalGroomHandlers: Record<string, ToolHandler> = {
    async splat_synthesize_analytical_groom(args) {
        const service = AnalyticalGroomSplatService.getInstance();
        const contract = service.buildContract({
            surface: {
                baseRadius: typeof args.baseRadius === 'number' ? args.baseRadius : undefined,
                harmonicFrequency: typeof args.harmonicFrequency === 'number' ? args.harmonicFrequency : undefined,
                harmonicAmplitude: typeof args.harmonicAmplitude === 'number' ? args.harmonicAmplitude : undefined,
                axialTaper: typeof args.axialTaper === 'number' ? args.axialTaper : undefined
            },
            groom: {
                strandCount: typeof args.strandCount === 'number' ? args.strandCount : undefined,
                guideCount: typeof args.guideCount === 'number' ? args.guideCount : undefined,
                length: typeof args.length === 'number' ? args.length : undefined,
                clumping: typeof args.clumping === 'number' ? args.clumping : undefined,
                curlRadius: typeof args.curlRadius === 'number' ? args.curlRadius : undefined,
                curlFrequency: typeof args.curlFrequency === 'number' ? args.curlFrequency : undefined,
                waveAmplitude: typeof args.waveAmplitude === 'number' ? args.waveAmplitude : undefined,
                waveFrequency: typeof args.waveFrequency === 'number' ? args.waveFrequency : undefined,
                eumelanin: typeof args.eumelanin === 'number' ? args.eumelanin : undefined,
                pheomelanin: typeof args.pheomelanin === 'number' ? args.pheomelanin : undefined,
                baseColorRgb: Array.isArray(args.baseColorRgb) ? args.baseColorRgb as [number, number, number] : undefined,
                tipColorRgb: Array.isArray(args.tipColorRgb) ? args.tipColorRgb as [number, number, number] : undefined
            },
            splat: {
                scaleMultiplier: typeof args.splatScaleMultiplier === 'number' ? args.splatScaleMultiplier : undefined,
                exportFormat: (args.exportFormat as any) || 'spz'
            }
        }, 'splat_synthesize_analytical_groom');

        const result = await service.executeGroomSplat(contract);
        if (!result.success) {
            throw new Error(`Failed to synthesize analytical groom splat: ${result.error}`);
        }

        return {
            resultPayload: result as unknown as ToolResultPayload,
            summaryResult: `Successfully synthesized ${result.splatCount} anisotropic 3D Gaussian Splats from ${result.strandCount} biophysical strands (harmonic freq: ${contract.surface.harmonicFrequency ?? 0}, amplitude: ${contract.surface.harmonicAmplitude ?? 0}) in ${result.executionTimeMs}ms. SPZ: ${result.spzPath || 'N/A'}`
        };
    },
    streetview_grounding_image: async (args, ctx) => {
        const fs = await import('fs');
        const lat = typeof args.lat === 'number' ? args.lat : undefined;
        const lng = typeof args.lng === 'number' ? args.lng : undefined;
        let panoId = asString(args.panoId);
        let pano: GooglePano | undefined;
        if (!panoId) {
            if (lat === undefined || lng === undefined) throw new Error('Give a panoId, or lat and lng.');
            pano = await StreetViewGroundingImageService.findGooglePano(lat, lng, MapsImageryGroundingService.resolveApiKey());
            panoId = pano.panoId;
        }
        const service = createStreetViewGroundingImageService(new GeminiClient());
        const shot = await service.retrieveGroundingImage({
            panoId,
            headingDegree: typeof args.headingDegree === 'number' ? args.headingDegree : undefined,
            pitchDegree: typeof args.pitchDegree === 'number' ? args.pitchDegree : undefined,
            fovDegree: typeof args.fovDegree === 'number' ? args.fovDegree : undefined,
            aspectRatio: GROUNDING_ASPECT_RATIOS.includes(args.aspectRatio as GroundingAspectRatio) ? args.aspectRatio as GroundingAspectRatio : undefined
        });
        const dir = path.join(ctx.workspaceRoot, 'build', 'streetview-grounding');
        fs.mkdirSync(dir, { recursive: true });
        const ext = shot.mimeType.includes('png') ? 'png' : 'jpg';
        const file = path.join(dir, `${panoId.replace(/[^A-Za-z0-9_-]/g, '_')}_h${Math.round(shot.headingDegree)}_p${Math.round(shot.pitchDegree)}_f${Math.round(shot.fovDegree)}.${ext}`);
        fs.writeFileSync(file, shot.image);
        return {
            resultPayload: {
                imagePath: path.relative(ctx.workspaceRoot, file),
                panoId,
                panoLocation: pano ? { lat: pano.lat, lng: pano.lng, date: pano.date } : undefined,
                headingDegree: shot.headingDegree,
                pitchDegree: shot.pitchDegree,
                fovDegree: shot.fovDegree,
                mimeType: shot.mimeType,
                bytes: shot.image.length,
                permittedForGenerativeMedia: true
            } as unknown as ToolResultPayload,
            summaryResult: `Saved redacted Street View image of pano ${panoId} (heading ${shot.headingDegree}°) to ${path.relative(ctx.workspaceRoot, file)}.`
        };
    },
    maps_imagery_grounding_pano: async (args, _ctx) => {
        const prompt = asString(args.prompt);
        const panoId = asString(args.panoId);
        const lat = typeof args.lat === 'number' ? args.lat : undefined;
        const lng = typeof args.lng === 'number' ? args.lng : undefined;
        const canvasWidth = typeof args.canvasWidth === 'number' ? args.canvasWidth : 2048;
        const canvasHeight = typeof args.canvasHeight === 'number' ? args.canvasHeight : 1024;
        const outputImagePath = asString(args.outputImagePath);

        const result = await MapsImageryGroundingService.groundAndProjectStreetViewPanorama({
            prompt: prompt || undefined,
            panoId: panoId || undefined,
            lat,
            lng,
            canvasWidth,
            canvasHeight,
            outputPath: outputImagePath || undefined
        });

        if (!result.success) {
            throw new Error(`Maps Imagery Grounding failed: ${result.error}`);
        }

        return {
            resultPayload: result as unknown as ToolResultPayload,
            summaryResult: `Successfully grounded & projected Street View panorama for panoId "${result.panoId}". ERP canvas saved to: ${(result as any).outputPath || (result as any).erpPath || 'saved'} (${result.erpWidth}x${result.erpHeight}). Date: ${result.captureDate || (result as any).date || 'Historical'}, Lat/Lng: ${result.lat}, ${result.lng}.`
        };
    },
    stage_3d_vector_world: async (args, _ctx) => {
        const { lat: latitude, lng: longitude } = readCoordinateArgs('stage_3d_vector_world', args.latitude, args.longitude);
        const zoom = typeof args.zoom === 'number' ? args.zoom : 16;
        const radiusTiles = typeof args.radiusTiles === 'number' ? args.radiusTiles : 1;
        const style = asString(args.style) || 'studio_clay';
        const outputGlbPath = asString(args.outputGlbPath);
        const populate = args.populate !== false;
        const includeTraffic = args.includeTraffic === true;
        const includeStreetlamps = args.includeStreetlamps !== false;
        const includeSidewalks = args.includeSidewalks !== false;
        const heroStaging = args.heroStaging && typeof args.heroStaging === 'object' ? args.heroStaging as any : undefined;

        if (populate) {
            const { VectorWorldPopulatorService } = await import('../../spatial/VectorWorldPopulatorService');
            const result = await VectorWorldPopulatorService.generatePopulatedWorld({
                latitude,
                longitude,
                zoom,
                radiusTiles,
                style,
                outputGlbPath: outputGlbPath || undefined,
                includeTraffic,
                includeStreetlamps,
                includeSidewalks,
                heroStaging
            });

            const heroSummary = result.heroPlacement
                ? ` Hero Placement solved: [${result.heroPlacement.position.map(n => n.toFixed(2)).join(', ')}], yaw: ${result.heroPlacement.headingDeg.toFixed(1)}° on ${result.heroPlacement.targetSurface}.`
                : '';

            let mountedArtifact: any = undefined;
            if (_ctx.request?.activeArtifact?.type === '3d-scene') {
                const prevArtifact = _ctx.request.activeArtifact;
                const prevData = (prevArtifact.data as any) || {};
                const prevObjects = Array.isArray(prevData.objects) ? [...prevData.objects] : [];
                const vectorWorldObj = {
                    id: `vector-world-${Date.now()}`,
                    content: {
                        type: '3d-model',
                        durableUri: result.glbPath,
                        mimeType: 'model/gltf-binary',
                        metadata: {
                            source: 'GoogleVectorTileService',
                            latitude,
                            longitude,
                            buildingCount: result.stats.buildingCount,
                            roadSegmentCount: result.stats.roadSegmentCount,
                            streetlampCount: result.stats.streetlampCount,
                            trafficVehicleCount: result.stats.trafficVehicleCount,
                            trafficSynthetic: result.stats.trafficSynthetic,
                            flatFootprintCount: result.stats.flatFootprintCount,
                            vertexCount: result.stats.vertexCount,
                            triangleCount: result.stats.triangleCount
                        }
                    },
                    space: { spatial3d: { x: 0, y: 0, z: 0 } },
                    time: { startMs: 0, durationMs: 20000 },
                    lineage: { version: 1 }
                };
                mountedArtifact = {
                    ...prevArtifact,
                    version: (prevArtifact.version || 1) + 1,
                    title: `${prevArtifact.title || '3D Scene'} — Staged at [${latitude.toFixed(4)}, ${longitude.toFixed(4)}]`,
                    summary: `Staged active 3D asset with real-world Google Vector Tiles world population (${result.stats.buildingCount} buildings, ${result.stats.roadSegmentCount} road segments in 18% Studio Grey Clay).`,
                    data: {
                        ...prevData,
                        groundTileMode: 'vector-world-clay',
                        geoAnchor: { lat: latitude, lng: longitude, active: true },
                        objects: [...prevObjects, vectorWorldObj]
                    }
                };
            }

            return {
                resultPayload: {
                    ...result,
                    ...(mountedArtifact ? { artifact: mountedArtifact } : {})
                } as unknown as ToolResultPayload,
                summaryResult: `Staged populated 3D vector world in 18% Studio Grey Clay at [${latitude}, ${longitude}]: ${result.stats.buildingCount} extruded buildings (heights: ${Object.entries(result.stats.heightSources).filter(([k]) => k !== 'none').map(([k, n]) => `${n} ${k}`).join(', ') || 'none'})`
                    + `${result.stats.flatFootprintCount ? `, ${result.stats.flatFootprintCount} footprints with no height data drawn flat` : ''}`
                    + `${result.stats.fusion.skipped ? ` (Solar DSM fusion skipped: ${result.stats.fusion.skipped}; vector heights only)` : `, ${result.stats.fusion.buildingsFused} seated on the Solar DSM`}`
                    + `, ${result.stats.roadSegmentCount} road cross-sections, ${result.stats.streetlampCount} streetlamps`
                    + `${result.stats.trafficVehicleCount ? `, ${result.stats.trafficVehicleCount} SYNTHETIC vehicles (seeded placement ${result.stats.trafficSeed}, not observed traffic)` : ''}`
                    + `, ${result.stats.waterPolygonCount} water polygons; GLB ${result.stats.vertexCount} vertices, ${result.stats.triangleCount} triangles: ${result.glbPath}.${heroSummary}`
            };
        } else {
            const result = await GoogleVectorTileService.stage3DVectorWorld({
                latitude,
                longitude,
                zoom,
                radiusTiles,
                style,
                outputGlbPath: outputGlbPath || undefined
            });

            if (!result.success) {
                throw new Error(`3D Vector Tile staging failed: ${(result as any).error || 'unknown error'}`);
            }

            let mountedArtifact: any = undefined;
            if (_ctx.request?.activeArtifact?.type === '3d-scene') {
                const prevArtifact = _ctx.request.activeArtifact;
                const prevData = (prevArtifact.data as any) || {};
                const prevObjects = Array.isArray(prevData.objects) ? [...prevData.objects] : [];
                const vectorWorldObj = {
                    id: `vector-world-${Date.now()}`,
                    content: {
                        type: '3d-model',
                        durableUri: (result as any).glbPath || (result as any).outputGlbPath,
                        mimeType: 'model/gltf-binary',
                        metadata: {
                            source: 'GoogleVectorTileService',
                            latitude,
                            longitude,
                            buildingCount: result.stats.buildingCount,
                            roadSegmentCount: result.stats.roadSegmentCount,
                            vertexCount: result.stats.vertexCount,
                            triangleCount: result.stats.triangleCount
                        }
                    },
                    space: { spatial3d: { x: 0, y: 0, z: 0 } },
                    time: { startMs: 0, durationMs: 20000 },
                    lineage: { version: 1 }
                };
                mountedArtifact = {
                    ...prevArtifact,
                    version: (prevArtifact.version || 1) + 1,
                    title: `${prevArtifact.title || '3D Scene'} — Staged at [${latitude.toFixed(4)}, ${longitude.toFixed(4)}]`,
                    summary: `Staged active 3D asset with real-world Google Vector Tiles massing (${result.stats.buildingCount} buildings, ${result.stats.roadSegmentCount} road segments in 18% Studio Grey Clay).`,
                    data: {
                        ...prevData,
                        groundTileMode: 'vector-world-clay',
                        geoAnchor: { lat: latitude, lng: longitude, active: true },
                        objects: [...prevObjects, vectorWorldObj]
                    }
                };
            }

            return {
                resultPayload: {
                    ...result,
                    ...(mountedArtifact ? { artifact: mountedArtifact } : {})
                } as unknown as ToolResultPayload,
                summaryResult: `Successfully staged 3D vector world in 18% Studio Grey Clay at [${latitude}, ${longitude}]. Extruded ${result.stats.buildingCount} buildings, ${result.stats.roadSegmentCount} road segments, and ${result.stats.waterPolygonCount} water polygons into standard binary GLB (${result.stats.vertexCount} vertices, ${result.stats.triangleCount} triangles). GLB: ${(result as any).glbPath || (result as any).outputGlbPath}`
            };
        }
    },
    query_spatial_vector_data: async (args, _ctx) => {
        const { lat: latitude, lng: longitude } = readCoordinateArgs('query_spatial_vector_data', args.latitude, args.longitude);
        const elevation = typeof args.elevation === 'number' ? args.elevation : 0.0;
        const radiusMeters = typeof args.radiusMeters === 'number' ? args.radiusMeters : 250;
        const queryType = asString(args.queryType) || 'overview';
        const targetFeatureId = asString(args.targetFeatureId);
        const mobilityAffinity = asString(args.mobilityAffinity);
        const footprintRadiusM = typeof args.footprintRadiusM === 'number' ? args.footprintRadiusM : undefined;
        const preferredSurface = asString(args.preferredSurface);
        const localPoint = Array.isArray(args.localPoint) && args.localPoint.length >= 3
            ? [args.localPoint[0], args.localPoint[1], args.localPoint[2]] as [number, number, number]
            : undefined;

        const rawLayers = Array.isArray(args.layers) ? args.layers.map(l => String(l).toLowerCase()) : [];
        const layers = rawLayers.length > 0 ? (rawLayers as any[]) : undefined;

        const { SpatialVectorDataService } = await import('../../spatial/SpatialVectorDataService');
        const dataset = await SpatialVectorDataService.querySpatialVectorData({
            latitude,
            longitude,
            elevation,
            radiusMeters,
            layers
        });

        if (queryType === 'building_at_point' && localPoint) {
            const building = SpatialVectorDataService.queryBuildingAt(dataset, localPoint);
            return {
                resultPayload: {
                    queryType,
                    localPoint,
                    building: building || null,
                    found: !!building
                } as unknown as ToolResultPayload,
                summaryResult: building
                    ? `Found building at [${localPoint.join(', ')}]: ${building.name || building.universalId} (Area: ${building.areaM2}m², Verified Height: ${building.heightM !== null ? building.heightM + 'm' : 'unverified/null'}). Universal ID: ${building.universalId}`
                    : `No building footprint contains local point [${localPoint.join(', ')}].`
            };
        }

        if (queryType === 'nearest_road' && localPoint) {
            const nearest = SpatialVectorDataService.queryNearestRoad(dataset, localPoint);
            return {
                resultPayload: {
                    queryType,
                    localPoint,
                    nearestRoad: nearest || null,
                    found: !!nearest
                } as unknown as ToolResultPayload,
                summaryResult: nearest
                    ? `Nearest road to [${localPoint.join(', ')}]: ${nearest.road.name || nearest.road.universalId} (${nearest.road.roadClass}) at ${nearest.distanceM}m distance. Closest Lane: ${nearest.laneIndex}/${nearest.road.lanes}, Heading: ${nearest.headingDeg}°.`
                    : `No road corridor found within dataset bounds.`
            };
        }

        if (queryType === 'excavation_stencil') {
            const building = targetFeatureId
                ? (SpatialVectorDataService.getFeatureById(dataset, targetFeatureId) as any)
                : (localPoint ? SpatialVectorDataService.queryBuildingAt(dataset, localPoint) : dataset.buildings[0]);

            if (!building || building.layer !== 'building') {
                return {
                    resultPayload: { success: false, error: 'No valid building feature identified for excavation stencil.' } as unknown as ToolResultPayload,
                    summaryResult: `Failed to generate excavation stencil: no building found matching target.`
                };
            }

            const stencil = SpatialVectorDataService.generateExcavationStencil(building);
            return {
                resultPayload: {
                    queryType,
                    buildingId: building.universalId,
                    stencil
                } as unknown as ToolResultPayload,
                summaryResult: `Generated 2D excavation stencil for ${building.name || building.universalId}: Bounding box [${stencil.boundingBox.map(n => n.toFixed(1)).join(', ')}], Area: ${stencil.areaM2}m², Vertices: ${stencil.stencilPolygonEnu.length}. Ready for clipping Google 3D Photorealistic Tiles.`
            };
        }

        if (queryType === 'kinematic_graph') {
            const graph = SpatialVectorDataService.generateKinematicGraph(dataset);
            return {
                resultPayload: {
                    queryType,
                    graph
                } as unknown as ToolResultPayload,
                summaryResult: `Generated kinematic road network graph: ${graph.nodes.length} intersection nodes, ${graph.roads.length} road segments spanning ${graph.totalLengthKm} km with precomputed lane centerlines.`
            };
        }

        if (queryType === 'semantic_annotations') {
            const annotations = SpatialVectorDataService.generateSemantic3DAnnotations(dataset);
            return {
                resultPayload: {
                    queryType,
                    annotations
                } as unknown as ToolResultPayload,
                summaryResult: `Generated ${annotations.length} semantic 3D HUD billboard annotations (buildings, road corridors, POIs) with Universal Spatial IDs.`
            };
        }

        if (queryType === 'staging_anchors') {
            const anchors = SpatialVectorDataService.solveStagingAnchors(dataset, {
                mobilityAffinity: mobilityAffinity as any,
                footprintRadiusM,
                preferredSurface: preferredSurface as any,
                referencePoint: localPoint || [0, 0, 0],
                maxCandidates: 5
            });

            const topAnchor = anchors[0];
            return {
                resultPayload: {
                    queryType,
                    latitude,
                    longitude,
                    anchors,
                    topAnchor: topAnchor || null,
                    count: anchors.length
                } as unknown as ToolResultPayload,
                summaryResult: topAnchor
                    ? `Discovered ${anchors.length} intelligent staging anchors at [${latitude}, ${longitude}]. Top anchor: "${topAnchor.name}" (${topAnchor.surfaceType}) at [${topAnchor.position.map(n => n.toFixed(1)).join(', ')}] with heading ${topAnchor.headingDeg}° (Confidence: ${(topAnchor.confidenceScore * 100).toFixed(0)}%). Rationale: ${topAnchor.spatialRationale}`
                    : `No staging anchors discovered within search bounds.`
            };
        }

        // Default: overview
        return {
            resultPayload: {
                dataset,
                notes: [
                    'Co-registered with Google 3D Photorealistic Tiles via LocalTangentPlane ENU.',
                    'Universal Spatial Identifiers formatted as urn:scratchbox:spatial:<layer>:<geohash>:<id>.',
                    'Vector data carries no individual trees; google_3d_tiles_get_clay measures the trees in the photo tiles and rebuilds them as SB-Veggie trees.'
                ]
            } as unknown as ToolResultPayload,
            summaryResult: `Spatial Vector Data queried at [${latitude}, ${longitude}] (${dataset.geohash}): ${dataset.stats.buildingCount} buildings (${dataset.stats.totalBuildingFootprintAreaM2}m² footprint, ${dataset.stats.verifiedHeightCount} verified heights), ${dataset.stats.roadSegmentCount} road segments (${dataset.stats.roadNetworkLengthKm}km, ${dataset.stats.bridgeCount} bridges, ${dataset.stats.tunnelCount} tunnels), ${dataset.landuse.length} landuse zones, ${dataset.water.length} water bodies, ${dataset.pois.length} POIs.`
        };
    }
};

// Aliases for unified spatial tool access
export const SPATIAL_TOOL_DECLARATIONS = PANORAMA_TOOL_DECLARATIONS;
export const spatialHandlers = panoramaHandlers;

/** Parameters shared by the camera-resection tools (geobox_resect_image_location and its aliases). */
function geoboxResectionProperties(): NonNullable<NonNullable<ToolDeclaration['parameters']>['properties']> {
    const point = (description: string) => ({
        type: 'OBJECT' as const,
        description,
        properties: { lat: { type: 'NUMBER' as const }, lng: { type: 'NUMBER' as const }, alt: { type: 'NUMBER' as const } }
    });
    return {
        imagePath: { type: 'STRING', description: 'Path of the photograph or frame (recorded with the result; its pixels are not analysed).' },
        videoPath: { type: 'STRING', description: 'Optional path of the video the frame comes from.' },
        targetLandmarkName: { type: 'STRING', description: 'Name or address of what the photo shows, as the user wrote it; resolved with Google Places (the result reports the address it resolved).' },
        promptHint: { type: 'STRING', description: 'Optional place text, looked up only when there is no targetLandmarkName, targetCoords or camera position.' },
        targetCoords: point('Coordinates of what the photo shows; alt is the ground altitude in metres (looked up with the Elevation API when omitted).'),
        cameraOpticalCenter: point('The camera position, with alt in metres above mean sea level.'),
        knownCoords: point('The camera position (same as cameraOpticalCenter), with alt in metres above mean sea level.'),
        headingDeg: { type: 'NUMBER', description: 'Camera compass heading in degrees clockwise from north.' },
        pitchDeg: { type: 'NUMBER', description: 'Camera pitch in degrees above the horizon (negative looks down).' },
        standoffDistanceMeters: { type: 'NUMBER', description: 'Distance in metres from the camera to the target, needed with headingDeg when there is no camera position.' },
        points2D: {
            type: 'ARRAY',
            description: 'Pixel coordinates in the photo, matched one-to-one with points3D (at least 4).',
            items: { type: 'OBJECT', properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' } } }
        },
        points3D: {
            type: 'ARRAY',
            description: 'East-north-up metres relative to the target, matched one-to-one with points2D.',
            items: { type: 'OBJECT', properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' }, z: { type: 'NUMBER' } } }
        },
        imageWidthPx: { type: 'NUMBER', description: 'Photo width in pixels (required with points2D).' },
        imageHeightPx: { type: 'NUMBER', description: 'Photo height in pixels (required with points2D).' },
        sensorFocalMm: { type: 'NUMBER', description: 'Lens focal length in mm, 35 mm equivalent (26 mm is assumed, and said so, when omitted).' },
        sensorWidthMm: { type: 'NUMBER', description: 'Sensor width in mm (default 36, full frame).' }
    };
}
