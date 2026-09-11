/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import {
    GoogleDriveConnectionState,
    GoogleDriveService
} from './google-drive-service';
import { getActiveUserName } from './canvas-types';
import {
    IconCheck,
    IconClose,
    IconExternalLink,
    IconGoogleDocs,
    IconGoogleDocsColor,
    IconGoogleDriveColor,
    IconLock,
    IconSparkles
} from './canvas-icons';

export interface GoogleDriveConnectModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConnected?: (state: GoogleDriveConnectionState) => void;
    onExportCurrentDocument?: () => void;
}

export const GoogleDriveConnectModal: React.FC<GoogleDriveConnectModalProps> = ({
    isOpen,
    onClose,
    onConnected,
    onExportCurrentDocument
}) => {
    const driveService = React.useMemo(() => GoogleDriveService.getInstance(), []);
    const [state, setState] = React.useState<GoogleDriveConnectionState>(() => driveService.getState());
    const [customEmail, setCustomEmail] = React.useState<string>(state.accountEmail || '');
    const [isSubmitting, setIsSubmitting] = React.useState<boolean>(false);
    const [authSuccessMsg, setAuthSuccessMsg] = React.useState<string | null>(null);

    React.useEffect(() => {
        const unsubscribe = driveService.subscribe(newState => {
            setState(newState);
            if (newState.accountEmail) {
                setCustomEmail(newState.accountEmail);
            }
        });
        return () => unsubscribe();
    }, [driveService]);

    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) {
        /* eslint-disable-next-line no-null/no-null */
        return null;
    }

    const isConnected = state.status === 'connected';

    const handleConnect = async () => {
        setIsSubmitting(true);
        setAuthSuccessMsg(null);
        try {
            const res = await driveService.connect(customEmail, getActiveUserName());
            setAuthSuccessMsg('✓ Google Drive & Docs successfully connected');
            if (onConnected) {
                onConnected(res);
            }
            setTimeout(() => setAuthSuccessMsg(null), 3500);
        } catch (err: any) {
            console.error('Failed to connect Google Drive:', err);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDisconnect = async () => {
        setIsSubmitting(true);
        try {
            await driveService.disconnect();
            setAuthSuccessMsg('Google Drive disconnected');
            setTimeout(() => setAuthSuccessMsg(null), 2500);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleToggleAutoSync = () => {
        driveService.toggleAutoSync(!state.autoSyncEnabled);
    };

    return (
        <div className="sb-settings-modal-backdrop sb-gdrive-modal-backdrop" onClick={onClose}>
            <div
                className="sb-gdrive-modal-window animate-modalPop"
                onClick={e => e.stopPropagation()}
            >
                {/* Header Window Bar */}
                <div className="sb-gdrive-modal-header">
                    <div className="flex items-center gap-3">
                        <div className="sb-gdrive-icon-badge">
                            <IconGoogleDriveColor size={22} />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h3 className="sb-gdrive-title font-semibold text-zinc-100 text-sm">
                                    Google Drive &amp; Docs Connection
                                </h3>
                                <span className={`sb-gdrive-status-badge ${isConnected ? 'sb-status-connected' : 'sb-status-disconnected'}`}>
                                    {isConnected ? 'Connected' : 'Disconnected'}
                                </span>
                            </div>
                            <p className="text-[12px] text-zinc-400 mt-0.5">
                                1-click Google OAuth / MCP connector authorization for real-time document export and workspace sync.
                            </p>
                        </div>
                    </div>

                    <button
                        type="button"
                        className="sb-btn sb-modal-close-btn sb-gdrive-close-btn"
                        onClick={onClose}
                        title="Close (Esc)"
                    >
                        <IconClose size={13} />
                    </button>
                </div>

                {/* Body Content */}
                <div className="sb-gdrive-modal-body">
                    {/* Success Notice */}
                    {authSuccessMsg && (
                        <div className="sb-gdrive-alert-success animate-fadeIn">
                            <IconCheck size={14} className="text-emerald-400" />
                            <span>{authSuccessMsg}</span>
                        </div>
                    )}

                    {/* Account Status Card */}
                    <div className="sb-gdrive-card">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 font-semibold text-sm">
                                    {state.accountName ? state.accountName.charAt(0).toUpperCase() : 'G'}
                                </div>
                                <div>
                                    <div className="text-xs font-semibold text-zinc-200">
                                        {state.accountName || 'Google Workspace Account'}
                                    </div>
                                    <div className="text-[11px] text-zinc-400 font-mono">
                                        {isConnected ? state.accountEmail : 'No active Google Drive account linked'}
                                    </div>
                                </div>
                            </div>

                            <div>
                                {isConnected ? (
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-danger sb-btn-xs"
                                        onClick={handleDisconnect}
                                        disabled={isSubmitting}
                                    >
                                        <span>Disconnect</span>
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-primary sb-btn-xs sb-gdrive-auth-btn"
                                        onClick={handleConnect}
                                        disabled={isSubmitting}
                                    >
                                        <IconSparkles size={11} />
                                        <span>{isSubmitting ? 'Connecting...' : 'Connect with Google OAuth'}</span>
                                    </button>
                                )}
                            </div>
                        </div>

                        {state.simulated && (
                            <div className="sb-gdrive-simulated-note mt-3 pt-3 border-t border-zinc-800/80 text-[11px] text-amber-300/90" role="note">
                                Simulated connection — Google OAuth is not configured. No data is sent to Google.
                            </div>
                        )}

                        {/* Storage Quota / Sync Status */}
                        {isConnected && state.storageQuota && (
                            <div className="mt-3 pt-3 border-t border-zinc-800/80 flex items-center justify-between text-[11px] text-zinc-400">
                                <div className="flex items-center gap-2">
                                    <span>Cloud Storage: <strong>{state.storageQuota.usedReadable}</strong> of {state.storageQuota.totalReadable}</span>
                                </div>
                                {state.lastSyncedAt && (
                                    <span className="text-zinc-500">
                                        Last synced: {new Date(state.lastSyncedAt).toLocaleTimeString()}
                                    </span>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Auto-Sync Toggle Card */}
                    <div className="sb-gdrive-card flex items-center justify-between">
                        <div className="pr-4">
                            <div className="text-xs font-medium text-zinc-200">
                                Auto-Sync Document Specs to Google Drive
                            </div>
                            <div className="text-[11px] text-zinc-400 mt-0.5">
                                Automatically upload version checkpoints whenever document architecture specifications are updated.
                            </div>
                        </div>

                        <label className="sb-toggle-switch">
                            <input
                                type="checkbox"
                                checked={state.autoSyncEnabled}
                                onChange={handleToggleAutoSync}
                            />
                            <span className="sb-toggle-slider" />
                        </label>
                    </div>

                    {/* Permissions & Scopes Breakdown */}
                    <div className="sb-gdrive-card space-y-2">
                        <div className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                            <IconLock size={12} className="text-blue-400" />
                            <span>Authorized Scopes &amp; Capabilities</span>
                        </div>

                        <div className="space-y-1.5 pt-1">
                            <div className="flex items-start gap-2 text-[11px] text-zinc-300">
                                <IconGoogleDocsColor size={14} className="mt-0.5 shrink-0" />
                                <div>
                                    <span className="font-medium text-zinc-200">Google Docs API: </span>
                                    <span className="text-zinc-400">Format and upload specifications with headings, tables, callouts, and checklists.</span>
                                </div>
                            </div>
                            <div className="flex items-start gap-2 text-[11px] text-zinc-300">
                                <IconGoogleDriveColor size={14} className="mt-0.5 shrink-0" />
                                <div>
                                    <span className="font-medium text-zinc-200">Google Drive File Storage: </span>
                                    <span className="text-zinc-400">Save markdown documents and JSON pipelines to your designated Drive folder.</span>
                                </div>
                            </div>
                            <div className="flex items-start gap-2 text-[11px] text-zinc-300">
                                <IconCheck size={13} className="mt-0.5 text-emerald-400 shrink-0" />
                                <div>
                                    <span className="font-medium text-zinc-200">Semantic Search: </span>
                                    <span className="text-zinc-400">Search existing Google Drive documentation from Scratchbox AI sidechat.</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Modal Footer Actions */}
                <div className="sb-gdrive-modal-footer">
                    <div className="flex items-center gap-2">
                        {isConnected && onExportCurrentDocument && (
                            <button
                                type="button"
                                className="sb-btn sb-btn-primary sb-btn-sm"
                                onClick={() => {
                                    onClose();
                                    onExportCurrentDocument();
                                }}
                            >
                                <IconGoogleDocs size={13} />
                                <span>Export Active Spec to Docs</span>
                            </button>
                        )}
                        {isConnected && (
                            <a
                                href="https://drive.google.com"
                                target="_blank"
                                rel="noreferrer"
                                className="sb-btn sb-btn-secondary sb-btn-sm"
                            >
                                <IconExternalLink size={12} />
                                <span>Open Google Drive</span>
                            </a>
                        )}
                    </div>

                    <button
                        type="button"
                        className="sb-btn sb-btn-secondary sb-btn-sm"
                        onClick={onClose}
                    >
                        <span>Done</span>
                    </button>
                </div>
            </div>
        </div>
    );
};
