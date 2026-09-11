/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** McpTab content of the Customize settings group. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { IconCheck, IconGoogleDriveColor, IconSparkles } from '../../canvas-icons';
import { GoogleDriveService } from '../../google-drive-service';
import { McpHubPrimitive } from '../../primitives/McpHubPrimitive';
import { useSettingsContext } from '../SettingsContext';

export const McpTab: React.FC = () => {
    const { gdriveFeedback, gdriveState, handleSaveMapsKey, handleTestMapsKey, isConnectingGdrive, isTestingMapsKey, mapsFeedback, mapsKeyInput, mapsState, mcpServers, onMcpServersChange, setGdriveFeedback, setIsConnectingGdrive, setMapsKeyInput } = useSettingsContext();
    return (
        <div className="space-y-4">
            {/* Google Drive & Docs Integration Card */}
            <div className="sb-cursor-group-card p-4 space-y-3 bg-zinc-900/90 border border-zinc-800 rounded-2xl shadow-lg">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                            <IconGoogleDriveColor size={22} />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h4 className="text-xs font-semibold text-zinc-100 flex items-center gap-1.5">
                                    <span>Google Drive &amp; Docs Integration</span>
                                </h4>
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${gdriveState.status === 'connected' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}>
                                    {gdriveState.status === 'connected' ? `Connected as ${gdriveState.accountEmail}` : 'Disconnected'}
                                </span>
                            </div>
                            <p className="text-[11px] text-zinc-400 mt-0.5">
                                Export documents to Google Docs, manage Drive files, real-time sync &amp; search.
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        {gdriveState.status === 'connected' ? (
                            <button
                                type="button"
                                className="sb-btn sb-btn-danger sb-btn-xs"
                                onClick={async () => {
                                    await GoogleDriveService.getInstance().disconnect();
                                    setGdriveFeedback('Google Drive disconnected');
                                    setTimeout(() => setGdriveFeedback(null), 3000);
                                }}
                            >
                                <span>Disconnect</span>
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="sb-btn sb-btn-primary sb-btn-xs bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-1"
                                disabled={isConnectingGdrive}
                                onClick={async () => {
                                    setIsConnectingGdrive(true);
                                    try {
                                        await GoogleDriveService.getInstance().connect();
                                        setGdriveFeedback('✓ Connected to Google Drive');
                                        setTimeout(() => setGdriveFeedback(null), 3000);
                                    } finally {
                                        setIsConnectingGdrive(false);
                                    }
                                }}
                            >
                                <IconSparkles size={11} />
                                <span>{isConnectingGdrive ? 'Connecting...' : 'Connect Google Drive'}</span>
                            </button>
                        )}
                    </div>
                </div>

                {gdriveFeedback && (
                    <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400 text-xs font-medium flex items-center gap-1.5 animate-fadeIn">
                        <IconCheck size={12} />
                        <span>{gdriveFeedback}</span>
                    </div>
                )}

                {/* Auto-Sync & Storage Row */}
                <div className="pt-2 border-t border-zinc-800/80 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                        <span className="text-zinc-300 font-medium">Auto-Sync Document Specs:</span>
                        <span className="text-zinc-400 text-[11px]">Automatically uploads document updates to Google Drive</span>
                    </div>
                    <label className="sb-toggle-switch">
                        <input
                            type="checkbox"
                            checked={gdriveState.autoSyncEnabled}
                            onChange={e => GoogleDriveService.getInstance().toggleAutoSync(e.target.checked)}
                        />
                        <span className="sb-toggle-slider" />
                    </label>
                </div>

                {/* Available Tools Grid */}
                <div className="pt-2 border-t border-zinc-800/80 space-y-1.5">
                    <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                        Active MCP Tools (4 Available)
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        {[
                            { name: 'create_document', title: 'Create & Export Google Doc', desc: 'Converts markdown specifications into formatted Google Docs' },
                            { name: 'upload_file', title: 'Upload File to Google Drive', desc: 'Uploads markdown files and datasets to Drive folders' },
                            { name: 'list_drive_files', title: 'List Files in Google Drive', desc: 'Lists and filters documents and spreadsheets in Drive' },
                            { name: 'search_drive', title: 'Search Google Drive Knowledge', desc: 'Full-text semantic search across Google Drive files' }
                        ].map((tool, tIdx) => (
                            <div key={tIdx} className="p-2.5 bg-zinc-950/60 rounded-xl border border-zinc-800/80 text-xs flex flex-col justify-between">
                                <div className="flex items-center justify-between">
                                    <span className="font-mono text-blue-400 font-medium text-[11px]">{tool.name}</span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20">MCP Tool</span>
                                </div>
                                <div className="text-zinc-200 font-medium mt-1 text-[11px]">{tool.title}</div>
                                <div className="text-zinc-500 text-[10px] mt-0.5">{tool.desc}</div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Google Maps & Geospatial Intelligence Integration Card */}
            <div className="sb-cursor-group-card p-4 space-y-3 bg-zinc-900/90 border border-zinc-800 rounded-2xl shadow-lg">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-xl">
                            🗺️
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h4 className="text-xs font-semibold text-zinc-100 flex items-center gap-1.5">
                                    <span>Google Maps &amp; Geospatial Intelligence</span>
                                </h4>
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${mapsState.status === 'ready' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}>
                                    {mapsState.status === 'ready' ? 'Active / Configured' : 'Procedural Fallback Mode'}
                                </span>
                            </div>
                            <p className="text-[11px] text-zinc-400 mt-0.5">
                                High-resolution Static Maps, Photorealistic 3D Tiles, Places geocoding, and live responsive map embeds.
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            className="sb-btn sb-btn-secondary sb-btn-xs"
                            onClick={handleTestMapsKey}
                            disabled={isTestingMapsKey}
                        >
                            {isTestingMapsKey ? 'Testing...' : 'Test Geocode'}
                        </button>
                    </div>
                </div>

                {/* API Key Input Line */}
                <div className="pt-2 border-t border-zinc-800/80 flex items-center gap-2">
                    <label className="text-[11px] text-zinc-400 shrink-0">API Key:</label>
                    <input
                        type="password"
                        className="flex-1 bg-zinc-950/80 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-blue-500"
                        placeholder="Paste Google Maps API Key (AIzaSy...)"
                        value={mapsKeyInput}
                        onChange={e => setMapsKeyInput(e.target.value)}
                    />
                    <button
                        type="button"
                        className="sb-btn sb-btn-primary sb-btn-xs bg-blue-600 hover:bg-blue-500 text-white"
                        onClick={handleSaveMapsKey}
                    >
                        Save
                    </button>
                </div>

                {mapsFeedback && (
                    <div className={`p-2 rounded-lg text-xs font-medium flex items-center gap-1.5 animate-fadeIn ${mapsFeedback.error ? 'bg-rose-500/10 border border-rose-500/20 text-rose-400' : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'}`}>
                        <IconCheck size={12} />
                        <span>{mapsFeedback.message}</span>
                    </div>
                )}

                {/* Available Tools Grid */}
                <div className="pt-2 border-t border-zinc-800/80 space-y-1.5">
                    <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                        Active Geospatial MCP Tools (4 Available)
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        {[
                            { name: 'maps_geocode', title: 'Geocoding & Place Search', desc: 'Resolves landmarks & addresses to exact lat/lng and elevation datums' },
                            { name: 'maps_static_imagery', title: 'Static Maps & Satellite', desc: 'Generates high-res static roadmap, satellite, and terrain visuals' },
                            { name: 'maps_3d_tiles', title: 'Photorealistic 3D Tiles', desc: 'Streams Google 3D geospatial mesh tiles for 3D viewports' },
                            { name: 'maps_interactive_embed', title: 'Live Map Embeds', desc: 'Interactive panoramic maps, street views, and navigation routes' }
                        ].map((tool, tIdx) => (
                            <div key={tIdx} className="p-2.5 bg-zinc-950/60 rounded-xl border border-zinc-800/80 text-xs flex flex-col justify-between">
                                <div className="flex items-center justify-between">
                                    <span className="font-mono text-emerald-400 font-medium text-[11px]">{tool.name}</span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">Maps API</span>
                                </div>
                                <div className="text-zinc-200 font-medium mt-1 text-[11px]">{tool.title}</div>
                                <div className="text-zinc-500 text-[10px] mt-0.5">{tool.desc}</div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* General MCP Hub Primitive */}
            <McpHubPrimitive
                data={{
                    title: 'Live Connections (MCP)',
                    subtitle: 'Model Context Protocol tool endpoints',
                    servers: mcpServers
                }}
                onToggleServer={(id: string, enabled: boolean) => {
                    const updated = mcpServers.map(s => s.id === id ? { ...s, isEnabled: enabled } : s);
                    onMcpServersChange(updated);
                }}
            />
        </div>
    );
};
