/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    CodebaseLens,
    LensContext,
    LensProjectionResult,
    LensUnprojectionResult,
    computeMultiFileHash
} from '../../../common/codebase-lens-protocol';
import {
    Media4DObject,
    PrimitiveType,
    Scene3DData
} from '../canvas-types';
import {
    DirectDispatchOperatorEngine,
    createOperatorEngine,
    BatchCommand,
    BatchExecutionOptions,
    BatchExecutionResult,
    OperatorResult
} from '../services/direct-dispatch-operator-engine';

export class Scene3DWorldLens implements CodebaseLens<Scene3DData> {
    readonly primitiveType: PrimitiveType = '3d-scene';

    canHandle(filePathOrFiles: string | Record<string, string>): boolean {
        if (typeof filePathOrFiles === 'string') {
            const lower = filePathOrFiles.toLowerCase();
            return (
                lower.endsWith('.scene.json') ||
                lower.endsWith('.3d.json') ||
                lower.endsWith('.3d') ||
                lower.endsWith('.spatial.json') ||
                lower.includes('/scenes/') ||
                lower.includes('/3d/') ||
                lower.startsWith('scenes/') ||
                lower.startsWith('3d/')
            );
        }
        return Object.keys(filePathOrFiles).some(p => this.canHandle(p));
    }

    /**
     * Create or retrieve a DirectDispatchOperatorEngine instance bound to a scene.
     */
    createEngine(sceneData?: Scene3DData): DirectDispatchOperatorEngine {
        return createOperatorEngine(sceneData);
    }

    /**
     * Execute a single direct-dispatch operator against the lens scene data.
     */
    executeOperator(
        sceneData: Scene3DData,
        operatorName: string,
        params?: any,
        options?: { recordHistory?: boolean }
    ): { sceneData: Scene3DData; result: OperatorResult } {
        const engine = this.createEngine(sceneData);
        const result = engine.dispatch(operatorName, params || {}, options);
        return {
            sceneData: engine.getSceneData(),
            result
        };
    }

    /**
     * Execute a batch sequence of direct-dispatch operators against the lens scene data.
     */
    executeOperatorBatch(
        sceneData: Scene3DData,
        commands: BatchCommand[],
        options?: BatchExecutionOptions
    ): { sceneData: Scene3DData; result: BatchExecutionResult } {
        const engine = this.createEngine(sceneData);
        const result = engine.executeBatch(commands, options);
        return {
            sceneData: engine.getSceneData(),
            result
        };
    }

    /**
     * Playback an operator stack or action log on top of an initial scene.
     */
    playbackOperatorStack(
        sceneData: Scene3DData,
        operators?: BatchCommand[]
    ): { sceneData: Scene3DData; result: BatchExecutionResult } {
        const engine = this.createEngine(sceneData);
        const result = engine.replayOperatorStack(operators);
        return {
            sceneData: engine.getSceneData(),
            result
        };
    }

    project(
        sourceContent: Record<string, string> | string,
        context?: LensContext
    ): LensProjectionResult<Scene3DData> {
        const rawText = typeof sourceContent === 'string'
            ? sourceContent
            : Object.values(sourceContent)[0] || '';

        try {
            const parsed = JSON.parse(rawText);
            const objects: Media4DObject[] = Array.isArray(parsed.objects) ? parsed.objects : [];
            const customMeshes = Array.isArray(parsed.customMeshes) ? parsed.customMeshes : [];

            const data: Scene3DData = {
                title: parsed.title || '3D Spatial Scene World',
                subtitle: parsed.subtitle || 'Geospatial 3D & 4D media composition',
                worldBranch: parsed.worldBranch || 'main',
                sceneType: parsed.sceneType || 'general',
                parentCommitId: parsed.parentCommitId,
                renderMode: parsed.renderMode || 'shaded',
                cameraMode: parsed.cameraMode || 'orbit',
                animation: parsed.animation,
                camera: parsed.camera || {
                    position: [0, 10, 25],
                    target: [0, 0, 0],
                    fov: 60
                },
                environment: parsed.environment || {
                    skybox: 'golden_hour',
                    lighting: 'studio_soft',
                    ground: true
                },
                geoAnchor: parsed.geoAnchor || {
                    lat: 37.7749,
                    lng: -122.4194,
                    elevation: 15.0,
                    active: true,
                    landmarkName: 'San Francisco Hub'
                },
                droneRoute: parsed.droneRoute,
                wasmPhysics: parsed.wasmPhysics,
                timeline: parsed.timeline,
                customMeshes,
                features: parsed.features,
                customScript: parsed.customScript,
                code: parsed.code,
                shaders: parsed.shaders,
                operatorStack: parsed.operatorStack,
                actionLog: parsed.actionLog,
                toolMode: parsed.toolMode,
                sculptSettings: parsed.sculptSettings,
                selectedMeshId: parsed.selectedMeshId,
                objects
            };

            return {
                data,
                contentHash: computeMultiFileHash(rawText)
            };
        } catch (error) {
            // Fallback default procedural 3D scene
            const defaultData: Scene3DData = {
                title: '3D Spatial Scene World',
                subtitle: 'Procedural 3D scene generated from template',
                worldBranch: 'main',
                sceneType: 'general',
                renderMode: 'shaded',
                cameraMode: 'orbit',
                camera: {
                    position: [0, 12, 28],
                    target: [0, 0, 0],
                    fov: 60
                },
                environment: {
                    skybox: 'clear_sky',
                    lighting: 'directional_sun',
                    ground: true
                },
                geoAnchor: {
                    lat: 37.7749,
                    lng: -122.4194,
                    elevation: 10.0,
                    active: true,
                    landmarkName: 'San Francisco Base'
                },
                customMeshes: [
                    {
                        id: 'mesh-root-anchor',
                        name: 'Anchor Beacon',
                        type: 'box',
                        position: [0, 0, 0],
                        rotation: [0, 0, 0],
                        scale: [4, 8, 4],
                        material: { color: 0x38bdf8, roughness: 0.3, metalness: 0.8 }
                    }
                ],
                objects: [
                    {
                        id: 'mesh-root-anchor',
                        content: {
                            type: '3d-scene',
                            durableUri: 'media://models/anchor-beacon.glb',
                            mimeType: 'model/gltf-binary',
                            metadata: {
                                dims: { width: 4, height: 8, depth: 4 }
                            }
                        },
                        space: {
                            position: { x: 0, y: 0, zIndex: 0 },
                            spatial3d: { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 },
                            geoAnchor: { lat: 37.7749, lng: -122.4194, alt: 10.0 }
                        },
                        time: {
                            startMs: 0,
                            durationMs: 10000
                        },
                        lineage: {
                            version: 1,
                            author: 'Scratchbox 3D Engine'
                        }
                    }
                ]
            };

            return {
                data: defaultData,
                contentHash: computeMultiFileHash(rawText || JSON.stringify(defaultData))
            };
        }
    }

    unproject(
        primitiveData: Scene3DData,
        currentDiskContent: Record<string, string> | string,
        context?: LensContext
    ): LensUnprojectionResult {
        let primaryFileName = 'world.scene.json';
        if (typeof currentDiskContent === 'object' && Object.keys(currentDiskContent).length > 0) {
            primaryFileName = Object.keys(currentDiskContent)[0];
        } else if (typeof currentDiskContent === 'string' && currentDiskContent.length > 0 && (currentDiskContent.endsWith('.json') || currentDiskContent.endsWith('.3d'))) {
            primaryFileName = currentDiskContent;
        }

        const serialized = JSON.stringify({
            title: primitiveData.title,
            subtitle: primitiveData.subtitle,
            worldBranch: primitiveData.worldBranch,
            sceneType: primitiveData.sceneType,
            parentCommitId: primitiveData.parentCommitId,
            renderMode: primitiveData.renderMode,
            cameraMode: primitiveData.cameraMode,
            animation: primitiveData.animation,
            camera: primitiveData.camera,
            environment: primitiveData.environment,
            geoAnchor: primitiveData.geoAnchor,
            droneRoute: primitiveData.droneRoute,
            wasmPhysics: primitiveData.wasmPhysics,
            timeline: primitiveData.timeline,
            features: primitiveData.features,
            customMeshes: primitiveData.customMeshes,
            customScript: primitiveData.customScript,
            code: primitiveData.code,
            shaders: primitiveData.shaders,
            operatorStack: primitiveData.operatorStack,
            actionLog: primitiveData.actionLog,
            toolMode: primitiveData.toolMode,
            sculptSettings: primitiveData.sculptSettings,
            selectedMeshId: primitiveData.selectedMeshId,
            objects: primitiveData.objects
        }, null, 2) + '\n';

        const files: Record<string, string> = {
            [primaryFileName]: serialized
        };

        const totalMeshCount = (primitiveData.customMeshes?.length || 0) + (primitiveData.objects?.length || 0);

        return {
            files,
            contentHash: computeMultiFileHash(files),
            modifiedFilePaths: [primaryFileName],
            changeSummary: `Unprojected 3D scene "${primitiveData.title}" with ${totalMeshCount} objects & ${primitiveData.operatorStack?.length || 0} operators in stack`
        };
    }
}
