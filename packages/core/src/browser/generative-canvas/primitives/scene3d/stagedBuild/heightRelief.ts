/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The viewer side of a model's material relief (user ask, 2026-11-05: real height). A model whose asset carries
 * extras.sbMaterialRelief (each class's recess tile: 255 the surface, 0 a recess of depthM, repeating at its real size) and
 * whose materials carry extras.sbMaterial.relief (the surface's class map and the metres its UVs span) is drawn with that
 * height three ways, by distance:
 *
 *  - Near (within the cell's showWithinM): the engine's displaced geometry (height-relief.ts), a child node per cell,
 *    drawn in place of the cell's flat triangles. Its material is marked displaced: no parallax (the geometry is the
 *    relief), but the fine normal and the recess shading below still apply.
 *  - Near and mid (to RELIEF_FADE.farM): parallax occlusion mapping. The view ray is marched through the recess field in
 *    the surface's own metric frame (the same field the engine displaces by), and every map is read where it lands; the
 *    normal is tilted by the field's slope there, and the ambient light dimmed by the recess (a joint is a groove). All of
 *    it fades out between RELIEF_FADE.nearM and farM.
 *  - Far: the material's own normal map alone, as before.
 *
 * Nothing here makes geometry (AGENTS.md section 3.1): the displaced cells come from the native engine; this file only
 * chooses which triangles are drawn, and shades.
 */

import * as THREE from 'three';

/** The relief in full within nearM of the camera, gone past farM (metres). */
export const RELIEF_FADE = { nearM: 30, farM: 70 } as const;
/** The most classes a model's relief may hold (the uniform array's size). */
export const MAX_RELIEF_CLASSES = 8;
/** How far a recess of the full depth dims the ambient light (0 none, 1 black). */
export const RELIEF_OCCLUSION = 0.45;
const TILE_SIZE = 256;

interface ReliefAsset { depthM: number; tiles: Array<null | { class: number; texture: number; sizeM: [number, number] }> }
interface ReliefMaterial { classTexture: number; uvMetres: [number, number]; displaced?: boolean }

interface GltfLike {
    scene: THREE.Object3D;
    parser?: { getDependency: (type: string, index: number) => Promise<unknown>; json?: { asset?: { extras?: { sbMaterialRelief?: ReliefAsset } } } };
}

const reliefOf = (m: THREE.Material | undefined): ReliefMaterial | undefined => {
    const r = (m?.userData as { sbMaterial?: { relief?: ReliefMaterial } } | undefined)?.sbMaterial?.relief;
    return r && typeof r.classTexture === 'number' && Array.isArray(r.uvMetres) ? r : undefined;
};

const FRAGMENT_DECL = `
#ifdef SB_RELIEF
precision highp sampler2DArray;
uniform sampler2D uSbReliefClass;
uniform sampler2DArray uSbReliefTiles;
uniform vec2 uSbReliefSize[ ${MAX_RELIEF_CLASSES} ];
uniform vec2 uSbReliefUvM;
uniform float uSbReliefDepth;
uniform vec2 uSbReliefFade;
vec2 sbUvR;
vec3 sbReliefTilt;
float sbReliefAo;
#endif
`;

/**
 * At the start of the fragment: the ray marched through the recess field (see the file comment), the UV it lands on
 * (sbUvR, which every map below is then read at), the surface's tilt there in view space (sbReliefTilt, added to the
 * normal after the normal map) and the ambient dimming (sbReliefAo).
 */
const FRAGMENT_MARCH = `
#include <clipping_planes_fragment>
#ifdef SB_RELIEF
    sbUvR = vMapUv;
    sbReliefTilt = vec3( 0.0 );
    sbReliefAo = 1.0;
    {
        vec2 sbUv0 = vMapUv;
        float sbFade = 1.0 - smoothstep( uSbReliefFade.x, uSbReliefFade.y, length( vViewPosition ) );
        int sbCi = int( floor( texture2D( uSbReliefClass, sbUv0 ).r * 255.0 + 0.5 ) );
        if ( sbFade > 0.0 && sbCi < ${MAX_RELIEF_CLASSES} && uSbReliefSize[ sbCi ].x > 0.0 ) {
            vec3 sbP = - vViewPosition;
            vec3 sbDpx = dFdx( sbP ), sbDpy = dFdy( sbP );
            vec2 sbDux = dFdx( sbUv0 ), sbDuy = dFdy( sbUv0 );
            vec3 sbN = normalize( vNormal ) * ( gl_FrontFacing ? 1.0 : - 1.0 );
            // the surface's own frame from the screen derivatives: Tg / det and Bg / det are the gradients of u and v
            vec3 sbPerp2 = cross( sbDpy, sbN ), sbPerp1 = cross( sbN, sbDpx );
            float sbDet = dot( sbDpx, sbPerp2 );
            vec3 sbTg = sbPerp2 * sbDux.x + sbPerp1 * sbDuy.x, sbBg = sbPerp2 * sbDux.y + sbPerp1 * sbDuy.y;
            if ( abs( sbDet ) > 1e-12 ) {
                float sbLayer = float( sbCi );
                vec2 sbScale = uSbReliefUvM / uSbReliefSize[ sbCi ];
                vec2 sbTdx = sbDux * sbScale, sbTdy = sbDuy * sbScale;
                float sbDepth = uSbReliefDepth * sbFade;
                float sbHit = 1.0 - textureGrad( uSbReliefTiles, vec3( sbUv0 * sbScale, sbLayer ), sbTdx, sbTdy ).r;
                #ifndef SB_RELIEF_DISPLACED
                {
                    vec3 sbD = normalize( sbP );
                    float sbNd = max( - dot( sbD, sbN ), 0.12 );
                    vec3 sbDt = sbD - sbN * dot( sbD, sbN );
                    // the UVs crossed in sinking the whole depth along the view ray
                    vec2 sbSpan = vec2( dot( sbDt, sbTg ), dot( sbDt, sbBg ) ) / ( sbDet * sbNd ) * sbDepth;
                    float sbStep = 1.0 / mix( 20.0, 6.0, sbNd );
                    float sbCur = 0.0, sbRec = sbHit, sbPrevCur = 0.0, sbPrevRec = sbHit;
                    for ( int i = 0; i < 20; i ++ ) {
                        if ( sbCur >= sbRec ) break;
                        sbPrevCur = sbCur; sbPrevRec = sbRec;
                        sbCur += sbStep;
                        sbRec = 1.0 - textureGrad( uSbReliefTiles, vec3( ( sbUv0 + sbSpan * sbCur ) * sbScale, sbLayer ), sbTdx, sbTdy ).r;
                    }
                    // between the last sample above the surface and the first below it
                    float sbBefore = sbPrevRec - sbPrevCur, sbAfter = sbRec - sbCur;
                    sbHit = sbCur > 0.0 ? mix( sbPrevCur, sbCur, clamp( sbBefore / max( sbBefore - sbAfter, 1e-5 ), 0.0, 1.0 ) ) : 0.0;
                    sbUvR = sbUv0 + sbSpan * sbHit;
                }
                #endif
                // the field's slope where the ray landed (metres per metre), as a tilt of the normal in view space
                vec2 sbTu = sbUvR * sbScale, sbE = vec2( 1.0 / ${TILE_SIZE.toFixed(1)}, 0.0 );
                float sbRx = textureGrad( uSbReliefTiles, vec3( sbTu - sbE.xy, sbLayer ), sbTdx, sbTdy ).r - textureGrad( uSbReliefTiles, vec3( sbTu + sbE.xy, sbLayer ), sbTdx, sbTdy ).r;
                float sbRy = textureGrad( uSbReliefTiles, vec3( sbTu - sbE.yx, sbLayer ), sbTdx, sbTdy ).r - textureGrad( uSbReliefTiles, vec3( sbTu + sbE.yx, sbLayer ), sbTdx, sbTdy ).r;
                vec2 sbSlope = vec2( sbRx, sbRy ) * sbDepth / ( 2.0 * sbE.x * uSbReliefSize[ sbCi ] );
                float sbSign = sbDet < 0.0 ? - 1.0 : 1.0;
                sbReliefTilt = normalize( sbTg * sbSign ) * sbSlope.x + normalize( sbBg * sbSign ) * sbSlope.y;
                sbReliefAo = 1.0 - ${RELIEF_OCCLUSION.toFixed(2)} * sbHit * sbFade;
            }
        }
    }
    #define vMapUv sbUvR
    #ifdef USE_ROUGHNESSMAP
        #define vRoughnessMapUv sbUvR
    #endif
    #ifdef USE_METALNESSMAP
        #define vMetalnessMapUv sbUvR
    #endif
    #ifdef USE_AOMAP
        #define vAoMapUv sbUvR
    #endif
#endif
`;
/** The normal map read where the ray landed, then tilted by the field's slope. */
const FRAGMENT_NORMAL = `
#if defined( SB_RELIEF ) && defined( USE_NORMALMAP )
    #define vNormalMapUv sbUvR
#endif
#include <normal_fragment_maps>
#ifdef SB_RELIEF
    normal = normalize( normal + sbReliefTilt );
#endif
`;
const FRAGMENT_AO = `
#include <aomap_fragment>
#ifdef SB_RELIEF
    reflectedLight.indirectDiffuse *= sbReliefAo;
#endif
`;

/** One channel of a loaded texture's image, resampled to size x size. */
function redOf(tex: THREE.Texture, size: number): Uint8Array {
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2D canvas to read a relief tile with');
    ctx.drawImage(tex.image as CanvasImageSource, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data, out = new Uint8Array(size * size);
    for (let i = 0; i < out.length; i++) out[i] = px[i * 4];
    return out;
}

// ---- the near level of detail ----

interface ReliefCell { start: number; count: number; near: THREE.Object3D; centre: THREE.Vector3; radius: number; shown: boolean }
interface ReliefSurface { mesh: THREE.Mesh; showWithinM: number; cells: ReliefCell[]; first: number }
const surfaces = new Set<ReliefSurface>();
const local = new THREE.Vector3();
/** Each prepared model's depth uniform with the depth it was given, so the relief can be switched off and on (setHeightReliefEnabled). */
const depths = new Set<{ uniform: { value: number }; depthM: number }>();
let enabled = true;

/**
 * Switches every model's relief off or on (the parallax, the fine normal, the recess shading and the displaced cells), for
 * a before/after at one camera; the materials' own normal maps stay. Returns the relief surfaces and materials it reached.
 */
export function setHeightReliefEnabled(on: boolean): { surfaces: number; materials: number } {
    enabled = on;
    for (const d of depths) d.uniform.value = on ? d.depthM : 0;
    return { surfaces: surfaces.size, materials: depths.size };
}

/** Which of a surface's index runs are drawn: all of it, less the cells whose displaced copy is shown. */
function applyRuns(s: ReliefSurface): void {
    const geo = s.mesh.geometry, any = s.cells.some(c => c.shown);
    geo.clearGroups();
    if (!any) {
        if (Array.isArray(s.mesh.material) && s.mesh.material.length === 1) s.mesh.material = s.mesh.material[0];
        return;
    }
    if (!Array.isArray(s.mesh.material)) s.mesh.material = [s.mesh.material];
    if (s.first > 0) geo.addGroup(0, s.first, 0);
    for (const c of s.cells) if (!c.shown) geo.addGroup(c.start, c.count, 0);
}

/**
 * Before each frame: every relief surface's cells nearer the camera than showWithinM show their displaced copy in place
 * of their flat triangles (leaving at 1.15 x, so a cell at the limit does not flicker). Returns the displaced cells shown.
 */
export function updateHeightReliefLods(camera: THREE.Camera): number {
    let shown = 0;
    for (const s of surfaces) {
        if (!s.mesh.parent) continue;
        s.mesh.worldToLocal(local.setFromMatrixPosition(camera.matrixWorld));
        let changed = false;
        for (const c of s.cells) {
            const d = local.distanceTo(c.centre) - c.radius, want = enabled && s.mesh.visible && d < s.showWithinM * (c.shown ? 1.15 : 1);
            if (want !== c.shown) { c.shown = want; c.near.visible = want; changed = true; }
            if (c.shown) shown++;
        }
        if (changed) applyRuns(s);
    }
    return shown;
}

/** The relief surfaces registered (for a test or a diagnostic). */
export const heightReliefSurfaceCount = () => surfaces.size;

function registerLods(scene: THREE.Object3D): number {
    let n = 0;
    scene.traverse(o => {
        const mesh = o as THREE.Mesh;
        const ex = (mesh.userData as { sbHeightRelief?: { role?: string; showWithinM?: number; cells?: Array<{ start: number; count: number; near: string; centre: number[]; radius: number }> } }).sbHeightRelief;
        if (!mesh.isMesh || ex?.role !== 'base' || !Array.isArray(ex.cells) || !mesh.geometry?.index) return;
        const cells: ReliefCell[] = [];
        for (const c of ex.cells) {
            const near = mesh.children.find(k => k.name === c.near);
            if (!near) continue;
            near.visible = false;
            cells.push({ start: c.start, count: c.count, near, centre: new THREE.Vector3(c.centre[0], c.centre[1], c.centre[2]), radius: c.radius, shown: false });
        }
        if (!cells.length) return;
        const s: ReliefSurface = { mesh, showWithinM: ex.showWithinM ?? 14, cells, first: Math.min(...cells.map(c => c.start)) };
        surfaces.add(s);
        mesh.geometry.addEventListener('dispose', () => surfaces.delete(s));
        n++;
    });
    return n;
}

/**
 * Prepares a just-loaded model's relief (see the file comment): the classes' tiles as one texture array, each relief
 * material's class map and shader, and the near level of detail's cells (hidden until the camera is near). Resolves with
 * the number of materials patched; a model without the extras is left untouched, and a texture that fails to load leaves
 * its material without relief and is reported.
 */
export async function prepareHeightRelief(gltf: GltfLike): Promise<number> {
    registerLods(gltf.scene);
    const parser = gltf.parser, asset = parser?.json?.asset?.extras?.sbMaterialRelief;
    if (!parser || !asset || !(asset.depthM > 0) || !Array.isArray(asset.tiles)) return 0;
    const mats = new Set<THREE.MeshStandardMaterial>();
    gltf.scene.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m && reliefOf(m) && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) mats.add(m as THREE.MeshStandardMaterial);
    });
    if (!mats.size) return 0;
    // the tiles stacked by class: a class without one is a layer of surface (255), and its size 0 tells the shader to skip it
    const layers = Math.min(MAX_RELIEF_CLASSES, asset.tiles.length);
    const data = new Uint8Array(TILE_SIZE * TILE_SIZE * layers).fill(255);
    const sizes = Array.from({ length: MAX_RELIEF_CLASSES }, () => new THREE.Vector2(0, 0));
    try {
        for (let k = 0; k < layers; k++) {
            const t = asset.tiles[k];
            if (!t) continue;
            data.set(redOf(await parser.getDependency('texture', t.texture) as THREE.Texture, TILE_SIZE), k * TILE_SIZE * TILE_SIZE);
            sizes[k].set(t.sizeM[0], t.sizeM[1]);
        }
    } catch (err) {
        console.warn('[staged textures] the relief tiles did not load; the surfaces keep their normal maps only:', err);
        return 0;
    }
    const tiles = new THREE.DataArrayTexture(data, TILE_SIZE, TILE_SIZE, layers);
    tiles.format = THREE.RedFormat; tiles.type = THREE.UnsignedByteType; tiles.colorSpace = THREE.NoColorSpace;
    tiles.wrapS = THREE.RepeatWrapping; tiles.wrapT = THREE.RepeatWrapping;
    tiles.magFilter = THREE.LinearFilter; tiles.minFilter = THREE.LinearMipmapLinearFilter; tiles.generateMipmaps = true;
    tiles.needsUpdate = true;
    const fade = new THREE.Vector2(RELIEF_FADE.nearM, RELIEF_FADE.farM);
    // one depth for the model, shared by its materials
    const depth = { uniform: { value: enabled ? asset.depthM : 0 }, depthM: asset.depthM };
    depths.add(depth);
    tiles.addEventListener('dispose', () => depths.delete(depth));
    let patched = 0;
    for (const mat of mats) {
        const relief = reliefOf(mat)!;
        try {
            const cls = await parser.getDependency('texture', relief.classTexture) as THREE.Texture;
            cls.colorSpace = THREE.NoColorSpace; cls.magFilter = THREE.NearestFilter; cls.minFilter = THREE.NearestFilter; cls.generateMipmaps = false;
            cls.wrapS = THREE.ClampToEdgeWrapping; cls.wrapT = THREE.ClampToEdgeWrapping; cls.needsUpdate = true;
            const uniforms = {
                uSbReliefClass: { value: cls }, uSbReliefTiles: { value: tiles }, uSbReliefSize: { value: sizes },
                uSbReliefUvM: { value: new THREE.Vector2(relief.uvMetres[0], relief.uvMetres[1]) }, uSbReliefDepth: depth.uniform, uSbReliefFade: { value: fade }
            };
            mat.defines = { ...(mat.defines ?? {}), SB_RELIEF: '', ...(relief.displaced ? { SB_RELIEF_DISPLACED: '' } : {}) };
            const prior = mat.onBeforeCompile, priorKey = mat.customProgramCacheKey;
            mat.onBeforeCompile = (shader, renderer) => {
                prior?.call(mat, shader, renderer);
                Object.assign(shader.uniforms, uniforms);
                shader.fragmentShader = shader.fragmentShader
                    .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
                    .replace('#include <clipping_planes_fragment>', FRAGMENT_MARCH)
                    .replace('#include <normal_fragment_maps>', FRAGMENT_NORMAL)
                    .replace('#include <aomap_fragment>', FRAGMENT_AO);
            };
            mat.customProgramCacheKey = () => `${priorKey?.call(mat) ?? ''}|sb-relief-v1:${relief.displaced ? 'd' : 'p'}`;
            mat.userData.sbRelief = uniforms;
            mat.needsUpdate = true;
            patched++;
        } catch (err) {
            console.warn('[staged textures] a relief class map did not load; its surface keeps its normal map only:', err);
        }
    }
    return patched;
}
