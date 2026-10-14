/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import type { ChatMessage } from '../canvas-types';
import { isVisualAuditUnavailable, type VisualVerificationOutcome } from '../../../common/visual-verification-protocol';

export interface VisualCheckDescription {
    tone: 'pass' | 'fail' | 'unavailable';
    text: string;
}

/** The background vision check as one line: its score and critique, or why it could not run. */
export function describeVisualCheck(outcome: VisualVerificationOutcome): VisualCheckDescription {
    if (isVisualAuditUnavailable(outcome)) {
        return { tone: 'unavailable', text: `Visual check unavailable: ${outcome.error}` };
    }
    const by = outcome.modelUsed ? ` (${outcome.modelUsed})` : '';
    const critique = outcome.critique?.trim() ? ` — ${outcome.critique.trim()}` : '';
    return { tone: outcome.pass ? 'pass' : 'fail', text: `Visual check${by}: ${outcome.fidelityScore}/100${critique}` };
}

const LINE_STYLE: React.CSSProperties = { fontSize: 11, lineHeight: 1.45, borderRadius: 8, padding: '5px 9px', wordBreak: 'break-word' };
const TONE_STYLE: Record<VisualCheckDescription['tone'], React.CSSProperties> = {
    pass: { ...LINE_STYLE, background: 'rgba(16, 185, 129, 0.10)', border: '1px solid rgba(16, 185, 129, 0.30)', color: '#6ee7b7' },
    fail: { ...LINE_STYLE, background: 'rgba(245, 158, 11, 0.10)', border: '1px solid rgba(245, 158, 11, 0.30)', color: '#fcd34d' },
    unavailable: { ...LINE_STYLE, background: 'rgba(113, 113, 122, 0.14)', border: '1px solid rgba(161, 161, 170, 0.30)', color: '#d4d4d8' }
};

/** Footnote of an assistant message: the background visual check of the canvas, or why it was unavailable. */
export const MessageNotices: React.FC<{ message: ChatMessage }> = ({ message }) => {
    const visual = message.visualAudit ? describeVisualCheck(message.visualAudit) : undefined;
    if (!visual) return null;
    return (
        <div className="sb-msg-notices" data-testid="sb-msg-notices" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
            <div data-testid="sb-visual-check" data-tone={visual.tone} style={TONE_STYLE[visual.tone]}>{visual.text}</div>
        </div>
    );
};
