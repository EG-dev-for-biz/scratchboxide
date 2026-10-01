/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * SB-Terrain Multi-Material Ground Engine (Universal).
 *
 * Dynamically classifies arbitrary worldwide terrain submeshes and renders them
 * across three distinct geological and urban material systems:
 * 1. Volcanic Tufa / Bedrock Rocks (steep scarps, cliffs, and rocky outcrops)
 * 2. Mediterranean Grass / Turf (organic lawns, vegetative slopes, and soil)
 * 3. Basalt Cobblestone Pavement (flat pedestrian plazas, roadways, and flagstones)
 *
 * Each material system is backed by procedural canvas bump maps (or DataTextures
 * in headless Node environments) for tactile micro-surface definition.
 ********************************************************************************/

import * as THREE from 'three';

export type TerrainSurfaceType = 'rock' | 'grass' | 'pavement';
export type TerrainLayerMode = 'all' | 'rocks' | 'grass' | 'pavement';

export interface TerrainClassificationMetrics {
    meanSlopeDeg: number;
    planarityRatio: number;
    steepnessRatio: number;
    roughnessStdDev: number;
    detectedType: TerrainSurfaceType;
}

export interface SbTerrainOptions {
    /** Slope angle threshold above which terrain is classified as rock. Default: 32°. */
    rockSlopeThresholdDeg?: number;
    /** Maximum slope angle to be considered flat pavement. Default: 10°. */
    pavementMaxSlopeDeg?: number;
    /** Minimum planarity ratio (Ny >= 0.95) to qualify as pavement. Default: 0.65. */
    minPavementPlanarity?: number;
    /** Custom rock material overrides. */
    customRockMaterial?: THREE.Material;
    /** Custom grass material overrides. */
    customGrassMaterial?: THREE.Material;
    /** Custom pavement material overrides. */
    customPavementMaterial?: THREE.Material;
    /** Initial visible layer mode. Default: 'all'. */
    initialLayer?: TerrainLayerMode;
}

export interface SbTerrainClassificationResult {
    /** Root group containing the 3 classified sub-groups. */
    terrainGroup: THREE.Group;
    /** Sub-group for steep volcanic tufa rock formations. */
    rocksGroup: THREE.Group;
    /** Sub-group for vegetated lawns and turf. */
    grassGroup: THREE.Group;
    /** Sub-group for flat cobblestone and flagstone pavement. */
    pavementGroup: THREE.Group;
    /** Telemetry statistics across classified ground chunks. */
    metrics: {
        totalSubmeshes: number;
        totalVertices: number;
        rockCount: number;
        grassCount: number;
        pavementCount: number;
        rockVertices: number;
        grassVertices: number;
        pavementVertices: number;
    };
}

// ============================================================================
// Procedural Bump Texture Synthesizers (DOM & Headless / SSR Safe)
// ============================================================================

function createHeadlessDataTexture(
    width: number,
    height: number,
    generator: (x: number, y: number) => number
): THREE.DataTexture {
    const size = width * height;
    const data = new Uint8Array(4 * size);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const val = Math.max(0, Math.min(255, Math.floor(generator(x, y))));
            data[idx] = val;
            data[idx + 1] = val;
            data[idx + 2] = val;
            data[idx + 3] = 255;
        }
    }
    const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
}

/**
 * Procedural Volcanic Rock Strata Bump Texture:
 * Simulates stratified sedimentary/volcanic bedding with sinusoidal shear and high-frequency noise.
 */
export function createProceduralRockStrataTexture(width = 256, height = 256): THREE.Texture {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.fillStyle = '#808080';
                ctx.fillRect(0, 0, width, height);
                for (let y = 0; y < height; y++) {
                    const band = Math.sin(y * 0.15) * 20 + Math.sin(y * 0.4) * 12;
                    for (let x = 0; x < width; x += 4) {
                        const noise = (Math.random() - 0.5) * 35;
                        const val = Math.max(0, Math.min(255, 128 + band + noise));
                        ctx.fillStyle = `rgb(${val},${val},${val})`;
                        ctx.fillRect(x, y, 4, 1);
                    }
                }
                const tex = new THREE.CanvasTexture(canvas);
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.repeat.set(8, 8);
                return tex;
            }
        } catch {
            // Fall back to headless data texture
        }
    }

    const tex = createHeadlessDataTexture(width, height, (x, y) => {
        const band = Math.sin(y * 0.15) * 20 + Math.sin(y * 0.4) * 12;
        const noise = (Math.sin(x * 0.3 + y * 0.2) + Math.cos(x * 0.7 - y * 0.5)) * 15;
        return 128 + band + noise;
    });
    tex.repeat.set(8, 8);
    return tex;
}

/**
 * Procedural Grass & Soil Micro-Dappled Bump Texture:
 * Simulates fine vegetative turf fibers and soil grain.
 */
export function createProceduralGrassTexture(width = 256, height = 256): THREE.Texture {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                const imgData = ctx.createImageData(width, height);
                const data = imgData.data;
                for (let i = 0; i < data.length; i += 4) {
                    const n = Math.floor(100 + Math.random() * 80);
                    data[i] = n;
                    data[i + 1] = n;
                    data[i + 2] = n;
                    data[i + 3] = 255;
                }
                ctx.putImageData(imgData, 0, 0);
                const tex = new THREE.CanvasTexture(canvas);
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.repeat.set(16, 16);
                return tex;
            }
        } catch {
            // Fall back to headless data texture
        }
    }

    const tex = createHeadlessDataTexture(width, height, (x, y) => {
        return 100 + (Math.sin(x * 12.3 + y * 7.1) * 0.5 + 0.5) * 80;
    });
    tex.repeat.set(16, 16);
    return tex;
}

/**
 * Procedural Roman Basalt Cobblestone (Sampietrini) / Paver Bump Texture:
 * Simulates running-bond rectangular pavers with recessed mortar joints.
 */
export function createProceduralCobblestoneTexture(width = 256, height = 256, cellSize = 16): THREE.Texture {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.fillStyle = '#a0a0a0';
                ctx.fillRect(0, 0, width, height);
                ctx.fillStyle = '#404040';
                for (let y = 0; y < height; y += cellSize) {
                    const shift = (Math.floor(y / cellSize) % 2) * (cellSize / 2);
                    ctx.fillRect(0, y, width, 2);
                    for (let x = 0; x < width; x += cellSize) {
                        const cx = (x + shift) % width;
                        ctx.fillRect(cx, y, 2, cellSize);
                    }
                }
                const tex = new THREE.CanvasTexture(canvas);
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.repeat.set(16, 16);
                return tex;
            }
        } catch {
            // Fall back to headless data texture
        }
    }

    const tex = createHeadlessDataTexture(width, height, (x, y) => {
        const row = Math.floor(y / cellSize);
        const shift = (row % 2) * (cellSize / 2);
        const col = Math.floor((x + shift) % width / cellSize);
        const isJointY = (y % cellSize) < 2;
        const isJointX = ((x + shift) % cellSize) < 2;
        return (isJointY || isJointX) ? 64 : 160;
    });
    tex.repeat.set(16, 16);
    return tex;
}

// ============================================================================
// Universal Geological Surface Classification
// ============================================================================

/**
 * Classifies any arbitrary terrain mesh or geometry into 'rock', 'grass', or 'pavement'.
 * Evaluates normal distribution, surface slope (theta = arccos(Ny)), and planarity ratio.
 */
export function classifyTerrainSurfaceType(
    meshOrGeometry: THREE.Mesh | THREE.BufferGeometry,
    options?: {
        rockSlopeThresholdDeg?: number;
        pavementMaxSlopeDeg?: number;
        minPavementPlanarity?: number;
    }
): TerrainSurfaceType {
    const rockSlopeLimit = options?.rockSlopeThresholdDeg ?? 32.0;
    const pavementSlopeLimit = options?.pavementMaxSlopeDeg ?? 10.0;
    const minPlanarity = options?.minPavementPlanarity ?? 0.65;

    const geom = (meshOrGeometry as THREE.Mesh).isMesh
        ? (meshOrGeometry as THREE.Mesh).geometry
        : (meshOrGeometry as THREE.BufferGeometry);

    if (!geom.attributes.normal) {
        geom.computeVertexNormals();
    }

    const normals = geom.attributes.normal;
    if (!normals || normals.count === 0) {
        return 'grass';
    }

    let flatCount = 0;
    let steepCount = 0;
    let totalNy = 0;

    for (let i = 0; i < normals.count; i++) {
        const ny = Math.max(-1.0, Math.min(1.0, normals.getY(i)));
        totalNy += ny;

        if (ny >= 0.95) {
            flatCount++;
        } else if (ny < 0.75) {
            steepCount++;
        }
    }

    const count = normals.count;
    const meanNy = totalNy / count;
    const meanSlopeDeg = Math.acos(Math.max(0.0, Math.min(1.0, meanNy))) * (180.0 / Math.PI);
    const planarityRatio = flatCount / count;
    const steepnessRatio = steepCount / count;

    // Classification decision tree
    if (meanSlopeDeg >= rockSlopeLimit || steepnessRatio > 0.45) {
        return 'rock';
    }
    if (meanSlopeDeg <= pavementSlopeLimit && planarityRatio >= minPlanarity) {
        return 'pavement';
    }
    return 'grass';
}

// ============================================================================
// SB-Terrain Multi-Material Ground Engine Service
// ============================================================================

export class SbTerrainGroundEngine {
    private terrainGroup: THREE.Group = new THREE.Group();
    private rocksGroup: THREE.Group = new THREE.Group();
    private grassGroup: THREE.Group = new THREE.Group();
    private pavementGroup: THREE.Group = new THREE.Group();
    private currentLayer: TerrainLayerMode = 'all';

    constructor() {
        this.terrainGroup.name = 'sbTerrainRoot';
        this.rocksGroup.name = 'terrainRocksGroup';
        this.grassGroup.name = 'terrainGrassGroup';
        this.pavementGroup.name = 'terrainPavementGroup';

        this.terrainGroup.add(this.rocksGroup);
        this.terrainGroup.add(this.grassGroup);
        this.terrainGroup.add(this.pavementGroup);
    }

    /**
     * Toggles layer visibility for the terrain sub-systems.
     */
    public setLayer(layer: TerrainLayerMode): void {
        this.currentLayer = layer;
        this.rocksGroup.visible = (layer === 'all' || layer === 'rocks');
        this.grassGroup.visible = (layer === 'all' || layer === 'grass');
        this.pavementGroup.visible = (layer === 'all' || layer === 'pavement');
    }

    public getLayer(): TerrainLayerMode {
        return this.currentLayer;
    }

    /**
     * Dynamically classifies an arbitrary collection of ground submeshes (or a parent Group)
     * and materializes them across the 3 canonical material systems.
     */
    public classifyAndRenderTerrain(
        input: THREE.Mesh[] | THREE.Group | THREE.BufferGeometry,
        options: SbTerrainOptions = {}
    ): SbTerrainClassificationResult {
        // Clear previous children
        this.rocksGroup.clear();
        this.grassGroup.clear();
        this.pavementGroup.clear();

        // 1. Resolve PBR Materials with Procedural Bump Maps
        const rockBump = createProceduralRockStrataTexture();
        const rockMat = options.customRockMaterial || new THREE.MeshStandardMaterial({
            color: 0x584e42, // Volcanic Tufa / Granite
            roughness: 0.94,
            metalness: 0.04,
            bumpMap: rockBump,
            bumpScale: 0.12,
            side: THREE.DoubleSide
        });

        const grassBump = createProceduralGrassTexture();
        const grassMat = options.customGrassMaterial || new THREE.MeshStandardMaterial({
            color: 0x446c24, // Mediterranean Lawn / Turf
            roughness: 0.88,
            metalness: 0.02,
            bumpMap: grassBump,
            bumpScale: 0.08,
            side: THREE.DoubleSide
        });

        const pavementBump = createProceduralCobblestoneTexture();
        const pavementMat = options.customPavementMaterial || new THREE.MeshStandardMaterial({
            color: 0x555960, // Basalt Cobblestone Pavers
            roughness: 0.80,
            metalness: 0.08,
            bumpMap: pavementBump,
            bumpScale: 0.06,
            side: THREE.DoubleSide
        });

        // 2. Collect submesh list
        const submeshes: THREE.Mesh[] = [];
        if (Array.isArray(input)) {
            submeshes.push(...input);
        } else if ((input as THREE.Group).isGroup || (input as THREE.Object3D).isObject3D) {
            (input as THREE.Object3D).traverse(node => {
                if ((node as THREE.Mesh).isMesh) {
                    submeshes.push(node as THREE.Mesh);
                }
            });
        } else {
            // Single BufferGeometry
            const syntheticMesh = new THREE.Mesh(input as THREE.BufferGeometry);
            submeshes.push(syntheticMesh);
        }

        let rockCount = 0, grassCount = 0, pavementCount = 0;
        let rockVertices = 0, grassVertices = 0, pavementVertices = 0;

        // 3. Classify and distribute into groups
        for (let i = 0; i < submeshes.length; i++) {
            const orig = submeshes[i];
            const geom = orig.geometry.clone();
            if (!geom.attributes.normal) {
                geom.computeVertexNormals();
            }

            const surfaceType = classifyTerrainSurfaceType(geom, {
                rockSlopeThresholdDeg: options.rockSlopeThresholdDeg,
                pavementMaxSlopeDeg: options.pavementMaxSlopeDeg,
                minPavementPlanarity: options.minPavementPlanarity
            });

            const vertexCount = geom.attributes.position ? geom.attributes.position.count : 0;

            let targetGroup: THREE.Group;
            let targetMat: THREE.Material;

            if (surfaceType === 'rock') {
                targetGroup = this.rocksGroup;
                targetMat = rockMat;
                rockCount++;
                rockVertices += vertexCount;
            } else if (surfaceType === 'pavement') {
                targetGroup = this.pavementGroup;
                targetMat = pavementMat;
                pavementCount++;
                pavementVertices += vertexCount;
            } else {
                targetGroup = this.grassGroup;
                targetMat = grassMat;
                grassCount++;
                grassVertices += vertexCount;
            }

            const outMesh = new THREE.Mesh(geom, targetMat);
            outMesh.name = `terrain_${surfaceType}_${orig.name || i}`;
            outMesh.position.copy(orig.position);
            outMesh.quaternion.copy(orig.quaternion);
            outMesh.scale.copy(orig.scale);
            targetGroup.add(outMesh);
        }

        if (options.initialLayer) {
            this.setLayer(options.initialLayer);
        }

        const totalVertices = rockVertices + grassVertices + pavementVertices;

        return {
            terrainGroup: this.terrainGroup,
            rocksGroup: this.rocksGroup,
            grassGroup: this.grassGroup,
            pavementGroup: this.pavementGroup,
            metrics: {
                totalSubmeshes: submeshes.length,
                totalVertices,
                rockCount,
                grassCount,
                pavementCount,
                rockVertices,
                grassVertices,
                pavementVertices
            }
        };
    }
}
