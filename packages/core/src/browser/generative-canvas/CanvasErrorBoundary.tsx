/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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

/**
 * Styles live in `packages/core/src/browser/style/unified-ui.css` under the
 * "Canvas Error Boundary" section (`.sb-error-boundary-*`).
 */
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
                <div className={`sb-error-boundary-compact ${className}`}>
                    <div className="sb-error-boundary-compact-body">
                        <span className="sb-error-boundary-compact-icon">⚠️</span>
                        <div className="sb-error-boundary-compact-text">
                            <strong>{fallbackTitle}:</strong>{' '}
                            <span className="sb-error-boundary-compact-message">{errorMessage}</span>
                        </div>
                    </div>
                    <button
                        type="button"
                        className="sb-btn sb-btn-ghost sb-btn-xs"
                        onClick={this.handleReset}
                    >
                        Retry
                    </button>
                </div>
            );
        }

        return (
            <div className={`sb-error-boundary-card ${className}`}>
                <div className="sb-error-boundary-icon">⚠️</div>

                <h3 className="sb-error-boundary-title">{fallbackTitle}</h3>

                <p className="sb-error-boundary-message">{fallbackMessage || errorMessage}</p>

                <div className="sb-error-boundary-actions">
                    <button
                        type="button"
                        className="sb-btn sb-btn-primary sb-btn-sm"
                        onClick={this.handleReset}
                    >
                        Recover Surface
                    </button>

                    <button
                        type="button"
                        className="sb-btn sb-btn-ghost sb-btn-sm"
                        onClick={() => this.setState(prev => ({ showDetails: !prev.showDetails }))}
                    >
                        {this.state.showDetails ? 'Hide Diagnostics' : 'Inspect Stack Trace'}
                    </button>
                </div>

                {this.state.showDetails && (
                    <div className="sb-error-boundary-stack">
                        {this.state.error?.stack || this.state.errorInfo?.componentStack || errorMessage}
                    </div>
                )}
            </div>
        );
    }
}
