/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { LatLngAlt, LocalTangentPlane } from '../../common/coordinate/LocalTangentPlane';
import {
    CameraAttitude,
    CameraViewFrustum,
    GeoCoordinate,
    GoogleMapTiles3DConfig,
    calculateStandoffDistance,
    computeCameraFrustum,
    haversineDistanceKm
} from '../3d-engine/geobox-pipeline-types';
import {
    SubPixelEdgeAlignmentOptimizer,
    OptimizationResult,
    CameraPose6DOF,
    computeSobelField,
    evaluateEdgeOverlap
} from './SubPixelEdgeAlignmentOptimizer';
import {
    SpatialPoseEstimatorService,
    Point2D,
    Point3D,
    CameraIntrinsics
} from './SpatialPoseEstimatorService';
import {
    geocode3DTilesAddress,
    GeoAnchor
} from './Google3DTileBlockoutPipelineService';
import { GoogleMapsService } from '../../browser/generative-canvas/services/google-maps-service';
import { LocationUnresolvedError, MissingInputError } from '../../common/errors/pipeline-errors';
import { assertUsableCoordinates } from '../../common/coordinate/parse-coordinates';
import { VfxLensInterchangeService } from '../../common/optics/VfxLensInterchangeService';
import {
    VanishingPointHorizonEstimator,
    LineSegment2D
} from './VanishingPointHorizonEstimator';

export interface GeoBoxResectionRequest {
    imagePath?: string;
    imageBuffer?: Buffer;
    videoPath?: string;
    promptHint?: string;
    targetLandmarkName?: string;
    knownCoords?: LatLngAlt;
    targetCoords?: LatLngAlt;
    cameraOpticalCenter?: LatLngAlt;
    headingDeg?: number;
    pitchDeg?: number;
    rollDeg?: number;
    standoffDistanceMeters?: number;
    glbPath?: string;
    points2D?: Point2D[] | { x: number; y: number }[];
    points3D?: Point3D[] | { x: number; y: number; z: number }[];
    verticalLines?: LineSegment2D[];
    /** Size of the photo the points2D are measured in; required with point correspondences. */
    imageWidthPx?: number;
    imageHeightPx?: number;
    /** Accepted for compatibility; resection runs no edge alignment (see resectCameraPose). */
    optimizeTo100Percent?: boolean;
    sensorFocalMm?: number;
    sensorWidthMm?: number;
    frustumReachMeters?: number;
}

export type ImageLocationResectionRequest = GeoBoxResectionRequest;
export type ImageLocationResectionResult = GeoBoxResectionResult;

import type { LensDistortionParams } from '../../common/vfx-plate-protocol';
export type { LensDistortionParams };

export interface GeoBoxResectionResult {
    success: boolean;
    landmark: {
        name: string;
        /** Where the target location came from: coordinates in the request, or a Google Places lookup of the name. */
        resolvedFrom: 'targetCoords' | 'google_places';
        coordinates: GeoCoordinate;
    };
    cameraOpticalCenter: {
        lat: number;
        lng: number;
        elevationMslMeters: number;
        groundElevationMeters: number;
        standoffDistanceMeters: number;
    };
    cameraAttitude: CameraAttitude;
    /** The evidence the pose was computed from (point correspondences, a stated camera position, or a stated heading). */
    poseSource: string;
    /** Always false: resection does not read the image pixels or align edges against them. */
    imageAnalysed: false;
    frustum: CameraViewFrustum;
    googleMapTiles3DConfig: GoogleMapTiles3DConfig;
    lensDistortion: LensDistortionParams;
    lensDistortionSource: string;
    glbPath?: string;
    resectionTimestamp: string;
}

export interface SubPixelOptimizationRequest {
    queryGrayscale: Float32Array;
    renderGrayscale: Float32Array;
    width: number;
    height: number;
    initialPose?: {
        position: [number, number, number];
        target: [number, number, number];
        fov: number;
    };
    maxIterations?: number;
}

/**
 * Surveyed reference poses for tests. Resolution never consults them (no name or substring lookup):
 * a test that wants one passes its coordinates explicitly.
 */
export const BENCHMARK_GEO_ANCHORS: Record<string, {
    name: string;
    targetCoords: GeoCoordinate;
    vantageCoords: GeoCoordinate;
    groundElevation: number;
    standoffDistanceMeters: number;
    headingDeg: number;
    pitchDeg: number;
    glbPath: string;
}> = {
    'plaza': {
        name: 'The Plaza Hotel NYC (Central Park South)',
        targetCoords: { lat: 40.764500, lng: -73.974400, altitudeMeters: 18.0 },
        vantageCoords: { lat: 40.764800, lng: -73.974000, altitudeMeters: 82.0 },
        groundElevation: 18.0,
        standoffDistanceMeters: 75.0,
        headingDeg: -29.0,
        pitchDeg: -30.0,
        glbPath: 'public/models/the_plaza_hotel_textured.glb'
    },
    'colosseum': {
        name: 'Colosseum (Flavian Amphitheater), Rome, Italy',
        targetCoords: { lat: 41.8902102, lng: 12.4922309, altitudeMeters: 22.0 },
        vantageCoords: { lat: 41.89080359, lng: 12.49022340, altitudeMeters: 24.5 },
        groundElevation: 22.8,
        standoffDistanceMeters: 140.0,
        headingDeg: 108.0,
        pitchDeg: 6.0,
        glbPath: 'public/models/colosseum_rome_textured.glb'
    },
    'eiffel': {
        name: 'Eiffel Tower, Champ de Mars, Paris, France',
        targetCoords: { lat: 48.8583701, lng: 2.2944813, altitudeMeters: 35.0 },
        vantageCoords: { lat: 48.8571000, lng: 2.2965000, altitudeMeters: 36.7 },
        groundElevation: 35.0,
        standoffDistanceMeters: 210.0,
        headingDeg: 332.0,
        pitchDeg: 18.0,
        glbPath: 'public/models/eiffel_tower_textured.glb'
    },
    'sydney': {
        name: 'Sydney Opera House, Bennelong Point, Sydney, Australia',
        targetCoords: { lat: -33.8567844, lng: 151.2152967, altitudeMeters: 4.0 },
        vantageCoords: { lat: -33.8585000, lng: 151.2130000, altitudeMeters: 5.8 },
        groundElevation: 4.0,
        standoffDistanceMeters: 175.0,
        headingDeg: 42.0,
        pitchDeg: 8.0,
        glbPath: 'public/models/sydney_opera_house_textured.glb'
    }
};

/**
 * Backwards-compatible alias for legacy test references.
 * Deprecated: Rely on dynamic geocoding or explicit coordinates.
 */
export const KNOWN_RESECTION_LANDMARKS = BENCHMARK_GEO_ANCHORS;

export class GeoBoxPrecisionResectionService {
    private edgeOptimizer: SubPixelEdgeAlignmentOptimizer;

    constructor(edgeOptimizer?: SubPixelEdgeAlignmentOptimizer) {
        this.edgeOptimizer = edgeOptimizer || new SubPixelEdgeAlignmentOptimizer();
    }

    /**
     * Resolves what the photo shows. Explicit target coordinates are used as given; otherwise the landmark name (or,
     * without one, the prompt hint) is resolved with Google Places. A camera position (cameraOpticalCenter or
     * knownCoords) is not a target: the ground under the camera is not what it looks at, so a camera position alone
     * is an error. Text is never scanned for landmark keywords or embedded numbers, and BENCHMARK_GEO_ANCHORS are
     * never consulted. The ground elevation is the stated altitude or the Elevation API's; when neither is available
     * this throws.
     */
    public async resolveGeodeticCoordinates(request: GeoBoxResectionRequest): Promise<{
        name: string;
        resolvedFrom: 'targetCoords' | 'google_places';
        targetCoords: GeoCoordinate;
        groundElevation: number;
        glbPath?: string;
    }> {
        // 1. Explicit target coordinates provided
        if (request.targetCoords) {
            const { lat, lng } = request.targetCoords;
            assertUsableCoordinates(lat, lng, `${lat}, ${lng}`);
            const ground = await this.groundElevation(lat, lng, request.targetCoords.alt);
            return {
                name: request.targetLandmarkName || `Coordinates (${lat.toFixed(6)}, ${lng.toFixed(6)})`,
                resolvedFrom: 'targetCoords',
                targetCoords: { lat, lng, altitudeMeters: ground },
                groundElevation: ground,
                glbPath: request.glbPath
            };
        }

        // 2. One place lookup: the landmark name when given, else the prompt hint. Coordinates typed in either are
        // used as given.
        const query = request.targetLandmarkName?.trim() || request.promptHint?.trim();
        if (!query) {
            const cameraOnly = request.knownCoords || request.cameraOpticalCenter;
            throw new MissingInputError(
                'geobox_resect_camera_pose',
                'targetCoords, targetLandmarkName or promptHint',
                cameraOnly
                    ? 'only the camera position was given: what the photo shows (the target) is needed too; the ground under the camera is not assumed to be it'
                    : 'no location was given; zero presets: no default place'
            );
        }
        const anchor = await geocode3DTilesAddress(query);
        const ground = await this.groundElevation(anchor.lat, anchor.lng, anchor.elevation);
        return {
            name: anchor.formattedAddress || anchor.landmarkName || query,
            resolvedFrom: 'google_places',
            targetCoords: { lat: anchor.lat, lng: anchor.lng, altitudeMeters: ground },
            groundElevation: ground,
            glbPath: request.glbPath
        };
    }

    /** The stated ground altitude, else the Elevation API's; throws LocationUnresolvedError when neither exists. */
    private async groundElevation(lat: number, lng: number, stated?: number): Promise<number> {
        if (typeof stated === 'number' && Number.isFinite(stated)) return stated;
        try {
            return await GoogleMapsService.getInstance().getElevation(lat, lng);
        } catch (err) {
            throw new LocationUnresolvedError(
                `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
                `no ground elevation: no altitude was given (targetCoords.alt) and the Elevation API gave none (${err instanceof Error ? err.message : String(err)})`
            );
        }
    }

    /**
     * Computes the camera's geodetic position, heading and pitch, its view frustum and a Google 3D Tiles camera
     * config from the pose evidence in the request. The evidence is, in order: 2D-3D point correspondences
     * (solvePnP, which needs the image size), a stated camera position (cameraOpticalCenter or knownCoords, with
     * altitude), or a stated heading, pitch and standoff distance. Missing evidence is an error; nothing is assumed.
     * The image pixels are not analysed here and no edge alignment is run: geobox_optimize_edge_alignment aligns a
     * model to the photograph and reports what it measured.
     */
    public async resectCameraPose(request: GeoBoxResectionRequest): Promise<GeoBoxResectionResult> {
        const tool = 'geobox_resect_camera_pose';
        // 1. Resolve geodetic coordinates (Zero presets: throws if not resolvable)
        const geo = await this.resolveGeodeticCoordinates(request);
        const targetCoords = geo.targetCoords;
        const targetLla = { lat: targetCoords.lat, lng: targetCoords.lng, alt: targetCoords.altitudeMeters };

        const focalMm = request.sensorFocalMm ?? 26.0;
        const sensorWidthMm = request.sensorWidthMm ?? 36.0;
        const fov = Number(((2 * Math.atan(sensorWidthMm / (2 * focalMm))) * 180 / Math.PI).toFixed(2));

        let cameraCoords: GeoCoordinate;
        let standoffDist: number;
        let headingDeg: number;
        let pitchDeg: number;
        let poseSource: string;

        /** Heading, pitch and range from the target to a camera at the given geodetic position. */
        const lookAtTarget = (camera: GeoCoordinate) => {
            const enu = LocalTangentPlane.geodeticToEnu(targetLla, { lat: camera.lat, lng: camera.lng, alt: camera.altitudeMeters });
            const dX = -enu.x, dY = -enu.y, dZ = -enu.z;
            return {
                range: Math.hypot(dX, dY, dZ),
                heading: (Math.atan2(dX, dY) * 180 / Math.PI + 360) % 360,
                pitch: Math.atan2(dZ, Math.hypot(dX, dY)) * 180 / Math.PI,
                horizontal: Math.hypot(dX, dY)
            };
        };
        const pitchFromLines = () => request.verticalLines && request.verticalLines.length >= 2
            ? VanishingPointHorizonEstimator.estimatePitchFromVerticalLines(request.verticalLines).pitchDeg
            : undefined;

        if (request.points2D && request.points3D && request.points2D.length >= 4 && request.points3D.length >= 4) {
            // 2a. Analytical 6-DOF pose from point correspondences.
            const width = request.imageWidthPx;
            const height = request.imageHeightPx;
            if (!(typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0)) {
                throw new MissingInputError(tool, 'imageWidthPx and imageHeightPx', 'the principal point of the photo comes from its size; no image size is assumed');
            }
            const p2d: Point2D[] = request.points2D.map(p => Array.isArray(p) ? p as Point2D : [(p as any).x, (p as any).y] as Point2D);
            const p3d: Point3D[] = request.points3D.map(p => Array.isArray(p) ? p as Point3D : [(p as any).x, (p as any).y, (p as any).z] as Point3D);
            const focalLengthPx = focalMm / sensorWidthMm * width;
            const intrinsics: CameraIntrinsics = { fx: focalLengthPx, fy: focalLengthPx, cx: width / 2, cy: height / 2, width, height };
            const pnp = SpatialPoseEstimatorService.solvePnPRansac(p3d, p2d, intrinsics);
            const center = pnp.pose.cameraCenterWorld;
            const geoCam = LocalTangentPlane.enuToGeodetic(targetLla, center[0], center[1], center[2]);
            cameraCoords = { lat: geoCam.lat, lng: geoCam.lng, altitudeMeters: geoCam.alt };
            standoffDist = Math.hypot(pnp.pose.translationCamera[0], pnp.pose.translationCamera[1], pnp.pose.translationCamera[2]);
            const dX = -center[0], dY = -center[1], dZ = -center[2];
            headingDeg = (Math.atan2(dX, dY) * 180 / Math.PI + 360) % 360;
            pitchDeg = Math.atan2(dZ, Math.hypot(dX, dY)) * 180 / Math.PI;
            // solvePnP holds the intrinsics fixed: the focal length comes from the stated (or assumed) lens and
            // sensor, it is not recovered from the correspondences.
            poseSource = `solvePnP from ${pnp.totalCount} point correspondences (${pnp.inlierCount} inliers, mean reprojection error ${pnp.pose.meanReprojectionErrorPx.toFixed(3)} px${pnp.consensus ? '' : ', no RANSAC consensus'}); focal length held fixed at ${focalLengthPx.toFixed(1)} px from a ${focalMm} mm lens on a ${sensorWidthMm} mm sensor${request.sensorFocalMm === undefined ? ' (26 mm assumed)' : ''}, not recovered`;
        } else if (request.cameraOpticalCenter || request.knownCoords) {
            // 2b. A stated camera position; heading and pitch default to looking at the target.
            const stated = (request.cameraOpticalCenter || request.knownCoords)!;
            const which = request.cameraOpticalCenter ? 'cameraOpticalCenter' : 'knownCoords';
            assertUsableCoordinates(stated.lat, stated.lng, `${stated.lat}, ${stated.lng}`);
            if (typeof stated.alt !== 'number' || !Number.isFinite(stated.alt)) {
                throw new MissingInputError(tool, `${which}.alt`, 'give the camera altitude in metres above mean sea level; no eye height is assumed');
            }
            cameraCoords = { lat: stated.lat, lng: stated.lng, altitudeMeters: stated.alt };
            const look = lookAtTarget(cameraCoords);
            const sameSpot = look.horizontal < 0.01;
            if (sameSpot && typeof request.headingDeg !== 'number') {
                throw new MissingInputError(tool, 'headingDeg', `the camera (${which}) is directly above or below the target, so its heading cannot be derived`);
            }
            standoffDist = look.range;
            headingDeg = request.headingDeg ?? look.heading;
            pitchDeg = request.pitchDeg ?? pitchFromLines() ?? look.pitch;
            poseSource = `stated camera position (${which})${typeof request.headingDeg === 'number' ? ', stated heading' : ', heading toward the target'}${typeof request.pitchDeg === 'number' ? ', stated pitch' : request.verticalLines && request.verticalLines.length >= 2 ? ', pitch from vertical lines' : ', pitch toward the target'}`;
        } else {
            // 2c. A stated heading, pitch and standoff distance relative to the target.
            if (typeof request.headingDeg !== 'number') {
                throw new MissingInputError(
                    tool,
                    'point correspondences (points2D/points3D with imageWidthPx/imageHeightPx), a camera position (cameraOpticalCenter/knownCoords), or headingDeg with pitchDeg and standoffDistanceMeters',
                    `only the target location is known for "${geo.name}"; no camera pose is invented`
                );
            }
            const statedPitch = request.pitchDeg ?? pitchFromLines();
            if (typeof statedPitch !== 'number') {
                throw new MissingInputError(tool, 'pitchDeg (or verticalLines)', 'a heading alone does not place the camera; no pitch is assumed');
            }
            if (typeof request.standoffDistanceMeters !== 'number' || !(request.standoffDistanceMeters > 0)) {
                throw new MissingInputError(tool, 'standoffDistanceMeters', 'a heading alone does not place the camera; no distance is assumed');
            }
            standoffDist = request.standoffDistanceMeters;
            headingDeg = request.headingDeg;
            pitchDeg = statedPitch;
            // The camera looks along (heading, pitch) at the target, so it sits standoff metres back along that ray:
            // behind the target horizontally, and above it when the pitch is negative (looking down).
            const headingRad = headingDeg * Math.PI / 180;
            const pitchRad = pitchDeg * Math.PI / 180;
            const horizDist = standoffDist * Math.cos(pitchRad);
            const geoCam = LocalTangentPlane.enuToGeodetic(
                targetLla,
                -horizDist * Math.sin(headingRad),
                -horizDist * Math.cos(headingRad),
                -standoffDist * Math.sin(pitchRad)
            );
            cameraCoords = { lat: geoCam.lat, lng: geoCam.lng, altitudeMeters: geoCam.alt };
            poseSource = `stated heading, ${typeof request.pitchDeg === 'number' ? 'stated pitch' : 'pitch from vertical lines'} and stated standoff distance`;
        }

        // 3. Viewing frustum
        const reachMeters = request.frustumReachMeters ?? 350.0;
        const frustum = computeCameraFrustum(cameraCoords, headingDeg, fov, reachMeters);

        // 4. Typical Brown-Conrady coefficients for the lens (not measured from the image)
        const lensDistortion = this.calculateLensDistortion(focalMm, sensorWidthMm);

        // 5. Google 3D Tiles camera config (no match score: nothing was matched against the image)
        const cameraAltitude = cameraCoords.altitudeMeters as number;
        const googleMapTiles3DConfig: GoogleMapTiles3DConfig = {
            camera_position: {
                lat: Number(cameraCoords.lat.toFixed(6)),
                lng: Number(cameraCoords.lng.toFixed(6)),
                altitude: Number(cameraAltitude.toFixed(2))
            },
            center: {
                lat: Number(targetCoords.lat.toFixed(6)),
                lng: Number(targetCoords.lng.toFixed(6)),
                altitude: Number((targetCoords.altitudeMeters as number).toFixed(2))
            },
            heading: Number(headingDeg.toFixed(1)),
            // Maps 3D tilt: 0 looks straight down, 90 at the horizon, above 90 looks up.
            tilt: Number(cameraTiltFromPitch(pitchDeg).toFixed(1)),
            roll: 0.0,
            range: Number(standoffDist.toFixed(2)),
            fov,
            mode: 'hybrid'
        };

        return {
            success: true,
            landmark: {
                name: geo.name,
                resolvedFrom: geo.resolvedFrom,
                coordinates: targetCoords
            },
            cameraOpticalCenter: {
                lat: cameraCoords.lat,
                lng: cameraCoords.lng,
                elevationMslMeters: cameraAltitude,
                groundElevationMeters: geo.groundElevation,
                standoffDistanceMeters: standoffDist
            },
            cameraAttitude: {
                headingDeg,
                pitchDeg,
                rollDeg: 0.0
            },
            poseSource,
            imageAnalysed: false,
            frustum,
            googleMapTiles3DConfig,
            lensDistortion,
            lensDistortionSource: `typical coefficients for a ${focalMm} mm lens on a ${sensorWidthMm} mm sensor${request.sensorFocalMm === undefined ? ' (focal length not given; 26 mm assumed)' : ''}, not measured from the image`,
            glbPath: geo.glbPath,
            resectionTimestamp: new Date().toISOString()
        };
    }

    /**
     * Measures how well the edges of a fixed render line up with the edges of a photograph. With a fixed render
     * there is nothing to re-render, so the pose is not refined: the result reports the measured overlap at the
     * given pose (geobox_optimize_edge_alignment re-renders a model per trial pose to refine it).
     */
    public async optimizeEdgeAlignment(request: SubPixelOptimizationRequest): Promise<OptimizationResult> {
        if (!request.initialPose) {
            // Two fixed images carry no pose: aligning needs the model (.glb) rendered from a stated starting pose.
            throw new MissingInputError('geobox_optimize_edge_alignment', 'glbPath and initialPose', 'a model rendered from a stated starting pose is needed to align against the photo; no pose is assumed');
        }
        const queryField = computeSobelField(request.width, request.height, request.queryGrayscale);
        const renderField = computeSobelField(request.width, request.height, request.renderGrayscale);
        const measured = evaluateEdgeOverlap(queryField, renderField);
        const pose = request.initialPose;
        const distance = Math.hypot(pose.position[0] - pose.target[0], pose.position[1] - pose.target[1], pose.position[2] - pose.target[2]);
        const fPx = (request.height * 0.5) / Math.tan((pose.fov * 0.5 * Math.PI) / 180.0);
        return {
            initialOverlapScorePct: measured.overlapScorePercent,
            finalOverlapScorePct: measured.overlapScorePercent,
            subPixelResidualPx: measured.residualPx,
            physicalErrorMm: (measured.residualPx / Math.max(1.0, fPx)) * distance * 1000.0,
            converged: false,
            iterations: 0,
            optimizedPose: { position: [...pose.position], target: [...pose.target], fov: pose.fov }
        };
    }

    /**
     * Calculates Brown-Conrady lens barrel and tangential distortion coefficients.
     */
    public calculateLensDistortion(focalLengthMm: number, _sensorWidthMm: number = 36.0): LensDistortionParams {
        if (focalLengthMm <= 26.0) {
            return {
                k1: -0.038,
                k2: 0.008,
                p1: 0.0,
                p2: 0.0,
                chromaticAberration: 0.0003
            };
        }
        return {
            k1: -0.012,
            k2: 0.002,
            p1: 0.0,
            p2: 0.0,
            chromaticAberration: 0.0001
        };
    }

    /**
     * Resects and localizes image location: 6-DOF camera pose, geodetic coordinates,
     * landmark identification, viewing frustum, standoff distance, and sub-pixel edge alignment.
     */
    public async resectImageLocation(request: ImageLocationResectionRequest): Promise<ImageLocationResectionResult> {
        return this.resectCameraPose(request);
    }
}

/**
 * Google Maps 3D camera tilt for a pitch in degrees above the horizon (negative looks down): tilt 0 looks straight
 * down, 90 at the horizon and 180 straight up, so tilt = 90 + pitch.
 */
export function cameraTiltFromPitch(pitchDeg: number): number {
    return Math.max(0, Math.min(180, 90 + pitchDeg));
}

/**
 * Standalone convenience function for resecting image location.
 */
export async function resectImageLocation(request: ImageLocationResectionRequest): Promise<ImageLocationResectionResult> {
    const service = new GeoBoxPrecisionResectionService();
    return service.resectImageLocation(request);
}
