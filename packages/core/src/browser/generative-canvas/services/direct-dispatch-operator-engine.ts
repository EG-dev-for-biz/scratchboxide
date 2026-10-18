/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type { Scene3DData } from '../canvas-types';
import {
    type OperatorCategory,
    type OperatorResult,
    type BatchCommand,
    type BatchExecutionOptions,
    type BatchExecutionResult,
    type IOperatorContext,
    type OperatorDefinition,
    ALL_CORE_OPERATORS
} from './operators';
import { ViewportHistory } from './viewport-history';
import {
    ObjectEditCapture,
    SceneEditEntry,
    applySceneDelta,
    cloneJsonLike,
    computeSceneDelta,
    SCENE_BOOKKEEPING_KEYS
} from './viewport-history-deltas';
import type { SceneDelta } from './viewport-history-deltas';

export * from './operators';

/**
 * Copy of the scene for undo and rollback. Objects and arrays are copied so in-place operator edits cannot reach
 * the copy; strings (embedded GLB base64, source code) and typed arrays are shared, since operators replace them
 * rather than writing into them. `omit` drops top-level keys (the action log is never restored).
 */
function snapshotScene(data: Scene3DData, omit: ReadonlyArray<string> = ['actionLog']): Scene3DData {
    const copy = (value: unknown): unknown => {
        if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
        if (Array.isArray(value)) return value.map(copy);
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>)) {
            const v = (value as Record<string, unknown>)[key];
            if (typeof v !== 'function') out[key] = copy(v);
        }
        return out;
    };
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(data as unknown as Record<string, unknown>)) {
        if (omit.includes(key)) continue;
        const v = (data as unknown as Record<string, unknown>)[key];
        if (typeof v !== 'function') out[key] = copy(v);
    }
    return out as unknown as Scene3DData;
}

function getNowMs(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
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
    /** Shared viewport timeline; when attached it replaces the private whole-scene snapshots above. */
    private sharedHistory?: ViewportHistory;
    private recordingDepth = 0;
    /** True while the top of the private history stack is a copy of the live scene (a free rollback point). */
    private historyInSync = false;

    constructor(initialScene?: Scene3DData) {
        this.sceneData = initialScene ? snapshotScene(initialScene, []) : {
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
        this.historyInSync = false;
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
        this.sceneData = snapshotScene(data, []);
        this.historyStack = [];
        this.historyIndex = -1;
        this.sharedHistory?.clear();
        this.recordState('Load Scene');
    }

    /**
     * Records every dispatch / batch as one entry on the viewport's shared timeline (compact scene deltas
     * and sparse vertex deltas), and makes sb_undo / sb_redo walk that timeline, so agent operator edits
     * and the user's gizmo / sculpt / inspector edits undo in one order.
     */
    public attachHistory(history: ViewportHistory | undefined): void {
        this.sharedHistory = history;
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

        // 3. An object only in the live Three.js scene (a generated model's part, a tile mesh): operators get a
        // transient record of its transform. It is not written into the scene data, where it would be drawn as a
        // stand-in shape on the next load.
        const threeObj = this.getThreeObject(id);
        if (threeObj) {
            return {
                type: 'threeObject',
                object: {
                    id: threeObj.name || id,
                    name: threeObj.name || id,
                    position: [threeObj.position.x, threeObj.position.y, threeObj.position.z] as [number, number, number],
                    rotation: [threeObj.rotation.x, threeObj.rotation.y, threeObj.rotation.z] as [number, number, number],
                    scale: [threeObj.scale.x, threeObj.scale.y, threeObj.scale.z] as [number, number, number]
                },
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
        if (this.sharedHistory) return;
        if (this.historyIndex < this.historyStack.length - 1) {
            this.historyStack = this.historyStack.slice(0, this.historyIndex + 1);
        }
        this.historyStack.push(snapshotScene(this.sceneData));
        this.historyInSync = true;
        if (this.historyStack.length > this.maxHistory) {
            this.historyStack.shift();
        } else {
            this.historyIndex++;
        }
    }

    public undo(): boolean {
        if (this.sharedHistory) return this.sharedHistory.undo() !== null;
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.restoreSnapshot(this.historyStack[this.historyIndex]);
            this.historyInSync = true;
            this.syncToThreeScene();
            return true;
        }
        return false;
    }

    public redo(): boolean {
        if (this.sharedHistory) return this.sharedHistory.redo() !== null;
        if (this.historyIndex < this.historyStack.length - 1) {
            this.historyIndex++;
            this.restoreSnapshot(this.historyStack[this.historyIndex]);
            this.historyInSync = true;
            this.syncToThreeScene();
            return true;
        }
        return false;
    }

    /** Makes a copy of `snapshot` the live scene, keeping the running action log (undo is logged, not undone). */
    private restoreSnapshot(snapshot: Scene3DData, keepKeys: ReadonlyArray<string> = ['actionLog']): void {
        const current = this.sceneData as unknown as Record<string, unknown>;
        const next = snapshotScene(snapshot) as unknown as Record<string, unknown>;
        for (const key of keepKeys) {
            if (current[key] !== undefined) next[key] = current[key];
            else delete next[key];
        }
        this.sceneData = next as unknown as Scene3DData;
    }

    public resetScene(initialData?: Partial<Scene3DData>): void {
        // A reset removes every Three.js child, so earlier entries have nothing left to act on.
        this.sharedHistory?.clear();
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
    public executeOperator<TParams = any, TResult = any>(
        operatorName: string,
        params: TParams,
        options?: { recordHistory?: boolean }
    ): OperatorResult<TResult> {
        return this.dispatch<TParams, TResult>(operatorName, params, options);
    }

    public dispatch<TParams = any, TResult = any>(
        operatorName: string,
        params: TParams,
        options?: { recordHistory?: boolean }
    ): OperatorResult<TResult> {
        const startTime = getNowMs();
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

        const trackEdit = !!this.sharedHistory && this.recordingDepth === 0 && op.category !== 'inspect'
            && operatorName !== 'sb_undo' && operatorName !== 'sb_redo' && operatorName !== 'sb_reset_scene'
            && options?.recordHistory !== false && (params as any)?.recordHistory !== false;
        const tracker = trackEdit ? this.beginTrackedEdit([{ operator: operatorName, params }]) : undefined;
        // A failed operator leaves the scene data as it was: roll back to the tracked copy, the private history top
        // when it matches the scene, or a copy taken now. (Inspect operators do not write.)
        const rollbackPoint = op.category === 'inspect'
            ? undefined
            : tracker?.before
                ?? (!this.sharedHistory && this.historyInSync && this.historyIndex >= 0 ? this.historyStack[this.historyIndex] : undefined)
                ?? snapshotScene(this.sceneData);

        const paramsRecord = params ? cloneJsonLike(params) : undefined;
        try {
            const data = op.execute(this, params);
            tracker?.commit();
            
            const shouldRecord = options?.recordHistory !== false && (params as any)?.recordHistory !== false && op.category !== 'inspect';
            if (shouldRecord && operatorName !== 'sb_undo' && operatorName !== 'sb_redo') {
                this.recordState(`Dispatch ${operatorName}`);
            } else if (op.category !== 'inspect' && operatorName !== 'sb_undo' && operatorName !== 'sb_redo') {
                this.historyInSync = false;
            }

            const endTime = getNowMs();
            const executionTimeMs = Math.max(0.001, endTime - startTime);

            if (shouldRecord && operatorName !== 'sb_undo' && operatorName !== 'sb_redo') {
                if (!this.sceneData.operatorStack) this.sceneData.operatorStack = [];
                this.sceneData.operatorStack.push({
                    operator: operatorName,
                    params: paramsRecord,
                    timestamp: Date.now(),
                    result: data
                });
            }

            if (!this.sceneData.actionLog) this.sceneData.actionLog = [];
            this.sceneData.actionLog.push({
                operator: operatorName,
                params: paramsRecord,
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
            if (rollbackPoint) {
                // The failed dispatch did not change the bookkeeping (log, operator stack); it stays as it is now.
                this.restoreSnapshot(rollbackPoint, ['actionLog', ...SCENE_BOOKKEEPING_KEYS]);
                this.syncToThreeScene();
            }
            // Live Three.js edits made before the failure cannot be rolled back here; they stay undoable.
            tracker?.commit();
            const endTime = getNowMs();
            const executionTimeMs = Math.max(0.001, endTime - startTime);

            if (!this.sceneData.actionLog) this.sceneData.actionLog = [];
            this.sceneData.actionLog.push({
                operator: operatorName,
                params: paramsRecord,
                timestamp: Date.now(),
                executionTimeMs,
                success: false,
                error: err?.message || String(err)
            });

            return {
                success: false,
                operator: operatorName,
                error: err?.message || String(err),
                ...(typeof err?.code === 'string' ? { errorCode: err.code } : {}),
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
        const batchStartTime = getNowMs();
        const results: OperatorResult[] = [];
        const isAtomic = options?.atomic === true;
        const snapshotBeforeBatch = isAtomic ? snapshotScene(this.sceneData) : undefined;
        // A batch is one tool call: one shared-timeline entry, however many operators it runs.
        const tracker = this.sharedHistory && this.recordingDepth === 0 && options?.recordHistory !== false
            ? this.beginTrackedEdit(commands, snapshotBeforeBatch)
            : undefined;
        if (tracker) this.recordingDepth++;
        const finishTracking = (commit: boolean) => {
            if (!tracker) return;
            this.recordingDepth--;
            if (commit) tracker.commit();
        };

        for (const cmd of commands) {
            const res = this.dispatch(cmd.operator, cmd.params || {}, { recordHistory: !isAtomic });
            results.push(res);

            if (!res.success) {
                if (isAtomic && snapshotBeforeBatch) {
                    // Rollback to pre-batch snapshot
                    this.restoreSnapshot(snapshotBeforeBatch);
                    this.syncToThreeScene();
                }
                finishTracking(!isAtomic);
                const batchEndTime = getNowMs();
                return {
                    success: false,
                    results,
                    totalExecutionTimeMs: Math.max(0.001, batchEndTime - batchStartTime),
                    error: `Batch execution aborted on operator '${cmd.operator}': ${res.error}`
                };
            }
        }

        finishTracking(true);
        if (isAtomic && options?.recordHistory !== false) {
            this.recordState('Batch Execution');
        }

        const batchEndTime = getNowMs();
        return {
            success: true,
            results,
            totalExecutionTimeMs: Math.max(0.001, batchEndTime - batchStartTime)
        };
    }

    // ------------------------------------------------------------------------
    // Shared-timeline recording
    // ------------------------------------------------------------------------

    /** Three.js objects the commands name (objectId / objectIds / targetId / targetMeshId). */
    private targetsOf(commands: BatchCommand[]): THREE.Object3D[] {
        const found = new Set<THREE.Object3D>();
        for (const cmd of commands) {
            const p = (cmd.params ?? {}) as { objectId?: unknown; objectIds?: unknown; targetId?: unknown; targetMeshId?: unknown };
            const ids = [p.objectId, p.targetId, p.targetMeshId, ...(Array.isArray(p.objectIds) ? p.objectIds : [])];
            for (const id of ids) {
                if (typeof id !== 'string') continue;
                const obj = this.getThreeObject(id);
                if (obj) found.add(obj);
            }
        }
        return Array.from(found);
    }

    private beginTrackedEdit(commands: BatchCommand[], snapshot?: Scene3DData): { before: Scene3DData; commit: () => void } {
        const history = this.sharedHistory!;
        // The delta ignores the bookkeeping keys, so the copy leaves them out; a batch's rollback copy is reused.
        const before = snapshot ?? snapshotScene(this.sceneData, SCENE_BOOKKEEPING_KEYS);
        const capture = new ObjectEditCapture(this.targetsOf(commands));
        const name = (op: string) => op.replace(/^sb_/, '').replace(/[_-]+/g, ' ');
        const first = commands[0];
        const objectId = (first?.params as { objectId?: unknown } | undefined)?.objectId;
        const label = commands.length === 1
            ? `${name(first.operator).replace(/^./, c => c.toUpperCase())}${typeof objectId === 'string' ? `: ${objectId}` : ''}`
            : `Agent batch: ${commands.length} operators`;
        return {
            before,
            commit: () => {
                const delta = computeSceneDelta(before, this.sceneData, { clone: true, ignoreKeys: SCENE_BOOKKEEPING_KEYS });
                const live = capture.finish();
                if (!delta && !live) return;
                history.record(new SceneEditEntry({
                    label,
                    delta,
                    live,
                    target: {
                        applyDelta: (d: SceneDelta, direction) => {
                            this.sceneData = applySceneDelta(this.sceneData, d, direction, true);
                            this.syncToThreeScene();
                        }
                    }
                }));
            }
        };
    }

    // ------------------------------------------------------------------------
    // Core Operator Registrations
    // ------------------------------------------------------------------------

    private registerCoreOperators(): void {
        for (const op of ALL_CORE_OPERATORS) {
            this.registerOperator(op);
        }
    }
}

/**
 * Factory function to create a new DirectDispatchOperatorEngine instance.
 */
export function createOperatorEngine(initialScene?: Scene3DData): DirectDispatchOperatorEngine {
    return new DirectDispatchOperatorEngine(initialScene);
}
