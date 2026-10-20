/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { MORPH_TARGETS } from '../../primitive-transformer-engine';
import { PrimitiveType } from '../../canvas-types';

export const PRIMITIVE_TYPE_LABELS: Partial<Record<PrimitiveType, string>> = {
    '3d-scene': '3D Scene',
    'node-graph': 'Node Graph',
    'markdown-document': 'Document',
    'kanban-board': 'Kanban Board',
    'metric-dashboard': 'Metric Dashboard',
    'live-code-sandbox': 'Code Sandbox',
    'interactive-browser': 'Browser',
    'video-timeline': 'Video Timeline'
};

export interface ViewAsMenuProps {
    /** The primitive type currently on stage — its real target list comes from `MORPH_TARGETS[currentType]`. */
    currentType: PrimitiveType;
    onSelect: (targetType: PrimitiveType) => void;
    /** Override the target list (rare — defaults to the real, implemented set from `MORPH_TARGETS`). */
    targets?: PrimitiveType[];
    /** Extra classes for the trigger button, so each host primitive can match its own toolbar chrome. */
    triggerClassName?: string;
}

/**
 * A "View As" dropdown that projects the artifact already on stage into a
 * different canvas primitive via `morphArtifact` — never offers a target
 * `morphArtifact` doesn't actually implement for `currentType` (that list
 * lives in `MORPH_TARGETS`, the single source of truth, not hand-duplicated
 * here), so there is no dead option that silently no-ops when clicked.
 */
export const ViewAsMenu: React.FC<ViewAsMenuProps> = ({ currentType, onSelect, targets, triggerClassName }) => {
    const [open, setOpen] = React.useState(false);
    const resolvedTargets = targets ?? MORPH_TARGETS[currentType] ?? [];
    if (resolvedTargets.length === 0) {
        return null;
    }

    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className={triggerClassName ?? 'sb-3d-minimal-badge flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#121216]/80 hover:bg-[#1f1f28] backdrop-blur-md border border-white/10 text-[10px] font-mono text-zinc-300 hover:text-white transition-all shadow-md cursor-pointer'}
                title="View this artifact's real structured data as a different canvas primitive"
            >
                <span>View As</span>
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                </svg>
            </button>
            {open && (
                <div className="absolute right-0 top-full mt-1 min-w-[160px] rounded-md bg-[#121216]/95 backdrop-blur-md border border-white/10 shadow-lg z-30 py-1 text-[10px] font-mono text-zinc-300">
                    {resolvedTargets.map(targetType => (
                        <button
                            key={targetType}
                            type="button"
                            onClick={() => {
                                setOpen(false);
                                onSelect(targetType);
                            }}
                            className="w-full text-left px-3 py-1.5 hover:bg-white/10 hover:text-white transition-colors"
                        >
                            {PRIMITIVE_TYPE_LABELS[targetType] ?? targetType}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};
