/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { CanvasArtifact } from '../canvas-types';

export interface UseArtifactVersionHistoryReturn {
    artifactVersions: Record<string, CanvasArtifact[]>;
    recordArtifactVersion: (artifact: CanvasArtifact) => void;
    rollbackToVersion: (targetArtifact: CanvasArtifact) => CanvasArtifact | null;
    getArtifactVersions: (artifactId?: string) => CanvasArtifact[];
    getCurrentVersionIndex: (artifactId?: string, version?: number) => number;
}

export function useArtifactVersionHistory(
    initialVersions: Record<string, CanvasArtifact[]> = {}
): UseArtifactVersionHistoryReturn {
    const [artifactVersions, setArtifactVersions] = React.useState<Record<string, CanvasArtifact[]>>(initialVersions);

    const recordArtifactVersion = React.useCallback((artifact: CanvasArtifact) => {
        if (!artifact?.id) return;
        setArtifactVersions(prev => {
            const list = prev[artifact.id] || [];
            if (list.some(v => v.version === artifact.version)) {
                return prev;
            }
            return {
                ...prev,
                [artifact.id]: [...list, artifact]
            };
        });
    }, []);

    const rollbackToVersion = React.useCallback((targetArtifact: CanvasArtifact): CanvasArtifact | null => {
        if (!targetArtifact?.id) return null;
        return {
            ...targetArtifact,
            version: (targetArtifact.version || 1) + 1,
            createdAt: 'Restored from history'
        };
    }, []);

    const getArtifactVersions = React.useCallback((artifactId?: string): CanvasArtifact[] => {
        if (!artifactId || !artifactVersions[artifactId]) return [];
        return artifactVersions[artifactId];
    }, [artifactVersions]);

    const getCurrentVersionIndex = React.useCallback((artifactId?: string, version?: number): number => {
        if (!artifactId || !artifactVersions[artifactId]) return 0;
        const list = artifactVersions[artifactId];
        const idx = list.findIndex(v => v.version === version);
        return idx >= 0 ? idx : list.length - 1;
    }, [artifactVersions]);

    return {
        artifactVersions,
        recordArtifactVersion,
        rollbackToVersion,
        getArtifactVersions,
        getCurrentVersionIndex
    };
}
