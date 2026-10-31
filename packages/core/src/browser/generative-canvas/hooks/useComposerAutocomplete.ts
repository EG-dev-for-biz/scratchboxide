/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * useComposerAutocomplete
 *
 * Composer capability selection (skills/MCP), / and @ autocomplete popup state, attached context mentions and token budget.
 *
 * Extracted verbatim from GenerativeCanvasStudio.tsx.
 */
import * as React from 'react';
import { SkillItem, TokenBudgetMetrics } from '../canvas-types';
import { ContextMentionCategory, ContextMentionItem, findTriggerMatch, insertMentionToken } from '../context-mention-engine';

export interface UseComposerAutocompleteDeps {
    inputRef: React.RefObject<HTMLTextAreaElement>;
    inputValue: string;
    setInputValue: React.Dispatch<React.SetStateAction<string>>;
    setSkills: React.Dispatch<React.SetStateAction<SkillItem[]>>;
    showToast: (text: string, icon?: string) => void;
}

export function useComposerAutocomplete(deps: UseComposerAutocompleteDeps) {
    const { inputRef, inputValue, setInputValue, setSkills, showToast } = deps;

    // Prompt Context attached capabilities
    const [selectedSkillIds, setSelectedSkillIds] = React.useState<string[]>([]);
    const [selectedMcpIds, setSelectedMcpIds] = React.useState<string[]>([]);

    // Autocomplete popup state
    const [autocompleteQuery, setAutocompleteQuery] = React.useState<string | undefined>(undefined);
    const [autocompleteType, setAutocompleteType] = React.useState<'skill' | 'mcp' | 'context' | undefined>(undefined);
    const [activeContextCategory, setActiveContextCategory] = React.useState<ContextMentionCategory>('file');
    const [selectedAutocompleteIndex, setSelectedAutocompleteIndex] = React.useState<number>(0);

    // Attached rich context mentions (@file, @git, @terminal, etc.)
    const [attachedContextMentions, setAttachedContextMentions] = React.useState<ContextMentionItem[]>([]);

    // Live Token Budget & Context Metrics
    const [, setTokenBudget] = React.useState<TokenBudgetMetrics>({
        promptTokens: 840,
        candidateTokens: 420,
        totalTokens: 1260,
        maxContextLimit: 128000,
        compressionRatio: 0.64,
        activeModel: 'gemini-4-argon',
        thinkingBudget: 1024,
        rawLogTokens: 3500,
        compactedTokens: 1260,
        anchorsRetainedCount: 8
    });

    // Input change handler with / and @ autocomplete detection supporting multi-word queries
    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const val = e.target.value;
        setInputValue(val);

        const cursorPos = e.target.selectionStart || val.length;
        const triggerMatch = findTriggerMatch(val, cursorPos);

        if (triggerMatch) {
            setAutocompleteType(triggerMatch.type === 'skill' ? 'skill' : 'context');
            let effectiveQuery = triggerMatch.query;
            if (triggerMatch.type === 'context') {
                const rawQ = triggerMatch.query.toLowerCase();
                const categoryPrefixMatch = rawQ.match(/^(scene|mesh|camera|timeline|file|files|folder|git|terminal|web|docs|mcp)(?::(.*))?$/);
                if (categoryPrefixMatch) {
                    const matchedCat = (categoryPrefixMatch[1] === 'files' ? 'file' : categoryPrefixMatch[1]) as ContextMentionCategory;
                    setActiveContextCategory(matchedCat);
                    effectiveQuery = categoryPrefixMatch[2] !== undefined
                        ? triggerMatch.query.slice(categoryPrefixMatch[1].length + 1)
                        : '';
                }
            }
            setAutocompleteQuery(effectiveQuery);
            setSelectedAutocompleteIndex(0);
        } else if (autocompleteType !== undefined) {
            setAutocompleteType(undefined);
            setAutocompleteQuery(undefined);
        }
    };

    const handleSelectAutocompleteSkill = (skill: SkillItem) => {
        if (!skill.isEnabled) {
            setSkills(prev => prev.map(s => s.id === skill.id ? { ...s, isEnabled: true } : s));
        }
        if (!selectedSkillIds.includes(skill.id)) {
            setSelectedSkillIds(prev => [...prev, skill.id]);
        }
        const match = findTriggerMatch(inputValue);
        if (match) {
            const res = insertMentionToken(inputValue, match.triggerIndex, match.query.length + 1, '');
            setInputValue(res.newText.trim() ? `${res.newText.trim()} ` : '');
        }
        setAutocompleteType(undefined);
        setAutocompleteQuery(undefined);
        inputRef.current?.focus();
        showToast(`Superpower "${skill.name}" attached`);
    };

    const handleSelectAutocompleteContext = (item: ContextMentionItem) => {
        if (!attachedContextMentions.some(c => c.id === item.id)) {
            setAttachedContextMentions(prev => [...prev, item]);
        }
        const match = findTriggerMatch(inputValue);
        if (match) {
            const res = insertMentionToken(inputValue, match.triggerIndex, match.query.length + 1, '');
            setInputValue(res.newText.trim() ? `${res.newText.trim()} ` : '');
        }
        setAutocompleteType(undefined);
        setAutocompleteQuery(undefined);
        inputRef.current?.focus();
        showToast(`Attached @${item.type} "${item.name}"`);
    };

    const handleToggleComposerSkill = (skillId: string) => {
        setSelectedSkillIds(prev =>
            prev.includes(skillId) ? prev.filter(id => id !== skillId) : [...prev, skillId]
        );
    };

    const handleToggleComposerMcp = (mcpId: string) => {
        setSelectedMcpIds(prev =>
            prev.includes(mcpId) ? prev.filter(id => id !== mcpId) : [...prev, mcpId]
        );
    };

    return { activeContextCategory, attachedContextMentions, autocompleteQuery, autocompleteType, handleInputChange, handleSelectAutocompleteContext, handleSelectAutocompleteSkill, handleToggleComposerMcp, handleToggleComposerSkill, selectedAutocompleteIndex, selectedMcpIds, selectedSkillIds, setActiveContextCategory, setAttachedContextMentions, setAutocompleteQuery, setAutocompleteType, setSelectedAutocompleteIndex, setSelectedSkillIds, setTokenBudget };
}
