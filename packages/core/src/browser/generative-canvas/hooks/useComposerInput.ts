/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * useComposerInput
 *
 * Composer keyboard handling (autocomplete navigation + Enter-to-send), voice dictation toggle and the filtered autocomplete skill list.
 *
 * Extracted verbatim from GenerativeCanvasStudio.tsx.
 */
import * as React from 'react';
import { WorkspaceGitStatusSnapshot } from '../state/studio-defaults';
import { McpServerItem, PrimitiveType, SkillItem } from '../canvas-types';
import { ContextMentionItem, cycleSelectedIndex, resolveContextMentionQuery } from '../context-mention-engine';
import { useComposerAutocomplete } from '../hooks/useComposerAutocomplete';
import { DEFAULT_WORKSPACE_FILES } from '../state/studio-defaults';

export interface UseComposerInputDeps {
    activeContextCategory: ReturnType<typeof useComposerAutocomplete>['activeContextCategory'];
    autocompleteQuery: ReturnType<typeof useComposerAutocomplete>['autocompleteQuery'];
    autocompleteType: ReturnType<typeof useComposerAutocomplete>['autocompleteType'];
    handleSelectAutocompleteContext: ReturnType<typeof useComposerAutocomplete>['handleSelectAutocompleteContext'];
    handleSelectAutocompleteSkill: ReturnType<typeof useComposerAutocomplete>['handleSelectAutocompleteSkill'];
    handleSendMessage: (textToSend?: string, targetPrimitiveType?: PrimitiveType) => Promise<void>;
    mcpServers: McpServerItem[];
    selectedAutocompleteIndex: ReturnType<typeof useComposerAutocomplete>['selectedAutocompleteIndex'];
    setAutocompleteQuery: ReturnType<typeof useComposerAutocomplete>['setAutocompleteQuery'];
    setAutocompleteType: ReturnType<typeof useComposerAutocomplete>['setAutocompleteType'];
    setInputValue: React.Dispatch<React.SetStateAction<string>>;
    setSelectedAutocompleteIndex: ReturnType<typeof useComposerAutocomplete>['setSelectedAutocompleteIndex'];
    showToast: (text: string, icon?: string) => void;
    skills: SkillItem[];
    workspaceFilesList: typeof DEFAULT_WORKSPACE_FILES;
    workspaceGitStatus: WorkspaceGitStatusSnapshot;
}

export function useComposerInput(deps: UseComposerInputDeps) {
    const { activeContextCategory, autocompleteQuery, autocompleteType, handleSelectAutocompleteContext, handleSelectAutocompleteSkill, handleSendMessage, mcpServers, selectedAutocompleteIndex, setAutocompleteQuery, setAutocompleteType, setInputValue, setSelectedAutocompleteIndex, showToast, skills, workspaceFilesList, workspaceGitStatus } = deps;

    const [isVoiceActive, setIsVoiceActive] = React.useState<boolean>(false);
    const speechRecognitionRef = React.useRef<any>(null);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (autocompleteType !== undefined) {
            const items = autocompleteType === 'skill'
                ? filteredAutocompleteSkills
                : resolveContextMentionQuery(activeContextCategory, autocompleteQuery, workspaceFilesList, workspaceGitStatus, mcpServers);

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedAutocompleteIndex(prev => cycleSelectedIndex(prev, items.length, 'down'));
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedAutocompleteIndex(prev => cycleSelectedIndex(prev, items.length, 'up'));
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                if (items.length > 0 && items[selectedAutocompleteIndex]) {
                    e.preventDefault();
                    if (autocompleteType === 'skill') {
                        handleSelectAutocompleteSkill(items[selectedAutocompleteIndex] as SkillItem);
                    } else {
                        handleSelectAutocompleteContext(items[selectedAutocompleteIndex] as ContextMentionItem);
                    }
                    return;
                }
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setAutocompleteType(undefined);
                setAutocompleteQuery(undefined);
                return;
            }
        }

        if (e.key === 'Enter') {
            if (!e.shiftKey || e.metaKey || e.ctrlKey) {
                e.preventDefault();
                handleSendMessage();
            }
        }
    };

    const handleVoiceToggle = () => {
        if (isVoiceActive) {
            if (speechRecognitionRef.current) {
                try {
                    speechRecognitionRef.current.stop();
                } catch (e) {
                    // ignore
                }
            }
            setIsVoiceActive(false);
            return;
        }

        if (typeof window === 'undefined') return;
        const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRec) {
            showToast('Voice dictation is not supported in this browser.', '🎙');
            return;
        }

        try {
            const recognition = new SpeechRec();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.lang = 'en-US';

            recognition.onstart = () => {
                setIsVoiceActive(true);
                showToast('Listening... Speak your prompt', '🎙');
            };

            recognition.onresult = (event: any) => {
                let fullTranscript = '';
                for (let i = 0; i < event.results.length; i++) {
                    fullTranscript += event.results[i][0].transcript + ' ';
                }
                setInputValue(fullTranscript.trim());
            };

            recognition.onerror = (event: any) => {
                console.warn('SpeechRecognition error:', event);
                if (event.error === 'not-allowed') {
                    showToast('Microphone access denied', '⚠️');
                }
                setIsVoiceActive(false);
            };

            recognition.onend = () => {
                setIsVoiceActive(false);
            };

            speechRecognitionRef.current = recognition;
            recognition.start();
        } catch (e) {
            console.warn('Failed to start SpeechRecognition', e);
            setIsVoiceActive(false);
            showToast('Microphone initialization failed', '⚠️');
        }
    };

    const filteredAutocompleteSkills = skills.filter(s =>
        !autocompleteQuery ||
        s.name.toLowerCase().includes(autocompleteQuery.toLowerCase()) ||
        s.category.toLowerCase().includes(autocompleteQuery.toLowerCase())
    );

    return { filteredAutocompleteSkills, handleKeyDown, handleVoiceToggle, isVoiceActive };
}
