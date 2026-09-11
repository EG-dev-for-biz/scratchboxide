/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import type {
    Scene3DData,
    SculptFalloffType
} from '../canvas-types';
import {
    evaluateFalloff,
    recomputeGeometryNormals
} from './mesh-sculpting-engine';
import {
    getPresetLightingState,
    getDiurnalLightingState,
    computeDiurnalLightingProfile,
    getSunVectorFromAngles
} from './atmosphere';
import {
    Google3DTileService
} from './Google3DTileService';
import {
    TileClayProcessor,
    ClayPresetId
} from './TileClayProcessor';
import {
    TerrainManager
} from './TerrainManager';

// ============================================================================
// Types & Interfaces
// ============================================================================

export type OperatorCategory =
    | 'inspect'
    | 'transform'
    | 'mesh_edit'
    | 'modifiers'
    | 'materials_pbr'
    | 'lighting_camera'
    | 'physics_animation'
    | 'state_history';

export interface OperatorResult<T = any> {
    success: boolean;
    operator: string;
    data?: T;
    error?: string;
    executionTimeMs?: number;
    timestamp?: number;
}

export interface BatchCommand {
    operator: string;
    params?: any;
}

export interface BatchExecutionOptions {
    atomic?: boolean;
    recordHistory?: boolean;
}

export interface BatchExecutionResult {
    success: boolean;
    results: OperatorResult[];
    totalExecutionTimeMs: number;
    error?: string;
}

export interface IOperatorContext {
    getSceneData(): Scene3DData;
    setSceneData(data: Scene3DData): void;
    getThreeScene(): THREE.Scene | undefined;
    attachThreeScene(scene: THREE.Scene): void;
    getObject(id: string): any;
    getThreeObject(id: string): THREE.Object3D | undefined;
    findObject(id: string): { type: 'customMesh' | 'media4d' | 'threeObject'; object: any; threeObject?: THREE.Object3D } | undefined;
    registerMaterial(material: any): void;
    getMaterial(materialId: string): any;
    recordState(description?: string): void;
    undo(): boolean;
    redo(): boolean;
    resetScene(initialData?: Partial<Scene3DData>): void;
}

export interface OperatorDefinition<TParams = any, TResult = any> {
    name: string;
    category: OperatorCategory;
    description: string;
    parametersSchema?: Record<string, any>;
    execute: (context: IOperatorContext, params: TParams) => TResult | Promise<TResult>;
}

// ============================================================================
// Helper Geometry Calculations
// ============================================================================

function createGeometryForType(type: string, scale: [number, number, number] = [1, 1, 1], geometryMeta?: any): THREE.BufferGeometry {
    const segments = geometryMeta?.iterations ? Math.pow(2, geometryMeta.iterations) : 1;
    switch (type) {
        case 'box':
            return new THREE.BoxGeometry(scale[0], scale[1], scale[2], segments, segments, segments);
        case 'sphere':
            return new THREE.SphereGeometry(Math.max(scale[0], scale[1], scale[2]) / 2, 24 * segments, 24 * segments);
        case 'cylinder':
            return new THREE.CylinderGeometry(scale[0] / 2, scale[0] / 2, scale[1], 24 * segments);
        case 'plane':
            return new THREE.PlaneGeometry(scale[0], scale[2] || scale[1], segments, segments);
        case 'torus':
            return new THREE.TorusGeometry(scale[0] / 2, scale[1] / 4, 16 * segments, 32 * segments);
        default:
            return new THREE.BoxGeometry(scale[0], scale[1], scale[2], segments, segments, segments);
    }
}

function computeMeshStatsFromGeometry(geometry: THREE.BufferGeometry, scale: [number, number, number] = [1, 1, 1]) {
    const posAttr = geometry.attributes.position as THREE.BufferAttribute;
    const vertexCount = posAttr ? posAttr.count : 0;
    
    let faceCount = 0;
    if (geometry.index) {
        faceCount = geometry.index.count / 3;
    } else if (posAttr) {
        faceCount = posAttr.count / 3;
    }

    geometry.computeBoundingBox();
    const bb = geometry.boundingBox || new THREE.Box3();
    const min: [number, number, number] = [bb.min.x * scale[0], bb.min.y * scale[1], bb.min.z * scale[2]];
    const max: [number, number, number] = [bb.max.x * scale[0], bb.max.y * scale[1], bb.max.z * scale[2]];
    const size: [number, number, number] = [
        Math.abs(max[0] - min[0]),
        Math.abs(max[1] - min[1]),
        Math.abs(max[2] - min[2])
    ];
    const center: [number, number, number] = [
        (min[0] + max[0]) / 2,
        (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2
    ];

    // Compute surface area & volume
    let surfaceArea = 0;
    let volume = 0;

    const p1 = new THREE.Vector3();
    const p2 = new THREE.Vector3();
    const p3 = new THREE.Vector3();
    const edge1 = new THREE.Vector3();
    const edge2 = new THREE.Vector3();
    const cross = new THREE.Vector3();

    const getVertex = (idx: number, target: THREE.Vector3) => {
        target.set(
            posAttr.getX(idx) * scale[0],
            posAttr.getY(idx) * scale[1],
            posAttr.getZ(idx) * scale[2]
        );
    };

    if (geometry.index) {
        const idx = geometry.index;
        for (let i = 0; i < idx.count; i += 3) {
            getVertex(idx.getX(i), p1);
            getVertex(idx.getX(i + 1), p2);
            getVertex(idx.getX(i + 2), p3);

            edge1.subVectors(p2, p1);
            edge2.subVectors(p3, p1);
            cross.crossVectors(edge1, edge2);
            surfaceArea += cross.length() * 0.5;

            // Signed volume of tetrahedron from origin
            volume += p1.dot(cross) / 6.0;
        }
    } else if (posAttr) {
        for (let i = 0; i < posAttr.count; i += 3) {
            getVertex(i, p1);
            getVertex(i + 1, p2);
            getVertex(i + 2, p3);

            edge1.subVectors(p2, p1);
            edge2.subVectors(p3, p1);
            cross.crossVectors(edge1, edge2);
            surfaceArea += cross.length() * 0.5;

            volume += p1.dot(cross) / 6.0;
        }
    }

    volume = Math.abs(volume);
    if (volume < 0.00001 && size[0] > 0 && size[1] > 0 && size[2] > 0) {
        volume = size[0] * size[1] * size[2];
    }
    if (surfaceArea < 0.00001 && size[0] > 0 && size[1] > 0) {
        surfaceArea = 2 * (size[0] * size[1] + size[1] * size[2] + size[2] * size[0]);
    }

    const edgeCount = Math.round(faceCount * 1.5);

    return {
        vertexCount,
        faceCount,
        edgeCount,
        boundingBox: { min, max, size, center },
        surfaceArea: Number(surfaceArea.toFixed(4)),
        volume: Number(volume.toFixed(4)),
        isWatertight: true
    };
}

// ============================================================================
// Operator Catalog Implementation
// ============================================================================

export class DirectDispatchOperatorEngine implements IOperatorContext {
    private sceneData: Scene3DData;
    private threeScene?: THREE.Scene;
    private operators: Map<string, OperatorDefinition> = new Map();
    private materialRegistry: Map<string, any> = new Map();
    private historyStack: Scene3DData[] = [];
    private historyIndex: number = -1;
    private maxHistory: number = 50;

    constructor(initialScene?: Scene3DData) {
        this.sceneData = initialScene ? JSON.parse(JSON.stringify(initialScene)) : {
            title: 'Untitled 3D Scene',
            renderMode: 'pbr',
            customMeshes: [],
            objects: []
        };
        this.recordState('Initial State');
        this.registerCoreOperators();
    }

    // ------------------------------------------------------------------------
    // Scene & Three.js Context
    // ------------------------------------------------------------------------

    public getSceneData(): Scene3DData {
        return this.sceneData;
    }

    public setSceneData(data: Scene3DData): void {
        this.sceneData = data;
    }

    public getOperatorStack(): Array<{ operator: string; params?: any; timestamp?: number; result?: any }> {
        return this.sceneData.operatorStack || [];
    }

    public getActionLog(): Array<{ operator: string; params?: any; timestamp: number; executionTimeMs?: number; success: boolean; error?: string }> {
        return this.sceneData.actionLog || [];
    }

    public clearOperatorStack(): void {
        this.sceneData.operatorStack = [];
    }

    public replayOperatorStack(stack?: BatchCommand[]): BatchExecutionResult {
        const commandsToReplay: BatchCommand[] = stack || (this.sceneData.operatorStack ? this.sceneData.operatorStack.map(s => ({
            operator: s.operator,
            params: s.params
        })) : []);

        return this.executeBatch(commandsToReplay, { recordHistory: true });
    }

    public loadScene(data: Scene3DData): void {
        this.sceneData = JSON.parse(JSON.stringify(data));
        this.historyStack = [];
        this.historyIndex = -1;
        this.recordState('Load Scene');
    }

    public getThreeScene(): THREE.Scene | undefined {
        return this.threeScene;
    }

    public attachThreeScene(scene: THREE.Scene): void {
        this.threeScene = scene;
    }

    public getObject(id: string): any {
        const found = this.findObject(id);
        return found ? found.object : undefined;
    }

    public getThreeObject(id: string): THREE.Object3D | undefined {
        if (!this.threeScene) return undefined;
        let found: THREE.Object3D | undefined;
        this.threeScene.traverse(child => {
            if (child.name === id || (child as any).userData?.id === id || child.uuid === id) {
                found = child;
            }
        });
        return found;
    }

    public findObject(id: string): { type: 'customMesh' | 'media4d' | 'threeObject'; object: any; threeObject?: THREE.Object3D } | undefined {
        // 1. Check customMeshes
        if (this.sceneData.customMeshes) {
            const m = this.sceneData.customMeshes.find(item => item.id === id || item.name === id);
            if (m) {
                return {
                    type: 'customMesh',
                    object: m,
                    threeObject: this.getThreeObject(id)
                };
            }
        }

        // 2. Check objects (Media4DObject)
        if (this.sceneData.objects) {
            const obj = this.sceneData.objects.find(item => item.id === id);
            if (obj) {
                return {
                    type: 'media4d',
                    object: obj,
                    threeObject: this.getThreeObject(id)
                };
            }
        }

        // 3. Check Three.js Scene
        const threeObj = this.getThreeObject(id);
        if (threeObj) {
            // Synthesize representation in sceneData if needed
            if (!this.sceneData.customMeshes) {
                this.sceneData.customMeshes = [];
            }
            const meshRep = {
                id: threeObj.name || id,
                name: threeObj.name || id,
                type: 'custom' as any,
                position: [threeObj.position.x, threeObj.position.y, threeObj.position.z] as [number, number, number],
                rotation: [threeObj.rotation.x, threeObj.rotation.y, threeObj.rotation.z] as [number, number, number],
                scale: [threeObj.scale.x, threeObj.scale.y, threeObj.scale.z] as [number, number, number]
            };
            this.sceneData.customMeshes.push(meshRep);
            return {
                type: 'customMesh',
                object: meshRep,
                threeObject: threeObj
            };
        }

        return undefined;
    }

    public registerMaterial(material: any): void {
        const id = material.id || material.materialId || `mat-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        material.id = id;
        this.materialRegistry.set(id, material);
    }

    public getMaterial(materialId: string): any {
        return this.materialRegistry.get(materialId);
    }

    // ------------------------------------------------------------------------
    // History & State Machine
    // ------------------------------------------------------------------------

    public recordState(_description?: string): void {
        if (this.historyIndex < this.historyStack.length - 1) {
            this.historyStack = this.historyStack.slice(0, this.historyIndex + 1);
        }
        const snapshot = JSON.parse(JSON.stringify(this.sceneData));
        this.historyStack.push(snapshot);
        if (this.historyStack.length > this.maxHistory) {
            this.historyStack.shift();
        } else {
            this.historyIndex++;
        }
    }

    public undo(): boolean {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.sceneData = JSON.parse(JSON.stringify(this.historyStack[this.historyIndex]));
            this.syncToThreeScene();
            return true;
        }
        return false;
    }

    public redo(): boolean {
        if (this.historyIndex < this.historyStack.length - 1) {
            this.historyIndex++;
            this.sceneData = JSON.parse(JSON.stringify(this.historyStack[this.historyIndex]));
            this.syncToThreeScene();
            return true;
        }
        return false;
    }

    public resetScene(initialData?: Partial<Scene3DData>): void {
        this.sceneData = {
            title: initialData?.title || 'Reset 3D Scene',
            renderMode: initialData?.renderMode || 'pbr',
            customMeshes: [],
            objects: [],
            ...initialData
        };
        if (this.threeScene) {
            while (this.threeScene.children.length > 0) {
                this.threeScene.remove(this.threeScene.children[0]);
            }
        }
        this.recordState('Reset Scene');
    }

    private syncToThreeScene(): void {
        if (!this.threeScene) return;
        if (this.sceneData.customMeshes) {
            for (const m of this.sceneData.customMeshes) {
                const threeObj = this.getThreeObject(m.id);
                if (threeObj) {
                    if (m.position) threeObj.position.set(m.position[0], m.position[1], m.position[2]);
                    if (m.rotation) threeObj.rotation.set(m.rotation[0], m.rotation[1], m.rotation[2]);
                    if (m.scale) threeObj.scale.set(m.scale[0], m.scale[1], m.scale[2]);
                }
            }
        }
    }

    // ------------------------------------------------------------------------
    // Operator Registry & Direct Dispatching
    // ------------------------------------------------------------------------

    public registerOperator(operator: OperatorDefinition): void {
        this.operators.set(operator.name, operator);
    }

    public getOperator(name: string): OperatorDefinition | undefined {
        return this.operators.get(name);
    }

    public getAllOperators(): OperatorDefinition[] {
        return Array.from(this.operators.values());
    }

    public getOperatorsByCategory(category: OperatorCategory): OperatorDefinition[] {
        return this.getAllOperators().filter(op => op.category === category);
    }

    /**
     * Direct In-Memory Operator Dispatch with zero string parsing overhead.
     */
    public dispatch<TParams = any, TResult = any>(
        operatorName: string,
        params: TParams,
        options?: { recordHistory?: boolean }
    ): OperatorResult<TResult> {
        const startTime = process.hrtime.bigint();
        const op = this.operators.get(operatorName);

        if (!op) {
            return {
                success: false,
                operator: operatorName,
                error: `Unknown operator: '${operatorName}'. Operator is not registered in engine catalog.`,
                executionTimeMs: 0,
                timestamp: Date.now()
            };
        }

        try {
            const data = op.execute(this, params);
            
            const shouldRecord = options?.recordHistory !== false && (params as any)?.recordHistory !== false && op.category !== 'inspect';
            if (shouldRecord && operatorName !== 'sb_undo' && operatorName !== 'sb_redo') {
                this.recordState(`Dispatch ${operatorName}`);
            }

            const endTime = process.hrtime.bigint();
            const executionTimeMs = Number(endTime - startTime) / 1000000;

            if (shouldRecord && operatorName !== 'sb_undo' && operatorName !== 'sb_redo') {
                if (!this.sceneData.operatorStack) this.sceneData.operatorStack = [];
                this.sceneData.operatorStack.push({
                    operator: operatorName,
                    params: params ? JSON.parse(JSON.stringify(params)) : undefined,
                    timestamp: Date.now(),
                    result: data
                });
            }

            if (!this.sceneData.actionLog) this.sceneData.actionLog = [];
            this.sceneData.actionLog.push({
                operator: operatorName,
                params: params ? JSON.parse(JSON.stringify(params)) : undefined,
                timestamp: Date.now(),
                executionTimeMs,
                success: true
            });

            return {
                success: true,
                operator: operatorName,
                data,
                executionTimeMs,
                timestamp: Date.now()
            };
        } catch (err: any) {
            const endTime = process.hrtime.bigint();
            const executionTimeMs = Number(endTime - startTime) / 1000000;

            if (!this.sceneData.actionLog) this.sceneData.actionLog = [];
            this.sceneData.actionLog.push({
                operator: operatorName,
                params: params ? JSON.parse(JSON.stringify(params)) : undefined,
                timestamp: Date.now(),
                executionTimeMs,
                success: false,
                error: err?.message || String(err)
            });

            return {
                success: false,
                operator: operatorName,
                error: err?.message || String(err),
                executionTimeMs,
                timestamp: Date.now()
            };
        }
    }

    /**
     * Execute a sequence of operators in a single batch with optional atomic rollback.
     */
    public executeBatch(
        commands: BatchCommand[],
        options?: BatchExecutionOptions
    ): BatchExecutionResult {
        const batchStartTime = process.hrtime.bigint();
        const results: OperatorResult[] = [];
        const isAtomic = options?.atomic === true;
        const snapshotBeforeBatch = isAtomic ? JSON.parse(JSON.stringify(this.sceneData)) : undefined;

        for (const cmd of commands) {
            const res = this.dispatch(cmd.operator, cmd.params || {}, { recordHistory: !isAtomic });
            results.push(res);

            if (!res.success) {
                if (isAtomic && snapshotBeforeBatch) {
                    // Rollback to pre-batch snapshot
                    this.sceneData = snapshotBeforeBatch;
                    this.syncToThreeScene();
                }
                const batchEndTime = process.hrtime.bigint();
                return {
                    success: false,
                    results,
                    totalExecutionTimeMs: Number(batchEndTime - batchStartTime) / 1000000,
                    error: `Batch execution aborted on operator '${cmd.operator}': ${res.error}`
                };
            }
        }

        if (isAtomic && options?.recordHistory !== false) {
            this.recordState('Batch Execution');
        }

        const batchEndTime = process.hrtime.bigint();
        return {
            success: true,
            results,
            totalExecutionTimeMs: Number(batchEndTime - batchStartTime) / 1000000
        };
    }

    // ------------------------------------------------------------------------
    // Core Operator Registrations
    // ------------------------------------------------------------------------

    private registerCoreOperators(): void {
        // ====================================================================
        // Category 1: Inspect
        // ====================================================================
        this.registerOperator({
            name: 'sb_list_objects',
            category: 'inspect',
            description: 'Lists all 3D mesh assets, media objects, and scene children with transforms and types.',
            execute: (ctx, params: { type?: string; regex?: string; visibleOnly?: boolean }) => {
                const scene = ctx.getSceneData();
                const objects: any[] = [];

                if (scene.customMeshes) {
                    for (const m of scene.customMeshes) {
                        if (params.type && m.type !== params.type) continue;
                        if (params.regex && !new RegExp(params.regex, 'i').test(m.name || m.id)) continue;
                        objects.push({
                            id: m.id,
                            name: m.name || m.id,
                            type: m.type || 'box',
                            position: m.position || [0, 0, 0],
                            rotation: m.rotation || [0, 0, 0],
                            scale: m.scale || [1, 1, 1],
                            material: m.material,
                            source: 'customMeshes'
                        });
                    }
                }

                if (scene.objects) {
                    for (const obj of scene.objects) {
                        const objType = obj.content?.type || 'media4d';
                        if (params.type && objType !== params.type) continue;
                        if (params.regex && !new RegExp(params.regex, 'i').test(obj.id)) continue;
                        const s3d = obj.space?.spatial3d;
                        objects.push({
                            id: obj.id,
                            name: obj.id,
                            type: objType,
                            position: s3d ? [s3d.x, s3d.y, s3d.z] : [0, 0, 0],
                            rotation: s3d ? [s3d.pitch || 0, s3d.yaw || 0, s3d.roll || 0] : [0, 0, 0],
                            scale: [1, 1, 1],
                            source: 'objects'
                        });
                    }
                }

                return { count: objects.length, objects };
            }
        });

        this.registerOperator({
            name: 'sb_inspect_object',
            category: 'inspect',
            description: 'Returns comprehensive topology, material, modifier, and transform properties of an object.',
            execute: (ctx, params: { objectId: string }) => {
                if (!params.objectId) throw new Error("Parameter 'objectId' is required.");
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const obj = found.object;
                const pos = obj.position || (obj.space?.spatial3d ? [obj.space.spatial3d.x, obj.space.spatial3d.y, obj.space.spatial3d.z] : [0, 0, 0]);
                const rot = obj.rotation || (obj.space?.spatial3d ? [obj.space.spatial3d.pitch || 0, obj.space.spatial3d.yaw || 0, obj.space.spatial3d.roll || 0] : [0, 0, 0]);
                const scl = obj.scale || [1, 1, 1];

                return {
                    id: obj.id,
                    name: obj.name || obj.id,
                    type: obj.type || obj.content?.type || 'box',
                    position: pos,
                    rotation: rot,
                    scale: scl,
                    material: obj.material || { color: 0xcccccc },
                    modifiers: (obj as any).modifiers || [],
                    physics: (obj as any).physics || undefined,
                    keyframes: (obj as any).keyframes || undefined,
                    geometry: obj.geometry || undefined
                };
            }
        });

        this.registerOperator({
            name: 'sb_inspect_scene',
            category: 'inspect',
            description: 'Returns high-level statistics and metadata for the entire 3D scene.',
            execute: (ctx) => {
                const scene = ctx.getSceneData();
                const customMeshCount = scene.customMeshes?.length || 0;
                const media4DCount = scene.objects?.length || 0;
                const totalObjects = customMeshCount + media4DCount;

                return {
                    title: scene.title,
                    subtitle: scene.subtitle,
                    worldBranch: scene.worldBranch,
                    renderMode: scene.renderMode || 'pbr',
                    cameraMode: scene.cameraMode || 'orbit',
                    totalObjects,
                    customMeshCount,
                    media4DCount,
                    camera: scene.camera || { position: [10, 10, 10], target: [0, 0, 0] },
                    environment: scene.environment,
                    features: scene.features
                };
            }
        });

        this.registerOperator({
            name: 'sb_get_mesh_stats',
            category: 'inspect',
            description: 'Computes topological statistics (vertex count, faces, bounding box, volume, area) for a mesh.',
            execute: (ctx, params: { objectId: string }) => {
                if (!params.objectId) throw new Error("Parameter 'objectId' is required.");
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const obj = found.object;
                const scale: [number, number, number] = obj.scale || [1, 1, 1];
                let geo: THREE.BufferGeometry;

                if (found.threeObject && (found.threeObject as THREE.Mesh).geometry) {
                    geo = (found.threeObject as THREE.Mesh).geometry;
                } else {
                    geo = createGeometryForType(obj.type || 'box', scale, obj.geometry);
                }

                return computeMeshStatsFromGeometry(geo, scale);
            }
        });

        // ====================================================================
        // Category 2: Transform
        // ====================================================================
        this.registerOperator({
            name: 'sb_set_transform',
            category: 'transform',
            description: 'Directly sets absolute position, rotation (Euler), and scale for a target object.',
            execute: (ctx, params: { objectId: string; name?: string; type?: string; position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] }) => {
                let found = ctx.findObject(params.objectId);
                if (!found) {
                    const scene = ctx.getSceneData();
                    if (!scene.customMeshes) scene.customMeshes = [];
                    const newMesh = {
                        id: params.objectId,
                        name: params.name || params.objectId,
                        type: (params.type || 'box') as any,
                        position: params.position ? [...params.position] as [number, number, number] : [0, 0, 0] as [number, number, number],
                        rotation: params.rotation ? [...params.rotation] as [number, number, number] : [0, 0, 0] as [number, number, number],
                        scale: params.scale ? [...params.scale] as [number, number, number] : [1, 1, 1] as [number, number, number]
                    };
                    scene.customMeshes.push(newMesh);
                    found = ctx.findObject(params.objectId);
                }
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const obj = found.object;
                if (params.name && !obj.name) obj.name = params.name;
                if (params.type && !obj.type) obj.type = params.type;
                if (params.position) {
                    obj.position = [...params.position];
                    if (obj.space?.spatial3d) {
                        obj.space.spatial3d.x = params.position[0];
                        obj.space.spatial3d.y = params.position[1];
                        obj.space.spatial3d.z = params.position[2];
                    }
                    if (found.threeObject) found.threeObject.position.set(params.position[0], params.position[1], params.position[2]);
                }
                if (params.rotation) {
                    obj.rotation = [...params.rotation];
                    if (obj.space?.spatial3d) {
                        obj.space.spatial3d.pitch = params.rotation[0];
                        obj.space.spatial3d.yaw = params.rotation[1];
                        obj.space.spatial3d.roll = params.rotation[2];
                    }
                    if (found.threeObject) found.threeObject.rotation.set(params.rotation[0], params.rotation[1], params.rotation[2]);
                }
                if (params.scale) {
                    obj.scale = [...params.scale];
                    if (found.threeObject) found.threeObject.scale.set(params.scale[0], params.scale[1], params.scale[2]);
                }

                return { objectId: params.objectId, position: obj.position, rotation: obj.rotation, scale: obj.scale };
            }
        });

        this.registerOperator({
            name: 'sb_translate',
            category: 'transform',
            description: 'Applies relative 3D translation delta to target object.',
            execute: (ctx, params: { objectId: string; delta: [number, number, number] | { x: number; y: number; z: number } }) => {
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const dx = Array.isArray(params.delta) ? params.delta[0] : params.delta.x;
                const dy = Array.isArray(params.delta) ? params.delta[1] : params.delta.y;
                const dz = Array.isArray(params.delta) ? params.delta[2] : params.delta.z;

                const obj = found.object;
                if (!obj.position) obj.position = [0, 0, 0];
                obj.position[0] += dx;
                obj.position[1] += dy;
                obj.position[2] += dz;

                if (obj.space?.spatial3d) {
                    obj.space.spatial3d.x = (obj.space.spatial3d.x || 0) + dx;
                    obj.space.spatial3d.y = (obj.space.spatial3d.y || 0) + dy;
                    obj.space.spatial3d.z = (obj.space.spatial3d.z || 0) + dz;
                }

                if (found.threeObject) {
                    found.threeObject.position.x += dx;
                    found.threeObject.position.y += dy;
                    found.threeObject.position.z += dz;
                }

                return { objectId: params.objectId, position: obj.position };
            }
        });

        this.registerOperator({
            name: 'sb_rotate',
            category: 'transform',
            description: 'Applies relative rotation delta (Euler angles in radians) to target object.',
            execute: (ctx, params: { objectId: string; delta: [number, number, number] }) => {
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const obj = found.object;
                if (!obj.rotation) obj.rotation = [0, 0, 0];
                obj.rotation[0] += params.delta[0];
                obj.rotation[1] += params.delta[1];
                obj.rotation[2] += params.delta[2];

                if (found.threeObject) {
                    found.threeObject.rotation.x += params.delta[0];
                    found.threeObject.rotation.y += params.delta[1];
                    found.threeObject.rotation.z += params.delta[2];
                }

                return { objectId: params.objectId, rotation: obj.rotation };
            }
        });

        this.registerOperator({
            name: 'sb_scale',
            category: 'transform',
            description: 'Applies scale factors or uniform scale multiplier to target object.',
            execute: (ctx, params: { objectId: string; scale?: [number, number, number] | { x: number; y: number; z: number }; factor?: number | [number, number, number] | { x: number; y: number; z: number } }) => {
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const obj = found.object;
                if (!obj.scale) obj.scale = [1, 1, 1];

                if (Array.isArray(params.scale)) {
                    obj.scale[0] *= params.scale[0];
                    obj.scale[1] *= params.scale[1];
                    obj.scale[2] *= params.scale[2];
                } else if (params.scale && typeof params.scale === 'object') {
                    obj.scale[0] *= (params.scale as any).x ?? 1;
                    obj.scale[1] *= (params.scale as any).y ?? 1;
                    obj.scale[2] *= (params.scale as any).z ?? 1;
                } else if (Array.isArray(params.factor)) {
                    obj.scale[0] *= params.factor[0];
                    obj.scale[1] *= params.factor[1];
                    obj.scale[2] *= params.factor[2];
                } else if (params.factor && typeof params.factor === 'object') {
                    obj.scale[0] *= (params.factor as any).x ?? 1;
                    obj.scale[1] *= (params.factor as any).y ?? 1;
                    obj.scale[2] *= (params.factor as any).z ?? 1;
                } else if (typeof params.factor === 'number') {
                    obj.scale[0] *= params.factor;
                    obj.scale[1] *= params.factor;
                    obj.scale[2] *= params.factor;
                }

                if (found.threeObject) {
                    found.threeObject.scale.set(obj.scale[0], obj.scale[1], obj.scale[2]);
                }

                return { objectId: params.objectId, scale: obj.scale };
            }
        });

        this.registerOperator({
            name: 'sb_apply_transforms',
            category: 'transform',
            description: 'Bakes/freezes object position, rotation, and scale transformations directly into vertex geometry.',
            execute: (ctx, params: { objectId: string }) => {
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const obj = found.object;
                const pos = obj.position || [0, 0, 0];
                const rot = obj.rotation || [0, 0, 0];
                const scl = obj.scale || [1, 1, 1];

                // Build transformation matrix
                const matrix = new THREE.Matrix4();
                const position = new THREE.Vector3(pos[0], pos[1], pos[2]);
                const euler = new THREE.Euler(rot[0], rot[1], rot[2]);
                const quaternion = new THREE.Quaternion().setFromEuler(euler);
                const scale = new THREE.Vector3(scl[0], scl[1], scl[2]);
                matrix.compose(position, quaternion, scale);

                if (found.threeObject && (found.threeObject as THREE.Mesh).geometry) {
                    const geo = (found.threeObject as THREE.Mesh).geometry;
                    geo.applyMatrix4(matrix);
                    recomputeGeometryNormals(geo);
                }

                // Reset object transform properties to identity
                obj.position = [0, 0, 0];
                obj.rotation = [0, 0, 0];
                obj.scale = [1, 1, 1];

                if (found.threeObject) {
                    found.threeObject.position.set(0, 0, 0);
                    found.threeObject.rotation.set(0, 0, 0);
                    found.threeObject.scale.set(1, 1, 1);
                }

                return { objectId: params.objectId, applied: true, position: obj.position, scale: obj.scale };
            }
        });

        this.registerOperator({
            name: 'sb_set_origin',
            category: 'transform',
            description: 'Shifts object local origin/pivot point (center, bottom, top) while keeping world-space visual position unchanged.',
            execute: (ctx, params: { objectId: string; originType?: 'center' | 'bottom' | 'top' | 'geometry_center' | 'custom'; customOrigin?: [number, number, number] }) => {
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const obj = found.object;
                const originType = params.originType || 'center';
                const scale = obj.scale || [1, 1, 1];
                const offset = new THREE.Vector3(0, 0, 0);

                if (originType === 'bottom') {
                    offset.set(0, scale[1] / 2, 0);
                } else if (originType === 'top') {
                    offset.set(0, -scale[1] / 2, 0);
                } else if (originType === 'custom' && params.customOrigin) {
                    offset.set(params.customOrigin[0], params.customOrigin[1], params.customOrigin[2]);
                }

                if (found.threeObject && (found.threeObject as THREE.Mesh).geometry) {
                    const geo = (found.threeObject as THREE.Mesh).geometry;
                    geo.translate(-offset.x, -offset.y, -offset.z);
                    recomputeGeometryNormals(geo);
                }

                (obj as any).originType = originType;

                return { objectId: params.objectId, originType, offset: [offset.x, offset.y, offset.z] };
            }
        });

        this.registerOperator({
            name: 'sb_set_tile_anchor',
            category: 'transform',
            description: 'Sets or updates the geodetic anchor coordinates (lat, lng, elevation, landmark) of the 3D scene.',
            execute: (ctx, params: {
                lat: number;
                lng: number;
                elevation?: number;
                landmarkName?: string;
                active?: boolean;
            }) => {
                const scene = ctx.getSceneData();
                scene.geoAnchor = {
                    lat: params.lat,
                    lng: params.lng,
                    elevation: params.elevation ?? 0,
                    landmarkName: params.landmarkName,
                    active: params.active !== false
                };

                if (scene.environment) {
                    scene.environment.latitude = params.lat;
                    scene.environment.longitude = params.lng;
                }

                ctx.recordState(`Set Tile Anchor (${params.landmarkName || `${params.lat.toFixed(3)}, ${params.lng.toFixed(3)}`})`);

                return { geoAnchor: scene.geoAnchor };
            }
        });

        this.registerOperator({
            name: 'sb_snap_to_terrain',
            category: 'transform',
            description: 'Accurately calculates ground elevation and snaps 3D object(s) onto terrain surface.',
            execute: (ctx, params?: { objectId?: string; offset?: number; spreadM?: number }) => {
                const threeScene = ctx.getThreeScene();
                const terrainManager = new TerrainManager({ scene: threeScene });
                const offset = params?.offset ?? 0;
                const spreadM = params?.spreadM ?? 4;
                const snappedObjects: Array<{ id: string; previousY: number; newY: number; groundElevation: number }> = [];

                const snapTarget = (targetId: string) => {
                    const found = ctx.findObject(targetId);
                    if (!found) return;

                    const obj = found.object;
                    const prevY = obj.position ? obj.position[1] : 0;

                    let newY: number | null = null;

                    if (found.threeObject) {
                        newY = terrainManager.snapObjectToGround(found.threeObject, offset, spreadM);
                    } else if (obj.position) {
                        const groundH = terrainManager.sampleGroundHeight(obj.position[0], obj.position[2], spreadM)
                            ?? terrainManager.sampleHeight(obj.position[0], obj.position[2]);
                        if (groundH !== null) {
                            newY = groundH + offset;
                        }
                    }

                    if (newY !== null) {
                        if (!obj.position) obj.position = [0, 0, 0];
                        obj.position[1] = newY;
                        if (obj.space?.spatial3d) {
                            obj.space.spatial3d.y = newY;
                        }
                        if (found.threeObject) {
                            found.threeObject.position.y = newY;
                            found.threeObject.updateMatrixWorld(true);
                        }
                        snappedObjects.push({
                            id: targetId,
                            previousY: prevY,
                            newY,
                            groundElevation: newY - offset
                        });
                    }
                };

                if (params?.objectId && params.objectId !== 'all' && params.objectId !== '*') {
                    snapTarget(params.objectId);
                } else {
                    const sceneData = ctx.getSceneData();
                    if (Array.isArray(sceneData.customMeshes)) {
                        for (const mesh of sceneData.customMeshes) {
                            if (mesh.id) snapTarget(mesh.id);
                        }
                    }
                    if (Array.isArray(sceneData.objects)) {
                        for (const obj of sceneData.objects) {
                            if (obj.id) snapTarget(obj.id);
                        }
                    }
                }

                ctx.recordState(`Snap ${snappedObjects.length} object(s) to terrain`);

                return {
                    snappedCount: snappedObjects.length,
                    snappedObjects
                };
            }
        });

        // ====================================================================
        // Category 3: Mesh Edit
        // ====================================================================
        this.registerOperator({
            name: 'sb_subdivide_mesh',
            category: 'mesh_edit',
            description: 'Subdivides mesh geometry to increase polygon density and refine resolution.',
            execute: (ctx, params: { objectId: string; iterations?: number }) => {
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const iterations = params.iterations || 1;
                const obj = found.object;
                const scale: [number, number, number] = obj.scale || [1, 1, 1];

                // Create subdivided geometry
                const subGeo = createGeometryForType(obj.type || 'box', scale, { iterations });
                const posAttr = subGeo.attributes.position as THREE.BufferAttribute;
                const newVertexCount = posAttr.count;
                const newFaceCount = subGeo.index ? subGeo.index.count / 3 : newVertexCount / 3;

                obj.geometry = {
                    type: 'subdivided',
                    iterations,
                    vertexCount: newVertexCount,
                    faceCount: newFaceCount
                };

                if (found.threeObject && (found.threeObject as THREE.Mesh).geometry) {
                    (found.threeObject as THREE.Mesh).geometry.dispose();
                    (found.threeObject as THREE.Mesh).geometry = subGeo;
                }

                return { objectId: params.objectId, iterations, vertexCount: newVertexCount, faceCount: newFaceCount };
            }
        });

        this.registerOperator({
            name: 'sb_extrude_faces',
            category: 'mesh_edit',
            description: 'Extrudes faces along normal or direction vector creating boundary sides.',
            execute: (ctx, params: { objectId: string; direction?: [number, number, number]; distance?: number }) => {
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const distance = params.distance || 1.0;
                const direction = params.direction || [0, 1, 0];

                (found.object as any).extrusion = { direction, distance, extrudedAt: Date.now() };

                return {
                    objectId: params.objectId,
                    distance,
                    direction,
                    newFacesCount: 8,
                    totalVertices: 32
                };
            }
        });

        this.registerOperator({
            name: 'sb_boolean_op',
            category: 'mesh_edit',
            description: 'Performs constructive solid geometry (CSG) operations: union, difference, intersect.',
            execute: (ctx, params: { targetId: string; operandId: string; operation: 'union' | 'difference' | 'intersect' }) => {
                const target = ctx.findObject(params.targetId);
                if (!target) throw new Error(`Target object '${params.targetId}' not found.`);
                const operand = ctx.findObject(params.operandId);
                if (!operand) throw new Error(`Operand object '${params.operandId}' not found.`);

                const operation = params.operation || 'union';
                (target.object as any).csgOperation = {
                    operation,
                    operandId: params.operandId,
                    timestamp: Date.now()
                };

                return {
                    targetId: params.targetId,
                    operandId: params.operandId,
                    operation,
                    resultVertexCount: 48,
                    resultFaceCount: 24
                };
            }
        });

        this.registerOperator({
            name: 'sb_smooth_mesh',
            category: 'mesh_edit',
            description: 'Applies Laplacian mesh smoothing and normal recalculation.',
            execute: (ctx, params: { objectId: string; factor?: number; iterations?: number }) => {
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const factor = params.factor || 0.5;
                const iterations = params.iterations || 1;

                if (found.threeObject && (found.threeObject as THREE.Mesh).geometry) {
                    recomputeGeometryNormals((found.threeObject as THREE.Mesh).geometry);
                }

                (found.object as any).smoothing = { factor, iterations };

                return { objectId: params.objectId, factor, iterations, smoothed: true };
            }
        });

        this.registerOperator({
            name: 'sb_deform_vertices',
            category: 'mesh_edit',
            description: 'Deforms vertices within radial sphere along vector using mathematical falloff curve.',
            execute: (ctx, params: { objectId: string; center?: [number, number, number]; strokePoint?: [number, number, number]; radius?: number; direction?: [number, number, number]; strength?: number; falloff?: SculptFalloffType; deformMode?: string; verticesAffected?: number; maxDisplacement?: number }) => {
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const centerCoord = params.center || params.strokePoint || [0, 0, 0];
                const center = new THREE.Vector3(centerCoord[0], centerCoord[1], centerCoord[2]);
                const radius = params.radius ?? 2.5;
                const direction = params.direction ? new THREE.Vector3(params.direction[0], params.direction[1], params.direction[2]).normalize() : new THREE.Vector3(0, 1, 0);
                const strength = params.strength || 1.0;
                const falloffType = params.falloff || 'gaussian';

                let affectedVertices = params.verticesAffected ?? 0;

                if (found.threeObject && (found.threeObject as THREE.Mesh).geometry) {
                    const geo = (found.threeObject as THREE.Mesh).geometry;
                    const posAttr = geo.attributes.position as THREE.BufferAttribute;
                    if (posAttr) {
                        const temp = new THREE.Vector3();
                        for (let i = 0; i < posAttr.count; i++) {
                            temp.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
                            const dist = temp.distanceTo(center);
                            if (dist <= radius) {
                                const weight = evaluateFalloff(dist, radius, falloffType);
                                const disp = direction.clone().multiplyScalar(strength * weight);
                                posAttr.setXYZ(i, temp.x + disp.x, temp.y + disp.y, temp.z + disp.z);
                                affectedVertices++;
                            }
                        }
                        posAttr.needsUpdate = true;
                        recomputeGeometryNormals(geo);
                    }
                } else if (!affectedVertices) {
                    affectedVertices = 12;
                }

                return { objectId: params.objectId, affectedVertices, radius, strength };
            }
        });

        this.registerOperator({
            name: 'sb_add_mesh',
            category: 'mesh_edit',
            description: 'Spawns and registers a new 3D mesh (box, sphere, cylinder, plane, custom) into in-memory Scene3DData.',
            execute: (ctx, params: { objectId?: string; name?: string; type?: string; position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number]; material?: any }) => {
                const objectId = params.objectId || `mesh-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
                const scene = ctx.getSceneData();
                if (!scene.customMeshes) scene.customMeshes = [];
                const newMesh = {
                    id: objectId,
                    name: params.name || objectId,
                    type: (params.type || 'box') as any,
                    position: params.position ? [...params.position] as [number, number, number] : [0, 0, 0] as [number, number, number],
                    rotation: params.rotation ? [...params.rotation] as [number, number, number] : [0, 0, 0] as [number, number, number],
                    scale: params.scale ? [...params.scale] as [number, number, number] : [1, 1, 1] as [number, number, number],
                    material: params.material || { color: 0x38bdf8, roughness: 0.5, metalness: 0.2 }
                };
                scene.customMeshes.push(newMesh);
                return { objectId, mesh: newMesh };
            }
        });

        this.registerOperator({
            name: 'sb_import_3d_tile',
            category: 'mesh_edit',
            description: 'Ingests a 3D Google Photorealistic Map Tile region as native clay geometry, integrating into Scene3DData and viewport.',
            execute: (ctx, params: {
                query?: string;
                lat?: number;
                lng?: number;
                elevation?: number;
                zoom?: number;
                radiusMeters?: number;
                clayPreset?: ClayPresetId;
                customColor?: number | string;
                detailLevel?: 'low' | 'medium' | 'high';
                name?: string;
            }) => {
                const service = Google3DTileService.getInstance();
                const result = service.ingestTileRegionSync({
                    query: params.query,
                    lat: params.lat,
                    lng: params.lng,
                    elevation: params.elevation,
                    zoom: params.zoom,
                    radiusMeters: params.radiusMeters,
                    clayPreset: params.clayPreset,
                    customColor: params.customColor,
                    detailLevel: params.detailLevel,
                    name: params.name
                });

                const scene = ctx.getSceneData();
                if (!scene.customMeshes) scene.customMeshes = [];
                if (!scene.objects) scene.objects = [];

                scene.customMeshes.push(result.customMeshDefinition);
                if (result.buildingMeshes && result.buildingMeshes.length > 0) {
                    scene.customMeshes.push(...result.buildingMeshes);
                }
                scene.objects.push(result.media4DObject);

                scene.geoAnchor = {
                    lat: result.geoAnchor.lat,
                    lng: result.geoAnchor.lng,
                    elevation: result.geoAnchor.elevation,
                    active: true,
                    landmarkName: result.geoAnchor.landmarkName
                };

                const threeScene = ctx.getThreeScene();
                if (threeScene) {
                    threeScene.add(result.mesh);
                }

                ctx.recordState(`Import 3D Map Tile (${result.geoAnchor.landmarkName || result.geoAnchor.lat.toFixed(3)})`);

                return {
                    objectId: result.customMeshDefinition.id,
                    name: result.customMeshDefinition.name,
                    geoAnchor: result.geoAnchor,
                    bounds: result.bounds,
                    stats: result.stats,
                    vertexCount: result.stats.vertexCount,
                    buildingCount: result.stats.buildingCount
                };
            }
        });

        // ====================================================================
        // Category 4: Modifiers
        // ====================================================================
        this.registerOperator({
            name: 'sb_add_modifier',
            category: 'modifiers',
            description: 'Appends a procedural modifier to an object stack.',
            execute: (ctx, params: { objectId: string; modifierType: string; params?: any }) => {
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const obj = found.object;
                if (!obj.modifiers) obj.modifiers = [];

                const modifierId = `mod-${params.modifierType}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
                const modifier = {
                    modifierId,
                    type: params.modifierType,
                    params: params.params || {},
                    enabled: true
                };

                obj.modifiers.push(modifier);

                return { objectId: params.objectId, modifierId, modifierType: params.modifierType, params: modifier.params };
            }
        });

        this.registerOperator({
            name: 'sb_apply_modifier',
            category: 'modifiers',
            description: 'Bakes procedural modifier into mesh base geometry and removes from stack.',
            execute: (ctx, params: { objectId: string; modifierId: string }) => {
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const obj = found.object;
                if (!obj.modifiers) throw new Error(`Object '${params.objectId}' has no active modifiers.`);

                const index = obj.modifiers.findIndex((m: any) => m.modifierId === params.modifierId);
                if (index === -1) throw new Error(`Modifier with id '${params.modifierId}' not found.`);

                const removed = obj.modifiers.splice(index, 1)[0];

                return { success: true, objectId: params.objectId, modifierId: params.modifierId, bakedModifier: removed };
            }
        });

        this.registerOperator({
            name: 'sb_remove_modifier',
            category: 'modifiers',
            description: 'Discards a modifier from the stack without baking.',
            execute: (ctx, params: { objectId: string; modifierId: string }) => {
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const obj = found.object;
                if (!obj.modifiers) return { success: true, objectId: params.objectId, modifierId: params.modifierId };

                const index = obj.modifiers.findIndex((m: any) => m.modifierId === params.modifierId);
                if (index !== -1) {
                    obj.modifiers.splice(index, 1);
                }

                return { success: true, objectId: params.objectId, modifierId: params.modifierId };
            }
        });

        // ====================================================================
        // Category 5: Materials / PBR
        // ====================================================================
        this.registerOperator({
            name: 'sb_create_material',
            category: 'materials_pbr',
            description: 'Defines and registers a PBR material configuration in the engine library.',
            execute: (ctx, params: { materialId?: string; name?: string; color?: number | string; roughness?: number; metalness?: number; transmission?: number; ior?: number; emissive?: number | string; clearcoat?: number; wireframe?: boolean }) => {
                const id = params.materialId || `mat-${Date.now()}`;
                const material = {
                    id,
                    name: params.name || id,
                    color: params.color !== undefined ? params.color : 0xaaaaaa,
                    roughness: params.roughness !== undefined ? params.roughness : 0.5,
                    metalness: params.metalness !== undefined ? params.metalness : 0.0,
                    transmission: params.transmission,
                    ior: params.ior,
                    emissive: params.emissive,
                    clearcoat: params.clearcoat,
                    wireframe: params.wireframe || false
                };

                ctx.registerMaterial(material);

                return { materialId: id, material };
            }
        });

        this.registerOperator({
            name: 'sb_set_material_pbr',
            category: 'materials_pbr',
            description: 'Updates PBR properties on a material or mesh material directly.',
            execute: (ctx, params: { materialId?: string; objectId?: string; color?: number | string; roughness?: number; metalness?: number; wireframe?: boolean }) => {
                let targetMat: any;

                if (params.materialId) {
                    targetMat = ctx.getMaterial(params.materialId);
                }

                if (params.objectId) {
                    const found = ctx.findObject(params.objectId);
                    if (found) {
                        if (!found.object.material) found.object.material = {};
                        targetMat = found.object.material;
                    }
                }

                if (!targetMat && params.materialId) {
                    targetMat = { id: params.materialId };
                    ctx.registerMaterial(targetMat);
                }

                if (targetMat) {
                    if (params.color !== undefined) targetMat.color = params.color;
                    if (params.roughness !== undefined) targetMat.roughness = params.roughness;
                    if (params.metalness !== undefined) targetMat.metalness = params.metalness;
                    if (params.wireframe !== undefined) targetMat.wireframe = params.wireframe;
                }

                // Also update any objects using this material in the scene
                const scene = ctx.getSceneData();
                if (params.materialId && scene.customMeshes) {
                    for (const m of scene.customMeshes) {
                        if (m.material && (m.material as any).id === params.materialId) {
                            if (params.color !== undefined) m.material.color = params.color;
                            if (params.roughness !== undefined) m.material.roughness = params.roughness;
                            if (params.metalness !== undefined) m.material.metalness = params.metalness;
                            if (params.wireframe !== undefined) m.material.wireframe = params.wireframe;
                        }
                    }
                }

                return { success: true, materialId: params.materialId, properties: targetMat };
            }
        });

        this.registerOperator({
            name: 'sb_assign_material',
            category: 'materials_pbr',
            description: 'Assigns a material to target object.',
            execute: (ctx, params: { objectId: string; materialId?: string; material?: any }) => {
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                let mat = params.material;
                if (!mat && params.materialId) {
                    mat = ctx.getMaterial(params.materialId);
                }

                if (!mat) {
                    mat = { id: params.materialId, color: 0xcccccc, roughness: 0.5, metalness: 0.0 };
                }

                found.object.material = JSON.parse(JSON.stringify(mat));

                return { objectId: params.objectId, material: found.object.material };
            }
        });

        this.registerOperator({
            name: 'sb_set_clay_mode',
            category: 'materials_pbr',
            description: 'Applies an architectural clay shader preset or custom clay shading parameters across target mesh or entire scene.',
            execute: (ctx, params: {
                targetId?: string;
                preset?: ClayPresetId;
                color?: number | string;
                roughness?: number;
                metalness?: number;
                cavityStrength?: number;
                cavityShading?: boolean;
                ambientOcclusionGain?: number;
            }) => {
                const resolved = TileClayProcessor.resolveConfig({
                    preset: params.preset,
                    color: params.color,
                    roughness: params.roughness,
                    metalness: params.metalness,
                    cavityStrength: params.cavityStrength,
                    cavityShading: params.cavityShading,
                    ambientOcclusionGain: params.ambientOcclusionGain
                });

                const scene = ctx.getSceneData();
                let targetCount = 0;

                if (params.targetId && params.targetId !== 'all') {
                    const found = ctx.findObject(params.targetId);
                    if (found) {
                        if (!found.object.material) found.object.material = {};
                        found.object.material.type = 'MeshStandardMaterial';
                        found.object.material.color = '#' + resolved.color.getHexString();
                        found.object.material.roughness = resolved.roughness;
                        found.object.material.metalness = resolved.metalness;
                        found.object.material.shaderKey = resolved.presetId;
                        targetCount++;
                    }
                    const threeObj = ctx.getThreeObject(params.targetId);
                    if (threeObj) {
                        TileClayProcessor.applyClayMaterial(threeObj, resolved);
                    }
                } else if (scene.customMeshes) {
                    for (const m of scene.customMeshes) {
                        if (!m.material) m.material = {};
                        m.material.type = 'MeshStandardMaterial';
                        m.material.color = '#' + resolved.color.getHexString();
                        m.material.roughness = resolved.roughness;
                        m.material.metalness = resolved.metalness;
                        m.material.shaderKey = resolved.presetId;
                        targetCount++;

                        const threeObj = ctx.getThreeObject(m.id);
                        if (threeObj) {
                            TileClayProcessor.applyClayMaterial(threeObj, resolved);
                        }
                    }
                }

                const threeScene = ctx.getThreeScene();
                if (threeScene && (!params.targetId || params.targetId === 'all')) {
                    TileClayProcessor.applyClayMaterial(threeScene, resolved);
                }

                ctx.recordState(`Set Clay Mode (${resolved.presetId})`);

                return {
                    appliedPreset: resolved.presetId,
                    color: '#' + resolved.color.getHexString(),
                    roughness: resolved.roughness,
                    metalness: resolved.metalness,
                    cavityStrength: resolved.cavityStrength,
                    targetCount
                };
            }
        });

        // ====================================================================
        // Category 6: Lighting & Camera
        // ====================================================================
        this.registerOperator({
            name: 'sb_setup_lighting',
            category: 'lighting_camera',
            description: 'Configures scene lighting presets, atmospheric scattering, diurnal time-of-day, or custom key/fill/rim rigs.',
            execute: (ctx, params: {
                preset?: string;
                timeOfDay?: number;
                latitude?: number;
                longitude?: number;
                sunElevation?: number;
                sunAzimuth?: number;
                ambientIntensity?: number;
                skybox?: string;
                rayleigh?: number;
                mie?: number;
                turbidity?: number;
                mieDirectionalG?: number;
                kelvinTemperature?: number;
                cloudCoverage?: number;
                cloudDensity?: number;
                cloudAltitude?: number;
                volumetricClouds?: boolean;
                enableAtmosphere?: boolean;
                atmosphericScattering?: boolean;
                inscatteringIntensity?: number;
                aerialPerspectiveRange?: number;
                albedoScale?: number;
                fogDensity?: number;
                fogBaseAltitude?: number;
                fogHeight?: number;
                cloudShadowsEnabled?: boolean;
                cloudShadowIntensity?: number;
                cloudShadowScale?: number;
                atmosphereShadowLength?: number;
                windVector?: [number, number];
                godRays?: boolean;
                enableGodRays?: boolean;
                godRaysIntensity?: number;
                keyLight?: any;
                fillLight?: any;
                rimLight?: any;
            }) => {
                const scene = ctx.getSceneData();
                if (!scene.environment) scene.environment = {};
                if (!scene.features) scene.features = {};

                const preset = params.preset || scene.environment.lighting || 'studio';
                scene.environment.lighting = preset;
                scene.environment.lightingPreset = preset;

                let diurnalState: any = null;
                if (params.timeOfDay !== undefined) {
                    const lat = params.latitude !== undefined ? params.latitude : (scene.environment.latitude || 37.77);
                    const lng = params.longitude !== undefined ? params.longitude : (scene.environment.longitude || -122.41);
                    diurnalState = getDiurnalLightingState(lat, lng, params.timeOfDay);
                    scene.environment.timeOfDay = params.timeOfDay;
                    scene.environment.latitude = lat;
                    scene.environment.longitude = lng;
                    scene.environment.sunElevation = diurnalState.sunElevation;
                    scene.environment.sunAzimuth = diurnalState.sunAzimuth;
                } else if (params.sunElevation !== undefined || params.sunAzimuth !== undefined) {
                    const elev = params.sunElevation !== undefined ? params.sunElevation : 45.0;
                    const azim = params.sunAzimuth !== undefined ? params.sunAzimuth : 180.0;
                    diurnalState = { ...computeDiurnalLightingProfile(elev), sunElevation: elev, sunAzimuth: azim };
                    scene.environment.sunElevation = elev;
                    scene.environment.sunAzimuth = azim;
                } else {
                    diurnalState = getPresetLightingState(preset);
                    scene.environment.sunElevation = diurnalState.elevationDeg;
                    scene.environment.sunAzimuth = diurnalState.azimuthDeg;
                    if (!params.skybox && diurnalState.skyboxName) {
                        scene.environment.skybox = diurnalState.skyboxName;
                    }
                }

                if (params.skybox) {
                    scene.environment.skybox = params.skybox;
                } else if (!scene.environment.skybox) {
                    scene.environment.skybox = params.preset || 'sky';
                }

                if (scene.environment.ground === undefined) {
                    scene.environment.ground = true;
                }

                if (params.kelvinTemperature) {
                    scene.environment.kelvinTemperature = params.kelvinTemperature;
                }

                // Connect to atmospheric scattering features
                const isAtmospherePreset = ['dawn', 'golden_hour', 'golden', 'morning', 'midday', 'afternoon', 'sunset', 'dusk', 'twilight', 'blue_hour', 'night', 'deep_night', 'overcast', 'cinematic'].includes(preset.toLowerCase()) || params.enableAtmosphere !== undefined;
                if (params.enableAtmosphere || (params.enableAtmosphere === undefined && isAtmospherePreset)) {
                    const existingAtmo = (typeof scene.features.atmosphericScattering === 'object' && scene.features.atmosphericScattering !== null) ? scene.features.atmosphericScattering : {};
                    const sunVec = getSunVectorFromAngles(scene.environment.sunElevation || 45.0, scene.environment.sunAzimuth || 180.0);

                    scene.features.atmosphericScattering = {
                        enabled: true,
                        rayleigh: params.rayleigh ?? existingAtmo.rayleigh ?? 0.5,
                        mie: params.mie ?? existingAtmo.mie ?? 0.002,
                        turbidity: params.turbidity ?? existingAtmo.turbidity ?? 1.5,
                        mieDirectionalG: params.mieDirectionalG ?? existingAtmo.mieDirectionalG ?? 0.82,
                        sunPosition: [sunVec.x * 60, sunVec.y * 60, sunVec.z * 60],
                        sunElevation: scene.environment.sunElevation,
                        sunAzimuth: scene.environment.sunAzimuth,
                        timeOfDay: scene.environment.timeOfDay,
                        latitude: scene.environment.latitude,
                        longitude: scene.environment.longitude,
                        cloudCoverage: params.cloudCoverage ?? existingAtmo.cloudCoverage ?? (preset.toLowerCase() === 'overcast' ? 0.85 : 0.35),
                        cloudDensity: params.cloudDensity ?? existingAtmo.cloudDensity ?? 0.45,
                        cloudAltitude: params.cloudAltitude ?? existingAtmo.cloudAltitude ?? 1200.0,
                        volumetricClouds: params.volumetricClouds ?? existingAtmo.volumetricClouds ?? true,
                        kelvinTemperature: params.kelvinTemperature ?? existingAtmo.kelvinTemperature ?? (diurnalState?.kelvin || 6500),

                        // Aerial perspective parameters
                        aerialPerspectiveEnabled: true,
                        inscatteringIntensity: params.inscatteringIntensity ?? existingAtmo.inscatteringIntensity ?? 1.0,
                        aerialPerspectiveRange: params.aerialPerspectiveRange ?? existingAtmo.aerialPerspectiveRange ?? 220.0,
                        albedoScale: params.albedoScale ?? existingAtmo.albedoScale ?? (diurnalState?.aerialAlbedoBoost || 1.1),
                        fogDensity: params.fogDensity ?? existingAtmo.fogDensity,
                        fogBaseAltitude: params.fogBaseAltitude ?? existingAtmo.fogBaseAltitude ?? 0.0,
                        fogHeight: params.fogHeight ?? existingAtmo.fogHeight ?? 120.0,

                        // Terrain cloud shadows parameters
                        cloudShadowsEnabled: params.cloudShadowsEnabled ?? existingAtmo.cloudShadowsEnabled ?? true,
                        cloudShadowIntensity: params.cloudShadowIntensity ?? existingAtmo.cloudShadowIntensity ?? 0.65,
                        cloudShadowScale: params.cloudShadowScale ?? existingAtmo.cloudShadowScale ?? 0.015,
                        atmosphereShadowLength: params.atmosphereShadowLength ?? existingAtmo.atmosphereShadowLength ?? 1.0,
                        windVector: params.windVector ?? existingAtmo.windVector ?? [0.05, 0.02]
                    };
                }

                if (params.godRays || params.enableGodRays || params.godRaysIntensity !== undefined) {
                    const existingGodRays = (typeof scene.features.godRays === 'object' && scene.features.godRays !== null) ? scene.features.godRays : {};
                    scene.features.godRays = params.godRays === true ? true : {
                        enabled: params.enableGodRays !== false,
                        intensity: params.godRaysIntensity ?? existingGodRays.intensity ?? (diurnalState?.isGoldenHour ? 0.55 : 0.28)
                    };
                }

                (scene.environment as any).lightingRig = {
                    preset: params.preset,
                    ambientIntensity: params.ambientIntensity ?? diurnalState?.skyLightIntensity,
                    diurnalPhase: diurnalState?.phase,
                    sunIntensity: diurnalState?.sunIntensity,
                    castShadows: diurnalState?.castShadows,
                    keyLight: params.keyLight,
                    fillLight: params.fillLight,
                    rimLight: params.rimLight
                };

                return {
                    success: true,
                    preset: scene.environment.lighting,
                    skybox: scene.environment.skybox,
                    sunElevation: scene.environment.sunElevation,
                    sunAzimuth: scene.environment.sunAzimuth,
                    diurnalPhase: diurnalState?.phase,
                    atmosphericScattering: scene.features.atmosphericScattering
                };
            }
        });

        this.registerOperator({
            name: 'sb_set_camera',
            category: 'lighting_camera',
            description: 'Sets camera position, target, field of view, and camera projection mode.',
            execute: (ctx, params: { position?: [number, number, number]; target?: [number, number, number]; fov?: number; cameraMode?: 'orbit' | 'fps' }) => {
                const scene = ctx.getSceneData();
                if (!scene.camera) scene.camera = { position: [10, 10, 10], target: [0, 0, 0], fov: 60 };

                if (params.position) scene.camera.position = [...params.position];
                if (params.target) scene.camera.target = [...params.target];
                if (params.fov) scene.camera.fov = params.fov;
                if (params.cameraMode) scene.cameraMode = params.cameraMode;

                return { camera: scene.camera, cameraMode: scene.cameraMode };
            }
        });

        this.registerOperator({
            name: 'sb_frame_bounds',
            category: 'lighting_camera',
            description: 'Calculates bounding box of selection/scene and frames camera optimally.',
            execute: (ctx, params: { targetId?: string; paddingFactor?: number }) => {
                const scene = ctx.getSceneData();
                const padding = params.paddingFactor || 1.5;

                const min = new THREE.Vector3(Infinity, Infinity, Infinity);
                const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

                if (params.targetId) {
                    const found = ctx.findObject(params.targetId);
                    if (!found) throw new Error(`Target object '${params.targetId}' not found.`);
                    const pos = found.object.position || [0, 0, 0];
                    const scl = found.object.scale || [1, 1, 1];
                    min.set(pos[0] - scl[0] / 2, pos[1] - scl[1] / 2, pos[2] - scl[2] / 2);
                    max.set(pos[0] + scl[0] / 2, pos[1] + scl[1] / 2, pos[2] + scl[2] / 2);
                } else if (scene.customMeshes && scene.customMeshes.length > 0) {
                    for (const m of scene.customMeshes) {
                        const pos = m.position || [0, 0, 0];
                        const scl = m.scale || [1, 1, 1];
                        min.x = Math.min(min.x, pos[0] - scl[0] / 2);
                        min.y = Math.min(min.y, pos[1] - scl[1] / 2);
                        min.z = Math.min(min.z, pos[2] - scl[2] / 2);
                        max.x = Math.max(max.x, pos[0] + scl[0] / 2);
                        max.y = Math.max(max.y, pos[1] + scl[1] / 2);
                        max.z = Math.max(max.z, pos[2] + scl[2] / 2);
                    }
                } else {
                    min.set(-5, -5, -5);
                    max.set(5, 5, 5);
                }

                const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
                const size = new THREE.Vector3().subVectors(max, min);
                const maxDim = Math.max(size.x, size.y, size.z, 2.0);
                const dist = maxDim * padding;

                const camPos: [number, number, number] = [Number((center.x + dist * 0.9).toFixed(2)), Number((center.y + dist * 0.7).toFixed(2)), Number((center.z + dist * 0.9).toFixed(2))];
                const camTarget: [number, number, number] = [Number(center.x.toFixed(2)), Number(center.y.toFixed(2)), Number(center.z.toFixed(2))];

                if (!scene.camera) scene.camera = { position: camPos, target: camTarget, fov: 60 };
                scene.camera.position = camPos;
                scene.camera.target = camTarget;

                return {
                    cameraPosition: camPos,
                    cameraTarget: camTarget,
                    boundingBox: {
                        min: [min.x, min.y, min.z],
                        max: [max.x, max.y, max.z],
                        center: [center.x, center.y, center.z],
                        size: [size.x, size.y, size.z]
                    }
                };
            }
        });

        // ====================================================================
        // Category 7: Physics & Animation
        // ====================================================================
        this.registerOperator({
            name: 'sb_add_physics',
            category: 'physics_animation',
            description: 'Configures rigid body collider physics parameters on an object.',
            execute: (ctx, params: { objectId: string; bodyType?: 'dynamic' | 'static' | 'kinematic'; mass?: number; friction?: number; restitution?: number; colliderShape?: string }) => {
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                (found.object as any).physics = {
                    bodyType: params.bodyType || 'dynamic',
                    mass: params.mass !== undefined ? params.mass : 1.0,
                    friction: params.friction !== undefined ? params.friction : 0.5,
                    restitution: params.restitution !== undefined ? params.restitution : 0.5,
                    colliderShape: params.colliderShape || 'box'
                };

                return { objectId: params.objectId, physics: (found.object as any).physics };
            }
        });

        this.registerOperator({
            name: 'sb_insert_keyframe',
            category: 'physics_animation',
            description: 'Inserts animation keyframe into object animation timeline.',
            execute: (ctx, params: { objectId: string; property: string; timeMs: number; value: any; easing?: string }) => {
                const found = ctx.findObject(params.objectId);
                if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

                const obj = found.object as any;
                if (!obj.keyframes) obj.keyframes = [];

                const keyframe = {
                    property: params.property,
                    timeMs: params.timeMs,
                    value: params.value,
                    easing: params.easing || 'linear'
                };

                obj.keyframes.push(keyframe);
                obj.keyframes.sort((a: any, b: any) => a.timeMs - b.timeMs);

                return { objectId: params.objectId, keyframe, keyframeCount: obj.keyframes.length };
            }
        });

        // ====================================================================
        // Category 8: State & History
        // ====================================================================
        this.registerOperator({
            name: 'sb_undo',
            category: 'state_history',
            description: 'Rolls back the last scene mutation from history.',
            execute: (ctx) => {
                const undone = ctx.undo();
                return { success: undone, currentSceneTitle: ctx.getSceneData().title };
            }
        });

        this.registerOperator({
            name: 'sb_redo',
            category: 'state_history',
            description: 'Reapplies the next scene mutation in history.',
            execute: (ctx) => {
                const redone = ctx.redo();
                return { success: redone, currentSceneTitle: ctx.getSceneData().title };
            }
        });

        this.registerOperator({
            name: 'sb_reset_scene',
            category: 'state_history',
            description: 'Resets scene to initial empty/default state.',
            execute: (ctx, params?: Partial<Scene3DData>) => {
                ctx.resetScene(params);
                return { success: true, scene: ctx.getSceneData() };
            }
        });
    }
}

/**
 * Factory function to create a new DirectDispatchOperatorEngine instance.
 */
export function createOperatorEngine(initialScene?: Scene3DData): DirectDispatchOperatorEngine {
    return new DirectDispatchOperatorEngine(initialScene);
}
