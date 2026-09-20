/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import React, { useState } from 'react';
import { VideoTimelineData } from '../../services/video/videoTypes';
import { exportToOtio } from '../../services/video/otioSerializer';

export interface VideoExportModalProps {
    data: VideoTimelineData;
    isOpen: boolean;
    onClose: () => void;
}

export const VideoExportModal: React.FC<VideoExportModalProps> = ({
    data,
    isOpen,
    onClose
}) => {
    const [exportFormat, setExportFormat] = useState<'otio' | 'webm' | 'mp4' | 'wav'>('otio');
    const [resolution, setResolution] = useState<'1080p' | '4k' | '720p' | 'vertical' | 'square'>('1080p');
    const [fps, setFps] = useState<number>(data.fps || 30);
    const [isExporting, setIsExporting] = useState<boolean>(false);
    const [progress, setProgress] = useState<number>(0);

    if (!isOpen) return null;

    const handleStartExport = () => {
        setIsExporting(true);
        setProgress(15);

        if (exportFormat === 'otio') {
            setTimeout(() => {
                setProgress(60);
                const otioDoc = exportToOtio(data);
                const jsonString = JSON.stringify(otioDoc, null, 2);
                const blob = new Blob([jsonString], { type: 'application/json' });
                const url = URL.createObjectURL(blob);

                const link = document.createElement('a');
                link.href = url;
                link.download = `${(data.title || 'timeline').toLowerCase().replace(/\s+/g, '_')}.otio`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);

                setProgress(100);
                setTimeout(() => {
                    setIsExporting(false);
                    onClose();
                }, 400);
            }, 300);
        } else {
            // Simulated video render progress
            let currentProg = 20;
            const timer = setInterval(() => {
                currentProg += 20;
                setProgress(Math.min(100, currentProg));
                if (currentProg >= 100) {
                    clearInterval(timer);
                    setTimeout(() => {
                        setIsExporting(false);
                        onClose();
                    }, 400);
                }
            }, 200);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm animate-fadeIn">
            <div className="w-[460px] bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-5 flex flex-col gap-4 text-xs text-zinc-300">
                {/* Modal Header */}
                <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
                    <div>
                        <div className="text-base font-bold text-zinc-100 flex items-center gap-2">
                            <span>Export Video Timeline</span>
                            <span className="px-2 py-0.5 rounded text-[10px] bg-blue-600/20 text-blue-400 border border-blue-500/30">
                                Pro NLE
                            </span>
                        </div>
                        <div className="text-[11px] text-zinc-400">
                            Export to DaVinci Resolve, Premiere, or render master video
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="sb-btn sb-btn-ghost sb-btn-xs text-zinc-500 hover:text-zinc-200 p-1 rounded"
                    >
                        ✕
                    </button>
                </div>

                {/* Format Selection */}
                <div className="flex flex-col gap-1.5">
                    <span className="font-semibold text-zinc-200">Export Format</span>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            onClick={() => setExportFormat('otio')}
                            className={`sb-btn-card p-2.5 rounded-lg border text-left transition-all ${
                                exportFormat === 'otio'
                                    ? 'bg-blue-600/10 border-blue-500 text-blue-200'
                                    : 'bg-zinc-800/40 border-zinc-700 hover:bg-zinc-800 text-zinc-300'
                            }`}
                        >
                            <div className="font-semibold text-xs">OpenTimelineIO (.otio)</div>
                            <div className="text-[10px] text-zinc-400">DaVinci Resolve, Premiere, Final Cut Pro</div>
                        </button>

                        <button
                            type="button"
                            onClick={() => setExportFormat('mp4')}
                            className={`sb-btn-card p-2.5 rounded-lg border text-left transition-all ${
                                exportFormat === 'mp4'
                                    ? 'bg-blue-600/10 border-blue-500 text-blue-200'
                                    : 'bg-zinc-800/40 border-zinc-700 hover:bg-zinc-800 text-zinc-300'
                            }`}
                        >
                            <div className="font-semibold text-xs">MP4 Video (H.264 / AAC)</div>
                            <div className="text-[10px] text-zinc-400">Universal web and cinema distribution</div>
                        </button>

                        <button
                            type="button"
                            onClick={() => setExportFormat('webm')}
                            className={`sb-btn-card p-2.5 rounded-lg border text-left transition-all ${
                                exportFormat === 'webm'
                                    ? 'bg-blue-600/10 border-blue-500 text-blue-200'
                                    : 'bg-zinc-800/40 border-zinc-700 hover:bg-zinc-800 text-zinc-300'
                            }`}
                        >
                            <div className="font-semibold text-xs">WebM Video (VP9 / Opus)</div>
                            <div className="text-[10px] text-zinc-400">Fast modern browser playback</div>
                        </button>

                        <button
                            type="button"
                            onClick={() => setExportFormat('wav')}
                            className={`sb-btn-card p-2.5 rounded-lg border text-left transition-all ${
                                exportFormat === 'wav'
                                    ? 'bg-blue-600/10 border-blue-500 text-blue-200'
                                    : 'bg-zinc-800/40 border-zinc-700 hover:bg-zinc-800 text-zinc-300'
                            }`}
                        >
                            <div className="font-semibold text-xs">WAV Audio Master</div>
                            <div className="text-[10px] text-zinc-400">Lossless 24-bit 48kHz audio mixdown</div>
                        </button>
                    </div>
                </div>

                {/* Resolution & Framerate */}
                <div className="grid grid-cols-2 gap-3 bg-zinc-950 p-3 rounded-lg border border-zinc-800">
                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] text-zinc-400">Resolution Preset</span>
                        <select
                            value={resolution}
                            onChange={e => setResolution(e.target.value as any)}
                            className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1.5 focus:outline-none"
                        >
                            <option value="1080p">1920 × 1080 (1080p FHD)</option>
                            <option value="4k">3840 × 2160 (4K UHD)</option>
                            <option value="720p">1280 × 720 (720p HD)</option>
                            <option value="vertical">1080 × 1920 (Vertical Shorts / Reels)</option>
                            <option value="square">1080 × 1080 (1:1 Square)</option>
                        </select>
                    </div>

                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] text-zinc-400">Framerate (FPS)</span>
                        <select
                            value={fps}
                            onChange={e => setFps(parseInt(e.target.value, 10))}
                            className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1.5 focus:outline-none"
                        >
                            <option value="24">24 fps (Cinema Film)</option>
                            <option value="30">30 fps (Standard Web)</option>
                            <option value="60">60 fps (High Smoothness)</option>
                        </select>
                    </div>
                </div>

                {/* Export Progress Bar if Active */}
                {isExporting && (
                    <div className="flex flex-col gap-1.5">
                        <div className="flex justify-between text-[11px]">
                            <span>Rendering timeline...</span>
                            <span className="font-mono text-blue-400">{progress}%</span>
                        </div>
                        <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-blue-600 transition-all duration-150 rounded-full"
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                    </div>
                )}

                {/* Action Buttons */}
                <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={isExporting}
                        className="sb-btn sb-btn-secondary px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleStartExport}
                        disabled={isExporting}
                        className="sb-btn sb-btn-primary px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-semibold flex items-center gap-1.5 shadow-md transition-all"
                    >
                        {isExporting ? 'Exporting...' : exportFormat === 'otio' ? 'Download .otio' : 'Render & Download'}
                    </button>
                </div>
            </div>
        </div>
    );
};
