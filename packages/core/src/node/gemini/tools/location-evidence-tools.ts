/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Location evidence: tools that report what independent sources say about a real place, each source's value kept
 * beside the others. Implementations live in ./location-evidence/.
 */

import type { ToolDeclaration, ToolHandler } from './types';
import { BUILDING_SHAPE_TOOL_DECLARATION, buildingShapeHandler } from './location-evidence/building-shape';
import { STREETVIEW_SURVEY_DECLARATION, streetviewSurveyHandler } from './location-evidence/streetview-survey';

export const LOCATION_EVIDENCE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    BUILDING_SHAPE_TOOL_DECLARATION,
    STREETVIEW_SURVEY_DECLARATION
];

export const locationEvidenceHandlers: Record<string, ToolHandler> = {
    [BUILDING_SHAPE_TOOL_DECLARATION.name]: buildingShapeHandler,
    [STREETVIEW_SURVEY_DECLARATION.name]: streetviewSurveyHandler
};
