/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The node library's sections in a 3D graph: tools grouped by the task they serve (as 3D tools group their nodes),
 * from the declaration list each tool comes from. Labels for browsing only: nothing runs or is chosen by them. A list
 * this table does not know lands in "Other tools" (tool-nodes.test.ts names it, so a new list gets a home).
 */

export const TOOL_TASK_GROUPS: ReadonlyArray<{ title: string; packs: readonly string[] }> = [
    { title: 'Locations & tiles', packs: ['Google 3D Tiles', 'Tile Refine', 'Utdra', 'Location Evidence', 'Location Reference', 'SB Roadie', 'Webxr Geospatial', 'Geobox Precision'] },
    { title: 'Build geometry', packs: ['Universal 3D Structure', 'Python 3D', 'Object Reference', 'Local SF3D', 'Turnaround', 'Botanical Tree', 'Mesh Shaping', 'Virtual Geometry', 'SB Script Guide', 'Bvh Query'] },
    { title: 'Materials & textures', packs: ['Surface Materials', 'Pbr Material', 'Image to Pbr', 'Algorithmic UV', 'Nano Banana'] },
    { title: 'Light, sky & camera', packs: ['Lighting', 'Atmosphere', 'Physical Camera', 'Optics Lens Distortion'] },
    { title: 'Characters & motion', packs: ['SB Rig', 'Avatar 4DGS', 'Humanoid Avatar', 'Analytical Groom', 'Pose Depth', 'Tapir 4DGS'] },
    { title: 'Splats & panoramas', packs: ['Panorama'] },
    { title: 'Image & video', packs: ['Image Generation', 'Vfx Video', 'Adaptive Matchmove', 'AI Beautify'] },
    { title: 'Workspace & code', packs: ['Workspace', 'Lens', 'Browser', 'Canvas'] }
];

export const OTHER_TOOLS = 'Other tools';

export function taskGroupOf(pack: string): string {
    return TOOL_TASK_GROUPS.find(g => g.packs.includes(pack))?.title ?? OTHER_TOOLS;
}
