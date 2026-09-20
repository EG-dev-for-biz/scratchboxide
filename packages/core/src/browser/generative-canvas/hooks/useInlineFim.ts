/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { useState, useRef, useCallback, useEffect } from 'react';
import { GeminiClient } from '../gemini-client';

export interface UseInlineFimOptions {
    enabled?: boolean;
    language?: string;
    fileName?: string;
    debounceMs?: number;
    onApplyCompletion?: (newCode: string, newCursorOffset: number) => void;
}

export interface UseInlineFimReturn {
    ghostText: string;
    ghostPosition: number;
    isLoading: boolean;
    dismissGhostText: () => void;
    handleEditorKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>, currentCode: string) => boolean;
    triggerFimCheck: (code: string, cursorOffset: number) => void;
}

export function useInlineFim(options: UseInlineFimOptions = {}): UseInlineFimReturn {
    const {
        enabled = true,
        language = 'typescript',
        fileName = 'source.ts',
        debounceMs = 180,
        onApplyCompletion
    } = options;

    const [ghostText, setGhostText] = useState<string>('');
    const [ghostPosition, setGhostPosition] = useState<number>(0);
    const [isLoading, setIsLoading] = useState<boolean>(false);

    const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const lastRequestPayloadRef = useRef<string>('');

    const dismissGhostText = useCallback(() => {
        setGhostText('');
        setGhostPosition(0);
        setIsLoading(false);
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
    }, []);

    const triggerFimCheck = useCallback((code: string, cursorOffset: number) => {
        if (!enabled) return;

        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }

        // Cancel previous inflight request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }

        const prefix = code.slice(0, cursorOffset);
        const suffix = code.slice(cursorOffset);

        // Don't trigger if cursor is in middle of a word or empty prefix
        const lastChar = prefix.slice(-1);
        if (!lastChar || /[a-zA-Z0-9_]/.test(suffix.charAt(0))) {
            setGhostText('');
            return;
        }

        const payloadKey = `${cursorOffset}:${prefix.slice(-50)}`;
        if (payloadKey === lastRequestPayloadRef.current) {
            return;
        }

        debounceTimerRef.current = setTimeout(async () => {
            lastRequestPayloadRef.current = payloadKey;
            setIsLoading(true);

            const controller = new AbortController();
            abortControllerRef.current = controller;

            try {
                const res = await GeminiClient.getInstance().completeFim({
                    prefix,
                    suffix,
                    language,
                    fileName,
                    maxTokens: 64,
                    temperature: 0.1
                });

                if (!controller.signal.aborted && res.success && res.completion) {
                    setGhostText(res.completion);
                    setGhostPosition(cursorOffset);
                } else if (!controller.signal.aborted) {
                    setGhostText('');
                }
            } catch {
                if (!controller.signal.aborted) {
                    setGhostText('');
                }
            } finally {
                if (!controller.signal.aborted) {
                    setIsLoading(false);
                }
            }
        }, debounceMs);
    }, [enabled, language, fileName, debounceMs]);

    const handleEditorKeyDown = useCallback((
        e: React.KeyboardEvent<HTMLTextAreaElement>,
        currentCode: string
    ): boolean => {
        if (!ghostText) return false;

        // 1. Tab accepts full ghost text
        if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            const prefix = currentCode.slice(0, ghostPosition);
            const suffix = currentCode.slice(ghostPosition);
            const newCode = prefix + ghostText + suffix;
            const newCursor = ghostPosition + ghostText.length;

            setGhostText('');
            if (onApplyCompletion) {
                onApplyCompletion(newCode, newCursor);
            }
            return true;
        }

        // 2. Cmd/Ctrl + Right accepts next word
        if (e.key === 'ArrowRight' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            const words = ghostText.split(/(\s+|[^\w\s]+)/);
            const nextChunk = words[0] || '';
            if (nextChunk) {
                const remaining = ghostText.slice(nextChunk.length);
                const prefix = currentCode.slice(0, ghostPosition);
                const suffix = currentCode.slice(ghostPosition);
                const newCode = prefix + nextChunk + suffix;
                const newCursor = ghostPosition + nextChunk.length;

                setGhostText(remaining);
                setGhostPosition(newCursor);
                if (onApplyCompletion) {
                    onApplyCompletion(newCode, newCursor);
                }
                return true;
            }
        }

        // 3. Escape dismisses ghost text
        if (e.key === 'Escape') {
            e.preventDefault();
            dismissGhostText();
            return true;
        }

        return false;
    }, [ghostText, ghostPosition, onApplyCompletion, dismissGhostText]);

    useEffect(() => {
        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        };
    }, []);

    return {
        ghostText,
        ghostPosition,
        isLoading,
        dismissGhostText,
        handleEditorKeyDown,
        triggerFimCheck
    };
}
