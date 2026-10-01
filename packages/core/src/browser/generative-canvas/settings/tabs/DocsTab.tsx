/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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
