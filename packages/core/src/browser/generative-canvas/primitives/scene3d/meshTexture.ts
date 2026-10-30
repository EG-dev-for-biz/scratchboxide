/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { PbrTextureSet, Scene3DData } from '../../canvas-types';
import { customMeshDefinitionId } from './syncCustomMeshes';
import { EXTERNAL_OBJECT_ROOT_PREFIX } from './selection';

/**
 * A texture a chat media card puts on the open 3D scene: a base-colour image, plus the other PBR maps when the card
 * has them. Each is any URL the viewport's texture loader reads (a data URI, an http(s) or app path, a texture-library path).
 */
export interface MeshTextureChannels {
    albedo: string;
    normal?: string;
    roughness?: string;
    metallic?: string;
    ao?: string;
    orm?: string;
}

export type MeshTextureChannel = keyof MeshTextureChannels;

/** What a texture request did, as the card reports it. */
export type MeshTextureOutcome =
    | { status: 'applied'; meshId: string; meshName: string; channels: MeshTextureChannel[]; note?: string }
    | { status: 'failed'; reason: string };

export type MeshTextureEdit =
    | { ok: true; scene: Scene3DData; meshId: string; meshName: string; channels: MeshTextureChannel[] }
    | { ok: false; reason: string };

const CHANNEL_ORDER: MeshTextureChannel[] = ['albedo', 'normal', 'roughness', 'metallic', 'ao', 'orm'];

const CHANNEL_WORDS: Record<MeshTextureChannel, string> = {
    albedo: 'base colour',
    normal: 'normal',
    roughness: 'roughness',
    metallic: 'metalness',
    ao: 'ambient occlusion',
    orm: 'occlusion-roughness-metalness'
};

/** The channels `channels` names, in a fixed order. */
export function meshTextureChannelsOf(channels: MeshTextureChannels): MeshTextureChannel[] {
    return CHANNEL_ORDER.filter(c => typeof channels[c] === 'string' && channels[c]!.length > 0);
}

/** How the viewport names a selection that is not a scene mesh: a loaded model by its name, else the id itself. */
function selectionLabel(scene: Scene3DData, id: string): string {
    const objectId = id.startsWith(EXTERNAL_OBJECT_ROOT_PREFIX) ? id.slice(EXTERNAL_OBJECT_ROOT_PREFIX.length) : id;
    const object = scene.objects?.find(o => o.id === objectId);
    const name = object?.content?.metadata?.name;
    return typeof name === 'string' && name ? name : id;
}

/**
 * Puts `channels` on the scene mesh named `targetId` (a customMeshes entry, matched the way the viewport names it): its
 * pbrTextures channel set is replaced (the tiling repeat kept), its base colour set to white so the image shows as it is, and
 * its roughness or metalness factor set to 1 where a map now carries that value (the factor multiplies the map), or dropped
 * where the map it multiplied is gone. Returns a
 * new scene and leaves `scene` as it was. Fails, changing nothing, when nothing is targeted, the base-colour image is
 * missing, or the target is not one of the scene's own meshes.
 */
export function applyMeshTexture(scene: Scene3DData, targetId: string | null | undefined, channels: MeshTextureChannels): MeshTextureEdit {
    if (!channels?.albedo) return { ok: false, reason: 'The card has no base-colour image to apply. Nothing was changed.' };
    if (!targetId) return { ok: false, reason: 'Nothing is selected in the 3D viewport. Select a mesh, then apply again.' };
    const meshes = scene.customMeshes ?? [];
    const index = meshes.findIndex((m, i) => customMeshDefinitionId(m, i) === targetId);
    if (index < 0) {
        return {
            ok: false,
            reason: `'${selectionLabel(scene, targetId)}' is not one of the scene's own meshes (it belongs to a loaded or generated model), and only scene meshes take an image texture here for now. Nothing was changed.`
        };
    }
    const mesh = meshes[index];
    const used = meshTextureChannelsOf(channels);
    const pbrTextures: PbrTextureSet = {
        ...(mesh.pbrTextures?.repeat ? { repeat: mesh.pbrTextures.repeat } : {}),
        albedoUrl: channels.albedo,
        ...(channels.normal ? { normalUrl: channels.normal } : {}),
        ...(channels.roughness ? { roughnessUrl: channels.roughness } : {}),
        ...(channels.metallic ? { metallicUrl: channels.metallic } : {}),
        ...(channels.ao ? { aoUrl: channels.ao } : {}),
        ...(channels.orm ? { ormUrl: channels.orm } : {})
    };
    const prev = mesh.pbrTextures;
    const material: NonNullable<typeof mesh.material> = { ...mesh.material, color: '#ffffff' };
    // a factor set to multiply a map the new set drops goes with that map, and the viewport's default stands in
    if (channels.roughness || channels.orm) material.roughness = 1;
    else if (prev?.roughnessUrl || prev?.roughnessMap || prev?.ormUrl || prev?.ormMap) delete material.roughness;
    if (channels.metallic || channels.orm) material.metalness = 1;
    else if (prev?.metallicUrl || prev?.metalnessMap || prev?.ormUrl || prev?.ormMap) delete material.metalness;
    const nextMeshes = meshes.slice();
    nextMeshes[index] = { ...mesh, material, pbrTextures };
    const meshId = customMeshDefinitionId(mesh, index);
    return { ok: true, scene: { ...scene, customMeshes: nextMeshes }, meshId, meshName: mesh.name || meshId, channels: used };
}

/** Why a texture was not applied when one of its images would not load (a data URI is not quoted). */
export function textureLoadFailureReason(channel: MeshTextureChannel, url: string): string {
    const source = url.startsWith('data:') ? 'an inline image' : url.length > 80 ? `${url.slice(0, 77)}...` : url;
    return `The ${CHANNEL_WORDS[channel]} image (${source}) could not be loaded. Nothing was changed.`;
}

/** The card's line for an outcome. */
export function describeMeshTextureOutcome(outcome: MeshTextureOutcome): string {
    if (outcome.status === 'failed') return outcome.reason;
    const words = outcome.channels.map(c => CHANNEL_WORDS[c]);
    const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0];
    const maps = `${list} map${words.length > 1 ? 's' : ''}`;
    return `Applied to '${outcome.meshName}': ${maps}.${outcome.note ? ` ${outcome.note}` : ''}`;
}

/** Window event a media card sends; every open 3D viewport hears it (Scene3DPrimitive). */
export const APPLY_MESH_TEXTURE_EVENT = 'scratchbox:apply-3d-texture';

/**
 * The detail of APPLY_MESH_TEXTURE_EVENT. The first viewport able to apply it claims it with the outcome of doing so; a viewport
 * that cannot declines with its reason.
 */
export interface MeshTextureRequest {
    channels: MeshTextureChannels;
    /** The mesh to texture; the viewport's selection when absent. */
    targetId?: string;
    /** True once a viewport has claimed the request, so a second open viewport leaves it. */
    readonly claimed: boolean;
    claim(outcome: Promise<MeshTextureOutcome>): void;
    /** `targeted`: the viewport had a mesh to try (its reason says more than "nothing selected"). */
    decline(reason: string, targeted: boolean): void;
}

export const NO_VIEWPORT_REASON = 'No 3D scene is open. Open the scene, select a mesh in its viewport, then apply again.';

/**
 * Asks the open 3D viewports to put `channels` on their selected mesh (or `targetId`) and resolves with what happened: the
 * claiming viewport's outcome, else a declining viewport's reason (one that had a mesh to try first), else that no 3D scene is open.
 */
export async function requestMeshTexture(channels: MeshTextureChannels, targetId?: string, target: EventTarget = window): Promise<MeshTextureOutcome> {
    let claimed: Promise<MeshTextureOutcome> | undefined;
    const declined: Array<{ reason: string; targeted: boolean }> = [];
    const request: MeshTextureRequest = {
        channels,
        ...(targetId ? { targetId } : {}),
        get claimed() { return claimed !== undefined; },
        claim(outcome) { if (!claimed) claimed = outcome; },
        decline(reason, targeted) { declined.push({ reason, targeted }); }
    };
    target.dispatchEvent(new CustomEvent(APPLY_MESH_TEXTURE_EVENT, { detail: request }));
    if (claimed) {
        try {
            return await claimed;
        } catch (err) {
            return { status: 'failed', reason: `The texture was not applied: ${err instanceof Error ? err.message : String(err)}` };
        }
    }
    const best = declined.find(d => d.targeted) ?? declined[0];
    return { status: 'failed', reason: best ? best.reason : NO_VIEWPORT_REASON };
}
