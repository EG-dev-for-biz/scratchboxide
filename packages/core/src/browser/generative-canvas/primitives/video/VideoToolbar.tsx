/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import React from 'react';
import { NleTool } from '../../services/video/videoTypes';

export interface VideoToolbarProps {
    activeTool: NleTool;
    onSelectTool: (tool: NleTool) => void;
    snappingEnabled: boolean;
    onToggleSnapping: () => void;
    onSplitAtPlayhead: () => void;
    onRippleDeleteSelected: () => void;
    onAddTrack: (type: 'video' | 'audio') => void;
    zoom: number;
    onChangeZoom: (newZoom: number) => void;
    onOpenExportModal: () => void;
    canSplit: boolean;
    canDelete: boolean;
}

export const VideoToolbar: React.FC<VideoToolbarProps> = ({
    activeTool,
    onSelectTool,
    snappingEnabled,
    onToggleSnapping,
    onSplitAtPlayhead,
    onRippleDeleteSelected,
    onAddTrack,
    zoom,
    onChangeZoom,
    onOpenExportModal,
    canSplit,
    canDelete
}) => {
    return (
        <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 text-xs text-zinc-300">
            {/* Left: Editing Tools */}
            <div className="flex items-center gap-1">
                {/* Pointer / Selection Tool (V) */}
                <button
                    type="button"
                    onClick={() => onSelectTool('select')}
                    className={`sb-btn sb-btn-ghost sb-btn-xs flex items-center gap-1 px-2 py-1 rounded transition-colors ${
                        activeTool === 'select'
                            ? 'bg-blue-600 text-white font-medium'
                            : 'hover:bg-zinc-800 text-zinc-400'
                    }`}
                    title="Selection Tool (V)"
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 3l7 18 3-7 7-3L3 3z" />
                    </svg>
                    <span>Select</span>
                </button>

                {/* Razor Blade / Cut Tool (C) */}
                <button
                    type="button"
                    onClick={() => onSelectTool('cut')}
                    className={`sb-btn sb-btn-ghost sb-btn-xs flex items-center gap-1 px-2 py-1 rounded transition-colors ${
                        activeTool === 'cut'
                            ? 'bg-rose-600 text-white font-medium'
                            : 'hover:bg-zinc-800 text-zinc-400'
                    }`}
                    title="Razor Cut Tool (C)"
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="6" cy="6" r="3" />
                        <circle cx="6" cy="18" r="3" />
                        <line x1="20" y1="4" x2="8.12" y2="15.88" />
                        <line x1="14.47" y1="14.48" x2="20" y2="20" />
                        <line x1="8.12" y1="8.12" x2="12" y2="12" />
                    </svg>
                    <span>Razor</span>
                </button>

                {/* Ripple Edit Tool (B) */}
                <button
                    type="button"
                    onClick={() => onSelectTool('ripple')}
                    className={`sb-btn sb-btn-ghost sb-btn-xs flex items-center gap-1 px-2 py-1 rounded transition-colors ${
                        activeTool === 'ripple'
                            ? 'bg-amber-600 text-white font-medium'
                            : 'hover:bg-zinc-800 text-zinc-400'
                    }`}
                    title="Ripple Edit Tool (B)"
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="15 18 9 12 15 6" />
                        <polyline points="19 18 13 12 19 6" />
                    </svg>
                    <span>Ripple</span>
                </button>

                {/* Slip Tool (Y) */}
                <button
                    type="button"
                    onClick={() => onSelectTool('slip')}
                    className={`sb-btn sb-btn-ghost sb-btn-xs flex items-center gap-1 px-2 py-1 rounded transition-colors ${
                        activeTool === 'slip'
                            ? 'bg-purple-600 text-white font-medium'
                            : 'hover:bg-zinc-800 text-zinc-400'
                    }`}
                    title="Slip Tool (Y)"
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17 8l4 4m0 0l-4 4m4-4H3" />
                    </svg>
                    <span>Slip</span>
                </button>

                {/* Slide Tool (U) */}
                <button
                    type="button"
                    onClick={() => onSelectTool('slide')}
                    className={`sb-btn sb-btn-ghost sb-btn-xs flex items-center gap-1 px-2 py-1 rounded transition-colors ${
                        activeTool === 'slide'
                            ? 'bg-emerald-600 text-white font-medium'
                            : 'hover:bg-zinc-800 text-zinc-400'
                    }`}
                    title="Slide Tool (U)"
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="7 13 12 18 17 13" />
                        <polyline points="7 6 12 11 17 6" />
                    </svg>
                    <span>Slide</span>
                </button>

                <div className="w-[1px] h-4 bg-zinc-700 mx-1" />

                {/* Split at Playhead Action */}
                <button
                    type="button"
                    onClick={onSplitAtPlayhead}
                    disabled={!canSplit}
                    className={`sb-btn sb-btn-ghost sb-btn-xs px-2 py-1 rounded flex items-center gap-1 transition-colors ${
                        canSplit
                            ? 'hover:bg-zinc-800 text-zinc-200'
                            : 'text-zinc-600 cursor-not-allowed'
                    }`}
                    title="Split Clip at Playhead (Cmd+K)"
                >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="2" x2="12" y2="22" />
                    </svg>
                    <span>Split (⌘K)</span>
                </button>

                {/* Ripple Delete Selected */}
                <button
                    type="button"
                    onClick={onRippleDeleteSelected}
                    disabled={!canDelete}
                    className={`sb-btn sb-btn-ghost sb-btn-xs px-2 py-1 rounded flex items-center gap-1 transition-colors ${
                        canDelete
                            ? 'hover:bg-rose-950/40 text-rose-400 hover:text-rose-300'
                            : 'text-zinc-600 cursor-not-allowed'
                    }`}
                    title="Ripple Delete Clip (Shift+Delete)"
                >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                    <span>Delete</span>
                </button>

                {/* Snapping Toggle */}
                <button
                    type="button"
                    onClick={onToggleSnapping}
                    className={`sb-btn sb-btn-ghost sb-btn-xs px-2 py-1 rounded flex items-center gap-1 transition-colors ${
                        snappingEnabled
                            ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                            : 'hover:bg-zinc-800 text-zinc-400'
                    }`}
                    title="Toggle Magnetic Snapping (S)"
                >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
                        <path d="M12 12v9" />
                        <path d="M8 17l4 4 4-4" />
                    </svg>
                    <span>Snap</span>
                </button>
            </div>

            {/* Right: Tracks, Zoom, Export */}
            <div className="flex items-center gap-2">
                {/* Add Tracks Dropdown */}
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={() => onAddTrack('video')}
                        className="sb-btn sb-btn-secondary sb-btn-xs px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-300 transition-colors"
                        title="Add Video Track"
                    >
                        + Video
                    </button>
                    <button
                        type="button"
                        onClick={() => onAddTrack('audio')}
                        className="sb-btn sb-btn-secondary sb-btn-xs px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-300 transition-colors"
                        title="Add Audio Track"
                    >
                        + Audio
                    </button>
                </div>

                <div className="w-[1px] h-4 bg-zinc-700 mx-1" />

                {/* Zoom Controller */}
                <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-zinc-400">Zoom:</span>
                    <input
                        type="range"
                        min="15"
                        max="120"
                        value={zoom}
                        onChange={e => onChangeZoom(parseFloat(e.target.value))}
                        className="w-20 accent-blue-500 h-1 bg-zinc-700 rounded cursor-pointer"
                        title="Timeline Zoom Level"
                    />
                    <button
                        type="button"
                        onClick={() => onChangeZoom(40)}
                        className="sb-btn sb-btn-secondary sb-btn-xs px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-400"
                        title="Fit Timeline"
                    >
                        Fit
                    </button>
                </div>

                <div className="w-[1px] h-4 bg-zinc-700 mx-1" />

                {/* Export Button */}
                <button
                    type="button"
                    onClick={onOpenExportModal}
                    className="sb-btn sb-btn-primary sb-btn-xs flex items-center gap-1.5 px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs shadow-sm transition-all"
                    title="Export Timeline (OTIO / Video / Master)"
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    <span>Export</span>
                </button>
            </div>
        </div>
    );
};
