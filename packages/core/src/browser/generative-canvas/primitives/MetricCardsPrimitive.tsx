/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { MetricDashboardData, MetricItem } from '../canvas-types';

export interface MetricCardsPrimitiveProps {
    data: MetricDashboardData;
    onUpdate?: (updatedData: MetricDashboardData) => void;
    onAnalyzeWithAi?: (metricTitle: string) => void;
    onExportData?: () => void;
}

export const MetricCardsPrimitive: React.FC<MetricCardsPrimitiveProps> = ({
    data,
    onAnalyzeWithAi,
    onExportData
}) => {
    const metricsList = Array.isArray(data?.metrics) ? data.metrics : [];
    const [selectedMetricId, setSelectedMetricId] = React.useState<string | undefined>(
        metricsList[0]?.id
    );
    const [hoveredBarIndex, setHoveredBarIndex] = React.useState<number | undefined>(undefined);
    const [chartMode, setChartMode] = React.useState<'bar' | 'line' | 'area'>('area');
    const [timeRange, setTimeRange] = React.useState<'7D' | '30D' | '90D' | 'YTD'>('30D');

    // Dynamically filter or scale chart data based on time range
    const activeChartData = React.useMemo(() => {
        const raw = data?.chart?.data || [];
        if (raw.length === 0) return [];
        if (timeRange === '7D') {
            return raw.slice(-7);
        } else if (timeRange === '90D') {
            return raw.map(d => ({ ...d, value: Math.round(d.value * 2.8) }));
        } else if (timeRange === 'YTD') {
            return raw.map(d => ({ ...d, value: Math.round(d.value * 5.4) }));
        }
        return raw;
    }, [data?.chart?.data, timeRange]);

    const renderSparkline = (points?: number[], colorClass: string = 'sb-spark-blue') => {
        if (!points || points.length < 2) {
            /* eslint-disable-next-line no-null/no-null */
            return null;
        }
        const width = 84;
        const height = 26;
        const min = Math.min(...points);
        const max = Math.max(...points);
        const range = max - min === 0 ? 1 : max - min;

        const pathData = points
            .map((val, idx) => {
                const x = (idx / (points.length - 1)) * width;
                const y = height - ((val - min) / range) * (height - 6) - 3;
                return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
            })
            .join(' ');

        return (
            <svg className={`sb-sparkline ${colorClass}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
                <path d={pathData} fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        );
    };

    const renderChartToggles = () => (
        <div className="flex items-center gap-2">
            <div className="sb-segmented-control sb-segmented-control-xs">
                {(['7D', '30D', '90D', 'YTD'] as const).map(tr => (
                    <button
                        key={tr}
                        type="button"
                        className={`sb-segment-btn ${timeRange === tr ? 'sb-segment-active' : ''}`}
                        onClick={() => setTimeRange(tr)}
                    >
                        {tr}
                    </button>
                ))}
            </div>
            <div className="sb-segmented-control sb-segmented-control-xs">
                {(['area', 'line', 'bar'] as const).map(mode => (
                    <button
                        key={mode}
                        type="button"
                        className={`sb-segment-btn ${chartMode === mode ? 'sb-segment-active' : ''}`}
                        onClick={() => setChartMode(mode)}
                    >
                        {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </button>
                ))}
            </div>
        </div>
    );

    const renderChart = () => {
        if (!data.chart || activeChartData.length === 0) {
            /* eslint-disable-next-line no-null/no-null */
            return null;
        }
        const maxVal = Math.max(...activeChartData.map(d => d.value), 1);
        const chartHeight = 180;
        const width = 640;

        if (chartMode === 'line' || chartMode === 'area') {
            const points = activeChartData.map(d => d.value);
            const min = Math.min(...points, 0);
            const max = Math.max(...points, 1);
            const range = max - min === 0 ? 1 : max - min;

            const pathD = points
                .map((val, idx) => {
                    const x = (idx / Math.max(1, points.length - 1)) * (width - 48) + 24;
                    const y = chartHeight - ((val - min) / range) * (chartHeight - 40) - 20;
                    return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
                })
                .join(' ');

            return (
                <div className="sb-primitive-chart-container">
                    <div className="sb-chart-header">
                        <div className="flex items-center gap-3">
                            <div>
                                <h4 className="sb-chart-title">{data.chart.title}</h4>
                                <span className="sb-chart-unit">{data.chart.unit || 'Continuous Metric Trend'} ({timeRange})</span>
                            </div>
                        </div>
                        {renderChartToggles()}
                    </div>

                    <div className="sb-line-chart-wrapper" style={{ height: `${chartHeight}px`, position: 'relative' }}>
                        <svg width="100%" height="100%" viewBox={`0 0 ${width} ${chartHeight}`} preserveAspectRatio="none">
                            <defs>
                                <linearGradient id="streamlineChartGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={chartMode === 'area' ? '0.35' : '0.0'} />
                                    <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
                                </linearGradient>
                            </defs>
                            {chartMode === 'area' && (
                                <path
                                    d={`${pathD} L ${width - 24} ${chartHeight - 10} L 24 ${chartHeight - 10} Z`}
                                    fill="url(#streamlineChartGrad)"
                                />
                            )}
                            <path d={pathD} fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                            {activeChartData.map((item, idx) => {
                                const x = (idx / Math.max(1, points.length - 1)) * (width - 48) + 24;
                                const y = chartHeight - ((item.value - min) / range) * (chartHeight - 40) - 20;
                                return (
                                    <circle
                                        key={idx}
                                        cx={x}
                                        cy={y}
                                        r="3.5"
                                        fill="#18181b"
                                        stroke="#60a5fa"
                                        strokeWidth="2"
                                        className="sb-chart-point"
                                    />
                                );
                            })}
                        </svg>
                    </div>

                    <div className="sb-chart-x-labels-row">
                        {activeChartData.map((item, idx) => (
                            <span key={idx} className="sb-chart-x-label">{item.label}</span>
                        ))}
                    </div>
                </div>
            );
        }

        return (
            <div className="sb-primitive-chart-container">
                <div className="sb-chart-header">
                    <div>
                        <h4 className="sb-chart-title">{data.chart.title}</h4>
                        <span className="sb-chart-unit">{data.chart.unit || 'Performance Metric'} ({timeRange})</span>
                    </div>
                    {renderChartToggles()}
                </div>
                <div className="sb-chart-bars" style={{ height: `${chartHeight}px` }}>
                    {activeChartData.map((item, idx) => {
                        const barHeightPercent = Math.round((item.value / maxVal) * 100);
                        const isHovered = hoveredBarIndex === idx;
                        return (
                            <div
                                key={idx}
                                className={`sb-chart-bar-group ${isHovered ? 'sb-bar-active' : ''}`}
                                onMouseEnter={() => setHoveredBarIndex(idx)}
                                onMouseLeave={() => setHoveredBarIndex(undefined)}
                            >
                                <div className="sb-chart-tooltip">
                                    <span className="sb-tooltip-val">{item.value.toLocaleString()}</span>
                                    <span className="sb-tooltip-label">{item.label}</span>
                                </div>
                                <div className="sb-chart-bar-track">
                                    <div
                                        className="sb-chart-bar-fill"
                                        style={{ height: `${Math.max(barHeightPercent, 6)}%` }}
                                    />
                                </div>
                                <span className="sb-chart-x-label">{item.label}</span>
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    };

    return (
        <div className="sb-primitive-metric-dashboard sb-streamlined-dashboard">
            {/* Top Toolbar */}
            <div className="sb-dashboard-top-toolbar">
                <div className="sb-dashboard-title-block">
                    <h3 className="sb-dashboard-main-title">{data.title || 'Executive KPI Dashboard'}</h3>
                    {data.subtitle && <p className="sb-primitive-subtitle">{data.subtitle}</p>}
                </div>
                <div className="sb-dashboard-actions-group">
                    <button
                        type="button"
                        className="sb-btn sb-btn-secondary sb-btn-xs sb-metric-action-btn"
                        onClick={() => {
                            if (onExportData) onExportData();
                            else {
                                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = `${(data.title || 'metric-dashboard').toLowerCase().replace(/\s+/g, '-')}.json`;
                                a.click();
                            }
                        }}
                        title="Export Metric Data to JSON / CSV"
                    >
                        <span>⬇ Export</span>
                    </button>
                    <button
                        type="button"
                        className="sb-btn sb-btn-primary sb-btn-xs sb-metric-action-btn"
                        onClick={() => {
                            if (onAnalyzeWithAi) onAnalyzeWithAi(data.title || 'KPI Metrics');
                        }}
                        title="Synthesize real-time AI diagnostic"
                    >
                        <span>✨ AI Insights</span>
                    </button>
                </div>
            </div>

            {/* Metric KPI Grid */}
            <div className="sb-metrics-grid">
                {data.metrics.map((metric: MetricItem) => {
                    const isSelected = selectedMetricId === metric.id;
                    const colorClass = metric.color ? `sb-accent-${metric.color}` : 'sb-accent-blue';
                    return (
                        <div
                            key={metric.id}
                            className={`sb-metric-card ${colorClass} ${isSelected ? 'sb-card-selected' : ''}`}
                            onClick={() => setSelectedMetricId(metric.id)}
                        >
                            <div className="sb-metric-top">
                                <span className="sb-metric-label">{metric.label}</span>
                                {metric.badge && <span className="sb-metric-badge">{metric.badge}</span>}
                            </div>
                            <div className="sb-metric-middle">
                                <div className="sb-metric-value">{metric.value}</div>
                                {metric.sparkline && renderSparkline(metric.sparkline, `sb-spark-${metric.color || 'blue'}`)}
                            </div>
                            <div className="sb-metric-bottom">
                                {metric.change && (
                                    <span
                                        className={`sb-metric-trend-pill ${
                                            metric.trend === 'up'
                                                ? 'sb-trend-up'
                                                : metric.trend === 'down'
                                                ? 'sb-trend-down'
                                                : 'sb-trend-neutral'
                                        }`}
                                    >
                                        {metric.trend === 'up' ? '↗' : metric.trend === 'down' ? '↘' : '→'} {metric.change}
                                    </span>
                                )}
                                {metric.description && (
                                    <span className="sb-metric-desc">{metric.description}</span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Main Interactive Chart */}
            {renderChart()}

            {/* Key AI Insights Callout */}
            {data.insights && data.insights.length > 0 && (
                <div className="sb-primitive-insights">
                    <div className="sb-insights-header">
                        <span className="sb-insights-title">Automated AI Insights &amp; Diagnostic</span>
                    </div>
                    <ul className="sb-insights-list">
                        {data.insights.map((insight, idx) => (
                            <li key={idx} className="sb-insight-item">
                                <span className="sb-insight-bullet">●</span>
                                <span className="sb-insight-text">{insight}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
};
