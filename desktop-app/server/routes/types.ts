/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Response } from 'express';
import { PathTraversalError } from '../../../packages/core/src/node/security/path-guard';

export function isPathError(err: unknown): err is PathTraversalError {
    return err instanceof PathTraversalError || (err as any)?.code === 'path_traversal';
}

export interface RouteContext {
    allowedWorkspaceRoots: string[];
    requireWorkspaceRoot: (candidate: unknown) => string;
    sendError: (res: Response, err: any, fallbackStatus?: number) => void;
    isPathError: (err: unknown) => boolean;
}
