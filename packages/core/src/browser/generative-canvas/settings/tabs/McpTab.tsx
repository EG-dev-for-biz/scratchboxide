/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { IconCheck, IconGlobe, IconGoogleDriveColor, IconSparkles } from '../../canvas-icons';
import { GoogleDriveService } from '../../google-drive-service';
import { McpHubPrimitive } from '../../primitives/McpHubPrimitive';
import { useSettingsContext } from '../SettingsContext';

export const McpTab: React.FC = () => {
    const {
        gdriveState,
        isConnectingGdrive,
        gdriveFeedback,
        setGdriveFeedback,
        setIsConnectingGdrive,
        handleSaveMapsKey,
        handleTestMapsKey,
        isTestingMapsKey,
        mapsFeedback,
        mapsKeyInput,
        mapsState,
        mcpServers,
        onMcpServersChange,
        setMapsKeyInput
    } = useSettingsContext();

    return (
        <div className="sb-cursor-settings-content animate-fadeIn space-y-4">
            <h2 className="sb-cursor-content-title">MCP Tools &amp; Integrations</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
                Model Context Protocol endpoints, custom tool servers, and live Google Maps geospatial connections.
            </p>

            {/* Google Drive & Docs Integration Card */}
            <div className="sb-cursor-group-card">
                <div className="sb-cursor-row-item">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                            <IconGoogleDriveColor size={22} />
                        </div>
                        <div className="sb-cursor-row-info">
                            <div className="flex items-center gap-2">
                                <span className="sb-cursor-row-title">Google Drive &amp; Docs Integration</span>
                                <span className={`sb-badge-unified ${gdriveState.status === 'connected' ? 'sb-badge-emerald' : 'sb-badge-zinc'}`}>
                                    {gdriveState.status === 'connected' ? `Connected as ${gdriveState.accountEmail}` : 'Disconnected'}
                                </span>
                            </div>
                            <div className="sb-cursor-row-desc">
                                Export documents to Google Docs, manage Drive files, real-time sync &amp; search.
                            </div>
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
                    <div className="p-2.5 mx-3 mb-2 rounded-lg text-xs font-medium flex items-center gap-1.5 animate-fadeIn bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                        <IconCheck size={12} />
                        <span>{gdriveFeedback}</span>
                    </div>
                )}

                {/* Auto-Sync & Storage Row */}
                <div className="sb-cursor-row-item border-t border-zinc-200 dark:border-zinc-800/80">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Auto-Sync Document Specs</div>
                        <div className="sb-cursor-row-desc">Automatically uploads document updates to Google Drive</div>
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
                <div className="p-3 border-t border-zinc-200 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-950/30">
                    <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2">
                        Active MCP Tools (4 Available)
                    </div>
                    <div className="sb-cursor-tool-grid">
                        {[
                            { name: 'create_document', title: 'Create & Export Google Doc', desc: 'Converts markdown specifications into formatted Google Docs' },
                            { name: 'upload_file', title: 'Upload File to Google Drive', desc: 'Uploads markdown files and datasets to Drive folders' },
                            { name: 'list_drive_files', title: 'List Files in Google Drive', desc: 'Lists and filters documents and spreadsheets in Drive' },
                            { name: 'search_drive', title: 'Search Google Drive Knowledge', desc: 'Full-text semantic search across Google Drive files' }
                        ].map((tool, tIdx) => (
                            <div key={tIdx} className="sb-cursor-tool-card text-xs">
                                <div className="flex items-center justify-between">
                                    <span className="font-mono text-blue-600 dark:text-blue-400 font-medium text-xs">{tool.name}</span>
                                    <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-300 border border-blue-500/20 font-medium">MCP Tool</span>
                                </div>
                                <div className="text-zinc-800 dark:text-zinc-200 font-medium mt-1 text-xs">{tool.title}</div>
                                <div className="text-zinc-500 dark:text-zinc-400 text-xs mt-0.5">{tool.desc}</div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Google Maps & Geospatial Intelligence Integration Card */}
            <div className="sb-cursor-group-card">
                <div className="sb-cursor-row-item">
                    <div className="flex items-center gap-3">
                        <div className="sb-icon-box bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            <IconGlobe size={20} className="text-emerald-400" />
                        </div>
                        <div className="sb-cursor-row-info">
                            <div className="flex items-center gap-2">
                                <span className="sb-cursor-row-title">Google Maps &amp; Geospatial Intelligence</span>
                                <span className={`sb-badge-unified ${mapsState.status === 'ready' ? 'sb-badge-emerald' : 'sb-badge-zinc'}`}>
                                    {mapsState.status === 'ready' ? 'Active / Configured' : 'Procedural Fallback Mode'}
                                </span>
                            </div>
                            <div className="sb-cursor-row-desc">
                                High-resolution Static Maps, Photorealistic 3D Tiles, Places geocoding, and live responsive map embeds.
                            </div>
                        </div>
                    </div>

                    <div>
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
                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Maps API Key</div>
                        <div className="sb-cursor-row-desc">Google Maps Platform credentials for photorealistic 3D streaming and geocoding</div>
                    </div>
                    <div className="flex items-center gap-2">
                        <input
                            type="password"
                            className="sb-cursor-text-input w-64 font-mono"
                            placeholder="AIzaSy..."
                            value={mapsKeyInput}
                            onChange={e => setMapsKeyInput(e.target.value)}
                        />
                        <button
                            type="button"
                            className="sb-btn sb-btn-primary sb-btn-xs"
                            onClick={handleSaveMapsKey}
                        >
                            Save
                        </button>
                    </div>
                </div>

                {mapsFeedback && (
                    <div className={`p-2.5 mx-3 mb-2 rounded-lg text-xs font-medium flex items-center gap-1.5 animate-fadeIn ${mapsFeedback.error ? 'bg-rose-500/10 border border-rose-500/20 text-rose-400' : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'}`}>
                        <IconCheck size={12} />
                        <span>{mapsFeedback.message}</span>
                    </div>
                )}

                {/* Available Tools Grid */}
                <div className="p-3 border-t border-zinc-200 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-950/30">
                    <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2">
                        Active Geospatial MCP Tools (4 Available)
                    </div>
                    <div className="sb-cursor-tool-grid">
                        {[
                            { name: 'maps_geocode', title: 'Geocoding & Place Search', desc: 'Resolves landmarks & addresses to exact lat/lng and elevation datums' },
                            { name: 'maps_static_imagery', title: 'Static Maps & Satellite', desc: 'Generates high-res static roadmap, satellite, and terrain visuals' },
                            { name: 'maps_3d_tiles', title: 'Photorealistic 3D Tiles', desc: 'Streams Google 3D geospatial mesh tiles for 3D viewports' },
                            { name: 'maps_interactive_embed', title: 'Live Map Embeds', desc: 'Interactive panoramic maps, street views, and navigation routes' }
                        ].map((tool, tIdx) => (
                            <div key={tIdx} className="sb-cursor-tool-card text-xs">
                                <div className="flex items-center justify-between">
                                    <span className="font-mono text-emerald-600 dark:text-emerald-400 font-medium text-xs">{tool.name}</span>
                                    <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border border-emerald-500/20 font-medium">Maps API</span>
                                </div>
                                <div className="text-zinc-800 dark:text-zinc-200 font-medium mt-1 text-xs">{tool.title}</div>
                                <div className="text-zinc-500 dark:text-zinc-400 text-xs mt-0.5">{tool.desc}</div>
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
