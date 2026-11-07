/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The Map data view's drawing (common/spatial/map-data-view.ts): rendering only, every vertex from measured or
 * vector-modelled data the server sent.
 *
 * - blob groups: the scan mesh once (one shared position buffer), one mesh per group with that group's triangles, so a
 *   district of a thousand blobs is a handful of draw calls; flat-shaded in the group's palette colour;
 * - vector data: one merged screen-width line layer each for centrelines, footprint outlines and rails, hidden behind
 *   whatever stands in front of them (no line ever overlays an object or building), the measured carriageways and the areas as translucent fills on the ground, and POI
 *   labels as screen-space sprites;
 * - the roadmap: Google's 2D tiles, each a grid draped on the measured ground.
 */

import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
    assignColours, carriagewayStrip, codeWords, densify, featureKey, groupIndexLists, MAP_PALETTE,
    type BlobGroupsPayload, type MapDataLayer as LayerKey, type MapVec2, type MapVectorOverlay, type RoadmapTilePlacement
} from '../../../../common/spatial/map-data-view';

export const MAP_DATA_ROOT_NAME = 'sb-map-data-root';

/** The overlay's own display colours (vector layers); groups and area codes take MAP_PALETTE in their order. */
export const MAP_OVERLAY_COLOURS = {
    centreline: '#FFD60A',
    footprint: '#FF453A',
    rail: '#BF5AF2',
    carriagewayMeasured: '#5E5CE6',
    carriagewayDefaulted: '#C7C7CC',
    poi: '#FFFFFF'
} as const;

/** Heights above the measured ground the overlay draws at (m). */
const LIFT = { area: 0.25, carriageway: 0.3, roadmap: 0.4, line: 0.35, footprint: 0.3, poi: 8 };

export interface MapLegendRow { key: string; label: string; colour: string; count?: number; detail?: string }

export interface BlobPick { blobIndex: number; point: THREE.Vector3 }

export class MapDataLayer {
    readonly root = new THREE.Group();
    private readonly layers: Record<LayerKey, THREE.Group>;
    private blobMeshes = new Map<string, THREE.Mesh>();
    /** Per group mesh: its local triangle -> the payload's triangle (picking). */
    private blobTriangles = new Map<THREE.Mesh, Uint32Array>();
    private blobPayload?: BlobGroupsPayload;
    private areaMeshes = new Map<string, THREE.Mesh>();
    private lineMaterials: LineMaterial[] = [];
    private hiddenRoots = new Map<THREE.Object3D, boolean>();
    private roadmapMaterials: THREE.MeshBasicMaterial[] = [];

    constructor(private readonly scene: THREE.Scene) {
        this.root.name = MAP_DATA_ROOT_NAME;
        this.root.userData.sbOverlay = true;
        this.layers = {} as Record<LayerKey, THREE.Group>;
        for (const l of ['blobs', 'roads', 'footprints', 'areas', 'rails', 'pois', 'roadmap'] as LayerKey[]) {
            const g = new THREE.Group();
            g.name = `sb-map-data-${l}`;
            this.layers[l] = g;
            this.root.add(g);
        }
        scene.add(this.root);
    }

    // -------------------------------------------------------------------------------------------- blob groups

    /** Draws the blob groups; returns the legend (group label, palette colour, blob count) in palette order. */
    setBlobs(p: BlobGroupsPayload): MapLegendRow[] {
        this.clear('blobs');
        this.blobPayload = p;
        const colours = assignColours(p.header.groups.map(g => g.label));
        const position = new THREE.BufferAttribute(p.positions, 3);
        const lists = groupIndexLists(p);
        // the payload triangle of each group's local triangle, for picking
        const groupOfBlob = p.header.blobs.map(b => b.group);
        const fill = new Map<string, number>();
        const tris = new Map<string, Uint32Array>();
        for (const [g, list] of lists) { tris.set(g, new Uint32Array(list.length / 3)); fill.set(g, 0); }
        for (let t = 0; t < p.triBlob.length; t++) {
            const g = groupOfBlob[p.triBlob[t]];
            if (g === undefined) continue;
            const o = fill.get(g)!;
            tris.get(g)![o] = t;
            fill.set(g, o + 1);
        }
        for (const g of p.header.groups) {
            const list = lists.get(g.label);
            if (!list || list.length === 0) continue;
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', position);
            geom.setIndex(new THREE.BufferAttribute(list, 1));
            geom.computeBoundingSphere();
            geom.computeBoundingBox();
            const mat = new THREE.MeshStandardMaterial({ color: colours.get(g.label)!, roughness: 0.85, metalness: 0, flatShading: true, toneMapped: false, side: THREE.DoubleSide, polygonOffset: false, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.name = `sb-map-blob-group:${g.label}`;
            mesh.userData = { mapBlobGroup: g.label };
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            this.blobMeshes.set(g.label, mesh);
            this.blobTriangles.set(mesh, tris.get(g.label)!);
            this.layers.blobs.add(mesh);
        }
        return p.header.groups.map(g => ({ key: g.label, label: g.label, colour: colours.get(g.label)!, count: g.blobs, detail: `${g.blobs.toLocaleString('en-US')} blobs, ${Math.round(g.areaM2).toLocaleString('en-US')} m²` }));
    }

    /** The blob under a ray, among the shown groups. */
    pickBlob(raycaster: THREE.Raycaster): BlobPick | undefined {
        if (!this.blobPayload || !this.layers.blobs.visible) return undefined;
        const meshes = [...this.blobMeshes.values()].filter(m => m.visible);
        const hit = raycaster.intersectObjects(meshes, false)[0];
        if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return undefined;
        const t = this.blobTriangles.get(hit.object as THREE.Mesh)?.[hit.faceIndex];
        if (t === undefined) return undefined;
        return { blobIndex: this.blobPayload.triBlob[t], point: hit.point.clone() };
    }

    // -------------------------------------------------------------------------------------------- vector data

    /** Draws the vector overlay on the measured ground; returns the legend rows of the areas (by most specific code). */
    setVector(o: MapVectorOverlay, heightAt: (x: number, z: number) => number, resolution: THREE.Vector2): MapLegendRow[] {
        for (const l of ['roads', 'footprints', 'areas', 'rails', 'pois'] as LayerKey[]) this.clear(l);
        // a line layer, drawn only where nothing stands in front of it: no object or building is ever overlaid with a line
        const lineLayer = (segments: number[], colour: string, widthPx: number, name: string, dashed = false): LineSegments2 | undefined => {
            if (!segments.length) return undefined;
            const geom = new LineSegmentsGeometry();
            geom.setPositions(segments);
            const mat = new LineMaterial({ color: colour, linewidth: widthPx, worldUnits: false, transparent: true, opacity: 0.95, depthTest: true, depthWrite: false, toneMapped: false, dashed, dashSize: 3, gapSize: 2 });
            // a small depth bias: the line wins against the ground it lies on (and the ground blob's own bias), never a building in front
            mat.polygonOffset = true; mat.polygonOffsetFactor = -4; mat.polygonOffsetUnits = -16;
            mat.resolution.copy(resolution);
            this.lineMaterials.push(mat);
            const line = new LineSegments2(geom, mat);
            if (dashed) line.computeLineDistances();
            line.name = name;
            line.renderOrder = 21;
            return line;
        };
        const drape = (pts: MapVec2[], lift: number, out: number[], closed = false) => {
            const d = densify(closed && pts.length > 2 ? [...pts, pts[0]] : pts, 3);
            for (let i = 1; i < d.length; i++) {
                const [ax, az] = d[i - 1], [bx, bz] = d[i];
                out.push(ax, heightAt(ax, az) + lift, az, bx, heightAt(bx, bz) + lift, bz);
            }
        };

        // roads: centrelines and the measured carriageways
        const centre: number[] = [];
        for (const r of o.roads) drape(r.points, LIFT.line, centre);
        const cl = lineLayer(centre, MAP_OVERLAY_COLOURS.centreline, 2.5, 'sb-map-road-centrelines');
        if (cl) this.layers.roads.add(cl);
        if (o.carriageways.length) {
            const pos: number[] = [], col: number[] = [], idx: number[] = [];
            const measured = new THREE.Color(MAP_OVERLAY_COLOURS.carriagewayMeasured), defaulted = new THREE.Color(MAP_OVERLAY_COLOURS.carriagewayDefaulted);
            for (const c of o.carriageways) {
                const strip = carriagewayStrip(c.stations, LIFT.carriageway);
                const base = pos.length / 3;
                for (let i = 0; i < strip.positions.length; i++) pos.push(strip.positions[i]);
                c.stations.forEach(s => {
                    for (const m of [s.leftMeasured, s.rightMeasured]) { const k = m ? measured : defaulted; col.push(k.r, k.g, k.b); }
                });
                for (let i = 0; i < strip.indices.length; i++) idx.push(base + strip.indices[i]);
            }
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
            geom.setIndex(idx);
            const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
            mesh.name = 'sb-map-carriageways';
            mesh.renderOrder = 6;
            this.layers.roads.add(mesh);
        }

        // footprints: outlines at the ground
        const fp: number[] = [];
        for (const f of o.footprints) for (const loop of f.loops) drape(loop, LIFT.footprint, fp, loop.length > 2);
        const fl = lineLayer(fp, MAP_OVERLAY_COLOURS.footprint, 2, 'sb-map-footprints');
        if (fl) this.layers.footprints.add(fl);

        // rails
        const rl: number[] = [];
        for (const r of o.rails) drape(r, LIFT.line, rl);
        const rails = lineLayer(rl, MAP_OVERLAY_COLOURS.rail, 2.5, 'sb-map-rails', true);
        if (rails) this.layers.rails.add(rails);

        // areas: one translucent fill mesh per most-specific code, larger areas first
        const byKey = new Map<string, Array<{ loops: MapVec2[][] }>>();
        for (const a of o.areas) { const k = featureKey(a.types); (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(a); }
        const keys = [...byKey.keys()].sort();
        const colours = assignColours(keys, MAP_PALETTE.slice(4).concat(MAP_PALETTE.slice(0, 4)));
        const rows: MapLegendRow[] = [];
        keys.forEach((k, order) => {
            const pos: number[] = [];
            for (const a of byKey.get(k)!) {
                const [outer, ...holes] = a.loops.map(l => l.map(([x, z]) => new THREE.Vector2(x, z)));
                if (!outer || outer.length < 3) continue;
                const tris = THREE.ShapeUtils.triangulateShape(outer, holes.filter(h => h.length >= 3));
                const all = [outer, ...holes.filter(h => h.length >= 3)].flat();
                for (const t of tris) for (const i of t) { const v = all[i]; pos.push(v.x, heightAt(v.x, v.y) + LIFT.area, v.y); }
            }
            if (!pos.length) return;
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: colours.get(k)!, toneMapped: false, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
            mesh.name = `sb-map-area:${k}`;
            mesh.renderOrder = 5 + order * 0.01;
            this.areaMeshes.set(k, mesh);
            this.layers.areas.add(mesh);
            rows.push({ key: k, label: codeWords(k), colour: colours.get(k)!, count: byKey.get(k)!.length });
        });

        // POIs: a screen-space label over the ground
        for (const p of o.pois) {
            const text = p.name ?? codeWords(featureKey(p.types));
            const sprite = labelSprite(text, codeWords(featureKey(p.types)));
            sprite.position.set(p.x, heightAt(p.x, p.z) + LIFT.poi, p.z);
            this.layers.pois.add(sprite);
        }
        return rows;
    }

    // -------------------------------------------------------------------------------------------- roadmap

    setRoadmap(tiles: Array<RoadmapTilePlacement & { url: string }>, heightAt: (x: number, z: number) => number, opacity: number): void {
        this.clear('roadmap');
        const loader = new THREE.TextureLoader();
        const N = 8;
        for (const t of tiles) {
            const [nw, ne, se, sw] = t.corners;
            const pos = new Float32Array((N + 1) * (N + 1) * 3), uv = new Float32Array((N + 1) * (N + 1) * 2);
            for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
                const u = i / N, v = j / N;
                const x = (nw[0] * (1 - u) + ne[0] * u) * (1 - v) + (sw[0] * (1 - u) + se[0] * u) * v;
                const z = (nw[1] * (1 - u) + ne[1] * u) * (1 - v) + (sw[1] * (1 - u) + se[1] * u) * v;
                const k = j * (N + 1) + i;
                pos.set([x, heightAt(x, z) + LIFT.roadmap, z], k * 3);
                uv.set([u, 1 - v], k * 2);
            }
            const idx: number[] = [];
            for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
                const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
                idx.push(a, c, b, b, c, d);
            }
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
            geom.setIndex(idx);
            const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
            loader.load(t.url, tex => {
                tex.colorSpace = THREE.SRGBColorSpace;
                tex.anisotropy = 4;
                mat.map = tex;
                mat.needsUpdate = true;
            });
            this.roadmapMaterials.push(mat);
            const mesh = new THREE.Mesh(geom, mat);
            mesh.name = `sb-map-roadmap:${t.z}/${t.x}/${t.y}`;
            mesh.renderOrder = 4;
            this.layers.roadmap.add(mesh);
        }
    }

    setRoadmapOpacity(opacity: number): void {
        for (const m of this.roadmapMaterials) m.opacity = opacity;
    }

    // -------------------------------------------------------------------------------------------- visibility

    /** Layer switches and the legend rows hidden (group labels, area codes). */
    applyVisibility(layers: Record<LayerKey, boolean>, hidden: Set<string>): void {
        for (const [l, g] of Object.entries(this.layers) as Array<[LayerKey, THREE.Group]>) g.visible = layers[l];
        for (const [k, m] of this.blobMeshes) m.visible = !hidden.has(k);
        for (const [k, m] of this.areaMeshes) m.visible = !hidden.has(k);
    }

    /**
     * The blob groups' depth bias: only while the scene's own surface is drawn under them (the two would z-fight). With the
     * scene hidden the groups take none, so the lines and fills draped on the ground are not buried under a biased ground.
     */
    setBlobDepthBias(on: boolean): void {
        for (const m of this.blobMeshes.values()) {
            const mat = m.material as THREE.Material;
            if (mat.polygonOffset !== on) { mat.polygonOffset = on; mat.needsUpdate = true; }
        }
    }

    /** Hides the given scene roots (they are drawn again by the blob groups); restores them when called with hide false. */
    hideSceneRoots(roots: THREE.Object3D[], hide: boolean): void {
        if (hide) {
            for (const r of roots) {
                if (!this.hiddenRoots.has(r)) this.hiddenRoots.set(r, r.visible);
                r.visible = false;
            }
        } else {
            for (const [r, was] of this.hiddenRoots) r.visible = was;
            this.hiddenRoots.clear();
        }
    }

    setResolution(width: number, height: number): void {
        for (const m of this.lineMaterials) m.resolution.set(width, height);
    }

    has(layer: LayerKey): boolean {
        return this.layers[layer].children.length > 0;
    }

    private clear(layer: LayerKey): void {
        const g = this.layers[layer];
        for (const child of [...g.children]) {
            g.remove(child);
            child.traverse(o => {
                const m = o as THREE.Mesh;
                if (m.geometry) m.geometry.dispose();
                const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
                for (const mat of mats) {
                    const map = (mat as THREE.MeshBasicMaterial).map;
                    if (map) map.dispose();
                    mat.dispose();
                    this.lineMaterials = this.lineMaterials.filter(x => x !== mat);
                    this.roadmapMaterials = this.roadmapMaterials.filter(x => x !== mat);
                }
            });
        }
        if (layer === 'blobs') { this.blobMeshes.clear(); this.blobTriangles.clear(); this.blobPayload = undefined; }
        if (layer === 'areas') this.areaMeshes.clear();
    }

    dispose(): void {
        this.hideSceneRoots([], false);
        for (const l of Object.keys(this.layers) as LayerKey[]) this.clear(l);
        this.scene.remove(this.root);
    }
}

/** A screen-space label: text on a dark pill, constant size on screen (sizeAttenuation off), drawn over the scene. */
function labelSprite(text: string, kind: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const px = 24, pad = 8;
    ctx.font = `600 ${px}px system-ui, -apple-system, sans-serif`;
    const w = Math.ceil(ctx.measureText(text).width) + pad * 2 + 18, h = px + pad * 2;
    canvas.width = w; canvas.height = h;
    ctx.font = `600 ${px}px system-ui, -apple-system, sans-serif`;
    ctx.fillStyle = 'rgba(18,18,22,0.82)';
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = MAP_OVERLAY_COLOURS.poi;
    ctx.beginPath();
    ctx.arc(pad + 6, h / 2, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pad + 18, h / 2 + 1);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true }));
    const s = 0.016;
    sprite.scale.set((s * w) / h, s, 1);
    sprite.center.set(0, 0.5);
    sprite.renderOrder = 30;
    sprite.name = `sb-map-poi:${text}`;
    sprite.userData = { poiKind: kind };
    return sprite;
}
