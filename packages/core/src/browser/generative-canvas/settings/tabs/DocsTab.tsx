/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Docs settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { IconSparkles } from '../../canvas-icons';
import { useSettingsContext } from '../SettingsContext';

export const DocsTab: React.FC = () => {
    const { activeTab, sidebarNavSections } = useSettingsContext();
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">
                {sidebarNavSections.find(s => s.id === activeTab)?.label || 'Settings'}
            </h2>
            <div className="sb-cursor-group-card p-6 text-center space-y-2">
                <IconSparkles size={24} className="text-blue-400 mx-auto animate-pulse" />
                <div className="text-sm font-semibold text-zinc-200">
                    {sidebarNavSections.find(s => s.id === activeTab)?.label} Documentation
                </div>
                <p className="text-xs text-zinc-400 max-w-md mx-auto">
                    Cloud agent tasks and documentation links are accessible at docs.scratchbox.dev and scratchbox.io/docs.
                </p>
            </div>
        </div>
    );
};
