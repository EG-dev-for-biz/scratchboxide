/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import React, { useState } from 'react';
import type { InteractiveQuestionCardData } from '../canvas-types';

export interface QuestionCardProps {
    card: InteractiveQuestionCardData;
    messageId: string;
    onSubmit: (answerText: string, selectedOptions: Record<string, string[]>) => void;
    disabled?: boolean;
}

export const QuestionCard: React.FC<QuestionCardProps> = ({
    card,
    onSubmit,
    disabled = false
}) => {
    // Initialize selected options with defaults or recommended options
    const [selections, setSelections] = useState<Record<string, string[]>>(() => {
        if (card.selectedOptions) return card.selectedOptions;
        const initial: Record<string, string[]> = {};
        for (const q of card.questions) {
            if (q.defaultOptionId) {
                initial[q.id] = [q.defaultOptionId];
            } else {
                const rec = q.options.find(o => o.isRecommended);
                if (rec) {
                    initial[q.id] = [rec.id];
                } else if (q.options[0]) {
                    initial[q.id] = [q.options[0].id];
                }
            }
        }
        return initial;
    });

    const isSubmitted = !!card.submitted;

    const toggleOption = (qId: string, optId: string, allowMultiple: boolean) => {
        if (isSubmitted || disabled) return;
        setSelections(prev => {
            const current = prev[qId] || [];
            if (allowMultiple) {
                const exists = current.includes(optId);
                const next = exists ? current.filter(id => id !== optId) : [...current, optId];
                return { ...prev, [qId]: next };
            } else {
                return { ...prev, [qId]: [optId] };
            }
        });
    };

    const handleSubmit = () => {
        if (isSubmitted || disabled) return;
        // Build clear structured answer summary text
        const answerParts: string[] = [];
        for (const q of card.questions) {
            const chosenIds = selections[q.id] || [];
            const chosenLabels = q.options
                .filter(o => chosenIds.includes(o.id))
                .map(o => o.label);
            if (chosenLabels.length > 0) {
                answerParts.push(`${q.prompt}: ${chosenLabels.join(', ')}`);
            }
        }
        const summaryText = answerParts.length > 0
            ? `[Clarification Selection]: ${answerParts.join(' | ')}`
            : 'Proceed with default recommended configuration.';

        onSubmit(summaryText, selections);
    };

    return (
        <div className="sb-question-card animate-fadeIn" style={{
            background: 'var(--sb-surface-card, #18181b)',
            border: '1px solid var(--sb-surface-border, rgba(255, 255, 255, 0.1))',
            borderRadius: '10px',
            padding: '14px 16px',
            marginTop: '8px',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
        }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255, 255, 255, 0.06)', paddingBottom: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '13px' }}>❓</span>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--sb-text-label, #f4f4f5)', letterSpacing: '-0.01em' }}>
                        {card.title || 'Clarification & Configuration Required'}
                    </span>
                </div>
                {isSubmitted && (
                    <span style={{ fontSize: '10px', fontWeight: 600, color: '#34d399', background: 'rgba(52, 211, 153, 0.1)', padding: '2px 8px', borderRadius: '4px', border: '1px solid rgba(52, 211, 153, 0.25)' }}>
                        ✓ Confirmed
                    </span>
                )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {card.questions.map((q) => {
                    const chosen = selections[q.id] || [];
                    const allowMultiple = !!q.allowMultiple;
                    return (
                        <div key={q.id} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--sb-text-secondary, #cbd5e1)' }}>
                                {q.prompt}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {q.options.map(opt => {
                                    const isSelected = chosen.includes(opt.id);
                                    return (
                                        <div
                                            key={opt.id}
                                            onClick={() => toggleOption(q.id, opt.id, allowMultiple)}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'flex-start',
                                                gap: '10px',
                                                padding: '8px 12px',
                                                borderRadius: '6px',
                                                background: isSelected ? 'rgba(59, 130, 246, 0.1)' : 'rgba(255, 255, 255, 0.02)',
                                                border: isSelected ? '1px solid #3b82f6' : '1px solid rgba(255, 255, 255, 0.06)',
                                                cursor: isSubmitted || disabled ? 'default' : 'pointer',
                                                transition: 'all 0.15s ease'
                                            }}
                                        >
                                            <div style={{ marginTop: '2px', flexShrink: 0 }}>
                                                {allowMultiple ? (
                                                    <div style={{
                                                        width: '14px', height: '14px', borderRadius: '3px',
                                                        border: isSelected ? '1px solid #3b82f6' : '1px solid #71717a',
                                                        background: isSelected ? '#3b82f6' : 'transparent',
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '10px', color: '#fff'
                                                    }}>
                                                        {isSelected ? '✓' : ''}
                                                    </div>
                                                ) : (
                                                    <div style={{
                                                        width: '14px', height: '14px', borderRadius: '50%',
                                                        border: isSelected ? '1px solid #3b82f6' : '1px solid #71717a',
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center'
                                                    }}>
                                                        {isSelected && <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#3b82f6' }} />}
                                                    </div>
                                                )}
                                            </div>

                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                    <span style={{ fontSize: '12px', fontWeight: isSelected ? 600 : 500, color: isSelected ? '#93c5fd' : '#f4f4f5' }}>
                                                        {opt.label}
                                                    </span>
                                                    {opt.isRecommended && (
                                                        <span style={{ fontSize: '9px', fontWeight: 700, color: '#38bdf8', background: 'rgba(56, 189, 248, 0.15)', padding: '1px 5px', borderRadius: '3px' }}>
                                                            Recommended
                                                        </span>
                                                    )}
                                                </div>
                                                {opt.description && (
                                                    <span style={{ fontSize: '11px', color: '#94a3b8', lineHeight: 1.4 }}>
                                                        {opt.description}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>

            {!isSubmitted && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '4px' }}>
                    <button
                        type="button"
                        className="sb-btn sb-btn-primary sb-btn-xs"
                        onClick={handleSubmit}
                        disabled={disabled}
                        style={{
                            padding: '6px 14px',
                            fontSize: '11px',
                            fontWeight: 600,
                            borderRadius: '6px',
                            background: '#2563eb',
                            color: '#ffffff',
                            border: 'none',
                            cursor: 'pointer'
                        }}
                    >
                        Confirm Choice &amp; Proceed
                    </button>
                </div>
            )}
        </div>
    );
};
