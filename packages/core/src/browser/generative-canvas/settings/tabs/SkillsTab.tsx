/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** SkillsTab content of the Customize settings group. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { SkillItem } from '../../canvas-types';
import { SkillsManagerPrimitive } from '../../primitives/SkillsManagerPrimitive';
import { useSettingsContext } from '../SettingsContext';

export const SkillsTab: React.FC = () => {
    const { onClose, onSelectPromptStarter, onSkillsChange, skills } = useSettingsContext();
    return (
        <SkillsManagerPrimitive
            data={{
                title: 'Superpowers (Skills)',
                subtitle: 'Domain capabilities and system prompts',
                skills
            }}
            onToggleSkill={(id: string, enabled: boolean) => {
                const updated = skills.map(s => s.id === id ? { ...s, isEnabled: enabled } : s);
                onSkillsChange(updated);
            }}
            onSelectPromptStarter={(prompt: string, skill: SkillItem) => {
                onClose();
                onSelectPromptStarter(prompt, skill);
            }}
        />
    );
};
