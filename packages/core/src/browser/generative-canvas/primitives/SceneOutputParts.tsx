/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A scene graph's Output node and display flag, on the node cards: the Output says what the viewport shows (the final
 * scene, or the flagged node's result) and opens it; a node that made something the viewport can show alone carries
 * the flag toggle.
 */

import * as React from 'react';
import type { SceneDisplayFlag } from '../canvas-types';

const row: React.CSSProperties = { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center', margin: '6px 0', fontSize: '11px' };
const btn: React.CSSProperties = { fontSize: '10px', padding: '1px 8px' };

export interface SceneOutputBodyProps {
    flag?: SceneDisplayFlag;
    /** The final scene's contents, one per line (layers, meshes). */
    finalSummary?: string;
    onShowFinal: () => void;
    onOpenViewport?: () => void;
}

export const SceneOutputBody: React.FC<SceneOutputBodyProps> = ({ flag, finalSummary, onShowFinal, onOpenViewport }) => (
    <div className="sb-node-custom-body sb-body-scene-output" style={{ margin: '8px 0', padding: '6px 8px', borderRadius: '8px', border: '1px dashed rgba(255,255,255,0.15)', background: 'rgba(0,0,0,0.2)', fontSize: '11px' }} onMouseDown={e => e.stopPropagation()}>
        {flag ? (
            <span style={{ color: 'var(--sb-system-blue, #0a84ff)' }}>Viewport shows only: {flag.label} (display flag)</span>
        ) : (
            <span style={{ color: 'var(--sb-text-secondary)' }}>Viewport shows the final scene</span>
        )}
        {!flag && finalSummary && <div style={{ color: 'var(--sb-text-tertiary)', fontSize: '10px', marginTop: '3px', maxHeight: '48px', overflow: 'hidden', whiteSpace: 'pre-line' }}>{finalSummary}</div>}
        <div style={row}>
            {flag && <button type="button" className="sb-btn" style={btn} onClick={onShowFinal} title="Clear the display flag: the viewport shows the final scene">Show final</button>}
            {onOpenViewport && <button type="button" className="sb-btn" style={btn} onClick={onOpenViewport} title="Open the scene in the viewport">Open viewport</button>}
        </div>
    </div>
);

export const DisplayFlagToggle: React.FC<{ on: boolean; onToggle: () => void }> = ({ on, onToggle }) => (
    <button
        type="button"
        className="sb-btn"
        style={{ ...btn, margin: '4px 0', ...(on ? { background: 'rgba(10,132,255,0.25)', borderColor: 'rgba(10,132,255,0.6)' } : {}) }}
        aria-pressed={on}
        onMouseDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onToggle(); }}
        title={on ? 'The viewport shows only this node\'s result. Click to show the final scene.' : 'Show only this node\'s result in the viewport (display flag)'}
    >
        {on ? '◉ Displayed' : '○ Display'}
    </button>
);
