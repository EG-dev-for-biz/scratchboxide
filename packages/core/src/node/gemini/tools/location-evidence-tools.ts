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
import { ISOLATE_STRUCTURE_TOOL_DECLARATION, isolateStructureHandler } from './location-evidence/isolate-structure';
import { PHOTO_MATCH_EVALUATE_DECLARATION, runPhotoMatchEvaluate } from './location-evidence/photo-match-evaluate';
import { STREETVIEW_SURVEY_DECLARATION, streetviewSurveyHandler } from './location-evidence/streetview-survey';
import { SPLIT_BLOCK_TOOL_DECLARATION, splitBlockHandler } from './location-evidence/split-block';
import { RESIDUAL_AUDIT_TOOL_DECLARATION, residualAuditHandler } from './location-evidence/residual-audit';
import { FIT_OBJECT_TOOL_DECLARATION, fitObjectHandler } from './location-evidence/fit-object';
import { GRASS_MAP_TOOL_DECLARATION, grassMapHandler } from './location-evidence/grass-map';
import { STREET_OBJECTS_TOOL_DECLARATION, streetObjectsHandler } from './location-evidence/street-objects';
import { BUILDING_LINE_DRAWING_TOOL_DECLARATION, buildingLineDrawingHandler } from './location-evidence/building-line-drawing';

export const LOCATION_EVIDENCE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    BUILDING_SHAPE_TOOL_DECLARATION,
    PHOTO_MATCH_EVALUATE_DECLARATION,
    STREETVIEW_SURVEY_DECLARATION,
    ISOLATE_STRUCTURE_TOOL_DECLARATION,
    SPLIT_BLOCK_TOOL_DECLARATION,
    RESIDUAL_AUDIT_TOOL_DECLARATION,
    FIT_OBJECT_TOOL_DECLARATION,
    GRASS_MAP_TOOL_DECLARATION,
    STREET_OBJECTS_TOOL_DECLARATION,
    BUILDING_LINE_DRAWING_TOOL_DECLARATION
];

export const locationEvidenceHandlers: Record<string, ToolHandler> = {
    [BUILDING_SHAPE_TOOL_DECLARATION.name]: buildingShapeHandler,
    [PHOTO_MATCH_EVALUATE_DECLARATION.name]: runPhotoMatchEvaluate,
    [STREETVIEW_SURVEY_DECLARATION.name]: streetviewSurveyHandler,
    [ISOLATE_STRUCTURE_TOOL_DECLARATION.name]: isolateStructureHandler,
    [SPLIT_BLOCK_TOOL_DECLARATION.name]: splitBlockHandler,
    [RESIDUAL_AUDIT_TOOL_DECLARATION.name]: residualAuditHandler,
    [FIT_OBJECT_TOOL_DECLARATION.name]: fitObjectHandler,
    [GRASS_MAP_TOOL_DECLARATION.name]: grassMapHandler,
    [STREET_OBJECTS_TOOL_DECLARATION.name]: streetObjectsHandler,
    [BUILDING_LINE_DRAWING_TOOL_DECLARATION.name]: buildingLineDrawingHandler
};
