/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import type { GeminiToolConfig, ToolDeclaration, ToolHandler } from './tools/types';

/**
 * How the chat offers its tools (measured 2026-10-20, docs/processes/fast_chat_routing.md). Offering all ~160
 * declarations (287 KB, ~72k tokens) on every call made the model spend 6-9 s reading them before its first token.
 *
 * In `catalog` mode (the default) every call carries a small entry set, the tools most requests start with, and
 * `load_tools`, whose description lists every other tool by name with one line on what it does. The model loads the
 * tools a task needs by name, deciding by meaning (no words in the request select tools: AGENTS.md ADA 1.2), and the
 * loaded declarations are appended after the entry set for the rest of the request and are sent back to the client to
 * be offered again on the conversation's next request. `all` (SCRATCHBOX_CHAT_TOOLS=all) offers every tool, as
 * before; it is the off switch.
 */
export type ToolOfferMode = 'catalog' | 'all';

export function toolOfferMode(): ToolOfferMode {
    return process.env.SCRATCHBOX_CHAT_TOOLS === 'all' ? 'all' : 'catalog';
}

export const LOAD_TOOLS_NAME = 'load_tools';

/**
 * The entry set: what requests most often start with (a place, an object, a change to the open scene or its light,
 * an app, a document or board, a video timeline, a cut-out or quick edit of footage, an image, a question or plan for
 * the user, workspace basics). Chosen from the chat routing eval's reference choices (2026-10-20), not by the words
 * of any request.
 */
export const ENTRY_TOOL_NAMES: readonly string[] = [
    'google_3d_tiles_get_clay',
    'google_3d_tiles_get_full_texture',
    'build_3d_object_from_reference',
    'scene_3d_dispatch_operators',
    'staged_location_material_mode',
    'atmosphere_configure_scene',
    'mount_canvas_primitive',
    'vfx_segment_subject',
    'vfx_ffmpeg_quick_edit',
    'generate_image',
    'ask_user_question',
    'present_execution_plan',
    'update_task_list',
    'load_skill',
    'workspace_read_file',
    'workspace_write_file',
    'workspace_apply_diff',
    'workspace_list_directory',
    'workspace_grep_search',
    'workspace_find_by_name',
    'workspace_run_command',
    LOAD_TOOLS_NAME
];

/** The first sentence of a description, at most `max` characters: the catalog line for a tool. */
export function catalogLine(description: string | undefined, max = 150): string {
    const flat = (description || '').replace(/\s+/g, ' ').trim();
    const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
    return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The load_tools declaration for a catalog: every tool that is not offered yet, by name, with its catalog line.
 * Built from the registry, so it always lists the tools that exist, in registration order (stable across turns).
 */
export function loadToolsDeclaration(catalog: ReadonlyArray<Pick<ToolDeclaration, 'name' | 'description'>>): ToolDeclaration {
    const lines = catalog.map(d => `- ${d.name}: ${catalogLine(d.description)}`).join('\n');
    return {
        name: LOAD_TOOLS_NAME,
        description: `Load more tools for this task. Only the tools declared so far can be called; every other tool is listed below with what it does. Load the ones the task needs by name (several at once is fine), then call them; they stay available for the rest of the conversation. Do not load tools the task does not need.\n${lines}`,
        parameters: {
            type: 'OBJECT',
            properties: {
                tools: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Names of the tools to load, exactly as listed.' }
            },
            required: ['tools']
        }
    };
}

/** What load_tools returns to the model and to the streaming loop (which appends the declarations). */
export interface LoadToolsResult {
    loaded: string[];
    unknown: string[];
}

/** The load_tools handler for a registry: checks the names; the streaming loop adds the declarations. */
export function createLoadToolsHandler(has: (name: string) => boolean): ToolHandler {
    return args => {
        const requested = Array.isArray(args.tools) ? args.tools.filter((t): t is string => typeof t === 'string') : [];
        const loaded = [...new Set(requested.filter(name => name !== LOAD_TOOLS_NAME && has(name)))];
        const unknown = [...new Set(requested.filter(name => !has(name)))];
        if (loaded.length === 0) {
            return {
                status: 'failed',
                summaryResult: `No tools loaded${unknown.length ? `: unknown ${unknown.join(', ')}` : ''}`,
                resultPayload: { success: false, error: `No such tools: ${unknown.join(', ') || '(none given)'}. Use the names listed in load_tools.`, loaded, unknown }
            };
        }
        return {
            status: 'completed',
            summaryResult: `Loaded ${loaded.join(', ')}`,
            resultPayload: {
                success: true,
                loaded,
                unknown,
                note: `These tools are now declared and can be called${unknown.length ? `; not found: ${unknown.join(', ')}` : ''}.`
            }
        };
    };
}

/**
 * The tools a request can use: those declared, and those listed in its load_tools catalog (loadable by name).
 */
export function availableToolNames(tools: GeminiToolConfig[] | undefined): { declared: string[]; loadable: string[]; all: string[] } {
    const declarations = (tools || []).flatMap(t => ('functionDeclarations' in t && Array.isArray(t.functionDeclarations) ? t.functionDeclarations : []));
    const declared = declarations.map(d => d.name);
    const load = declarations.find(d => d.name === LOAD_TOOLS_NAME);
    const loadable = load ? [...(load.description || '').matchAll(/^- ([a-z0-9_]+): /gm)].map(m => m[1]) : [];
    return { declared, loadable, all: [...declared.filter(n => n !== LOAD_TOOLS_NAME), ...loadable] };
}
