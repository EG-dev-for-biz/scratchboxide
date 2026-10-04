/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import React from 'react';
import type { ExecutionPlanCardData } from '../canvas-types';

export interface ExecutionPlanCardProps {
    card: ExecutionPlanCardData;
    messageId: string;
    onConfirm: () => void;
    onAdjust: () => void;
    disabled?: boolean;
}

export const ExecutionPlanCard: React.FC<ExecutionPlanCardProps> = ({
    card,
    onConfirm,
    onAdjust,
    disabled = false
}) => {
    const isConfirmed = !!card.confirmed;

    const getTierBadge = (tier: ExecutionPlanCardData['pipelineTier']) => {
        if (tier === 'tier2-comfyui') {
            return {
                label: 'Tier 2: Cloud Run NVIDIA L4 GPU',
                color: '#c084fc',
                bg: 'rgba(192, 132, 252, 0.12)',
                border: 'rgba(192, 132, 252, 0.3)'
            };
        }
        if (tier === 'hybrid') {
            return {
                label: 'Multi-Tier Hybrid Pipeline',
                color: '#60a5fa',
                bg: 'rgba(96, 165, 250, 0.12)',
                border: 'rgba(96, 165, 250, 0.3)'
            };
        }
        return {
            label: 'Tier 1: Native C++20 Astro / SIMD',
            color: '#34d399',
            bg: 'rgba(52, 211, 153, 0.12)',
            border: 'rgba(52, 211, 153, 0.3)'
        };
    };

    const tierBadge = getTierBadge(card.pipelineTier);

    return (
        <div className="sb-execution-plan-card animate-fadeIn" style={{
            background: 'var(--sb-surface-card, #18181b)',
            border: '1px solid var(--sb-surface-border, rgba(255, 255, 255, 0.1))',
            borderRadius: '10px',
            padding: '16px',
            marginTop: '8px',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
        }}>
            {/* Header: Title and Pipeline Tier */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255, 255, 255, 0.06)', paddingBottom: '10px', gap: '8px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '14px' }}>📋</span>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--sb-text-label, #f4f4f5)' }}>
                        {card.title || 'Proposed Execution Plan'}
                    </span>
                </div>
                <div style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    color: tierBadge.color,
                    background: tierBadge.bg,
                    border: `1px solid ${tierBadge.border}`,
                    padding: '2px 8px',
                    borderRadius: '4px'
                }}>
                    {tierBadge.label}
                </div>
            </div>

            {/* Goal Narrative */}
            <div style={{ fontSize: '12px', color: 'var(--sb-text-secondary, #cbd5e1)', lineHeight: 1.5 }}>
                {card.goal}
            </div>

            {/* Deliverables Pills */}
            {card.deliverables && card.deliverables.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#71717a', fontWeight: 700 }}>
                        Target Deliverables
                    </span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {card.deliverables.map((deliv, idx) => (
                            <div key={`deliv-${deliv}-${idx}`} style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '6px',
                                background: 'rgba(255, 255, 255, 0.03)',
                                border: '1px solid rgba(255, 255, 255, 0.08)',
                                padding: '4px 8px',
                                borderRadius: '6px',
                                fontSize: '11px',
                                color: '#e2e8f0'
                            }}>
                                <span style={{ color: '#38bdf8', fontWeight: 600 }}>[{deliv.canvasType}]</span>
                                {deliv.assetFormat && <span style={{ opacity: 0.6, fontSize: '10px' }}>({deliv.assetFormat})</span>}
                                <span>{deliv.description}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Execution Steps sequence */}
            {card.steps && card.steps.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#71717a', fontWeight: 700 }}>
                        Execution Sequence ({card.steps.length} Steps)
                    </span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', background: 'rgba(0, 0, 0, 0.25)', padding: '8px', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.04)' }}>
                        {card.steps.map((st, sIdx) => (
                            <div key={st.id || sIdx} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '11px', lineHeight: 1.4 }}>
                                <span style={{ color: '#60a5fa', fontWeight: 700, minWidth: '16px', fontSize: '10px' }}>
                                    {sIdx + 1}.
                                </span>
                                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '6px', flex: 1 }}>
                                    <span style={{ fontWeight: 600, color: '#f1f5f9' }}>{st.title}</span>
                                    {st.engine && (
                                        <span style={{ fontSize: '9px', color: '#94a3b8', background: 'rgba(255, 255, 255, 0.06)', padding: '1px 5px', borderRadius: '3px' }}>
                                            {st.engine}
                                        </span>
                                    )}
                                    {st.description && (
                                        <span style={{ color: '#94a3b8', width: '100%' }}>{st.description}</span>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Estimated Latency & Open Questions */}
            {(card.estimatedLatency || (card.openQuestions && card.openQuestions.length > 0)) && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', color: '#94a3b8', paddingTop: '2px' }}>
                    {card.estimatedLatency && (
                        <span>Estimated latency: <strong style={{ color: '#cbd5e1' }}>{card.estimatedLatency}</strong></span>
                    )}
                    {card.openQuestions && card.openQuestions.length > 0 && (
                        <span style={{ color: '#fbbf24' }}>⚠ {card.openQuestions.length} assumption(s) to verify</span>
                    )}
                </div>
            )}

            {/* Confirmation Buttons */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', paddingTop: '6px', borderTop: '1px solid rgba(255, 255, 255, 0.06)' }}>
                {isConfirmed ? (
                    <span style={{ fontSize: '11px', fontWeight: 600, color: '#34d399', background: 'rgba(52, 211, 153, 0.1)', padding: '4px 10px', borderRadius: '5px' }}>
                        ✓ Plan Confirmed • Running Pipeline
                    </span>
                ) : (
                    <>
                        <button
                            type="button"
                            className="sb-btn sb-btn-ghost sb-btn-xs"
                            onClick={onAdjust}
                            disabled={disabled}
                            style={{
                                padding: '5px 12px',
                                fontSize: '11px',
                                fontWeight: 500,
                                borderRadius: '5px',
                                border: '1px solid rgba(255, 255, 255, 0.1)',
                                color: '#94a3b8',
                                cursor: 'pointer'
                            }}
                        >
                            Adjust Plan
                        </button>
                        <button
                            type="button"
                            className="sb-btn sb-btn-primary sb-btn-xs"
                            onClick={onConfirm}
                            disabled={disabled}
                            style={{
                                padding: '5px 14px',
                                fontSize: '11px',
                                fontWeight: 600,
                                borderRadius: '5px',
                                background: '#2563eb',
                                color: '#ffffff',
                                border: 'none',
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '5px'
                            }}
                        >
                            <span>Confirm &amp; Execute</span>
                            <span>↵</span>
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};
