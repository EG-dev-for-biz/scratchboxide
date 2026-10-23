/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Tools that cannot change the workspace, the canvas, or anything outside the app. Plan and Ask
 * modes are offered only these, and any other call is refused at execution time, so "read-only"
 * is enforced rather than requested in the prompt.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
    'workspace_read_file',
    'workspace_view_file',
    'workspace_view_image',
    'workspace_list_directory',
    'workspace_search',
    'workspace_grep_search',
    'workspace_find_by_name',
    'workspace_find_symbols',
    'workspace_semantic_search',
    'workspace_get_diagnostics',
    'lens_list_bindings',
    'browser_navigate',
    'browser_snapshot',
    'browser_extract_content',
    'audit_3d_scene_viewport',
    'invoke_subagent',
    'load_skill',
    'ask_user_question',
    'present_execution_plan',
    'update_task_list'
]);

/** Tools that only make sense for the agent talking to the user, never for a subagent. */
export const PARENT_ONLY_TOOLS: ReadonlySet<string> = new Set([
    'invoke_subagent',
    'ask_user_question',
    'present_execution_plan',
    'update_task_list'
]);

export function isReadOnlyMode(mode: string | undefined): boolean {
    return mode === 'plan' || mode === 'ask';
}

/** Why a tool call is refused in this mode, or undefined when it may run. */
export function toolBlockedReason(mode: string | undefined, toolName: string): string | undefined {
    if (!isReadOnlyMode(mode) || READ_ONLY_TOOLS.has(toolName)) return undefined;
    return `${toolName} can change the workspace, so it is not available in ${mode === 'plan' ? 'Plan' : 'Ask'} mode. Use read-only tools, then present your plan or answer; the user can switch to Agent mode to carry it out.`;
}
