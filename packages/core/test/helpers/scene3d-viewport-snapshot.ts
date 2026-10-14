/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { saveTestScreenshot } from './test-screenshot-helper';

type Rgb = [number, number, number];

export interface ViewportSnapshotMarker {
    /** World-space point drawn as a cross (e.g. where the transform gizmo is placed). */
    position: THREE.Vector3;
    color: Rgb;
}

export interface ViewportSnapshotOptions {
    width?: number;
    height?: number;
    /** Meshes under this object are drawn in the selection colour. */
    highlight?: THREE.Object3D | null;
    markers?: ViewportSnapshotMarker[];
    /** Background colour (hex), e.g. the renderer's own `classifyAtmosphere(...).backgroundHex`. */
    background?: number;
    /** Shade each mesh with its material's own colour instead of the neutral mesh grey. */
    materialColors?: boolean;
}

export interface ViewportSnapshotResult {
    path: string;
    /** Pixels covered by any visible mesh. */
    drawnPixels: number;
    /** Pixels covered by the highlighted subtree (visible faces only). */
    highlightPixels: number;
    /** Screen-space pixel of each marker, or null when it projects off screen. */
    markerPixels: Array<{ x: number; y: number } | null>;
    /** Screen bounds of the highlighted pixels, or null when none were drawn. */
    highlightBounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
    /** The saved frame's RGBA pixels, row-major. */
    rgba: Buffer;
}

const BACKGROUND: Rgb = [24, 26, 31];
const MESH: Rgb = [150, 156, 166];
const HIGHLIGHT: Rgb = [34, 211, 238];

function hexToRgb(hex: number): Rgb {
    return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function materialRgb(mesh: THREE.Mesh): Rgb | undefined {
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const color = (material as { color?: THREE.Color } | undefined)?.color;
    return color ? hexToRgb(color.getHex()) : undefined;
}

function isUnder(obj: THREE.Object3D, root: THREE.Object3D | null | undefined): boolean {
    for (let cur: THREE.Object3D | null = obj; cur; cur = cur.parent) if (cur === root) return true;
    return false;
}

/**
 * Software-rasterises the visible meshes of a scene graph through `camera` (flat-shaded, z-buffered)
 * and saves the frame as a test-result screenshot. It renders the same scene graph and camera the
 * test asserted against, so the PNG shows what the viewport would draw: which part is selected and
 * where overlays such as the gizmo sit. No WebGL context is needed.
 */
export function saveViewportSnapshot(
    testName: string,
    scene: THREE.Object3D,
    camera: THREE.PerspectiveCamera,
    options: ViewportSnapshotOptions = {}
): ViewportSnapshotResult {
    const width = options.width ?? 400;
    const height = options.height ?? 300;
    const rgba = Buffer.alloc(width * height * 4);
    const depth = new Float32Array(width * height).fill(Infinity);
    const background = options.background !== undefined ? hexToRgb(options.background) : BACKGROUND;
    for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = background[0];
        rgba[i * 4 + 1] = background[1];
        rgba[i * 4 + 2] = background[2];
        rgba[i * 4 + 3] = 255;
    }

    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    const toScreen = (p: THREE.Vector3) => {
        const ndc = p.clone().project(camera);
        return { x: (ndc.x * 0.5 + 0.5) * width, y: (1 - (ndc.y * 0.5 + 0.5)) * height, z: ndc.z };
    };

    let drawnPixels = 0;
    let highlightPixels = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const highlightMask = new Uint8Array(width * height);

    scene.traverseVisible(obj => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const position = mesh.geometry.getAttribute('position');
        if (!position) return;
        const index = mesh.geometry.index;
        const triCount = Math.floor((index ? index.count : position.count) / 3);
        const highlighted = !!options.highlight && isUnder(mesh, options.highlight);
        const base = highlighted ? HIGHLIGHT : (options.materialColors && materialRgb(mesh)) || MESH;
        const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
        const normal = new THREE.Vector3();
        const toCamera = new THREE.Vector3();

        for (let t = 0; t < triCount; t++) {
            for (let k = 0; k < 3; k++) {
                const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
                v[k].fromBufferAttribute(position, vi).applyMatrix4(mesh.matrixWorld);
            }
            normal.subVectors(v[1], v[0]).cross(toCamera.subVectors(v[2], v[0])).normalize();
            toCamera.subVectors(camera.position, v[0]).normalize();
            const shade = 0.45 + 0.55 * Math.abs(normal.dot(toCamera));
            const color: Rgb = [base[0] * shade, base[1] * shade, base[2] * shade];

            const [a, b, c] = v.map(toScreen);
            if ([a, b, c].some(p => p.z < -1 || p.z > 1)) continue;
            const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
            if (Math.abs(area) < 1e-9) continue;
            const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
            const x1 = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
            const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
            const y1 = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
            for (let py = y0; py <= y1; py++) {
                for (let px = x0; px <= x1; px++) {
                    const sx = px + 0.5;
                    const sy = py + 0.5;
                    const w0 = ((b.x - sx) * (c.y - sy) - (c.x - sx) * (b.y - sy)) / area;
                    const w1 = ((c.x - sx) * (a.y - sy) - (a.x - sx) * (c.y - sy)) / area;
                    const w2 = 1 - w0 - w1;
                    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                    const z = w0 * a.z + w1 * b.z + w2 * c.z;
                    const idx = py * width + px;
                    if (z >= depth[idx]) continue;
                    depth[idx] = z;
                    highlightMask[idx] = highlighted ? 1 : 0;
                    rgba[idx * 4] = Math.round(color[0]);
                    rgba[idx * 4 + 1] = Math.round(color[1]);
                    rgba[idx * 4 + 2] = Math.round(color[2]);
                }
            }
        }
    });

    for (let idx = 0; idx < width * height; idx++) {
        if (depth[idx] === Infinity) continue;
        drawnPixels++;
        if (!highlightMask[idx]) continue;
        highlightPixels++;
        const x = idx % width;
        const y = Math.floor(idx / width);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }

    const markerPixels = (options.markers || []).map(marker => {
        const p = toScreen(marker.position);
        if (p.z < -1 || p.z > 1 || p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) return null;
        const cx = Math.floor(p.x);
        const cy = Math.floor(p.y);
        for (let d = -6; d <= 6; d++) {
            for (const [x, y] of [[cx + d, cy], [cx, cy + d]]) {
                if (x < 0 || y < 0 || x >= width || y >= height) continue;
                const idx = (y * width + x) * 4;
                rgba[idx] = marker.color[0];
                rgba[idx + 1] = marker.color[1];
                rgba[idx + 2] = marker.color[2];
            }
        }
        return { x: cx, y: cy };
    });

    const path = saveTestScreenshot(testName, rgba, { width, height });
    return {
        path,
        drawnPixels,
        highlightPixels,
        markerPixels,
        highlightBounds: highlightPixels > 0 ? { minX, minY, maxX, maxY } : null,
        rgba
    };
}
