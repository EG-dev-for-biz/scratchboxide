/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';

export interface CanvasErrorBoundaryProps {
    children: React.ReactNode;
    fallbackTitle?: string;
    fallbackMessage?: string;
    compact?: boolean;
    className?: string;
    onReset?: () => void;
}

export interface CanvasErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
    errorInfo: React.ErrorInfo | null;
    showDetails: boolean;
}

export class CanvasErrorBoundary extends React.Component<CanvasErrorBoundaryProps, CanvasErrorBoundaryState> {
    constructor(props: CanvasErrorBoundaryProps) {
        super(props);
        this.state = {
            hasError: false,
            error: null,
            errorInfo: null,
            showDetails: false
        };
    }

    static getDerivedStateFromError(error: Error): Partial<CanvasErrorBoundaryState> {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
        console.error('[CanvasErrorBoundary] Caught render exception:', error, errorInfo);
        this.setState({ errorInfo });
    }

    handleReset = (): void => {
        this.setState({ hasError: false, error: null, errorInfo: null, showDetails: false });
        if (this.props.onReset) {
            this.props.onReset();
        }
    };

    render(): React.ReactNode {
        if (!this.state.hasError) {
            return this.props.children;
        }

        const { fallbackTitle = 'Component Render Notice', fallbackMessage, compact = false, className = '' } = this.props;
        const errorMessage = this.state.error?.message || 'An unexpected rendering error occurred.';

        if (compact) {
            return (
                <div
                    className={`sb-error-boundary-compact ${className}`}
                    style={{
                        padding: '10px 14px',
                        margin: '6px 0',
                        borderRadius: '8px',
                        background: 'rgba(239, 68, 68, 0.08)',
                        border: '1px solid rgba(239, 68, 68, 0.25)',
                        color: 'var(--sb-cadence-high, #f4f4f5)',
                        fontSize: '12px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '12px'
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                        <span style={{ color: '#ef4444', fontSize: '14px', flexShrink: 0 }}>⚠️</span>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <strong style={{ fontWeight: 600 }}>{fallbackTitle}:</strong>{' '}
                            <span style={{ color: 'var(--sb-cadence-medium, #94a3b8)' }}>{errorMessage}</span>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={this.handleReset}
                        style={{
                            padding: '4px 10px',
                            borderRadius: '6px',
                            background: 'rgba(255, 255, 255, 0.08)',
                            border: '1px solid rgba(255, 255, 255, 0.15)',
                            color: '#fff',
                            fontSize: '11px',
                            fontWeight: 500,
                            cursor: 'pointer',
                            flexShrink: 0
                        }}
                    >
                        Retry
                    </button>
                </div>
            );
        }

        return (
            <div
                className={`sb-error-boundary-card ${className}`}
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '32px 24px',
                    margin: '16px auto',
                    maxWidth: '640px',
                    width: 'calc(100% - 32px)',
                    borderRadius: '14px',
                    background: 'var(--sb-surface-card, #18181b)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
                    color: 'var(--sb-cadence-high, #f4f4f5)',
                    textAlign: 'center',
                    boxSizing: 'border-box'
                }}
            >
                <div
                    style={{
                        width: '44px',
                        height: '44px',
                        borderRadius: '12px',
                        background: 'rgba(239, 68, 68, 0.12)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '20px',
                        marginBottom: '14px'
                    }}
                >
                    ⚠️
                </div>

                <h3 style={{ margin: '0 0 6px 0', fontSize: '15px', fontWeight: 600, color: '#f87171' }}>
                    {fallbackTitle}
                </h3>

                <p style={{ margin: '0 0 16px 0', fontSize: '13px', color: 'var(--sb-cadence-medium, #a1a1aa)', lineHeight: 1.5, maxWidth: '480px' }}>
                    {fallbackMessage || errorMessage}
                </p>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
                    <button
                        type="button"
                        onClick={this.handleReset}
                        style={{
                            padding: '7px 16px',
                            borderRadius: '8px',
                            background: '#3b82f6',
                            border: 'none',
                            color: '#ffffff',
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: 'pointer',
                            transition: 'background 0.15s ease'
                        }}
                    >
                        Recover Surface
                    </button>

                    <button
                        type="button"
                        onClick={() => this.setState(prev => ({ showDetails: !prev.showDetails }))}
                        style={{
                            padding: '7px 14px',
                            borderRadius: '8px',
                            background: 'rgba(255, 255, 255, 0.06)',
                            border: '1px solid rgba(255, 255, 255, 0.12)',
                            color: 'var(--sb-cadence-medium, #cbd5e1)',
                            fontSize: '12px',
                            fontWeight: 500,
                            cursor: 'pointer'
                        }}
                    >
                        {this.state.showDetails ? 'Hide Diagnostics' : 'Inspect Stack Trace'}
                    </button>
                </div>

                {this.state.showDetails && (
                    <div
                        style={{
                            marginTop: '18px',
                            padding: '12px 14px',
                            borderRadius: '8px',
                            background: 'rgba(0, 0, 0, 0.5)',
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                            fontSize: '11px',
                            fontFamily: 'monospace',
                            textAlign: 'left',
                            maxHeight: '180px',
                            overflowY: 'auto',
                            width: '100%',
                            color: '#fca5a5',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                            boxSizing: 'border-box'
                        }}
                    >
                        {this.state.error?.stack || this.state.errorInfo?.componentStack || errorMessage}
                    </div>
                )}
            </div>
        );
    }
}
