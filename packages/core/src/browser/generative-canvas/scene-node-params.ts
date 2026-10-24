/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The live parameters of a scene graph's nodes: which control each one gets, read from the scene as it now stands, and
 * how a change writes back into the scene's data (so the graph, the scene record and the viewport stay one scene). The
 * control follows the value's kind and range (a slider for a ranged number, xyz fields for a vector, a toggle for a
 * flag, a dropdown only where the value comes from a fixed set the viewport or the type defines); open values (a
 * skybox name) keep whatever the scene holds as an option. Nodes that only describe a build (stages, compiled-model
 * parts) have no parameters here.
 */

import type { GraphNode, Scene3DData, Media4DObject } from './canvas-types';
import { withStagedMaterialMode } from './primitives/scene3d/stagedBuild/texturedTwins';

export type ParamControl =
    | { kind: 'select'; options: string[] }
    | { kind: 'slider'; min: number; max: number; step: number; unit?: string }
    | { kind: 'number'; step?: number; unit?: string }
    | { kind: 'toggle' }
    | { kind: 'vec3'; step?: number; unit?: string }
    | { kind: 'color' }
    | { kind: 'file'; accept: string[] }
    | { kind: 'text' }
    | { kind: 'json' };

export interface ParamField {
    key: string;
    label: string;
    control: ParamControl;
    value: unknown;
    hint?: string;
}

/** Skyboxes the viewport draws with a look of its own (syncAtmosphere.ts); any other name is kept as the scene has it. */
export const VIEWPORT_SKYBOXES = ['studio', 'clear_daylight', 'daylight', 'sky', 'sunset', 'night', 'space', 'space-stars', 'deep_space', 'void', 'black'];
const LIGHTINGS = ['studio', 'daylight'];
/** Scene3DData.renderMode's values. */
const RENDER_MODES = ['pbr', 'clay', 'shaded', 'solid', 'wireframe'];

const withCurrent = (options: string[], current: unknown) =>
    typeof current === 'string' && current && !options.includes(current) ? [current, ...options] : options;

const toColorString = (c: unknown): string | undefined =>
    typeof c === 'number' ? `#${c.toString(16).padStart(6, '0')}` : typeof c === 'string' ? c : undefined;

const RAD = 180 / Math.PI;

function objectOf(scene: Scene3DData, id: string): Media4DObject | undefined {
    return (scene.objects || []).find(o => o.id === id);
}

/** The node's live fields, or undefined when it has none to edit. */
export function sceneNodeFields(node: GraphNode, scene: Scene3DData | undefined): ParamField[] | undefined {
    if (!scene) return undefined;
    if (node.id === 'n-cam') {
        const cam = scene.camera;
        return [
            { key: 'fov', label: 'Field of view', control: { kind: 'slider', min: 10, max: 120, step: 1, unit: '°' }, value: cam?.fov ?? 45 },
            { key: 'position', label: 'Position', control: { kind: 'vec3', step: 0.1, unit: 'm' }, value: cam?.position ?? [0, 2, 6] },
            { key: 'target', label: 'Target', control: { kind: 'vec3', step: 0.1, unit: 'm' }, value: cam?.target ?? [0, 0, 0] }
        ];
    }
    if (node.id === 'n-env') {
        const env = scene.environment || {};
        const atmo = scene.features?.atmosphericScattering;
        const atmosphereOn = atmo === true || (typeof atmo === 'object' && atmo !== null && atmo.enabled !== false);
        return [
            // the sky dome is an opt-in (no uninvited atmosphere): the skybox's look shows only with it, and never in clay
            { key: 'atmosphere', label: 'Atmosphere (sky)', control: { kind: 'toggle' }, value: atmosphereOn, hint: 'Draws the sky, sun and haze; off by default' },
            { key: 'skybox', label: 'Skybox', control: { kind: 'select', options: withCurrent(VIEWPORT_SKYBOXES, env.skybox) }, value: env.skybox ?? 'studio', hint: atmosphereOn ? 'Shown in pbr and shaded modes (clay keeps the studio look)' : 'Shown once Atmosphere is on' },
            { key: 'lighting', label: 'Lighting', control: { kind: 'select', options: withCurrent(LIGHTINGS, env.lighting) }, value: env.lighting ?? 'studio' },
            { key: 'ground', label: 'Ground', control: { kind: 'toggle' }, value: env.ground !== false },
            { key: 'fog', label: 'Fog', control: { kind: 'toggle' }, value: !!env.fog, hint: 'Off unless the scene asks for it (no uninvited atmosphere)' },
            { key: 'ambientIntensity', label: 'Ambient light', control: { kind: 'slider', min: 0, max: 3, step: 0.05 }, value: env.ambientIntensity ?? 1 },
            { key: 'kelvinTemperature', label: 'Colour temperature', control: { kind: 'slider', min: 1500, max: 12000, step: 100, unit: 'K' }, value: env.kelvinTemperature ?? 6500 }
        ];
    }
    if (node.parameters?.output) {
        if (scene.stagedBuild) {
            return [{ key: 'materialMode', label: 'Materials', control: { kind: 'select', options: ['clay', 'textured'] }, value: scene.stagedBuild.materialMode ?? 'clay' }];
        }
        return [{ key: 'renderMode', label: 'Render mode', control: { kind: 'select', options: RENDER_MODES }, value: scene.renderMode ?? 'pbr' }];
    }
    if (node.id.startsWith('mesh-')) {
        const mesh = (scene.customMeshes || []).find(m => m.id === node.id.slice('mesh-'.length));
        if (!mesh) return undefined;
        return [
            { key: 'position', label: 'Position', control: { kind: 'vec3', step: 0.05, unit: 'm' }, value: mesh.position ?? [0, 0, 0] },
            { key: 'rotation', label: 'Rotation', control: { kind: 'vec3', step: 1, unit: '°' }, value: (mesh.rotation ?? [0, 0, 0]).map(r => Math.round(r * RAD * 10) / 10) },
            { key: 'scale', label: 'Scale', control: { kind: 'vec3', step: 0.05 }, value: mesh.scale ?? [1, 1, 1] },
            { key: 'color', label: 'Colour', control: { kind: 'color' }, value: toColorString(mesh.material?.color) ?? '#cccccc' },
            { key: 'roughness', label: 'Roughness', control: { kind: 'slider', min: 0, max: 1, step: 0.01 }, value: mesh.material?.roughness ?? 0.5 },
            { key: 'metalness', label: 'Metalness', control: { kind: 'slider', min: 0, max: 1, step: 0.01 }, value: mesh.material?.metalness ?? 0 }
        ];
    }
    if (node.id.startsWith('obj-')) {
        const obj = objectOf(scene, node.id.slice('obj-'.length));
        if (!obj) return undefined;
        const s = obj.space?.spatial3d;
        return [
            { key: 'position', label: 'Position', control: { kind: 'vec3', step: 0.1, unit: 'm' }, value: [s?.x ?? 0, s?.y ?? 0, s?.z ?? 0] },
            { key: 'yaw', label: 'Heading', control: { kind: 'slider', min: -180, max: 180, step: 1, unit: '°' }, value: s?.yaw ?? 0 },
            { key: 'color', label: 'Colour override', control: { kind: 'color' }, value: toColorString(obj.material?.color) ?? '', hint: 'Sets an explicit material over the model\'s own (clear it to restore)' },
            { key: 'roughness', label: 'Roughness override', control: { kind: 'slider', min: 0, max: 1, step: 0.01 }, value: obj.material?.roughness ?? 0.5 }
        ];
    }
    return undefined;
}

/** The scene with one node field set; unknown nodes or fields leave it unchanged. */
export function applySceneNodeParam(scene: Scene3DData, node: GraphNode, key: string, value: unknown): Scene3DData {
    if (node.id === 'n-cam') {
        const cam = { position: [0, 2, 6] as [number, number, number], target: [0, 0, 0] as [number, number, number], ...(scene.camera || {}) };
        // a pose set here is meant: the scene opens on it rather than re-framing
        return { ...scene, camera: { ...cam, [key]: value, keepPoseOnLoad: true } as Scene3DData['camera'] };
    }
    if (node.id === 'n-env') {
        if (key === 'atmosphere') {
            const prev = scene.features?.atmosphericScattering;
            const next = typeof prev === 'object' && prev !== null ? { ...prev, enabled: !!value } : !!value;
            return { ...scene, features: { ...(scene.features || {}), atmosphericScattering: next } };
        }
        return { ...scene, environment: { ...(scene.environment || {}), [key]: value } };
    }
    if (node.parameters?.output) {
        if (key === 'materialMode' && scene.stagedBuild && (value === 'clay' || value === 'textured')) return withStagedMaterialMode(scene as any, value) as Scene3DData;
        if (key === 'renderMode') return { ...scene, renderMode: value as Scene3DData['renderMode'] };
        return scene;
    }
    if (node.id.startsWith('mesh-')) {
        const id = node.id.slice('mesh-'.length);
        return {
            ...scene,
            customMeshes: (scene.customMeshes || []).map(m => {
                if (m.id !== id) return m;
                if (key === 'rotation') return { ...m, rotation: (value as number[]).map(d => d / RAD) as [number, number, number] };
                if (key === 'color' || key === 'roughness' || key === 'metalness') return { ...m, material: { ...(m.material || {}), [key]: value } };
                return { ...m, [key]: value };
            })
        };
    }
    if (node.id.startsWith('obj-')) {
        const id = node.id.slice('obj-'.length);
        return {
            ...scene,
            objects: (scene.objects || []).map(o => {
                if (o.id !== id) return o;
                const s = o.space?.spatial3d || { x: 0, y: 0, z: 0 };
                if (key === 'position') { const [x, y, z] = value as number[]; return { ...o, space: { ...o.space, spatial3d: { ...s, x, y, z } } }; }
                if (key === 'yaw') return { ...o, space: { ...o.space, spatial3d: { ...s, yaw: value as number } } };
                if (key === 'color') {
                    if (!value) { const { color: _, ...rest } = o.material || {}; return { ...o, material: Object.keys(rest).length ? rest : undefined }; }
                    return { ...o, material: { ...(o.material || {}), color: value as string } };
                }
                if (key === 'roughness') return { ...o, material: { ...(o.material || {}), roughness: value as number } };
                return o;
            })
        };
    }
    return scene;
}
