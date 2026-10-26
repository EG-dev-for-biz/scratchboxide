/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * useDataFileAttachments
 *
 * Global drag-and-drop (SKILL.md + CSV/data files), CSV parsing and the attached data-file composer state.
 *
 * Extracted verbatim from GenerativeCanvasStudio.tsx.
 */
import * as React from 'react';
import { ChatStore } from '../state/chatStore';
import { CanvasArtifact, ChartDataPoint, MetricItem, SkillItem } from '../canvas-types';

export interface UseDataFileAttachmentsDeps {
    inputRef: React.RefObject<HTMLTextAreaElement>;
    recordArtifactVersion: (art: CanvasArtifact) => void;
    setActiveArtifact: ChatStore['setActiveArtifact'];
    setArtifactHistory: ChatStore['setArtifactHistory'];
    setInputValue: React.Dispatch<React.SetStateAction<string>>;
    setSelectedSkillIds?: React.Dispatch<React.SetStateAction<string[]>>;
    setSkills?: React.Dispatch<React.SetStateAction<SkillItem[]>>;
    showToast: (text: string, icon?: string) => void;
}

export function useDataFileAttachments(deps: UseDataFileAttachmentsDeps) {
    const { inputRef, recordArtifactVersion, setActiveArtifact, setArtifactHistory, setInputValue, showToast } = deps;

    // CSV & data file state
    const [isDraggingDataFile, setIsDraggingDataFile] = React.useState<boolean>(false);
    const [attachedDataFile, setAttachedDataFile] = React.useState<{
        name: string;
        size: number;
        rowsCount: number;
        headers: string[];
        rawText: string;
        parsedRows: Record<string, any>[];
        summaryMetrics: MetricItem[];
        chartData?: ChartDataPoint[];
    } | undefined>(undefined);

    // CSV & Data File Parsing Engine
    const parseCSVContent = (content: string, filename: string, fileSize: number) => {
        const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
        if (lines.length === 0) {
            return {
                name: filename,
                size: fileSize,
                rowsCount: 0,
                headers: [],
                rawText: content,
                parsedRows: [],
                summaryMetrics: []
            };
        }

        const firstLine = lines[0];
        const commaCount = (firstLine.match(/,/g) || []).length;
        const tabCount = (firstLine.match(/\t/g) || []).length;
        const semiCount = (firstLine.match(/;/g) || []).length;
        const delimiter = tabCount > commaCount ? '\t' : (semiCount > commaCount ? ';' : ',');

        const parseLine = (line: string): string[] => {
            const result: string[] = [];
            let current = '';
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                if (char === '"' || char === "'") {
                    inQuotes = !inQuotes;
                } else if (char === delimiter && !inQuotes) {
                    result.push(current.trim().replace(/^["']|["']$/g, ''));
                    current = '';
                } else {
                    current += char;
                }
            }
            result.push(current.trim().replace(/^["']|["']$/g, ''));
            return result;
        };

        const headers = parseLine(lines[0]);
        const parsedRows: Record<string, any>[] = [];

        for (let i = 1; i < lines.length; i++) {
            const values = parseLine(lines[i]);
            if (values.length === 0 || (values.length === 1 && !values[0])) continue;
            const row: Record<string, any> = {};
            headers.forEach((h, idx) => {
                const val = values[idx] !== undefined ? values[idx] : '';
                const numVal = Number(val.replace(/[\$,%]/g, ''));
                row[h] = !isNaN(numVal) && val.trim() !== '' ? numVal : val;
            });
            parsedRows.push(row);
        }

        const numericCols = headers.filter(h => {
            const numCount = parsedRows.filter(r => typeof r[h] === 'number').length;
            return numCount >= Math.min(parsedRows.length * 0.5, 1);
        });

        const categoricalCols = headers.filter(h => !numericCols.includes(h));
        const labelCol = categoricalCols[0] || headers[0];
        const primaryNumCol = numericCols[0] || (headers.length > 1 ? headers[1] : headers[0]);

        const summaryMetrics: MetricItem[] = [
            {
                id: 'm-rows',
                label: 'Total Rows',
                value: parsedRows.length.toLocaleString(),
                trend: 'up',
                change: `${headers.length} attributes`,
                badge: 'Live Data',
                color: 'blue'
            }
        ];

        numericCols.slice(0, 3).forEach((col, idx) => {
            const nums = parsedRows.map(r => Number(r[col])).filter(n => !isNaN(n));
            if (nums.length > 0) {
                const sum = nums.reduce((a, b) => a + b, 0);
                const avg = sum / nums.length;
                const max = Math.max(...nums);
                const color: any = idx === 0 ? 'emerald' : idx === 1 ? 'indigo' : 'purple';
                const sparkline = nums.slice(0, 8);

                summaryMetrics.push({
                    id: `m-num-${idx}`,
                    label: `Total ${col}`,
                    value: sum > 1000000 ? `$${(sum / 1000000).toFixed(2)}M` : (sum > 1000 ? `$${(sum / 1000).toFixed(1)}k` : sum.toLocaleString()),
                    change: `Avg: ${avg.toFixed(1)} | Peak: ${max.toLocaleString()}`,
                    trend: 'up',
                    color,
                    sparkline
                });
            }
        });

        let chartData: ChartDataPoint[] = [];
        if (parsedRows.length > 0) {
            chartData = parsedRows.slice(0, 10).map((r, i) => ({
                label: String(r[labelCol] || `Row ${i + 1}`).slice(0, 16),
                value: Number(r[primaryNumCol]) || (i + 1) * 15
            }));
        }

        return {
            name: filename,
            size: fileSize,
            rowsCount: parsedRows.length,
            headers,
            rawText: content,
            parsedRows,
            summaryMetrics,
            chartData
        };
    };

    const handleFileDrop = (file: File) => {
        const reader = new FileReader();
        reader.onload = e => {
            const text = e.target?.result as string;
            if (file.name.endsWith('.csv') || file.name.endsWith('.tsv') || file.name.endsWith('.txt')) {
                const parsed = parseCSVContent(text, file.name, file.size);
                setAttachedDataFile(parsed);
                setInputValue(`Analyze ${file.name} and build an interactive KPI Metric Dashboard & Data Table with performance charts!`);
                showToast(`📊 Attached ${file.name} (${parsed.rowsCount} rows)`);
                inputRef.current?.focus();
            } else if (file.name.endsWith('.json')) {
                try {
                    const json = JSON.parse(text);
                    if (json.title && json.type && json.data) {
                        setActiveArtifact(json);
                        recordArtifactVersion(json);
                        setArtifactHistory(prev => [json, ...prev.filter(a => a.id !== json.id)]);
                        showToast(`Loaded canvas artifact "${json.title}"`);
                        return;
                    }
                } catch {
                    // Ignore JSON parse errors
                }
                showToast(`Attached ${file.name}`);
            }
        };
        reader.readAsText(file);
    };

    return { attachedDataFile, handleFileDrop, isDraggingDataFile, setAttachedDataFile, setIsDraggingDataFile };
}
