/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Location evidence tools: the staged-location build's own steps exposed one at a time (each implementation lives in
 * ./location-evidence/). One import, one declaration and one handler entry per tool.
 */

import type { ToolDeclaration, ToolHandler } from './types';
import { ISOLATE_STRUCTURE_TOOL_DECLARATION, isolateStructureHandler } from './location-evidence/isolate-structure';

export const LOCATION_EVIDENCE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    ISOLATE_STRUCTURE_TOOL_DECLARATION
];

export const locationEvidenceHandlers: Record<string, ToolHandler> = {
    location_isolate_structure: isolateStructureHandler
};
