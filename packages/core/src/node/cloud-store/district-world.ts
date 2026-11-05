/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A finished district build kept as a world (scripts/publish_district_world.ts): its scene with the models it names moved
 * under the world's folder, so `/api/worlds/<slug>/scene` and a starter button open it like a splat world.
 */

/**
 * The scene with every `/models/<file>` it names moved under the world's folder, and the files it names. It opens textured
 * when its layers have textured twins (AGENTS.md: textured by default, clay on request; a build saved mid-way or replayed
 * in clay keeps its twins), under `title` when one is given.
 */
export function districtWorldScene(artifact: { data?: Record<string, unknown> }, slug: string, opts: { title?: string } = {}): { scene: Record<string, unknown>; models: string[] } {
    if (!artifact.data || typeof artifact.data !== 'object') throw new Error('the artifact has no scene data');
    const models = new Set<string>();
    const text = JSON.stringify(artifact.data).replace(/"\/models\/([^"\\]+)"/g, (_m, file: string) => {
        models.add(file);
        return JSON.stringify(`/tilesets/${slug}/models/${file}`);
    });
    const scene = JSON.parse(text) as Record<string, any>;
    const textured = Array.isArray(scene.stagedBuild?.layers) && scene.stagedBuild.layers.some((l: { textured?: unknown }) => !!l.textured);
    return { scene: { ...scene, ...(textured ? { renderMode: 'pbr' } : {}), ...(opts.title ? { title: opts.title } : {}), world: { slug } }, models: [...models].sort() };
}

