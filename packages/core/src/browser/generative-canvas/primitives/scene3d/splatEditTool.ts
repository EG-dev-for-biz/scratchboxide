/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The viewport's Edit Splats tool: a sphere brush dragged over the loaded splats that erases, restores or paints them.
 * A stroke is previewed on the splat as it is drawn and handed to `commit` on release, which appends it to the scene's
 * splatEdits (one undoable step); the scene replays every stroke over the splat as built (common/spatial/splat-edits.ts).
 */

import * as THREE from 'three';
import { PRIMARY_SPLAT_TARGET, type SplatEditOp, type SplatEditStroke } from '../../../../common/spatial/splat-edits';
import type { PhotorealGaussianSplatMesh } from '../../services/spatial/PhotorealGaussianSplatMesh';

export interface SplatBrush {
    op: SplatEditOp;
    /** Brush radius, metres. */
    radius: number;
    /** Paint colour, 0..1 RGB. */
    color: [number, number, number];
    /** Paint strength, 0..1. */
    strength: number;
}

export const DEFAULT_SPLAT_BRUSH: SplatBrush = { op: 'erase', radius: 0.5, color: [0.55, 0.55, 0.55], strength: 0.6 };

/** What the pointer handlers call while the Edit Splats tool is active. */
export interface SplatEditTool {
    /** Starts a stroke where the ray meets a splat; false (nothing started) when it meets none. */
    begin(ray: THREE.Ray): boolean;
    /** Continues the stroke to where the ray meets the splat now. */
    extend(ray: THREE.Ray): void;
    /** Ends the stroke and commits it (nothing when it changed no splat). */
    end(): void;
    /** Places the brush cursor where the ray meets a splat, or hides it. */
    hover(ray: THREE.Ray): void;
    /** Hides the cursor (the tool was left). */
    hideCursor(): void;
}

/** The scene object id a splat mesh was loaded for (Scene3DPrimitive keys its splat meshes by it). */
const targetOf = (id: string) => (id === PRIMARY_SPLAT_TARGET ? undefined : id);

export function createSplatEditTool(args: {
    /** The splat meshes now in the scene, by scene object id. */
    meshes: () => ReadonlyMap<string, PhotorealGaussianSplatMesh>;
    brush: () => SplatBrush;
    /** The viewport's brush cursor ring (facing +Z; the sculpt tool's too), scaled to the brush while this tool shows it. */
    cursor: () => THREE.Mesh | null;
    commit: (stroke: SplatEditStroke) => void;
}): SplatEditTool {
    let active: { id: string; mesh: PhotorealGaussianSplatMesh; stroke: SplatEditStroke } | null = null;
    let lastHover = 0;

    const pick = (ray: THREE.Ray, only?: PhotorealGaussianSplatMesh) => {
        let best: { id: string; mesh: PhotorealGaussianSplatMesh; local: THREE.Vector3; world: THREE.Vector3; d: number } | undefined;
        for (const [id, mesh] of args.meshes()) {
            if (only && mesh !== only) continue;
            if (!mesh.parent || !mesh.visible) continue;
            const hit = mesh.pickEditPoint(ray);
            if (!hit) continue;
            const d = hit.world.distanceTo(ray.origin);
            if (!best || d < best.d) best = { id, mesh, ...hit, d };
        }
        return best;
    };

    const hide = () => {
        const cursor = args.cursor();
        if (!cursor) return;
        cursor.visible = false;
        cursor.scale.setScalar(1);
    };

    const placeCursor = (world: THREE.Vector3 | undefined, ray: THREE.Ray) => {
        const cursor = args.cursor();
        if (!cursor) return;
        if (!world) { hide(); return; }
        cursor.position.copy(world);
        // the ring faces the viewer: a splat carries no surface normal to lay it on
        cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), ray.direction.clone().negate());
        const ringRadius = (cursor.geometry as THREE.RingGeometry).parameters?.outerRadius || 1;
        cursor.scale.setScalar(args.brush().radius / ringRadius);
        cursor.visible = true;
    };

    return {
        begin(ray) {
            const hit = pick(ray);
            if (!hit) return false;
            const b = args.brush();
            const target = targetOf(hit.id);
            const stroke: SplatEditStroke = {
                op: b.op, points: [hit.local.x, hit.local.y, hit.local.z], radius: b.radius,
                ...(b.op === 'paint' ? { color: [...b.color] as [number, number, number], strength: b.strength } : {}),
                ...(target ? { target } : {})
            };
            active = { id: hit.id, mesh: hit.mesh, stroke };
            hit.mesh.beginEditPreview();
            hit.mesh.previewEditStroke(stroke);
            placeCursor(hit.world, ray);
            return true;
        },
        extend(ray) {
            if (!active) return;
            const hit = pick(ray, active.mesh);
            placeCursor(hit?.world, ray);
            if (!hit) return;
            const pts = active.stroke.points, n = pts.length;
            // a new point only once the brush has moved a quarter of its radius
            if (Math.hypot(hit.local.x - pts[n - 3], hit.local.y - pts[n - 2], hit.local.z - pts[n - 1]) < active.stroke.radius * 0.25) return;
            pts.push(hit.local.x, hit.local.y, hit.local.z);
            active.mesh.previewEditStroke(active.stroke);
        },
        end() {
            if (!active) return;
            const { mesh, stroke } = active;
            active = null;
            const changed = mesh.endEditPreview();
            const round = (v: number) => Math.round(v * 1000) / 1000;
            if (changed) args.commit({ ...stroke, points: stroke.points.map(round) });
        },
        hover(ray) {
            if (active) return;
            // picking walks the ray through the splat grid: at most every 50 ms while hovering
            const now = performance.now();
            if (now - lastHover < 50) return;
            lastHover = now;
            placeCursor(pick(ray)?.world, ray);
        },
        hideCursor: hide
    };
}
