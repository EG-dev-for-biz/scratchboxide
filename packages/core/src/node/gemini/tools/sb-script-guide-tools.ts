/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * read_sb_script_guide: the rules and API patterns for writing an sb Python script for execute_3d_python_script.
 * The guide is long, so it is read on demand when the agent is about to write a script instead of riding along in
 * every system instruction (prompt-builder includes it up front only while a script-built scene is active).
 */

import type { ToolDeclaration, ToolHandler } from './types';
import { SB_PYTHON_SCRIPT_GUIDE } from '../prompt-builder';

export const SB_SCRIPT_GUIDE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'read_sb_script_guide',
        description: 'Returns the rules and API patterns for writing an sb Python script (import scratchbox as sb) for execute_3d_python_script. Read it once in a conversation before writing or rewriting such a script, unless the rules ("WRITING SB PYTHON SCRIPTS") are already in your instructions.',
        parameters: { type: 'OBJECT', properties: {} }
    }
];

export const sbScriptGuideHandlers: Record<string, ToolHandler> = {
    read_sb_script_guide: () => ({
        resultPayload: { guide: SB_PYTHON_SCRIPT_GUIDE.trim() },
        summaryResult: 'Read the sb Python script guide.'
    })
};
