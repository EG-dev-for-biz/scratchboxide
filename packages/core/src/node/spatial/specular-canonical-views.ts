/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The "any instance" default evidence for the specular-material reading: a few canonical views rendered of the mesh
 * itself, orbiting its own bounds, needing nothing from the caller but a GLB path. No pose, Street View or tile photo
 * is required, unlike facade-materials.ts's evidence — the mesh's own existing bake is the only source, so the views
 * check each other's segmentation (facade-materials.ts's agreement floor, generalized in specular-material-projection.ts)
 * rather than confirming anything independent of that bake.
 */

import { SurveyStationRenderService } from './SurveyStationRenderService';
import { cameraBasis } from '../../common/spatial/SurveySynthesisEngine';
import type { ColmapCameraPose } from '../../common/spatial/colmap-vector-reference-types';

export interface RenderedView {
    eye: [number, number, number];
    right: [number, number, number];
    up: [number, number, number];
    fwd: [number, number, number];
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    width: number;
    height: number;
    /** The rendered view, PNG-encoded, row-major top row first (StationBlockoutRender's own convention). */
    png: Buffer;
}

export interface CanonicalViewOptions {
    /** Views evenly spaced around the mesh (default 6). */
    count?: number;
    width?: number;
    height?: number;
    /** Horizontal field of view in degrees (default 50). */
    fovDegrees?: number;
    /** Camera elevation above the mesh's own mid-height, in degrees (default 15: mostly level, slightly down). */
    elevationDeg?: number;
}

function normalize3(v: [number, number, number]): [number, number, number] {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
}

/** Renders `count` views evenly spaced in azimuth around the mesh's own bounds, each framed on its centre. */
export async function renderCanonicalViews(glbPath: string, opts: CanonicalViewOptions = {}): Promise<RenderedView[]> {
    const count = opts.count ?? 6;
    const width = opts.width ?? 512, height = opts.height ?? 512;
    const fovDegrees = opts.fovDegrees ?? 50;
    const elevationDeg = opts.elevationDeg ?? 15;

    const svc = new SurveyStationRenderService();
    await svc.loadMesh(glbPath);
    const bounds = svc.getMeshBounds();
    if (!bounds) throw new Error(`renderCanonicalViews: ${glbPath} has no triangles to render`);
    const center: [number, number, number] = [
        (bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2
    ];
    const diag = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
    // the horizontal half-fov must see the whole diagonal at this distance, with headroom for a mesh seen edge-on
    const dist = Math.max(diag / Math.tan((fovDegrees / 2) * Math.PI / 180) * 0.6, diag * 0.75, 0.5);
    const elevRad = (elevationDeg * Math.PI) / 180;

    const views: RenderedView[] = [];
    for (let i = 0; i < count; i++) {
        const az = (i / count) * 2 * Math.PI;
        const eye: [number, number, number] = [
            center[0] + dist * Math.cos(elevRad) * Math.cos(az),
            center[1] + dist * Math.sin(elevRad),
            center[2] + dist * Math.cos(elevRad) * Math.sin(az)
        ];
        const fwd = normalize3([center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]]);
        const { right, up } = cameraBasis(fwd, [0, 1, 0]);

        const station: ColmapCameraPose = {
            id: i, name: `orbit_${i}`, positionLocalENU: eye, forwardVector: fwd, upVector: up,
            yawDegrees: 0, pitchDegrees: 0, rollDegrees: 0,
            focalLengthMm: 24, sensorWidthMm: 36, fovDegrees, aspectRatio: width / height,
            // no real place: the sun spec below is passed explicitly so this placeholder is never read
            coordinatesWGS84: { lat: 0, lng: 0, elevation: 0 }
        };
        // a fixed, deterministic sun: there is no real place to look its ephemeris up for
        const render = await svc.renderStation(station, { width, height, renderMode: 'albedo', glbPath, sun: { elevationDeg: 55, azimuthDeg: 140 } });
        views.push({
            eye, right: right as [number, number, number], up: up as [number, number, number], fwd,
            fx: render.intrinsics.fx, fy: render.intrinsics.fy, cx: render.intrinsics.cx, cy: render.intrinsics.cy,
            width, height, png: render.png
        });
    }
    return views;
}
