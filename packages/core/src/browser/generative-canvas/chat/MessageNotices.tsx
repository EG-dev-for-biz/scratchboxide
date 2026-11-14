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
import type { ModelAnswerProvenance } from '../../../common/gemini-protocol';
import { isVisualAuditUnavailable, type VisualVerificationOutcome } from '../../../common/visual-verification-protocol';

export interface ProvenanceDescription {
    /** Always shown: which model and credential answered. */
    label: string;
    /** Shown prominently when the answer did not come from the requested model or the preferred credential. */
    notice?: string;
}

const CREDENTIAL_LABEL: Record<ModelAnswerProvenance['credential'], string> = {
    vertex: 'Vertex AI',
    'api-key': 'Gemini API key',
    'anthropic-api-key': 'Anthropic API key',
    'openai-api-key': 'OpenAI API key'
};

/** "Answered by X — Y unavailable: <reason>" when the fallback list moved on; the model and credential always. */
export function describeModelProvenance(p: ModelAnswerProvenance): ProvenanceDescription {
    const notices: string[] = [];
    if (p.noModelAnswered) {
        // The reply's error names every model tried and why; only the credential and helper calls are added here.
        if (p.credentialNote) notices.push(`Tried with the ${CREDENTIAL_LABEL['api-key']} — ${p.credentialNote}`);
        for (const note of p.helperNotes || []) notices.push(note);
        return {
            label: `No model answered · ${CREDENTIAL_LABEL[p.credential]}`,
            notice: notices.length > 0 ? notices.join('. ') : undefined
        };
    }
    if (p.modelUsed !== p.requestedModel) {
        notices.push(`Answered by ${p.modelUsed} — ${p.fallbackReason || `${p.requestedModel} unavailable`}`);
    }
    if (p.credentialNote) {
        notices.push(`Answered with the ${CREDENTIAL_LABEL['api-key']} — ${p.credentialNote}`);
    }
    for (const note of p.helperNotes || []) notices.push(note);
    if (p.routing) notices.push(`Routing: ${p.routing}`);
    return {
        label: `Answered by ${p.modelUsed} · ${CREDENTIAL_LABEL[p.credential]}`,
        notice: notices.length > 0 ? notices.join('. ') : undefined
    };
}

export interface VisualCheckDescription {
    tone: 'pass' | 'fail' | 'unavailable';
    text: string;
}

/** The background vision check as one line: its score and critique, or why it could not run. */
export function describeVisualCheck(outcome: VisualVerificationOutcome): VisualCheckDescription {
    if (isVisualAuditUnavailable(outcome)) {
        const via = outcome.credential ? ` (${outcome.modelUsed ? `${outcome.modelUsed} · ` : ''}${CREDENTIAL_LABEL[outcome.credential]})` : '';
        return { tone: 'unavailable', text: `Visual check unavailable${via}: ${outcome.error}` };
    }
    const answeredBy = [outcome.modelUsed, outcome.credential ? CREDENTIAL_LABEL[outcome.credential] : undefined].filter(Boolean).join(' · ');
    const by = answeredBy ? ` (${answeredBy})` : '';
    const critique = outcome.critique?.trim() ? ` — ${outcome.critique.trim()}` : '';
    return { tone: outcome.pass ? 'pass' : 'fail', text: `Visual check${by}: ${outcome.fidelityScore}/100${critique}` };
}

const LINE_STYLE: React.CSSProperties = { fontSize: 11, lineHeight: 1.45, borderRadius: 8, padding: '5px 9px', wordBreak: 'break-word' };
const NOTICE_STYLE: React.CSSProperties = { ...LINE_STYLE, background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.35)', color: '#fcd34d' };
const TONE_STYLE: Record<VisualCheckDescription['tone'], React.CSSProperties> = {
    pass: { ...LINE_STYLE, background: 'rgba(16, 185, 129, 0.10)', border: '1px solid rgba(16, 185, 129, 0.30)', color: '#6ee7b7' },
    fail: { ...LINE_STYLE, background: 'rgba(245, 158, 11, 0.10)', border: '1px solid rgba(245, 158, 11, 0.30)', color: '#fcd34d' },
    unavailable: { ...LINE_STYLE, background: 'rgba(113, 113, 122, 0.14)', border: '1px solid rgba(161, 161, 170, 0.30)', color: '#d4d4d8' }
};

/**
 * Footnotes of an assistant message: a notice when another model or credential answered than the one asked for,
 * the background visual check (or why it was unavailable), and which model answered.
 */
export const MessageNotices: React.FC<{ message: ChatMessage }> = ({ message }) => {
    const provenance = message.modelProvenance ? describeModelProvenance(message.modelProvenance) : undefined;
    const visual = message.visualAudit ? describeVisualCheck(message.visualAudit) : undefined;
    if (!provenance && !visual) return null;
    return (
        <div className="sb-msg-notices" data-testid="sb-msg-notices" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
            {provenance?.notice && (
                <div data-testid="sb-model-fallback-notice" role="note" style={NOTICE_STYLE}>{provenance.notice}</div>
            )}
            {visual && (
                <div data-testid="sb-visual-check" data-tone={visual.tone} style={TONE_STYLE[visual.tone]}>{visual.text}</div>
            )}
            {provenance && (
                <div data-testid="sb-model-label" style={{ fontSize: 10, color: '#a1a1aa' }}>{provenance.label}</div>
            )}
        </div>
    );
};
