/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import type { ViewportHistorySnapshot } from '../../services/viewport-history';

const BTN = 'sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all';
const ENABLED = 'text-zinc-300 hover:text-white hover:bg-white/10 border border-transparent';
const DISABLED = 'text-zinc-600 cursor-not-allowed border border-transparent opacity-40';

/** Undo / redo buttons and the history position for the viewport tool strip. */
export const ViewportHistoryButtons: React.FC<{
    snapshot: ViewportHistorySnapshot;
    onUndo: () => void;
    onRedo: () => void;
}> = ({ snapshot, onUndo, onRedo }) => (
    <>
        <button
            type="button"
            disabled={!snapshot.canUndo}
            aria-label="Undo"
            data-testid="sb-3d-undo"
            className={`${BTN} ${snapshot.canUndo ? ENABLED : DISABLED}`}
            onClick={onUndo}
            title={snapshot.canUndo ? `Undo: ${snapshot.undoLabel} (⌘Z / Ctrl+Z)` : 'Nothing to undo'}
        >
            <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7v6h6M3 13a9 9 0 1 1 3 7.7" />
            </svg>
        </button>
        <button
            type="button"
            disabled={!snapshot.canRedo}
            aria-label="Redo"
            data-testid="sb-3d-redo"
            className={`${BTN} ${snapshot.canRedo ? ENABLED : DISABLED}`}
            onClick={onRedo}
            title={snapshot.canRedo ? `Redo: ${snapshot.redoLabel} (⌘⇧Z / Ctrl+Y)` : 'Nothing to redo'}
        >
            <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 7v6h-6M21 13a9 9 0 1 0-3 7.7" />
            </svg>
        </button>
        <span
            data-testid="sb-3d-history-count"
            className="sb-3d-history-count text-[8px] leading-none text-zinc-500 tabular-nums select-none"
            title={snapshot.undoLabel ? `Undo: ${snapshot.undoLabel}` : 'No edits yet'}
        >
            {snapshot.undoCount}{snapshot.redoCount > 0 ? `/${snapshot.undoCount + snapshot.redoCount}` : ''}
        </span>
    </>
);
