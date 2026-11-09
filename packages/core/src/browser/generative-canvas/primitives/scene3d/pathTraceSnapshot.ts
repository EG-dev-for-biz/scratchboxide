/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What the 3D viewport shows, as one GLB for the Metal path tracer: every visible triangle mesh at its world
 * transform with its own material (instanced meshes written out per instance), and the viewport's furniture left
 * out (grid, gizmos, selection, sky dome, sun disc, god rays, stars, probes). Nothing is made here: the geometry is
 * the scene's own, read as it is drawn. What the tracer cannot take (points, lines, shader materials, splats) is
 * counted, not approximated, and the caller says so.
 *
 * The scene's point, spot and directional lights are not in the GLB: pathTraceLightsOf lists them for the session
 * (the tracer samples them with its light tree), so a change of light leaves the geometry file and its build as
 * they were. The atmosphere's sun is the tracer's own sun. Area lights have no punctual form and are counted.
 *
 * Also the light and camera of the view, in the tracer's terms: the atmospheric sun's direction as elevation and
 * azimuth (the helper's convention: azimuth 0 toward -Z, 90 toward +X), else the neutral studio dome.
 */

import * as THREE from 'three';
import type { PathTraceView } from '../../services/virtual-geometry/path-trace-client';

/** Viewport furniture by the names the viewport gives it: never part of the scene that is traced. */
const FURNITURE_NAMES = new Set([
    'sb-grid-helper', 'sb-selection-helper', 'sb-starfield', 'sb-place-reflection-probe', 'volumetric-god-rays', 'god-rays-emitter',
    'PhysicalSunDisc', 'AtmosphericSkyDome', 'AtmosphericSunGlare', 'sbStepSnapshot'
]);
/** The atmosphere's sun lights (syncAtmosphere / LocationObjectLightingService). */
const SUN_LIGHT_NAMES = new Set(['AtmosphericSunLight', 'LocationSunLight']);
/** Instanced copies written out before the rest are counted as skipped. */
const MAX_INSTANCED_TRIANGLES = 30_000_000;
const MAX_TEXTURE_SIZE = 4096;

export interface PathTraceSnapshotStats {
    meshes: number;
    triangles: number;
    instancesExpanded: number;
    /** Point, spot and directional lights the scene had (sent beside the GLB, see pathTraceLightsOf). */
    lights: number;
    /** Textures held as 8-bit pixel buffers (DataTextures), written out from a canvas of their pixels. */
    texturesConverted: number;
    /** Meshes whose vertex data was quantized (integer positions, normals or uvs), written out as float copies. */
    geometriesDequantized: number;
    /** Cut-out materials whose alphaMap was folded into the base colour's alpha (glTF has no alpha map; MASK reads it there). */
    alphaMapsFolded: number;
    /** `textures`: texture slots left out because their image is neither a picture nor an 8-bit pixel buffer. */
    skipped: { points: number; lines: number; shaderMaterials: number; instancesOverCap: number; empty: number; areaLights: number; textures: number };
    exportMs: number;
    bytes: number;
}

export interface PathTraceSnapshot {
    glb: ArrayBuffer;
    stats: PathTraceSnapshotStats;
}

export type PathTraceLighting = { sun: { elevationDeg: number; azimuthDeg: number } } | { studio: Record<string, never> };

function visibleInWorld(o: THREE.Object3D): boolean {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) {
        if (!p.visible || FURNITURE_NAMES.has(p.name)) return false;
    }
    return true;
}

function triangleCount(geometry: THREE.BufferGeometry): number {
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position');
    if (!position) return 0;
    return Math.floor((index ? index.count : position.count) / 3);
}

/**
 * A punctual light as the tracer takes it (MetalPathTracePunctualLight, the GLB's world coordinates): position,
 * the direction it shines (three's lights look from their position at their target), colour times intensity
 * (candela, or lux for a directional light), range and spot cone (three's penumbra softening the inner cone).
 */
export interface PathTraceLight {
    position: [number, number, number];
    direction: [number, number, number];
    intensity: [number, number, number];
    range?: number;
    innerConeAngle?: number;
    outerConeAngle?: number;
    distant?: boolean;
}

/** A point, spot or directional light as the tracer takes it, or null for any other kind of light. */
function tracedLight(light: THREE.Light): PathTraceLight | null {
    const l = light as THREE.Light & { isPointLight?: boolean; isSpotLight?: boolean; isDirectionalLight?: boolean };
    if (!l.isPointLight && !l.isSpotLight && !l.isDirectionalLight) return null;
    const position = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld);
    const direction = new THREE.Vector3(0, 0, -1);
    const target = (light as THREE.SpotLight | THREE.DirectionalLight).target as THREE.Object3D | undefined;
    if (target && !l.isPointLight) {
        target.updateMatrixWorld();
        const aim = new THREE.Vector3().setFromMatrixPosition(target.matrixWorld).sub(position);
        if (aim.lengthSq() > 0) direction.copy(aim.normalize());
    }
    const c = light.color;
    const out: PathTraceLight = {
        position: [position.x, position.y, position.z],
        direction: [direction.x, direction.y, direction.z],
        intensity: [c.r * light.intensity, c.g * light.intensity, c.b * light.intensity]
    };
    if (l.isDirectionalLight) out.distant = true;
    else {
        const distance = (light as THREE.PointLight).distance;
        if (distance > 0) out.range = distance;
    }
    if (l.isSpotLight) {
        const spot = light as THREE.SpotLight;
        out.outerConeAngle = spot.angle;
        out.innerConeAngle = (1 - spot.penumbra) * spot.angle;
    }
    return out;
}

/**
 * The scene's point, spot and directional lights for the tracer, apart from the atmosphere's sun (the tracer's own
 * sun, pathTraceLightingOf) and anything hidden or excluded; area lights are counted, having no punctual form.
 * Sent beside the snapshot rather than in it, so a change of light neither changes the geometry file nor rebuilds it.
 */
export function pathTraceLightsOf(scene: THREE.Scene, exclude: Array<THREE.Object3D | null | undefined> = []): { lights: PathTraceLight[]; areaLights: number } {
    const excluded = new Set(exclude.filter((o): o is THREE.Object3D => !!o));
    const lights: PathTraceLight[] = [];
    let areaLights = 0;
    scene.traverse(o => {
        const obj = o as THREE.Object3D & { isLight?: boolean; isRectAreaLight?: boolean };
        if (!obj.isLight) return;
        for (let p: THREE.Object3D | null = o; p; p = p.parent) if (excluded.has(p)) return;
        if (!visibleInWorld(o)) return;
        const light = o as THREE.Light;
        // Ambient and hemisphere light is the dome's.
        if (SUN_LIGHT_NAMES.has(light.name) || !(light.intensity > 0)) return;
        if (obj.isRectAreaLight) { areaLights++; return; }
        const traced = tracedLight(light);
        if (traced) lights.push(traced);
    });
    return { lights, areaLights };
}

/**
 * The geometry with float32 vertex attributes: a quantized one (KHR_mesh_quantization's integer positions, normals
 * or uvs, normalized or not, interleaved or not) is copied with every value read back as a float, since the
 * virtual geometry builder reads float positions only. The scene's own geometry is never changed.
 */
function floatGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry | null {
    const names = Object.keys(geometry.attributes);
    const quantized = names.some(n => {
        const a = geometry.attributes[n] as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
        return !((a as THREE.BufferAttribute).array instanceof Float32Array) || (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute;
    });
    if (!quantized) return null;
    const out = new THREE.BufferGeometry();
    for (const n of names) {
        const a = geometry.attributes[n] as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
        const values = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) {
            for (let k = 0; k < a.itemSize; k++) values[i * a.itemSize + k] = a.getComponent(i, k);
        }
        out.setAttribute(n, new THREE.BufferAttribute(values, a.itemSize));
    }
    const index = geometry.getIndex();
    if (index) out.setIndex(index);
    for (const g of geometry.groups) out.addGroup(g.start, g.count, g.materialIndex);
    out.boundingBox = geometry.boundingBox;
    out.boundingSphere = geometry.boundingSphere;
    return out;
}

/** Texture slots of three's materials that the exporter reads. */
const TEXTURE_SLOTS = ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'bumpMap', 'displacementMap', 'lightMap'] as const;

/** An image the exporter can draw on a canvas (it packs and converts maps that way without checking). */
function drawableImage(image: unknown): boolean {
    if (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) return image.complete && image.naturalWidth > 0;
    return (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement)
        || (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap)
        || (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas);
}

/** An 8-bit pixel buffer (a DataTexture's image: 1, 2, 3 or 4 channels) as an RGBA canvas, rows as stored; else null. */
function canvasOfPixels(image: unknown): HTMLCanvasElement | null {
    const img = image as { data?: unknown; width?: number; height?: number } | null;
    if (!img || !(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray)) return null;
    const width = img.width ?? 0, height = img.height ?? 0;
    const pixels = width * height;
    if (!(pixels > 0)) return null;
    const channels = img.data.length / pixels;
    if (![1, 2, 3, 4].includes(channels)) return null;
    const rgba = new Uint8ClampedArray(pixels * 4);
    for (let p = 0; p < pixels; p++) {
        const s = p * channels;
        const r = img.data[s];
        rgba[p * 4] = r;
        rgba[p * 4 + 1] = channels >= 3 ? img.data[s + 1] : r;
        rgba[p * 4 + 2] = channels >= 3 ? img.data[s + 2] : r;
        rgba[p * 4 + 3] = channels === 4 ? img.data[s + 3] : channels === 2 ? img.data[s + 1] : 255;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.putImageData(new ImageData(rgba, width, height), 0, 0);
    return canvas;
}

/**
 * The material with every texture the exporter can draw: a pixel-buffer texture is replaced by a copy drawn from a
 * canvas of its pixels, and one that is neither (a float buffer, an image not loaded) is left out and counted. The
 * scene's own material is never changed: a copy is made when a slot changes.
 */
function withDrawableTextures(material: THREE.Material, stats: PathTraceSnapshotStats, replaced: Map<THREE.Texture, THREE.Texture | null>): THREE.Material {
    let out: THREE.Material | null = null;
    const slots = material as unknown as Record<string, THREE.Texture | null | undefined>;
    for (const slot of TEXTURE_SLOTS) {
        const tex = slots[slot];
        if (!tex || !(tex as THREE.Texture).isTexture || (tex as THREE.CompressedTexture).isCompressedTexture || drawableImage(tex.image)) continue;
        if (!replaced.has(tex)) {
            const canvas = canvasOfPixels(tex.image);
            if (canvas) {
                const copy = tex.clone();
                copy.image = canvas;
                copy.needsUpdate = true;
                replaced.set(tex, copy);
                stats.texturesConverted++;
            } else {
                replaced.set(tex, null);
                stats.skipped.textures++;
            }
        }
        out ??= material.clone();
        (out as unknown as Record<string, THREE.Texture | null>)[slot] = replaced.get(tex) ?? null;
    }
    return out ?? material;
}

/** An image drawn on a canvas at a size, flipped vertically when its texture's row order differs from the output's. */
function drawInto(ctx: CanvasRenderingContext2D, image: CanvasImageSource, width: number, height: number, flip: boolean): void {
    ctx.save();
    if (flip) {
        ctx.translate(0, height);
        ctx.scale(1, -1);
    }
    ctx.drawImage(image, 0, 0, width, height);
    ctx.restore();
}

/**
 * A cut-out material (alphaMap with an alpha test) with its alpha moved where glTF keeps it: a copy of the base colour
 * texture whose alpha is the alphaMap's green channel (as three reads it), or a white texture carrying only the cut-out
 * when there is no colour map (the material's colour still tints it). The exporter then writes alphaMode MASK at the
 * material's alphaTest. Both maps are taken to share their uvs, as the viewport's cut-out cards and leaves do.
 */
function withAlphaInColour(material: THREE.Material, stats: PathTraceSnapshotStats, folded: Map<string, THREE.Texture>): THREE.Material {
    const m = material as THREE.MeshStandardMaterial;
    const alphaMap = m.alphaMap;
    if (!alphaMap || !(m.alphaTest > 0) || !drawableImage(alphaMap.image)) return material;
    const map = m.map && drawableImage(m.map.image) ? m.map : null;
    const key = `${map?.uuid ?? 'none'}|${alphaMap.uuid}`;
    let texture = folded.get(key);
    if (!texture) {
        const alphaImage = alphaMap.image as { width: number; height: number };
        const width = Math.max(alphaImage.width, (map?.image as { width?: number } | undefined)?.width ?? 0);
        const height = Math.max(alphaImage.height, (map?.image as { height?: number } | undefined)?.height ?? 0);
        const outFlipY = map ? map.flipY : alphaMap.flipY;
        const colour = document.createElement('canvas');
        colour.width = width;
        colour.height = height;
        const cctx = colour.getContext('2d', { willReadFrequently: true })!;
        if (map) drawInto(cctx, map.image as CanvasImageSource, width, height, map.flipY !== outFlipY);
        else { cctx.fillStyle = '#ffffff'; cctx.fillRect(0, 0, width, height); }
        const mask = document.createElement('canvas');
        mask.width = width;
        mask.height = height;
        const mctx = mask.getContext('2d', { willReadFrequently: true })!;
        drawInto(mctx, alphaMap.image as CanvasImageSource, width, height, alphaMap.flipY !== outFlipY);
        const rgba = cctx.getImageData(0, 0, width, height);
        const a = mctx.getImageData(0, 0, width, height).data;
        for (let i = 0; i < rgba.data.length; i += 4) rgba.data[i + 3] = a[i + 1];
        cctx.putImageData(rgba, 0, 0);
        const source = map ?? alphaMap;
        texture = new THREE.CanvasTexture(colour);
        texture.flipY = outFlipY;
        texture.wrapS = source.wrapS;
        texture.wrapT = source.wrapT;
        texture.offset.copy(source.offset);
        texture.repeat.copy(source.repeat);
        texture.rotation = source.rotation;
        texture.center.copy(source.center);
        texture.channel = source.channel;
        texture.colorSpace = map ? map.colorSpace : THREE.SRGBColorSpace;
        folded.set(key, texture);
        stats.alphaMapsFolded++;
    }
    const out = material.clone() as THREE.MeshStandardMaterial;
    out.map = texture;
    out.alphaMap = null;
    return out;
}

/** A material the exporter writes as glTF metallic-roughness; shader materials have no glTF reading and are refused. */
function exportMaterial(material: THREE.Material): THREE.Material | null {
    const m = material as THREE.Material & { isShaderMaterial?: boolean; isMeshStandardMaterial?: boolean; isMeshBasicMaterial?: boolean };
    if (m.isShaderMaterial) return null;
    if (m.isMeshStandardMaterial || m.isMeshBasicMaterial) return material;
    // Lambert, Phong, Toon and the like: their colour, map, emission and transparency carried over, rough and non-metal.
    const src = material as THREE.Material & { color?: THREE.Color; map?: THREE.Texture | null; emissive?: THREE.Color; emissiveMap?: THREE.Texture | null; normalMap?: THREE.Texture | null };
    const out = new THREE.MeshStandardMaterial({
        color: src.color ?? new THREE.Color(1, 1, 1),
        map: src.map ?? null,
        emissive: src.emissive ?? new THREE.Color(0, 0, 0),
        emissiveMap: src.emissiveMap ?? null,
        normalMap: src.normalMap ?? null,
        roughness: 0.8,
        metalness: 0,
        transparent: material.transparent,
        opacity: material.opacity,
        side: material.side,
        alphaTest: material.alphaTest
    });
    out.name = material.name;
    return out;
}

/**
 * The visible scene as a binary GLB. `exclude` names further objects the caller draws over the scene (its gizmo
 * group, brush cursor); they and their children are left out.
 */
export async function snapshotSceneForPathTrace(scene: THREE.Scene, exclude: Array<THREE.Object3D | null | undefined> = []): Promise<PathTraceSnapshot> {
    const started = performance.now();
    const excluded = new Set(exclude.filter((o): o is THREE.Object3D => !!o));
    const stats: PathTraceSnapshotStats = {
        meshes: 0, triangles: 0, instancesExpanded: 0, lights: 0, texturesConverted: 0, geometriesDequantized: 0, alphaMapsFolded: 0,
        skipped: { points: 0, lines: 0, shaderMaterials: 0, instancesOverCap: 0, empty: 0, areaLights: 0, textures: 0 },
        exportMs: 0, bytes: 0
    };
    scene.updateMatrixWorld(true);
    const root = new THREE.Group();
    root.name = 'sb-path-trace-snapshot';
    const converted = new Map<THREE.Material, THREE.Material | null>();
    const replacedTextures = new Map<THREE.Texture, THREE.Texture | null>();
    const foldedAlpha = new Map<string, THREE.Texture>();
    const materialFor = (m: THREE.Material): THREE.Material | null => {
        if (!converted.has(m)) {
            const exported = exportMaterial(m);
            converted.set(m, exported ? withAlphaInColour(withDrawableTextures(exported, stats, replacedTextures), stats, foldedAlpha) : null);
        }
        return converted.get(m)!;
    };
    const floatCopies = new Map<THREE.BufferGeometry, THREE.BufferGeometry | null>();
    const geometryFor = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
        if (!floatCopies.has(g)) {
            const copy = floatGeometry(g);
            if (copy) stats.geometriesDequantized++;
            floatCopies.set(g, copy);
        }
        return floatCopies.get(g) ?? g;
    };
    const place = (sourceGeometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], world: THREE.Matrix4, name: string) => {
        const geometry = geometryFor(sourceGeometry);
        const mats = Array.isArray(material) ? material.map(materialFor) : materialFor(material);
        if (Array.isArray(mats) ? mats.some(m => m === null) : mats === null) {
            stats.skipped.shaderMaterials++;
            return;
        }
        const mesh = new THREE.Mesh(geometry, mats as THREE.Material | THREE.Material[]);
        mesh.name = name;
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(world);
        root.add(mesh);
        stats.meshes++;
        stats.triangles += triangleCount(geometry);
    };

    let instancedTriangles = 0;
    const instanceMatrix = new THREE.Matrix4();
    const world = new THREE.Matrix4();
    scene.traverse(o => {
        if (excluded.has(o)) return;
        const obj = o as THREE.Object3D & { isPoints?: boolean; isLine?: boolean; isSprite?: boolean; isMesh?: boolean; isInstancedMesh?: boolean; isLight?: boolean; isRectAreaLight?: boolean };
        if (!obj.isPoints && !obj.isLine && !obj.isSprite && !obj.isMesh && !obj.isLight) return;
        let excludedAncestor = false;
        for (let p = o.parent; p; p = p.parent) if (excluded.has(p)) { excludedAncestor = true; break; }
        if (excludedAncestor || !visibleInWorld(o)) return;
        if (obj.isLight) return; // lights go beside the snapshot (pathTraceLightsOf)
        if (obj.isPoints || obj.isSprite) { stats.skipped.points++; return; }
        if (obj.isLine) { stats.skipped.lines++; return; }
        const mesh = o as THREE.Mesh;
        const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
        if (!geometry || triangleCount(geometry) === 0) { stats.skipped.empty++; return; }
        if (obj.isInstancedMesh) {
            const inst = o as THREE.InstancedMesh;
            const tris = triangleCount(geometry);
            for (let i = 0; i < inst.count; i++) {
                if (instancedTriangles + tris > MAX_INSTANCED_TRIANGLES) { stats.skipped.instancesOverCap += inst.count - i; break; }
                inst.getMatrixAt(i, instanceMatrix);
                world.multiplyMatrices(inst.matrixWorld, instanceMatrix);
                place(geometry, inst.material, world, `${inst.name || 'instanced'}#${i}`);
                instancedTriangles += tris;
                stats.instancesExpanded++;
            }
            return;
        }
        place(geometry, mesh.material, mesh.matrixWorld, mesh.name);
    });
    const sceneLights = pathTraceLightsOf(scene, exclude);
    stats.lights = sceneLights.lights.length;
    stats.skipped.areaLights = sceneLights.areaLights;

    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
    // Colour maps of opaque materials go as JPEG (far smaller and quicker to encode); the rest stay PNG.
    const jpegMarked: THREE.Texture[] = [];
    for (const m of converted.values()) {
        const map = (m as THREE.MeshStandardMaterial | null)?.map;
        if (m && map && !m.transparent && m.alphaTest === 0 && map.userData.mimeType === undefined) {
            map.userData.mimeType = 'image/jpeg';
            jpegMarked.push(map);
        }
    }
    try {
        const glb = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true, maxTextureSize: MAX_TEXTURE_SIZE }) as ArrayBuffer;
        stats.exportMs = performance.now() - started;
        stats.bytes = glb.byteLength;
        return { glb, stats };
    } finally {
        for (const t of jpegMarked) delete t.userData.mimeType;
        for (const [src, out] of converted) if (out && out !== src) out.dispose();
        for (const copy of replacedTextures.values()) copy?.dispose();
        for (const copy of foldedAlpha.values()) copy.dispose();
        for (const copy of floatCopies.values()) copy?.dispose();
    }
}

/** The atmospheric sun when one lights the scene from above the horizon, else the neutral studio dome. */
export function pathTraceLightingOf(scene: THREE.Scene): PathTraceLighting {
    let best: THREE.DirectionalLight | null = null;
    scene.traverse(o => {
        const l = o as THREE.DirectionalLight;
        if (!l.isDirectionalLight || !SUN_LIGHT_NAMES.has(l.name) || !visibleInWorld(l) || l.intensity <= 0) return;
        if (!best || l.intensity > best.intensity) best = l;
    });
    const sun = best as THREE.DirectionalLight | null;
    if (!sun) return { studio: {} };
    const from = new THREE.Vector3().setFromMatrixPosition(sun.matrixWorld);
    const to = new THREE.Vector3().setFromMatrixPosition(sun.target.matrixWorld);
    const d = from.sub(to);
    if (d.lengthSq() === 0) return { studio: {} };
    d.normalize();
    if (d.y <= 0) return { studio: {} };
    const elevationDeg = THREE.MathUtils.radToDeg(Math.asin(d.y));
    let azimuthDeg = THREE.MathUtils.radToDeg(Math.atan2(d.x, -d.z));
    if (azimuthDeg < 0) azimuthDeg += 360;
    return { sun: { elevationDeg, azimuthDeg } };
}

/** The viewport camera in the traced file's coordinates (the snapshot's world, less the file's origin). */
export function pathTraceViewOf(camera: THREE.PerspectiveCamera, origin: [number, number, number]): PathTraceView {
    camera.updateMatrixWorld();
    const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const forward = new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
    const up = new THREE.Vector3(0, 1, 0).transformDirection(camera.matrixWorld);
    const target = eye.clone().add(forward);
    const fovYDeg = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (camera.zoom || 1)));
    const round = (v: number) => Math.round(v * 1e5) / 1e5;
    return {
        eye: [round(eye.x - origin[0]), round(eye.y - origin[1]), round(eye.z - origin[2])],
        target: [round(target.x - origin[0]), round(target.y - origin[1]), round(target.z - origin[2])],
        up: [round(up.x), round(up.y), round(up.z)],
        fovYDeg: round(fovYDeg)
    };
}
