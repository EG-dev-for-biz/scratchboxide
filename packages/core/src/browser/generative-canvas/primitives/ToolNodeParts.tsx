/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Tool node parts for NodeGraphPrimitive: the card body (inputs, run state, output) and the inspector form, which is
 * generated from the tool's own parameter declaration.
 */

import * as React from 'react';
import type { GraphNode } from '../canvas-types';
import type { ToolNodeCatalogEntry, ToolNodeParameterSchema } from '../../../common/tool-node-protocol';
import { summarizeToolOutput } from '../../../common/tool-node-graph';
import { ParamFieldControl } from './ParamControls';
import type { ParamField } from '../scene-node-params';

const box: React.CSSProperties = {
    margin: '8px 0', borderRadius: '8px', border: '1px dashed rgba(255, 255, 255, 0.15)', background: 'rgba(0, 0, 0, 0.2)',
    padding: '6px 8px', fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px'
};
const chip: React.CSSProperties = {
    fontSize: '9px', padding: '1px 4px', borderRadius: '3px', background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.1)', color: 'var(--sb-text-secondary)', fontFamily: 'var(--sb-font-mono, monospace)'
};

export interface ToolNodeCardBodyProps {
    node: GraphNode;
    entry?: ToolNodeCatalogEntry;
    running: boolean;
    /** The tool's latest progress line while it runs. */
    progress?: string;
    onRun: () => void;
    onStop: () => void;
}

export const ToolNodeCardBody: React.FC<ToolNodeCardBodyProps> = ({ node, entry, running, progress, onRun, onStop }) => {
    const toolName: string = node.parameters?.toolName;
    const own = Object.entries(node.parameters?.toolArgs || {}).filter(([, v]) => v !== undefined && v !== '');
    const filled: Record<string, string> = node.outputData?.filledFrom || {};
    // required inputs neither set on the node nor filled from upstream on its last run
    const required = (entry?.parameters?.required || []).filter(r => !(r in filled));
    const summary = summarizeToolOutput(node.outputData?.resultPayload);
    return (
        <div className="sb-node-custom-body sb-body-tool" style={box} onMouseDown={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                <span style={{ ...chip, fontSize: '10px' }}>{toolName}</span>
                {running ? (
                    <button type="button" className="sb-btn" style={{ fontSize: '10px', padding: '1px 8px' }} onClick={onStop} title="Stop this tool run">Stop</button>
                ) : (
                    <button type="button" className="sb-btn" style={{ fontSize: '10px', padding: '1px 8px' }} onClick={onRun} disabled={!entry} title={entry ? `Run ${toolName}` : 'Tool not found in the catalog'}>Run</button>
                )}
            </div>
            {!entry && <span style={{ color: 'var(--sb-system-rose, #ff375f)' }}>Not in the tool catalog</span>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                {own.slice(0, 4).map(([k]) => <span key={k} style={chip}>{k}</span>)}
                {own.length > 4 && <span style={chip}>+{own.length - 4}</span>}
                {own.length === 0 && Object.keys(filled).length === 0 && <span style={{ color: 'var(--sb-text-tertiary)' }}>{required.length ? `Needs ${required.join(', ')} (set it or connect a node that outputs it)` : 'No inputs set'}</span>}
            </div>
            {running && progress && <span style={{ color: 'var(--sb-text-secondary)', wordBreak: 'break-word' }}>{progress.slice(0, 200)}</span>}
            {node.status === 'error' && node.errorMessage && (
                <span style={{ color: 'var(--sb-system-rose, #ff375f)', wordBreak: 'break-word' }}>{node.errorMessage.slice(0, 240)}</span>
            )}
            {node.status === 'completed' && (
                <>
                    {node.outputData?.summary && <span style={{ color: 'var(--sb-text-secondary)' }}>{String(node.outputData.summary).slice(0, 160)}</span>}
                    {summary.fields.slice(0, 3).map(f => (
                        <span key={f.key} style={{ color: 'var(--sb-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.key}: {f.value}</span>
                    ))}
                    {summary.files.slice(0, 2).map(f => <span key={f} style={{ ...chip, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f}>{f.split('/').pop()}</span>)}
                </>
            )}
            {Object.keys(filled).length > 0 && (
                <span style={{ fontSize: '9px', color: 'var(--sb-text-tertiary)' }}>From upstream: {Object.keys(filled).join(', ')}</span>
            )}
        </div>
    );
};

export interface ToolNodeInspectorProps {
    node: GraphNode;
    entry?: ToolNodeCatalogEntry;
    onArgsChange: (args: Record<string, unknown>) => void;
    workspacePath?: string;
}

/** File types a parameter's own description names (".glb", ".png"): such a string parameter gets a file picker. */
function fileTypesIn(description: string | undefined): string[] {
    return [...new Set((description || '').toLowerCase().match(/\.(glb|gltf|ply|spz|obj|fbx|usdz?|png|jpe?g|webp|exr|hdr|mp4|mov|wav|json)\b/g) || [])];
}

/** A tool parameter as a typed control, from its declaration: an empty value means "from upstream, or the tool's default". */
export function toolParamField(key: string, schema: ToolNodeParameterSchema, value: unknown, required: boolean): ParamField {
    const label = `${key}${required ? ' *' : ''}`;
    if (schema.enum?.length) return { key, label, hint: schema.description, control: { kind: 'select', options: ['', ...schema.enum] }, value: value ?? '' };
    if (schema.type === 'BOOLEAN') return { key, label, hint: schema.description, control: { kind: 'toggle' }, value: value === true };
    if (schema.type === 'NUMBER') return { key, label, hint: schema.description, control: { kind: 'number' }, value };
    if (schema.type === 'OBJECT' || schema.type === 'ARRAY') return { key, label, hint: schema.description, control: { kind: 'json' }, value };
    const files = fileTypesIn(schema.description);
    if (files.length) return { key, label, hint: schema.description, control: { kind: 'file', accept: files }, value: value ?? '' };
    return { key, label, hint: schema.description, control: { kind: 'text' }, value: value ?? '' };
}

/** One control per declared parameter; empty inputs are filled from upstream at run time. */
export const ToolNodeInspector: React.FC<ToolNodeInspectorProps> = ({ node, entry, onArgsChange, workspacePath }) => {
    const args: Record<string, unknown> = node.parameters?.toolArgs || {};
    const props = entry?.parameters?.properties || {};
    const required = new Set(entry?.parameters?.required || []);
    if (!entry) return <div className="sb-category-params-block"><span className="sb-params-section-title">Tool {node.parameters?.toolName} is not in the catalog</span></div>;
    const keys = Object.keys(props);
    const set = (key: string, value: unknown) => {
        const next = { ...args };
        if (value === undefined || value === '' || (value === false && props[key]?.type === 'BOOLEAN' && args[key] === undefined)) delete next[key]; else next[key] = value;
        onArgsChange(next);
    };
    return (
        <div className="sb-category-params-block">
            <span className="sb-params-section-title">{entry.name}</span>
            <p style={{ fontSize: '11px', color: 'var(--sb-text-secondary)', margin: '0 0 8px', maxHeight: '96px', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{entry.description}</p>
            {keys.length === 0 && <span style={{ fontSize: '11px', color: 'var(--sb-text-tertiary)' }}>This tool takes no inputs.</span>}
            {keys.map(key => (
                <ParamFieldControl key={key} field={toolParamField(key, props[key], args[key], required.has(key))} workspacePath={workspacePath} onChange={v => set(key, v)} />
            ))}
        </div>
    );
};
