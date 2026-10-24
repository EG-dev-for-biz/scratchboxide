/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Typed parameter controls for graph nodes, one per value kind (scene-node-params.ts ParamControl): a dropdown for a
 * value from a fixed set, a slider with its number for a ranged value, xyz fields for a vector, a toggle for a flag, a
 * swatch for a colour, a picker for a workspace file. Each commits a typed value through `onChange`.
 */

import * as React from 'react';
import type { ParamField } from '../scene-node-params';
import { WorkspaceConfigClient } from '../workspace-config-client';

const label: React.CSSProperties = { fontSize: '10px', color: 'var(--sb-text-secondary)', display: 'flex', justifyContent: 'space-between', gap: '6px' };
const input: React.CSSProperties = { width: '100%', fontSize: '11px', padding: '3px 6px', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', color: 'inherit' };
const row: React.CSSProperties = { display: 'flex', gap: '4px', alignItems: 'center' };

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const FilePicker: React.FC<{ value: string; accept: string[]; workspacePath?: string; onPick: (path: string) => void }> = ({ value, accept, workspacePath, onPick }) => {
    const [open, setOpen] = React.useState(false);
    const [files, setFiles] = React.useState<string[] | undefined>(undefined);
    const [filter, setFilter] = React.useState('');
    const [error, setError] = React.useState<string | undefined>(undefined);
    const load = async () => {
        setOpen(o => !o);
        if (files) return;
        const res = await WorkspaceConfigClient.getInstance().findFiles(accept, workspacePath);
        if (!res.success) { setError(res.error || 'Could not list the workspace'); return; }
        setFiles(res.files || []);
    };
    const root = '';
    const shown = (files || []).filter(f => f.toLowerCase().includes(filter.toLowerCase())).slice(0, 60);
    return (
        <div>
            <div style={row}>
                <input style={input} aria-label={`File path (${accept.join(', ')})`} value={value} placeholder={`a ${accept.join(' / ')} file`} onChange={e => onPick(e.target.value)} />
                <button type="button" className="sb-btn" style={{ fontSize: '10px', padding: '2px 6px' }} onClick={() => { void load(); }} title={`Pick a ${accept.join(' / ')} file from the workspace`}>Browse</button>
            </div>
            {open && (
                <div style={{ marginTop: '4px', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '4px', maxHeight: '160px', overflow: 'auto', fontSize: '10px' }}>
                    {error && <span style={{ color: 'var(--sb-system-rose, #ff375f)' }}>{error}</span>}
                    {!files && !error && <span style={{ color: 'var(--sb-text-tertiary)' }}>Listing…</span>}
                    {files && <input style={{ ...input, marginBottom: '4px' }} placeholder="Filter" value={filter} onChange={e => setFilter(e.target.value)} />}
                    {files && shown.length === 0 && <span style={{ color: 'var(--sb-text-tertiary)' }}>No {accept.join(' / ')} files</span>}
                    {shown.map(f => {
                        const rel = f.startsWith(root) ? f.slice(root.length) : f;
                        return (
                            <button key={f} type="button" className="sb-btn" style={{ display: 'block', width: '100%', textAlign: 'left', fontSize: '10px', padding: '2px 4px', fontFamily: 'var(--sb-font-mono, monospace)' }}
                                onClick={() => { onPick(rel); setOpen(false); }} title={rel}>{rel}</button>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export interface ParamFieldControlProps {
    field: ParamField;
    onChange: (value: unknown) => void;
    workspacePath?: string;
}

export const ParamFieldControl: React.FC<ParamFieldControlProps> = ({ field, onChange, workspacePath }) => {
    const c = field.control;
    const unit = 'unit' in c && c.unit ? c.unit : undefined;
    const head = (
        <label style={label} title={field.hint}>
            <span>{field.label}</span>
            {unit && <span style={{ opacity: 0.6 }}>{unit}</span>}
        </label>
    );
    let body: React.ReactNode;
    switch (c.kind) {
        case 'select':
            body = (
                <select style={input} aria-label={field.label} value={String(field.value ?? '')} onChange={e => onChange(e.target.value)}>
                    {c.options.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
            );
            break;
        case 'slider': {
            const v = num(field.value, c.min);
            body = (
                <div style={row}>
                    <input type="range" min={c.min} max={c.max} step={c.step} value={v} style={{ flex: 1 }} onChange={e => onChange(Number(e.target.value))} aria-label={field.label} />
                    <input type="number" min={c.min} max={c.max} step={c.step} value={v} style={{ ...input, width: '64px' }} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(n); }} aria-label={`${field.label} value`} />
                </div>
            );
            break;
        }
        case 'number':
            body = <input type="number" aria-label={field.label} step={c.step} style={input} value={num(field.value)} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(n); }} />;
            break;
        case 'toggle':
            body = (
                <button type="button" role="switch" aria-checked={!!field.value} aria-label={field.label} className="sb-btn" onClick={() => onChange(!field.value)}
                    style={{ fontSize: '10px', padding: '2px 10px', ...(field.value ? { background: 'rgba(10,132,255,0.3)', borderColor: 'rgba(10,132,255,0.6)' } : {}) }}>
                    {field.value ? 'On' : 'Off'}
                </button>
            );
            break;
        case 'vec3': {
            const v = Array.isArray(field.value) ? field.value as number[] : [0, 0, 0];
            body = (
                <div style={row}>
                    {['x', 'y', 'z'].map((axis, i) => (
                        <label key={axis} style={{ ...row, flex: 1, fontSize: '10px', color: 'var(--sb-text-tertiary)' }}>
                            <span>{axis}</span>
                            <input type="number" step={c.step ?? 0.1} value={num(v[i])} style={{ ...input, padding: '2px 4px' }} aria-label={`${field.label} ${axis}`}
                                onChange={e => { const n = Number(e.target.value); if (!Number.isFinite(n)) return; const next = [num(v[0]), num(v[1]), num(v[2])]; next[i] = n; onChange(next); }} />
                        </label>
                    ))}
                </div>
            );
            break;
        }
        case 'color': {
            const v = typeof field.value === 'string' ? field.value : '';
            body = (
                <div style={row}>
                    <input type="color" value={/^#[0-9a-f]{6}$/i.test(v) ? v : '#cccccc'} onChange={e => onChange(e.target.value)} style={{ width: '36px', height: '22px', padding: 0, border: 'none', background: 'none' }} aria-label={field.label} />
                    <span style={{ fontSize: '10px', fontFamily: 'var(--sb-font-mono, monospace)', color: 'var(--sb-text-secondary)' }}>{v || 'none'}</span>
                    {v && <button type="button" className="sb-btn" style={{ fontSize: '10px', padding: '1px 6px' }} onClick={() => onChange('')} title="Clear">Clear</button>}
                </div>
            );
            break;
        }
        case 'file':
            body = <FilePicker value={String(field.value ?? '')} accept={c.accept} workspacePath={workspacePath} onPick={onChange} />;
            break;
        case 'json':
            body = <textarea rows={3} style={{ ...input, fontFamily: 'var(--sb-font-mono, monospace)' }} defaultValue={field.value === undefined ? '' : JSON.stringify(field.value, null, 1)}
                onBlur={e => { try { onChange(e.target.value.trim() ? JSON.parse(e.target.value) : undefined); } catch { /* the form keeps the text; nothing is written */ } }} />;
            break;
        default:
            body = <input style={input} aria-label={field.label} value={String(field.value ?? '')} onChange={e => onChange(e.target.value)} />;
    }
    return <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', margin: '6px 0' }}>{head}{body}</div>;
};

/** A node's fields as one panel (the scene node inspector). */
export const ParamPanel: React.FC<{ title?: string; fields: ParamField[]; onChange: (key: string, value: unknown) => void; workspacePath?: string }> = ({ title, fields, onChange, workspacePath }) => (
    <div onMouseDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
        {title && <span className="sb-params-section-title">{title}</span>}
        {fields.map(f => <ParamFieldControl key={f.key} field={f} workspacePath={workspacePath} onChange={v => onChange(f.key, v)} />)}
    </div>
);
