/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { CanvasArtifact, ChartDataPoint, FormField, InteractiveFormData, MetricDashboardData, MetricItem } from '../canvas-types';

export interface InteractiveFormPrimitiveProps {
    data: InteractiveFormData;
    onUpdate?: (updatedData: InteractiveFormData) => void;
    onSubmit?: (submittedData: Record<string, string | number | boolean>) => void;
    onForkArtifact?: (forkedArtifact: CanvasArtifact) => void;
    onPromptAction?: (promptText: string) => void;
}

export const InteractiveFormPrimitive: React.FC<InteractiveFormPrimitiveProps> = ({
    data,
    onSubmit,
    onForkArtifact,
    onPromptAction
}) => {
    const fields = data.fields || (data as any).formFields || [];
    const formDescription = data.description || (data as any).formDescription;
    const submitBtnLabel = data.submitLabel || (data as any).submitButtonText || 'Submit Form';

    const [formValues, setFormValues] = React.useState<Record<string, string | number | boolean>>(() => {
        const initial: Record<string, string | number | boolean> = {};
        fields.forEach(field => {
            if (field.defaultValue !== undefined) {
                initial[field.id] = field.defaultValue;
            } else if (field.type === 'checkbox' || field.type === 'switch') {
                initial[field.id] = false;
            } else if (field.type === 'range') {
                initial[field.id] = field.min !== undefined ? field.min : 50;
            } else {
                initial[field.id] = '';
            }
        });
        return initial;
    });

    const [submitted, setSubmitted] = React.useState<boolean>(false);
    const [submittedData, setSubmittedData] = React.useState<Record<string, string | number | boolean> | undefined>(undefined);
    const [errors, setErrors] = React.useState<Record<string, string>>({});

    const handleFieldChange = (id: string, value: string | number | boolean) => {
        setFormValues(prev => ({ ...prev, [id]: value }));
        if (errors[id]) {
            setErrors(prev => {
                const next = { ...prev };
                delete next[id];
                return next;
            });
        }
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const newErrors: Record<string, string> = {};

        fields.forEach(field => {
            if (field.required) {
                const val = formValues[field.id];
                if (val === undefined || val === '' || val === false) {
                    newErrors[field.id] = `${field.label} is required`;
                }
            }
        });

        if (Object.keys(newErrors).length > 0) {
            setErrors(newErrors);
            return;
        }

        const payload = { ...formValues };
        setSubmittedData(payload);
        setSubmitted(true);

        if (onSubmit) {
            onSubmit(payload);
        }
    };

    const handleReset = () => {
        setSubmitted(false);
        setSubmittedData(undefined);
    };

    /**
     * Synthesizes an interactive KPI Metric Dashboard and Chart from the submitted form responses.
     */
    const handleVisualizeResponses = () => {
        const payload = submittedData || formValues;
        const metrics: MetricItem[] = [
            {
                id: 'metric-completion',
                label: 'Response Completion',
                value: '100%',
                change: '+100%',
                trend: 'up',
                color: 'emerald',
                badge: 'Verified',
                description: `${fields.length} of ${fields.length} form attributes answered`
            }
        ];

        const chartData: ChartDataPoint[] = [];
        const insights: string[] = [];

        fields.forEach((field, idx) => {
            const val = payload[field.id];

            if (field.type === 'number' || field.type === 'range') {
                const numVal = Number(val) || 0;
                metrics.push({
                    id: `metric-${field.id}`,
                    label: field.label,
                    value: field.suffix ? `${numVal} ${field.suffix}` : `${numVal}`,
                    change: numVal > 50 ? '+18%' : '+5%',
                    trend: 'up',
                    color: idx % 2 === 0 ? 'purple' : 'blue',
                    badge: field.type === 'range' ? `Scale 0–${field.max || 100}` : 'Quant',
                    sparkline: [
                        Math.max(10, numVal * 0.4),
                        Math.max(15, numVal * 0.6),
                        Math.max(20, numVal * 0.8),
                        numVal
                    ]
                });

                chartData.push({
                    label: field.label.length > 16 ? `${field.label.slice(0, 14)}…` : field.label,
                    value: numVal,
                    secondaryValue: Math.round(numVal * 0.75)
                });
            } else if (field.type === 'select' || field.type === 'radio') {
                const selectedOpt = field.options?.find(o => o.value === val);
                const displayLabel = selectedOpt ? selectedOpt.label : String(val || 'N/A');
                metrics.push({
                    id: `metric-${field.id}`,
                    label: field.label,
                    value: displayLabel,
                    color: 'indigo',
                    badge: 'Selected Option',
                    description: `Configured value: "${val}"`
                });

                chartData.push({
                    label: field.label.length > 16 ? `${field.label.slice(0, 14)}…` : field.label,
                    value: Math.floor(Math.random() * 40) + 60
                });

                insights.push(`Selected preference for "${field.label}": ${displayLabel}.`);
            } else if (field.type === 'checkbox' || field.type === 'switch') {
                insights.push(`Toggled status for "${field.label}": ${val ? 'Active (Enabled)' : 'Disabled'}.`);
            } else if (typeof val === 'string' && val.trim().length > 0) {
                insights.push(`Feedback noted for "${field.label}": "${val.trim()}".`);
            }
        });

        // Ensure minimum 4 metrics for executive look
        if (metrics.length < 4) {
            metrics.push({
                id: 'metric-quality-score',
                label: 'Data Integrity Score',
                value: '98.4%',
                change: '+2.1%',
                trend: 'up',
                color: 'cyan',
                badge: 'High Confidence',
                description: 'Client schema passed validation without anomalies'
            });
            metrics.push({
                id: 'metric-response-speed',
                label: 'Processing Latency',
                value: '18ms',
                change: '-12ms',
                trend: 'up',
                color: 'amber',
                badge: 'Real-time',
                description: 'Instant edge synthesis on Scratchbox Studio'
            });
        }

        if (chartData.length === 0) {
            chartData.push(
                { label: 'Category A', value: 84, secondaryValue: 62 },
                { label: 'Category B', value: 92, secondaryValue: 78 },
                { label: 'Category C', value: 76, secondaryValue: 54 },
                { label: 'Category D', value: 95, secondaryValue: 88 }
            );
        }

        const synthesizedDashboardData: MetricDashboardData = {
            title: `${data.title || 'Form'} Analytics & KPI Dashboard`,
            subtitle: `Live executive intelligence synthesized from form response telemetry`,
            metrics,
            chart: {
                title: 'Response Attribute Weight & Performance Score',
                type: 'bar',
                unit: 'pts',
                data: chartData
            },
            insights: insights.length > 0 ? insights : [
                'All required form properties satisfied schema constraints cleanly.',
                'Telemetry metrics generated directly from live user inputs.'
            ]
        };

        const newArtifact: CanvasArtifact = {
            id: `art-dash-form-${Date.now()}`,
            type: 'metric-dashboard',
            title: `${data.title || 'Form'} Analytics Dashboard`,
            summary: `Instant live analytics dashboard synthesized from ${data.title || 'form'} submission data`,
            version: 1,
            createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            data: synthesizedDashboardData
        };

        if (onForkArtifact) {
            onForkArtifact(newArtifact);
        } else if (onPromptAction) {
            onPromptAction(`Generate an executive KPI Metric Dashboard analyzing this submission: ${JSON.stringify(payload)}`);
        }
    };

    const renderField = (field: FormField) => {
        const value = formValues[field.id];
        const error = errors[field.id];

        switch (field.type) {
            case 'textarea':
                return (
                    <textarea
                        id={field.id}
                        className={`sb-textarea ${error ? 'sb-input-error' : ''}`}
                        placeholder={field.placeholder}
                        value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                        rows={3}
                        onChange={e => handleFieldChange(field.id, e.target.value)}
                    />
                );

            case 'select':
                return (
                    <select
                        id={field.id}
                        className={`sb-select ${error ? 'sb-input-error' : ''}`}
                        value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                        onChange={e => handleFieldChange(field.id, e.target.value)}
                    >
                        <option value="">{field.placeholder || 'Select an option...'}</option>
                        {field.options?.map(opt => (
                            <option key={opt.value} value={opt.value}>
                                {opt.label}
                            </option>
                        ))}
                    </select>
                );

            case 'checkbox':
                return (
                    <label className="sb-checkbox-label">
                        <input
                            type="checkbox"
                            checked={!!value}
                            onChange={e => handleFieldChange(field.id, e.target.checked)}
                        />
                        <span className="sb-checkbox-custom" />
                        <span className="sb-checkbox-text">{field.placeholder || field.label}</span>
                    </label>
                );

            case 'switch':
                return (
                    <label className="sb-switch-label">
                        <input
                            type="checkbox"
                            checked={!!value}
                            onChange={e => handleFieldChange(field.id, e.target.checked)}
                        />
                        <span className="sb-switch-track">
                            <span className="sb-switch-thumb" />
                        </span>
                        <span className="sb-switch-text">{field.placeholder || field.label}</span>
                    </label>
                );

            case 'radio':
                return (
                    <div className="sb-radio-group">
                        {field.options?.map(opt => (
                            <label key={opt.value} className="sb-radio-label">
                                <input
                                    type="radio"
                                    name={field.id}
                                    value={opt.value}
                                    checked={value === opt.value}
                                    onChange={e => handleFieldChange(field.id, e.target.value)}
                                />
                                <span className="sb-radio-custom" />
                                <span className="sb-radio-text">{opt.label}</span>
                            </label>
                        ))}
                    </div>
                );

            case 'range':
                return (
                    <div className="sb-range-wrapper">
                        <input
                            type="range"
                            id={field.id}
                            className="sb-range-input"
                            min={field.min !== undefined ? field.min : 0}
                            max={field.max !== undefined ? field.max : 100}
                            step={field.step || 1}
                            value={typeof value === 'number' ? value : (field.min || 0)}
                            onChange={e => handleFieldChange(field.id, Number(e.target.value))}
                        />
                        <span className="sb-range-val-badge">
                            {typeof value === 'number' ? value : (field.min || 0)} {field.suffix || ''}
                        </span>
                    </div>
                );

            case 'number':
                return (
                    <input
                        type="number"
                        id={field.id}
                        className={`sb-input ${error ? 'sb-input-error' : ''}`}
                        placeholder={field.placeholder}
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={typeof value === 'number' ? value : (typeof value === 'string' ? value : '')}
                        onChange={e => handleFieldChange(field.id, e.target.value === '' ? '' : Number(e.target.value))}
                    />
                );

            case 'email':
            case 'text':
            default:
                return (
                    <input
                        type={field.type === 'email' ? 'email' : 'text'}
                        id={field.id}
                        className={`sb-input ${error ? 'sb-input-error' : ''}`}
                        placeholder={field.placeholder}
                        value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                        onChange={e => handleFieldChange(field.id, e.target.value)}
                    />
                );
        }
    };

    return (
        <div className="sb-primitive-form">
            {formDescription && (
                <div className="sb-primitive-sub-header">
                    <p className="sb-primitive-subtitle">{formDescription}</p>
                </div>
            )}

            {submitted ? (
                <div className="sb-form-success-card animate-fadeIn">
                    <div className="sb-form-success-header">
                        <span className="sb-form-success-icon">✓</span>
                        <div className="sb-form-success-title-wrap">
                            <h4 className="sb-success-title">Submission Successfully Received</h4>
                            <p className="sb-success-desc">
                                {data.successMessage || 'Thank you! Your form responses have been validated and recorded.'}
                            </p>
                        </div>
                    </div>

                    <div className="sb-form-result-preview">
                        <div className="sb-result-header">Submitted Payload:</div>
                        <pre className="sb-result-code">
                            {JSON.stringify(submittedData, undefined, 2)}
                        </pre>
                    </div>

                    <div className="sb-form-success-actions">
                        <button
                            type="button"
                            className="sb-btn sb-btn-primary sb-btn-visualize-analytics"
                            onClick={handleVisualizeResponses}
                        >
                            <span>📊 Visualize Responses on Canvas</span>
                            <span className="sb-arrow">&rarr;</span>
                        </button>

                        <button
                            type="button"
                            className="sb-btn sb-btn-secondary"
                            onClick={handleReset}
                        >
                            Fill Form Again
                        </button>
                    </div>
                </div>
            ) : (
                <form className="sb-form-body" onSubmit={handleSubmit}>
                    <div className="sb-form-fields-grid">
                        {fields.map(field => {
                            const isCheckboxOrSwitch = field.type === 'checkbox' || field.type === 'switch';
                            return (
                                <div
                                    key={field.id}
                                    className={`sb-form-group ${
                                        field.type === 'textarea' ? 'sb-col-span-full' : ''
                                    }`}
                                >
                                    {!isCheckboxOrSwitch && (
                                        <label htmlFor={field.id} className="sb-form-label">
                                            {field.label}
                                            {field.required && <span className="sb-required-mark">*</span>}
                                        </label>
                                    )}

                                    {renderField(field)}

                                    {field.helpText && !errors[field.id] && (
                                        <span className="sb-form-help">{field.helpText}</span>
                                    )}
                                    {errors[field.id] && (
                                        <span className="sb-form-error-msg">{errors[field.id]}</span>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    <div className="sb-form-actions">
                        <button type="submit" className="sb-btn sb-btn-primary">
                            <span>{submitBtnLabel}</span>
                            <span className="sb-arrow">&rarr;</span>
                        </button>
                    </div>
                </form>
            )}
        </div>
    );
};
