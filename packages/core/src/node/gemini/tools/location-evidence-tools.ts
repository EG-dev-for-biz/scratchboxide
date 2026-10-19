/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Location evidence: the staged build's measurements of a real place (its Street View survey, its structure, how a
 * render matches a photo), each exposed as a tool. The implementations live in ./location-evidence/.
 */

import type { ToolDeclaration, ToolHandler } from './types';
import { STREETVIEW_SURVEY_DECLARATION, STREETVIEW_SURVEY_TOOL_NAME, streetviewSurveyHandler } from './location-evidence/streetview-survey';

export const LOCATION_EVIDENCE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    STREETVIEW_SURVEY_DECLARATION
];

export const locationEvidenceHandlers: Record<string, ToolHandler> = {
    [STREETVIEW_SURVEY_TOOL_NAME]: streetviewSurveyHandler
};
