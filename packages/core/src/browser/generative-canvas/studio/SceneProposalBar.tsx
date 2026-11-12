/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import type { SceneProposal } from '../services/scene-proposals';

export interface SceneProposalBarProps {
    proposal: SceneProposal;
    onAccept: () => void;
    onReject: () => void;
}

const BUTTON: React.CSSProperties = {
    height: 26,
    padding: '0 12px',
    borderRadius: 7,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    border: '1px solid var(--sb-surface-border)',
    background: 'transparent',
    color: 'var(--sb-foreground)',
    whiteSpace: 'nowrap'
};

const CHANGE_MARK: Record<string, { mark: string; color: string }> = {
    add: { mark: '+', color: '#4ade80' },
    remove: { mark: '−', color: '#f87171' },
    modify: { mark: '~', color: '#fbbf24' }
};

/**
 * The agent's edit to the open scene: what it changes, and Accept all / Reject all while it is held, or Keep / Undo all
 * once it is already on the scene.
 */
export const SceneProposalBar: React.FC<SceneProposalBarProps> = ({ proposal, onAccept, onReject }) => {
    const [open, setOpen] = React.useState(false);
    const count = proposal.hunks.length;
    const conflicts = proposal.hunks.filter(h => h.conflict).length;
    const held = proposal.status === 'pending';
    const summary = `${held ? 'Agent proposes' : 'Agent changed'} ${count} ${held ? `change${count === 1 ? '' : 's'}` : `thing${count === 1 ? '' : 's'}`}`;
    return (
        <div role="region" aria-label="Agent's proposed scene changes" data-testid="scene-proposal-bar" style={{
            borderBottom: '1px solid var(--sb-surface-border)',
            background: 'var(--sb-system-blue-subtle, rgba(37, 99, 235, 0.12))',
            padding: '6px 12px',
            fontSize: 12,
            color: 'var(--sb-foreground)'
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} style={{ ...BUTTON, border: 'none', padding: '0 4px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', flex: '1 1 auto', textAlign: 'left' }}>
                    {open ? '▾' : '▸'} {summary}: {proposal.label}
                    {conflicts > 0 && <span style={{ color: 'var(--sb-text-secondary)' }}> · {conflicts} you also changed (yours kept)</span>}
                </button>
                <button type="button" onClick={onReject} style={BUTTON}>{held ? 'Reject all' : 'Undo all'}</button>
                <button type="button" onClick={onAccept} style={{ ...BUTTON, background: 'var(--sb-system-blue, #2563eb)', borderColor: 'transparent', color: '#fff' }}>{held ? 'Accept all' : 'Keep'}</button>
            </div>
            {open && (
                <ul style={{ listStyle: 'none', margin: '6px 0 2px', padding: 0, maxHeight: 160, overflowY: 'auto' }}>
                    {proposal.hunks.map(h => (
                        <li key={h.id} style={{ display: 'flex', gap: 8, padding: '2px 4px', color: 'var(--sb-text-secondary)' }}>
                            <span style={{ width: 10, color: CHANGE_MARK[h.change].color, fontFamily: 'var(--sb-font-mono, monospace)' }}>{CHANGE_MARK[h.change].mark}</span>
                            <span>{h.label}{h.conflict ? ' (you changed this too: yours is kept)' : ''}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};
