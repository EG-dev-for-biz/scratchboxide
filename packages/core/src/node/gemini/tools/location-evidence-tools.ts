/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Location evidence tools: checks of a location build against the real place (Street View, footprints, the scan).
 * Each tool lives in its own file under location-evidence/; this pack only lists them, one line per tool.
 */

import type { ToolDeclaration, ToolHandler } from './types';
import { PHOTO_MATCH_EVALUATE_DECLARATION, PHOTO_MATCH_EVALUATE_TOOL, runPhotoMatchEvaluate } from './location-evidence/photo-match-evaluate';

export const LOCATION_EVIDENCE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    PHOTO_MATCH_EVALUATE_DECLARATION,
];

export const locationEvidenceHandlers: Record<string, ToolHandler> = {
    [PHOTO_MATCH_EVALUATE_TOOL]: runPhotoMatchEvaluate,
};
