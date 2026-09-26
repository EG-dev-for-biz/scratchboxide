/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
