/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The canvas tool-node catalog: every registered tool, titled by the declaration list it is declared in, so the node
 * library groups tools the way the code does instead of by a category list of its own.
 */

import type { ToolNodeCatalogEntry } from '../../common/tool-node-protocol';
import { STANDALONE_PACKS } from '../mcp/standalone-packs';
import { CANVAS_TOOL_DECLARATIONS, LENS_TOOL_DECLARATIONS, BROWSER_TOOL_DECLARATIONS, type ToolDeclaration } from './tools';
import type { ToolRegistry } from './tool-registry';

const JOINING_WORDS = new Set(['TO', 'OF', 'IN', 'ON', 'AT', 'BY', 'AND', 'OR']);

/** "GOOGLE_3D_TILES_TOOL_DECLARATIONS" -> "Google 3D Tiles"; short words stay capitals (SB, UV), joining words go lower. */
export function packTitle(listName: string): string {
    return listName.replace(/_TOOL_DECLARATIONS$/, '').split('_').filter(Boolean)
        .map((w, i) => i > 0 && JOINING_WORDS.has(w) ? w.toLowerCase() : /\d/.test(w) || w.length <= 2 ? w.toUpperCase() : w[0] + w.slice(1).toLowerCase()).join(' ');
}

const SOURCE_LISTS: ReadonlyArray<{ name: string; declarations: ReadonlyArray<ToolDeclaration> }> = [
    { name: 'CANVAS_TOOL_DECLARATIONS', declarations: CANVAS_TOOL_DECLARATIONS },
    { name: 'LENS_TOOL_DECLARATIONS', declarations: LENS_TOOL_DECLARATIONS },
    { name: 'BROWSER_TOOL_DECLARATIONS', declarations: BROWSER_TOOL_DECLARATIONS },
    ...STANDALONE_PACKS
];

/** Every tool the registry can dispatch, in registration order; a tool in no known list is titled "Other tools". */
export function buildToolNodeCatalog(registry: ToolRegistry): ToolNodeCatalogEntry[] {
    const packOf = new Map<string, string>();
    for (const list of SOURCE_LISTS) for (const d of list.declarations) if (!packOf.has(d.name)) packOf.set(d.name, packTitle(list.name));
    return registry.names().map(name => {
        const reg = registry.get(name)!;
        return {
            name,
            description: reg.declaration.description,
            parameters: reg.declaration.parameters,
            pack: packOf.get(name) ?? 'Other tools',
            offeredByDefault: reg.offeredByDefault
        };
    });
}
