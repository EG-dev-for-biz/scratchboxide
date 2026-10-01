/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { AgentSessionState, AgentStreamEvent } from '../../../common/agent-checkpoint-protocol';

export interface AgentDashboardProps {
    agentSession: AgentSessionState | undefined;
    agentEvents: AgentStreamEvent[];
    handlePauseAgent: () => void;
    handleResumeAgent: () => void;
    handleCancelAgent: () => void;
}

/** Floating telemetry card for a long-running agent session (milestones, live log, budget). */
export const AgentDashboard: React.FC<AgentDashboardProps> = ({ agentSession, agentEvents, handlePauseAgent, handleResumeAgent, handleCancelAgent }) => {
    if (!agentSession) return null;

    const currentMilestone = agentSession.milestones[agentSession.currentMilestoneIndex] || agentSession.milestones[agentSession.milestones.length - 1];

    return (
        <div className="sb-modal-unified sb-glass-card" style={{
            position: 'fixed',
            bottom: '100px',
            right: '24px',
            width: '380px',
            maxHeight: '500px',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '16px',
            overflow: 'hidden',
            background: 'rgba(24, 24, 27, 0.85)',
            backdropFilter: 'blur(20px)'
        }}>
            <div style={{
                padding: '16px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'rgba(255, 255, 255, 0.02)'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        display: 'inline-block',
                        background: agentSession.status === 'running' ? '#3b82f6' : '#a1a1aa',
                        boxShadow: agentSession.status === 'running' ? '0 0 8px #3b82f6' : 'none'
                    }} />
                    <span style={{ fontWeight: 600, fontSize: '13px', color: '#f4f4f5' }}>Long-Running Agent Loop</span>
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                    {agentSession.status === 'running' ? (
                        <button className="sb-btn sb-btn-ghost sb-btn-xs" style={{ padding: '4px 8px' }} onClick={handlePauseAgent}>
                            Pause
                        </button>
                    ) : agentSession.status === 'paused' ? (
                        <button className="sb-btn sb-btn-primary sb-btn-xs" style={{ padding: '4px 8px' }} onClick={handleResumeAgent}>
                            Resume
                        </button>
                    ) : null}
                    <button className="sb-btn sb-btn-danger sb-btn-xs" style={{ padding: '4px 8px' }} onClick={handleCancelAgent}>
                        Stop
                    </button>
                </div>
            </div>

            <div style={{ padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
                <div>
                    <div style={{ fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase' }}>Current Goal</div>
                    <div style={{ fontSize: '13px', color: '#e4e4e7', fontWeight: 500, marginTop: '2px' }}>{agentSession.goal}</div>
                </div>

                <div style={{ background: 'rgba(255, 255, 255, 0.05)', borderRadius: '4px', height: '6px', overflow: 'hidden', position: 'relative' }}>
                    <div style={{
                        background: '#3b82f6',
                        height: '100%',
                        width: `${(agentSession.currentMilestoneIndex / agentSession.milestones.length) * 100}%`,
                        transition: 'width 0.3s ease'
                    }} />
                </div>

                {currentMilestone && (
                    <div className="sb-surface-card-unified" style={{ padding: '10px 12px', border: '1px solid rgba(59, 130, 246, 0.2)' }}>
                        <div style={{ fontSize: '10px', color: '#3b82f6', fontWeight: 600, textTransform: 'uppercase' }}>Active Milestone</div>
                        <div style={{ fontSize: '12px', color: '#f4f4f5', fontWeight: 500, marginTop: '2px' }}>{currentMilestone.description}</div>
                        <div style={{ fontSize: '11px', color: '#a1a1aa', marginTop: '4px' }}>Criteria: {currentMilestone.acceptanceCriteria}</div>
                    </div>
                )}

                <div>
                    <div style={{ fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase', marginBottom: '6px' }}>Milestone Progress</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {agentSession.milestones.map((m) => (
                            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                                {m.status === 'completed' ? (
                                    <span style={{ color: '#10b981' }}>✓</span>
                                ) : m.status === 'in_progress' ? (
                                    <span style={{ color: '#3b82f6' }}>●</span>
                                ) : (
                                    <span style={{ color: '#71717a' }}>○</span>
                                )}
                                <span style={{ color: m.status === 'completed' ? '#a1a1aa' : '#e4e4e7', textDecoration: m.status === 'completed' ? 'line-through' : 'none' }}>
                                    {m.description}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>

                <div style={{ flex: 1, minHeight: '120px', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase', marginBottom: '6px' }}>Live Telemetry Log</div>
                    <div style={{
                        flex: 1,
                        background: 'rgba(0, 0, 0, 0.25)',
                        border: '1px solid rgba(255, 255, 255, 0.05)',
                        borderRadius: '8px',
                        padding: '8px',
                        fontFamily: 'ui-monospace, monospace',
                        fontSize: '11px',
                        color: '#e4e4e7',
                        overflowY: 'auto',
                        maxHeight: '150px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px'
                    }}>
                        {agentEvents.slice(-6).map((ev, i) => (
                            <div key={`${ev.timestamp}-${ev.type}-${i}`} style={{ display: 'flex', gap: '6px' }}>
                                <span style={{ color: '#a1a1aa' }}>[{new Date(ev.timestamp).toLocaleTimeString()}]</span>
                                <span style={{
                                    color: ev.type === 'step_complete' || ev.type === 'milestone_complete' ? '#34d399' :
                                           ev.type === 'step_failed' || ev.type === 'agent_error' ? '#f87171' :
                                           ev.type === 'guardrail_gate' ? '#fbbf24' : '#60a5fa'
                                }}>{ev.message}</span>
                            </div>
                        ))}
                        {agentEvents.length === 0 && <span style={{ color: '#71717a' }}>Waiting for stream events...</span>}
                    </div>
                </div>
            </div>

            <div style={{
                padding: '10px 16px',
                borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '11px',
                color: '#a1a1aa',
                background: 'rgba(255, 255, 255, 0.01)'
            }}>
                <span>Iterations: {agentSession.budget.usedIterations} / {agentSession.budget.maxIterations}</span>
                <span>Duration: {Math.round(agentSession.budget.usedDurationMs / 1000)}s / {Math.round(agentSession.budget.maxDurationMs / 1000)}s</span>
            </div>
        </div>
    );
};
