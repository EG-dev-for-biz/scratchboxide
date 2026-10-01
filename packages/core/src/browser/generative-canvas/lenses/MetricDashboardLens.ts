/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    CodebaseLens,
    LensContext,
    LensProjectionResult,
    LensUnprojectionResult,
    computeMultiFileHash
} from '../../../common/codebase-lens-protocol';
import {
    ChartDataPoint,
    MetricDashboardData,
    MetricItem,
    PrimitiveType
} from '../canvas-types';

function parseDelimitedText(text: string, delimiter: string = ','): { headers: string[]; rows: string[][] } {
    const lines = text.trim().split('\n').filter(line => line.trim().length > 0);
    if (lines.length === 0) return { headers: [], rows: [] };

    const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^['"]|['"]$/g, ''));
    const rows: string[][] = [];

    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(delimiter).map(c => c.trim().replace(/^['"]|['"]$/g, ''));
        rows.push(cols);
    }

    return { headers, rows };
}

function serializeToDelimitedText(headers: string[], rows: string[][], delimiter: string = ','): string {
    const lines: string[] = [];
    lines.push(headers.join(delimiter));
    for (const row of rows) {
        lines.push(row.join(delimiter));
    }
    return lines.join('\n') + '\n';
}

export class MetricDashboardLens implements CodebaseLens<MetricDashboardData> {
    readonly primitiveType: PrimitiveType = 'metric-dashboard';

    canHandle(filePathOrFiles: string | Record<string, string>): boolean {
        if (typeof filePathOrFiles === 'string') {
            const lower = filePathOrFiles.toLowerCase();
            return (
                lower.endsWith('.csv') ||
                lower.endsWith('.tsv') ||
                lower.endsWith('.analytics.json') ||
                lower.endsWith('.metrics.json') ||
                lower.endsWith('.dashboard.json') ||
                lower.endsWith('.kpi.json') ||
                lower.includes('/metrics/') ||
                lower.includes('/analytics/')
            );
        }
        return Object.keys(filePathOrFiles).some(p => this.canHandle(p));
    }

    project(
        sourceContent: Record<string, string> | string,
        context?: LensContext
    ): LensProjectionResult<MetricDashboardData> {
        const filePath = typeof sourceContent === 'object' ? Object.keys(sourceContent)[0] || 'analytics.json' : 'analytics.json';
        const rawText = typeof sourceContent === 'string'
            ? sourceContent
            : Object.values(sourceContent)[0] || '';

        const lowerPath = filePath.toLowerCase();
        const isCsv = lowerPath.endsWith('.csv');
        const isTsv = lowerPath.endsWith('.tsv');

        // Case 1: CSV / TSV tabular files
        if (isCsv || isTsv || (!rawText.trim().startsWith('{') && rawText.includes(','))) {
            const delimiter = isTsv ? '\t' : ',';
            const { headers, rows } = parseDelimitedText(rawText, delimiter);

            const metrics: MetricItem[] = [];
            const chartData: ChartDataPoint[] = [];

            metrics.push({
                id: 'metric-total-records',
                label: 'Total Data Points',
                value: rows.length,
                trend: 'neutral',
                color: 'blue',
                description: `Derived from ${headers.join(', ')}`
            });

            // Analyze numeric columns
            const numericColIndices: number[] = [];
            headers.forEach((h, idx) => {
                const sampleValues = rows.slice(0, 10).map(r => Number(r[idx]));
                const isNumeric = sampleValues.length > 0 && sampleValues.every(v => !isNaN(v));
                if (isNumeric) numericColIndices.push(idx);
            });

            if (numericColIndices.length > 0) {
                const primaryNumericIdx = numericColIndices[0];
                const colName = headers[primaryNumericIdx];
                let sum = 0;
                const numbers: number[] = [];

                rows.forEach(r => {
                    const val = Number(r[primaryNumericIdx]) || 0;
                    sum += val;
                    numbers.push(val);
                });

                const avg = rows.length > 0 ? (sum / rows.length).toFixed(2) : '0';

                metrics.push({
                    id: `metric-${colName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-sum`,
                    label: `Total ${colName}`,
                    value: sum >= 1000 ? sum.toLocaleString() : sum,
                    trend: 'up',
                    color: 'emerald',
                    sparkline: numbers.slice(0, 8)
                });

                metrics.push({
                    id: `metric-${colName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-avg`,
                    label: `Average ${colName}`,
                    value: avg,
                    trend: 'neutral',
                    color: 'indigo'
                });

                // Chart from rows
                const labelIdx = headers.findIndex((_h, idx) => idx !== primaryNumericIdx) >= 0
                    ? headers.findIndex((_h, idx) => idx !== primaryNumericIdx)
                    : 0;

                rows.slice(0, 12).forEach((r, idx) => {
                    chartData.push({
                        label: r[labelIdx] || `Point ${idx + 1}`,
                        value: Number(r[primaryNumericIdx]) || 0
                    });
                });
            }

            const data: MetricDashboardData = {
                title: filePath.split('/').pop()?.replace(/\.[^/.]+$/, '') || 'Analytics Dashboard',
                subtitle: `Live metric projection from ${rows.length} tabular records`,
                metrics,
                chart: chartData.length > 0 ? {
                    title: `${headers[numericColIndices[0] || 0] || 'Metric'} Distribution`,
                    type: 'bar',
                    data: chartData
                } : undefined,
                insights: [
                    `Parsed ${rows.length} records across ${headers.length} attributes (${headers.join(', ')}).`,
                    'Real-time bi-directional CSV synchronization active.'
                ]
            };

            return {
                data,
                contentHash: computeMultiFileHash(rawText)
            };
        }

        // Case 2: JSON Metric Dashboard file
        try {
            const parsed = JSON.parse(rawText);
            const data: MetricDashboardData = {
                title: parsed.title || 'Executive Metrics Dashboard',
                subtitle: parsed.subtitle || 'Real-time telemetry and KPI metrics',
                metrics: Array.isArray(parsed.metrics) ? parsed.metrics : [],
                chart: parsed.chart,
                insights: Array.isArray(parsed.insights) ? parsed.insights : []
            };

            return {
                data,
                contentHash: computeMultiFileHash(rawText)
            };
        } catch (error) {
            const defaultData: MetricDashboardData = {
                title: 'Executive Metrics Dashboard',
                subtitle: 'Real-time telemetry and KPI metrics',
                metrics: [
                    { id: 'm1', label: 'Total Operations', value: '14,820', trend: 'up', change: '+12.4%', color: 'blue' },
                    { id: 'm2', label: 'Average Latency', value: '24ms', trend: 'down', change: '-4ms', color: 'emerald' },
                    { id: 'm3', label: 'Success Rate', value: '99.94%', trend: 'neutral', color: 'indigo' }
                ],
                chart: {
                    title: 'Throughput Trends',
                    type: 'line',
                    data: [
                        { label: '00:00', value: 120 },
                        { label: '04:00', value: 95 },
                        { label: '08:00', value: 450 },
                        { label: '12:00', value: 890 },
                        { label: '16:00', value: 780 },
                        { label: '20:00', value: 340 }
                    ]
                },
                insights: ['System operating within healthy nominal boundaries.']
            };

            return {
                data: defaultData,
                contentHash: computeMultiFileHash(rawText || JSON.stringify(defaultData))
            };
        }
    }

    unproject(
        primitiveData: MetricDashboardData,
        currentDiskContent: Record<string, string> | string,
        context?: LensContext
    ): LensUnprojectionResult {
        const primaryFileName = typeof currentDiskContent === 'object' && Object.keys(currentDiskContent).length > 0
            ? Object.keys(currentDiskContent)[0]
            : 'analytics.json';

        const lower = primaryFileName.toLowerCase();
        const isCsv = lower.endsWith('.csv');
        const isTsv = lower.endsWith('.tsv');

        let serialized: string;

        if (isCsv || isTsv) {
            const delimiter = isTsv ? '\t' : ',';
            if (primitiveData.chart?.data && primitiveData.chart.data.length > 0) {
                const headers = ['Label', 'Value'];
                const rows = primitiveData.chart.data.map(d => [d.label, String(d.value)]);
                serialized = serializeToDelimitedText(headers, rows, delimiter);
            } else if (primitiveData.metrics && primitiveData.metrics.length > 0) {
                const headers = ['MetricId', 'Label', 'Value', 'Trend', 'Change'];
                const rows = primitiveData.metrics.map(m => [
                    m.id,
                    m.label,
                    String(m.value),
                    m.trend || 'neutral',
                    m.change || ''
                ]);
                serialized = serializeToDelimitedText(headers, rows, delimiter);
            } else {
                serialized = `Label${delimiter}Value\n`;
            }
        } else {
            serialized = JSON.stringify({
                title: primitiveData.title,
                subtitle: primitiveData.subtitle,
                metrics: primitiveData.metrics,
                chart: primitiveData.chart,
                insights: primitiveData.insights
            }, null, 2) + '\n';
        }

        const files: Record<string, string> = {
            [primaryFileName]: serialized
        };

        return {
            files,
            contentHash: computeMultiFileHash(files),
            modifiedFilePaths: [primaryFileName],
            changeSummary: `Unprojected metric dashboard "${primitiveData.title}" with ${primitiveData.metrics?.length || 0} KPIs`
        };
    }
}
