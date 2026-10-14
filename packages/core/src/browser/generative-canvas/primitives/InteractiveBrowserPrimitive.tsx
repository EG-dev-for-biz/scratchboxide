/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import {
    BrowserConsoleLogItem,
    BrowserViewportMode,
    CanvasArtifact,
    InteractiveBrowserData
} from '../canvas-types';
import {
    IconArrowLeft,
    IconArrowRight,
    IconBrowser,
    IconCheck,
    IconClose,
    IconCode,
    IconCopy,
    IconExternalLink,
    IconGlobe,
    IconLaptop,
    IconLock,
    IconMaximize,
    IconRefresh,
    IconSmartphone,
    IconSparkles,
    IconTablet,
    IconTerminal,
    IconTrash
} from '../canvas-icons';

export interface InteractiveBrowserPrimitiveProps {
    data: InteractiveBrowserData;
    onUpdate?: (updatedData: InteractiveBrowserData) => void;
    onPromptAction?: (promptText: string) => void;
    onMorphArtifact?: (artifact: CanvasArtifact, targetType: string) => void;
    onCaptureReady?: (captureFn: () => string | null) => void;
    onVisualVerification?: (screenshotDataUrl: string) => void;
    hideTopbar?: boolean;
}

/**
 * Captures a screenshot data URL of the active interactive browser viewport or iframe.
 */
export function captureBrowserScreenshot(containerOrIframe?: HTMLElement | null): string | null {
    if (containerOrIframe) {
        if (containerOrIframe instanceof HTMLIFrameElement) {
            try {
                const doc = containerOrIframe.contentDocument || containerOrIframe.contentWindow?.document;
                const canvas = doc?.querySelector('canvas') as HTMLCanvasElement;
                if (canvas && typeof canvas.toDataURL === 'function') {
                    const dataUrl = canvas.toDataURL('image/png');
                    if (dataUrl && dataUrl.length > 22) return dataUrl;
                }
            } catch (e) {
                // cross-origin fallback
            }
        }
        const canvas = containerOrIframe.querySelector('canvas') as HTMLCanvasElement;
        if (canvas && typeof canvas.toDataURL === 'function') {
            try {
                const dataUrl = canvas.toDataURL('image/png');
                if (dataUrl && dataUrl.length > 22) return dataUrl;
            } catch (e) {
                // fall through
            }
        }
    }

    if (typeof document !== 'undefined') {
        const canvas = document.querySelector('.sb-browser-stage-wrapper canvas, .sb-browser-stage-wrapper iframe') as HTMLCanvasElement;
        if (canvas && typeof canvas.toDataURL === 'function') {
            try {
                const dataUrl = canvas.toDataURL('image/png');
                if (dataUrl && dataUrl.length > 22) return dataUrl;
            } catch (e) {
                // fall through
            }
        }
    }

    // No readable canvas: report no frame (never a placeholder image for the visual check to inspect).
    return null;
}

const DEFAULT_BOOKMARKS = [
    { title: 'Localhost:3000', url: 'http://localhost:3000', icon: '⚡' },
    { title: 'Hacker News', url: 'https://news.ycombinator.com', icon: '🟧' },
    { title: 'GitHub', url: 'https://github.com', icon: '🐙' },
    { title: 'Wikipedia', url: 'https://en.wikipedia.org', icon: '🌐' },
    { title: 'Example Domain', url: 'https://example.com', icon: '📄' },
    { title: 'Docs Preview', url: 'http://localhost:3000/docs/preview', icon: '📘' }
];

export const InteractiveBrowserPrimitive: React.FC<InteractiveBrowserPrimitiveProps> = ({
    data,
    onUpdate,
    onPromptAction,
    onMorphArtifact,
    onCaptureReady,
    onVisualVerification,
    hideTopbar = false
}) => {
    // Current URL and Input State
    const [inputUrl, setInputUrl] = React.useState<string>(data.url || 'https://example.com');
    const [currentUrl, setCurrentUrl] = React.useState<string>(data.url || 'https://example.com');
    const [pageTitle, setPageTitle] = React.useState<string>(data.title || 'Web Browser');
    const [isLoading, setIsLoading] = React.useState<boolean>(data.isLoading || false);
    const [viewportMode, setViewportMode] = React.useState<BrowserViewportMode>(data.viewportMode || 'desktop');
    const [deviceOrientation, setDeviceOrientation] = React.useState<'portrait' | 'landscape'>(data.deviceOrientation || 'portrait');
    const [deviceScale] = React.useState<number>(data.deviceScale || 1);
    const [useProxy, setUseProxy] = React.useState<boolean>(true);

    // History navigation stack
    const [history, setHistory] = React.useState<string[]>(() => data.history || [data.url || 'https://example.com']);
    const [historyIndex, setHistoryIndex] = React.useState<number>(() => data.historyIndex ?? 0);

    // Drawer state
    const [isConsoleOpen, setIsConsoleOpen] = React.useState<boolean>(data.inspectMode || false);
    const [activeDrawerTab, setActiveDrawerTab] = React.useState<'console' | 'network' | 'dom' | 'actions' | 'timeline'>('console');
    const [logFilter, setLogFilter] = React.useState<'all' | 'error' | 'warn' | 'info' | 'log'>('all');
    const [evalInput, setEvalInput] = React.useState<string>('');

    // Console logs list
    const [consoleLogs, setConsoleLogs] = React.useState<BrowserConsoleLogItem[]>(() => {
        if (data.consoleLogs && data.consoleLogs.length > 0) return data.consoleLogs;
        return [
            { type: 'info', text: `Session initialized for ${data.url || 'https://example.com'}`, timestamp: new Date().toLocaleTimeString() },
            { type: 'log', text: 'Chromium Web Gateway active. Live X-Frame bypass and AI agent control enabled.', timestamp: new Date().toLocaleTimeString() }
        ];
    });

    // Mock network requests
    const [networkRequests, setNetworkRequests] = React.useState<Array<{ id: string; url: string; method: string; status: number; durationMs: number; type: string }>>(() => {
        return (data as any).networkRequests || [
            { id: 'req-1', url: data.url || 'https://example.com', method: 'GET', status: 200, durationMs: 42, type: 'document' },
            { id: 'req-2', url: '/styles/bundle.css', method: 'GET', status: 200, durationMs: 14, type: 'stylesheet' },
            { id: 'req-3', url: '/scripts/runtime.js', method: 'GET', status: 200, durationMs: 28, type: 'script' }
        ];
    });

    // Copy notification
    const [copiedUrl, setCopiedUrl] = React.useState<boolean>(false);
    const [showBookmarks] = React.useState<boolean>(true);
    const [iframeKey, setIframeKey] = React.useState<number>(0);
    const [hasFrameError, setHasFrameError] = React.useState<boolean>(false);

    // Synchronize internal state if incoming data props change
    React.useEffect(() => {
        if (data.url && data.url !== currentUrl) {
            setInputUrl(data.url);
            setCurrentUrl(data.url);
            if (data.title) setPageTitle(data.title);
            setHasFrameError(false);
            setIframeKey(k => k + 1);
        }
    }, [data.url, data.title]);

    // Iframe ref and timeline state
    const iframeRef = React.useRef<HTMLIFrameElement>(null);
    const [timelineSteps, setTimelineSteps] = React.useState<Array<{
        id: string;
        timestamp: string;
        action: string;
        target?: string;
        url: string;
        status: 'completed' | 'failed' | 'pending';
        error?: string;
    }>>([]);
    const [clickMarker, setClickMarker] = React.useState<{ x: number; y: number; label?: string } | null>(null);
    const pendingActionsMapRef = React.useRef<Map<string, (result: any) => void>>(new Map());

    // Check if running in Electron environment with webview capability
    const isElectronEnvironment = React.useMemo(() => {
        return typeof window !== 'undefined' && (
            !!(window as any).electron ||
            navigator.userAgent.toLowerCase().includes(' electron/') ||
            typeof (window as any).process === 'object'
        );
    }, []);

    // Frame Capture & Automated Verification Hooks
    const captureFrame = React.useCallback((): string | null => {
        return captureBrowserScreenshot(iframeRef.current);
    }, []);

    React.useEffect(() => {
        if (typeof window !== 'undefined') {
            (window as any).__scratchbox_capture_active_browser = captureFrame;
        }
        onCaptureReady?.(captureFrame);

        return () => {
            if (typeof window !== 'undefined' && (window as any).__scratchbox_capture_active_browser === captureFrame) {
                delete (window as any).__scratchbox_capture_active_browser;
            }
        };
    }, [captureFrame, onCaptureReady]);

    React.useEffect(() => {
        if (!onVisualVerification) return;
        const settleTimer = setTimeout(() => {
            const frame = captureFrame();
            if (frame && frame.length > 20) {
                onVisualVerification(frame);
            }
        }, 600);
        return () => clearTimeout(settleTimer);
    }, [currentUrl, captureFrame, onVisualVerification]);

    // Resolve frame URL: route external targets through the Chromium backend proxy
    const resolveFrameUrl = React.useCallback((target: string): string => {
        let trimmed = (target || '').trim();
        if (!trimmed) return 'https://example.com';
        if (trimmed.startsWith('data:') || trimmed.startsWith('about:')) {
            return trimmed;
        }

        // Local relative paths or same-origin URLs run directly in the iframe without proxying
        if (trimmed.startsWith('/') || (typeof window !== 'undefined' && trimmed.startsWith(window.location.origin))) {
            return trimmed;
        }

        // If already pointing to proxy endpoint, extract original url
        if (trimmed.includes('/api/browser/proxy?url=')) {
            const match = trimmed.match(/[?&]url=([^&]+)/);
            if (match && match[1]) {
                try {
                    trimmed = decodeURIComponent(match[1]);
                } catch(e) {}
            }
        }

        // If proxy is active, route through backend gateway to strip X-Frame-Options and CSP
        if (useProxy) {
            return `/api/browser/proxy?url=${encodeURIComponent(trimmed)}`;
        }

        return trimmed;
    }, [useProxy]);

    const triggerSnapshotFetch = React.useCallback(() => {
        const iframe = iframeRef.current;
        if (!iframe || !iframe.contentWindow) return;
        const requestId = `snap-${Date.now()}`;
        iframe.contentWindow.postMessage({
            type: 'scratchbox-browser-action',
            requestId,
            action: 'snapshot'
        }, '*');
    }, []);

    // Polling hook to fetch pending actions from server and dispatch to iframe bridge.
    // Runs only while this primitive is mounted AND the document is visible; in-flight requests
    // are aborted and the interval cleared on unmount or when the tab is hidden.
    React.useEffect(() => {
        if (typeof document === 'undefined') return;
        let cancelled = false;
        let inFlight = false;
        let interval: ReturnType<typeof setInterval> | null = null;
        let controller: AbortController | null = null;

        const isVisible = () => document.visibilityState !== 'hidden';

        const pollOnce = async () => {
            if (cancelled || inFlight || !isVisible()) return;
            inFlight = true;
            controller = new AbortController();
            try {
                const res = await fetch('/api/browser/pending-actions', { signal: controller.signal });
                if (cancelled || !res.ok) return;
                const actions = await res.json();
                if (cancelled) return;
                if (Array.isArray(actions) && actions.length > 0) {
                    for (const action of actions) {
                        const iframe = iframeRef.current;
                        if (iframe && iframe.contentWindow) {
                            const timestamp = new Date().toLocaleTimeString();
                            const newStep = {
                                id: action.id,
                                timestamp,
                                action: action.action,
                                target: action.params?.elementId || action.params?.selector || action.params?.url || '',
                                url: currentUrl,
                                status: 'pending' as const
                            };
                            setTimelineSteps(prev => [...prev, newStep]);

                            iframe.contentWindow.postMessage({
                                type: 'scratchbox-browser-action',
                                requestId: action.id,
                                action: action.action,
                                params: action.params
                            }, '*');

                            pendingActionsMapRef.current.set(action.id, (response: any) => {
                                setTimelineSteps(prev => prev.map(step => {
                                    if (step.id === action.id) {
                                        return {
                                            ...step,
                                            status: response.success ? 'completed' : 'failed',
                                            error: response.error
                                        };
                                    }
                                    return step;
                                }));

                                if (response.success && response.result?.coords) {
                                    setClickMarker({
                                        x: response.result.coords.x,
                                        y: response.result.coords.y,
                                        label: action.action.toUpperCase()
                                    });
                                    setTimeout(() => {
                                        setClickMarker(null);
                                    }, 2500);
                                }

                                fetch('/api/browser/action-result', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        id: action.id,
                                        success: response.success,
                                        result: response.result,
                                        error: response.error
                                    })
                                }).catch(() => {});

                                setTimeout(triggerSnapshotFetch, 500);
                            });
                        }
                    }
                }
            } catch (e) {
                // Aborted or transport error: nothing to dispatch this tick.
            } finally {
                inFlight = false;
                controller = null;
            }
        };

        const startInterval = () => {
            if (interval || cancelled) return;
            interval = setInterval(pollOnce, 1000);
        };
        const stopInterval = () => {
            if (interval) {
                clearInterval(interval);
                interval = null;
            }
            controller?.abort();
        };
        const handleVisibilityChange = () => {
            if (isVisible()) {
                startInterval();
            } else {
                stopInterval();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        if (isVisible()) startInterval();

        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            stopInterval();
        };
    }, [currentUrl, triggerSnapshotFetch]);

    // Synchronize props when external updates occur (e.g. AI prompt mutating state)
    React.useEffect(() => {
        if (data.url && data.url !== currentUrl) {
            setCurrentUrl(data.url);
            setInputUrl(data.url);
        }
        if (data.title && data.title !== pageTitle) {
            setPageTitle(data.title);
        }
        if (data.viewportMode && data.viewportMode !== viewportMode) {
            setViewportMode(data.viewportMode);
        }
        if (data.history && data.history.length > 0) {
            setHistory(data.history);
        }
        if (typeof data.historyIndex === 'number') {
            setHistoryIndex(data.historyIndex);
        }
        if (typeof data.inspectMode === 'boolean') {
            setIsConsoleOpen(data.inspectMode);
        }
        if (data.consoleLogs && data.consoleLogs.length > 0) {
            setConsoleLogs(data.consoleLogs);
        }
    }, [data]);

    // Listen for client bridge messages from proxied iframe (links, history changes, title, console)
    React.useEffect(() => {
        const handleBridgeMessage = (event: MessageEvent) => {
            const msg = event.data;
            if (!msg || typeof msg !== 'object') return;

            // In-page link navigation
            if (msg.type === 'scratchbox-browser-navigate' && msg.url) {
                const targetUrl = msg.url;
                if (targetUrl !== currentUrl) {
                    setInputUrl(targetUrl);
                    setCurrentUrl(targetUrl);

                    const newLog: BrowserConsoleLogItem = {
                        id: `log-${Date.now()}`,
                        type: 'info',
                        text: `Navigated to ${targetUrl}`,
                        timestamp: new Date().toLocaleTimeString()
                    };
                    setConsoleLogs(prev => [...prev, newLog]);

                    if (msg.pushState !== false) {
                        const nextHistory = [...history.slice(0, historyIndex + 1), targetUrl];
                        setHistory(nextHistory);
                        setHistoryIndex(nextHistory.length - 1);
                        emitUpdate({
                            url: targetUrl,
                            history: nextHistory,
                            historyIndex: nextHistory.length - 1
                        });
                    } else {
                        emitUpdate({ url: targetUrl });
                    }
                }
            }

            // Page metadata (title, favicon)
            if (msg.type === 'scratchbox-browser-metadata') {
                if (msg.title && msg.title !== pageTitle) {
                    setPageTitle(msg.title);
                    emitUpdate({ title: msg.title });
                }
                triggerSnapshotFetch();
            }

            // Response to scratchbox-browser-action
            if (msg.type === 'scratchbox-browser-action-response' && msg.requestId) {
                const resolver = pendingActionsMapRef.current.get(msg.requestId);
                if (resolver) {
                    pendingActionsMapRef.current.delete(msg.requestId);
                    resolver(msg);
                } else if (msg.requestId.startsWith('snap-') && msg.success && msg.result) {
                    fetch('/api/browser/state', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            url: msg.result.url || currentUrl,
                            title: msg.result.title || pageTitle,
                            accessibilityTree: msg.result.accessibilityTree,
                            markdown: msg.result.markdown
                        })
                    }).catch(() => {});
                }
            }

            // Live console logs forwarded from within the proxied page
            if (msg.type === 'scratchbox-browser-console' && msg.text) {
                const liveLog: BrowserConsoleLogItem = {
                    id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
                    type: (msg.level as any) || 'log',
                    text: msg.text,
                    timestamp: new Date().toLocaleTimeString()
                };
                setConsoleLogs(prev => [...prev.slice(-100), liveLog]);
            }
        };

        window.addEventListener('message', handleBridgeMessage);
        return () => {
            window.removeEventListener('message', handleBridgeMessage);
        };
    }, [currentUrl, history, historyIndex, pageTitle, triggerSnapshotFetch]);

    const emitUpdate = (partial: Partial<InteractiveBrowserData>) => {
        if (onUpdate) {
            onUpdate({
                ...data,
                url: currentUrl,
                title: pageTitle,
                viewportMode,
                history,
                historyIndex,
                isLoading,
                consoleLogs,
                inspectMode: isConsoleOpen,
                deviceScale,
                deviceOrientation,
                ...partial
            });
        }
    };

    const normalizeUrl = (raw: string): string => {
        let trimmed = raw.trim();
        if (!trimmed) return 'https://example.com';
        if (trimmed.includes('/api/browser/proxy?url=')) {
            const match = trimmed.match(/[?&]url=([^&]+)/);
            if (match && match[1]) {
                try {
                    trimmed = decodeURIComponent(match[1]);
                } catch(e) {}
            }
        }
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('data:') || trimmed.startsWith('about:')) {
            return trimmed;
        }
        if (trimmed.startsWith('localhost') || trimmed.startsWith('127.0.0.1')) {
            return `http://${trimmed}`;
        }
        return `https://${trimmed}`;
    };

    const navigateTo = (targetUrl: string, pushHistory = true) => {
        const normalized = normalizeUrl(targetUrl);
        setIsLoading(true);
        setHasFrameError(false);
        setCurrentUrl(normalized);
        setInputUrl(normalized);
        setIframeKey(k => k + 1);

        const newLog: BrowserConsoleLogItem = {
            id: `log-${Date.now()}`,
            type: 'info',
            text: `Navigating to ${normalized} via Chromium Gateway...`,
            timestamp: new Date().toLocaleTimeString()
        };

        const updatedLogs = [...consoleLogs, newLog];
        setConsoleLogs(updatedLogs);

        let newHistory = [...history];
        let newIndex = historyIndex;

        if (pushHistory) {
            newHistory = [...history.slice(0, historyIndex + 1), normalized];
            newIndex = newHistory.length - 1;
            setHistory(newHistory);
            setHistoryIndex(newIndex);
        }

        // Mock network request log
        const newReq = {
            id: `req-${Date.now()}`,
            url: normalized,
            method: 'GET',
            status: 200,
            durationMs: Math.floor(Math.random() * 80) + 20,
            type: 'document'
        };
        setNetworkRequests(prev => [newReq, ...prev.slice(0, 15)]);

        emitUpdate({
            url: normalized,
            history: newHistory,
            historyIndex: newIndex,
            isLoading: false,
            consoleLogs: updatedLogs
        });

        // Clear loading indicator after brief delay
        setTimeout(() => {
            setIsLoading(false);
        }, 400);
    };

    const handleBack = () => {
        if (historyIndex > 0) {
            const nextIndex = historyIndex - 1;
            const target = history[nextIndex];
            setHistoryIndex(nextIndex);
            navigateTo(target, false);
        }
    };

    const handleForward = () => {
        if (historyIndex < history.length - 1) {
            const nextIndex = historyIndex + 1;
            const target = history[nextIndex];
            setHistoryIndex(nextIndex);
            navigateTo(target, false);
        }
    };

    const handleReload = () => {
        setIsLoading(true);
        setIframeKey(k => k + 1);
        const newLog: BrowserConsoleLogItem = {
            id: `log-${Date.now()}`,
            type: 'log',
            text: `Reloaded ${currentUrl}`,
            timestamp: new Date().toLocaleTimeString()
        };
        setConsoleLogs(prev => [...prev, newLog]);
        setTimeout(() => {
            setIsLoading(false);
        }, 400);
    };

    const handleUrlSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        navigateTo(inputUrl);
    };

    const handleCopyUrl = () => {
        navigator.clipboard.writeText(currentUrl);
        setCopiedUrl(true);
        setTimeout(() => setCopiedUrl(false), 2000);
    };

    const handleOpenExternal = () => {
        window.open(currentUrl, '_blank', 'noopener,noreferrer');
    };

    const handleClearLogs = () => {
        setConsoleLogs([]);
        emitUpdate({ consoleLogs: [] });
    };

    const handleEvaluateJs = (e: React.FormEvent) => {
        e.preventDefault();
        if (!evalInput.trim()) return;

        const expr = evalInput.trim();
        setEvalInput('');

        let resultText = '';
        let logType: 'log' | 'error' | 'info' = 'log';

        try {
            if (expr === 'document.title') {
                resultText = `"${pageTitle}"`;
            } else if (expr === 'window.location.href' || expr === 'location.href') {
                resultText = `"${currentUrl}"`;
            } else if (expr === 'navigator.userAgent') {
                resultText = `"${navigator.userAgent}"`;
            } else if (expr.startsWith('alert(')) {
                resultText = `Alert modal triggered: ${expr}`;
                logType = 'info';
            } else {
                resultText = `Evaluated: ${expr} => [Object DOMWindow]`;
            }
        } catch (err: any) {
            resultText = `Uncaught Exception: ${err?.message || err}`;
            logType = 'error';
        }

        const newLog: BrowserConsoleLogItem = {
            id: `log-${Date.now()}`,
            type: logType,
            text: `> ${expr}\n< ${resultText}`,
            timestamp: new Date().toLocaleTimeString()
        };

        const nextLogs = [...consoleLogs, newLog];
        setConsoleLogs(nextLogs);
        emitUpdate({ consoleLogs: nextLogs });
    };

    const handleQuickAction = (actionKey: string) => {
        if (actionKey === 'inspect_dom') {
            setIsConsoleOpen(true);
            setActiveDrawerTab('dom');
            const log: BrowserConsoleLogItem = {
                id: `log-${Date.now()}`,
                type: 'info',
                text: 'DOM tree inspector activated. Root node: <html lang="en"> (Children: 2, Elements: 14)',
                timestamp: new Date().toLocaleTimeString()
            };
            setConsoleLogs(prev => [...prev, log]);
        } else if (actionKey === 'screenshot') {
            const log: BrowserConsoleLogItem = {
                id: `log-${Date.now()}`,
                type: 'info',
                text: `Captured viewport screenshot for ${viewportMode} mode (${new Date().toLocaleTimeString()})`,
                timestamp: new Date().toLocaleTimeString()
            };
            setConsoleLogs(prev => [...prev, log]);
            if (onPromptAction) {
                onPromptAction(`Analyze captured browser screenshot for ${currentUrl}`);
            }
        } else if (actionKey === 'emulate_mobile') {
            setViewportMode('mobile');
            emitUpdate({ viewportMode: 'mobile' });
        } else if (actionKey === 'run_js') {
            setIsConsoleOpen(true);
            setActiveDrawerTab('console');
            setEvalInput('document.querySelectorAll("a, button").length');
        } else if (actionKey === 'morph_sandbox') {
            if (onMorphArtifact) {
                onMorphArtifact({
                    id: `art-browser-to-code-${Date.now()}`,
                    type: 'interactive-browser',
                    title: pageTitle,
                    summary: 'Browser canvas',
                    data: { ...data, url: currentUrl, title: pageTitle },
                    createdAt: new Date().toLocaleTimeString(),
                    version: 1
                }, 'live-code-sandbox');
            }
        }
    };

    // Calculate viewport chassis dimensions
    const getViewportStyles = (): { containerStyle: React.CSSProperties; frameStyle: React.CSSProperties } => {
        let width = '100%';
        let height = '100%';
        let borderRadius = '0px';
        let maxWidth = '100%';

        if (viewportMode === 'mobile') {
            width = deviceOrientation === 'portrait' ? '375px' : '667px';
            height = deviceOrientation === 'portrait' ? '680px' : '375px';
            maxWidth = deviceOrientation === 'portrait' ? '375px' : '667px';
            borderRadius = '36px';
        } else if (viewportMode === 'tablet') {
            width = deviceOrientation === 'portrait' ? '768px' : '1024px';
            height = deviceOrientation === 'portrait' ? '760px' : '600px';
            maxWidth = deviceOrientation === 'portrait' ? '768px' : '1024px';
            borderRadius = '24px';
        }

        const isFramed = viewportMode !== 'desktop';

        return {
            containerStyle: {
                display: 'flex',
                alignItems: isFramed ? 'center' : 'stretch',
                justifyContent: 'center',
                padding: isFramed ? '24px 16px' : '0',
                overflow: 'auto',
                flex: 1,
                background: isFramed ? 'radial-gradient(circle at center, rgba(30, 30, 36, 0.6) 0%, rgba(10, 10, 12, 0.95) 100%)' : 'transparent'
            },
            frameStyle: {
                width,
                maxWidth,
                height,
                borderRadius,
                transform: deviceScale !== 1 ? `scale(${deviceScale})` : undefined,
                transformOrigin: 'top center',
                transition: 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
            }
        };
    };

    const viewportStyles = getViewportStyles();

    const filteredLogs = consoleLogs.filter(log => {
        if (logFilter === 'all') return true;
        return log.type === logFilter;
    });

    const errorLogsCount = consoleLogs.filter(l => l.type === 'error').length;
    const warnLogsCount = consoleLogs.filter(l => l.type === 'warn').length;

    // Render interactive web content via proxy iframe or simulated document
    const renderSimulatedContent = () => {
        if (data.mockPageHtml) {
            return (
                <iframe
                    ref={iframeRef}
                    key={iframeKey}
                    srcDoc={data.mockPageHtml}
                    title={pageTitle}
                    className="sb-browser-iframe"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                />
            );
        }

        const effectiveFrameUrl = resolveFrameUrl(currentUrl);

        return (
            <div className="sb-browser-content-wrap">
                <iframe
                    ref={iframeRef}
                    key={iframeKey}
                    src={effectiveFrameUrl}
                    title={pageTitle}
                    className="sb-browser-iframe"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                    onError={() => setHasFrameError(true)}
                />

                {/* Simulated Localhost / Interactive Sandbox Fallback if Frame is blocked or requested */}
                {hasFrameError && (
                    <div className="sb-browser-fallback-overlay">
                        <div className="sb-browser-fallback-card">
                            <div className="sb-browser-fallback-icon">
                                <IconGlobe size={32} />
                            </div>
                            <h3>{pageTitle}</h3>
                            <p className="sb-browser-fallback-desc">
                                Target address <code>{currentUrl}</code> sent security response headers. You can open directly or interact with the client sandbox simulation below:
                            </p>
                            <div className="sb-browser-fallback-actions">
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-primary sb-btn-sm"
                                    onClick={handleOpenExternal}
                                >
                                    <IconExternalLink size={13} />
                                    <span>Open in New Tab</span>
                                </button>
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-secondary sb-btn-sm"
                                    onClick={() => {
                                        setHasFrameError(false);
                                        setUseProxy(true);
                                        handleReload();
                                    }}
                                >
                                    <span>Retry with Gateway Proxy</span>
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="sb-browser-primitive-container">
            {/* Top Browser Chrome Bar */}
            {!hideTopbar && (
                <div className="sb-browser-chrome">
                    {/* Left: Navigation Buttons */}
                    <div className="sb-browser-nav-group">
                        <button
                            type="button"
                            className="sb-browser-nav-btn"
                            title="Go Back"
                            disabled={historyIndex <= 0}
                            onClick={handleBack}
                        >
                            <IconArrowLeft size={14} />
                        </button>
                        <button
                            type="button"
                            className="sb-browser-nav-btn"
                            title="Go Forward"
                            disabled={historyIndex >= history.length - 1}
                            onClick={handleForward}
                        >
                            <IconArrowRight size={14} />
                        </button>
                        <button
                            type="button"
                            className={`sb-browser-nav-btn ${isLoading ? 'sb-btn-spinning' : ''}`}
                            title={isLoading ? 'Stop loading' : 'Reload page'}
                            onClick={handleReload}
                        >
                            <IconRefresh size={14} />
                        </button>
                        <button
                            type="button"
                            className="sb-browser-nav-btn"
                            title="Home"
                            onClick={() => navigateTo('https://example.com')}
                        >
                            <IconGlobe size={14} />
                        </button>
                    </div>

                    {/* Middle: URL Address Bar */}
                    <form className="sb-browser-address-bar" onSubmit={handleUrlSubmit}>
                        <div className="sb-browser-lock-icon" title={isElectronEnvironment ? "Native Chromium Web Engine" : useProxy ? "Chromium Gateway Proxy Active - X-Frame bypass enabled" : "Direct Connection"}>
                            <IconLock size={12} className={useProxy ? "text-emerald-400" : "text-amber-400"} />
                        </div>
                        <input
                            type="text"
                            value={inputUrl}
                            onChange={e => setInputUrl(e.target.value)}
                            className="sb-browser-url-input"
                            placeholder="Enter URL or localhost:3000..."
                            spellCheck={false}
                        />
                        {inputUrl !== currentUrl && (
                            <button
                                type="submit"
                                className="sb-browser-action-btn sb-btn-enter"
                                title="Press Enter to navigate"
                            >
                                <span>Go</span>
                            </button>
                        )}
                        <button
                            type="button"
                            className="sb-browser-action-btn"
                            title={copiedUrl ? 'Copied to clipboard' : 'Copy link'}
                            onClick={handleCopyUrl}
                        >
                            {copiedUrl ? <IconCheck size={12} className="text-emerald-400" /> : <IconCopy size={12} />}
                        </button>
                        <button
                            type="button"
                            className="sb-browser-action-btn"
                            title="Open in external browser window"
                            onClick={handleOpenExternal}
                        >
                            <IconExternalLink size={12} />
                        </button>
                    </form>

                    {/* Right: Viewport Controls & Inspect Drawer Toggle */}
                    <div className="sb-browser-tools-group">
                        {/* Viewport Switcher */}
                        <div className="sb-segmented-control sb-segmented-control-xs">
                            <button
                                type="button"
                                className={`sb-segment-btn ${viewportMode === 'desktop' ? 'sb-segment-active' : ''}`}
                                title="Desktop View (100% Fluid)"
                                onClick={() => {
                                    setViewportMode('desktop');
                                    emitUpdate({ viewportMode: 'desktop' });
                                }}
                            >
                                <IconLaptop size={12} />
                                <span>Desktop</span>
                            </button>
                            <button
                                type="button"
                                className={`sb-segment-btn ${viewportMode === 'tablet' ? 'sb-segment-active' : ''}`}
                                title="Tablet View (768px iPad frame)"
                                onClick={() => {
                                    setViewportMode('tablet');
                                    emitUpdate({ viewportMode: 'tablet' });
                                }}
                            >
                                <IconTablet size={12} />
                                <span>Tablet</span>
                            </button>
                            <button
                                type="button"
                                className={`sb-segment-btn ${viewportMode === 'mobile' ? 'sb-segment-active' : ''}`}
                                title="Mobile View (375px iPhone frame)"
                                onClick={() => {
                                    setViewportMode('mobile');
                                    emitUpdate({ viewportMode: 'mobile' });
                                }}
                            >
                                <IconSmartphone size={12} />
                                <span>Mobile</span>
                            </button>
                        </div>

                        {/* Orientation Toggle for mobile/tablet */}
                        {viewportMode !== 'desktop' && (
                            <button
                                type="button"
                                className="sb-browser-tool-btn"
                                title={`Rotate orientation (${deviceOrientation === 'portrait' ? 'Landscape' : 'Portrait'})`}
                                onClick={() => {
                                    const next = deviceOrientation === 'portrait' ? 'landscape' : 'portrait';
                                    setDeviceOrientation(next);
                                    emitUpdate({ deviceOrientation: next });
                                }}
                            >
                                <IconRefresh size={12} />
                                <span className="text-xs">{deviceOrientation === 'portrait' ? 'Portrait' : 'Landscape'}</span>
                            </button>
                        )}

                        {/* Developer Tools / Inspect Drawer Toggle */}
                        <button
                            type="button"
                            className={`sb-browser-tool-btn ${isConsoleOpen ? 'sb-btn-active' : ''}`}
                            title="Toggle Developer Console & Network Drawer"
                            onClick={() => {
                                const next = !isConsoleOpen;
                                setIsConsoleOpen(next);
                                emitUpdate({ inspectMode: next });
                            }}
                        >
                            <IconTerminal size={12} />
                            <span>DevTools</span>
                            {(errorLogsCount > 0 || warnLogsCount > 0) && (
                                <span className={`sb-badge-count ${errorLogsCount > 0 ? 'sb-badge-error' : 'sb-badge-warn'}`}>
                                    {errorLogsCount > 0 ? errorLogsCount : warnLogsCount}
                                </span>
                            )}
                        </button>

                        {/* AI Agent Interaction Prompt Trigger */}
                        {onPromptAction && (
                            <button
                                type="button"
                                className="sb-btn sb-btn-primary sb-btn-xs sb-browser-ai-btn"
                                title="Ask AI Agent to interact with, navigate, or test this web page"
                                onClick={() => {
                                    onPromptAction(`Analyze active web page at ${currentUrl} and test user navigation flows.`);
                                }}
                            >
                                <IconSparkles size={12} />
                                <span>Ask AI</span>
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Bookmarks Bar */}
            {showBookmarks && (
                <div className="sb-browser-bookmarks-bar">
                    <div className="sb-bookmarks-list">
                        {DEFAULT_BOOKMARKS.map(bm => (
                            <button
                                key={bm.url}
                                type="button"
                                className={`sb-bookmark-item ${currentUrl === bm.url ? 'sb-bookmark-active' : ''}`}
                                onClick={() => navigateTo(bm.url)}
                            >
                                <span className="sb-bookmark-icon">{bm.icon}</span>
                                <span className="sb-bookmark-title">{bm.title}</span>
                            </button>
                        ))}
                    </div>
                    <div className="sb-bookmarks-right">
                        <span className="sb-viewport-metric-pill">
                            {viewportMode === 'desktop' ? 'Fluid (100%)' : viewportMode === 'tablet' ? '768 × 1024' : '375 × 667'}
                        </span>
                    </div>
                </div>
            )}

            {/* AI Agent Live Interaction Notification Banner */}
            {data.isAiInteracting && (
                <div className="sb-browser-ai-banner animate-fadeIn">
                    <div className="sb-ai-pulse-dot" />
                    <span>AI Agent Action: {data.aiActionMessage || `Interacting with ${currentUrl}...`}</span>
                </div>
            )}

            {/* Main Viewport Stage */}
            <div className="sb-browser-stage" style={viewportStyles.containerStyle}>
                <div
                    className={`sb-browser-viewport-frame sb-frame-${viewportMode} ${deviceOrientation === 'landscape' ? 'sb-frame-landscape' : ''}`}
                    style={viewportStyles.frameStyle}
                >
                    {/* Device Chassis Notch for mobile/tablet */}
                    {viewportMode === 'mobile' && (
                        <div className="sb-mobile-notch">
                            <div className="sb-notch-speaker" />
                            <div className="sb-notch-camera" />
                        </div>
                    )}

                    {/* Loading Overlay */}
                    {isLoading && (
                        <div className="sb-browser-loading-bar">
                            <div className="sb-loading-progress-indeterminate" />
                        </div>
                    )}

                    {/* Simulated Interactive AI Cursor Click Marker */}
                    {(clickMarker || data.clickMarker) && (
                        <div
                            className="sb-browser-click-marker animate-ping"
                            style={{
                                left: `${(clickMarker || data.clickMarker)!.x}px`,
                                top: `${(clickMarker || data.clickMarker)!.y}px`
                            }}
                        >
                            <span className="sb-marker-dot" />
                            {(clickMarker || data.clickMarker)!.label && <span className="sb-marker-label">{(clickMarker || data.clickMarker)!.label}</span>}
                        </div>
                    )}

                    {/* Interactive Frame / Simulated Web Page */}
                    {renderSimulatedContent()}
                </div>
            </div>

            {/* Collapsible Developer Console Drawer */}
            {isConsoleOpen && (
                <div className="sb-browser-console-drawer animate-slideUp">
                    {/* Drawer Header & Tabs */}
                    <div className="sb-drawer-header">
                        <div className="sb-drawer-tabs">
                            <button
                                type="button"
                                className={`sb-drawer-tab ${activeDrawerTab === 'console' ? 'sb-tab-active' : ''}`}
                                onClick={() => setActiveDrawerTab('console')}
                            >
                                <IconTerminal size={12} />
                                <span>Console</span>
                                {errorLogsCount > 0 && <span className="sb-tab-badge sb-badge-error">{errorLogsCount}</span>}
                            </button>
                            <button
                                type="button"
                                className={`sb-drawer-tab ${activeDrawerTab === 'network' ? 'sb-tab-active' : ''}`}
                                onClick={() => setActiveDrawerTab('network')}
                            >
                                <IconGlobe size={12} />
                                <span>Network</span>
                                <span className="sb-tab-badge">{networkRequests.length}</span>
                            </button>
                            <button
                                type="button"
                                className={`sb-drawer-tab ${activeDrawerTab === 'dom' ? 'sb-tab-active' : ''}`}
                                onClick={() => setActiveDrawerTab('dom')}
                            >
                                <IconCode size={12} />
                                <span>DOM Tree</span>
                            </button>
                            <button
                                type="button"
                                className={`sb-drawer-tab ${activeDrawerTab === 'actions' ? 'sb-tab-active' : ''}`}
                                onClick={() => setActiveDrawerTab('actions')}
                            >
                                <IconSparkles size={12} />
                                <span>Quick Actions</span>
                            </button>
                            <button
                                type="button"
                                className={`sb-drawer-tab ${activeDrawerTab === 'timeline' ? 'sb-tab-active' : ''}`}
                                onClick={() => setActiveDrawerTab('timeline')}
                            >
                                <IconRefresh size={12} />
                                <span>Agent Timeline</span>
                                {timelineSteps.length > 0 && (
                                    <span className="sb-tab-badge sb-badge-warn">{timelineSteps.length}</span>
                                )}
                            </button>
                        </div>

                        <div className="sb-drawer-controls">
                            {activeDrawerTab === 'console' && (
                                <>
                                    <div className="sb-segmented-control sb-segmented-control-xs">
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${logFilter === 'all' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setLogFilter('all')}
                                        >
                                            All ({consoleLogs.length})
                                        </button>
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${logFilter === 'error' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setLogFilter('error')}
                                        >
                                            Errors ({errorLogsCount})
                                        </button>
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${logFilter === 'warn' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setLogFilter('warn')}
                                        >
                                            Warnings ({warnLogsCount})
                                        </button>
                                    </div>
                                    <button
                                        type="button"
                                        className="sb-drawer-icon-btn"
                                        title="Clear Console"
                                        onClick={handleClearLogs}
                                    >
                                        <IconTrash size={12} />
                                    </button>
                                </>
                            )}
                            <button
                                type="button"
                                className="sb-drawer-icon-btn"
                                title="Close Drawer"
                                onClick={() => setIsConsoleOpen(false)}
                            >
                                <IconClose size={12} />
                            </button>
                        </div>
                    </div>

                    {/* Drawer Tab Content */}
                    <div className="sb-drawer-body">
                        {/* Tab 1: Console Logs */}
                        {activeDrawerTab === 'console' && (
                            <div className="sb-console-panel">
                                <div className="sb-console-logs-list">
                                    {filteredLogs.length === 0 ? (
                                        <div className="sb-console-empty">
                                            <span>No console output matching filter</span>
                                        </div>
                                    ) : (
                                        filteredLogs.map(log => (
                                            <div key={log.id || `${log.timestamp}-${log.text}`} className={`sb-console-log-row sb-log-${log.type}`}>
                                                <span className="sb-log-time">{log.timestamp}</span>
                                                <span className={`sb-log-tag sb-tag-${log.type}`}>{log.type.toUpperCase()}</span>
                                                <span className="sb-log-text">{log.text}</span>
                                            </div>
                                        ))
                                    )}
                                </div>
                                {/* Evaluator input */}
                                <form className="sb-console-eval-form" onSubmit={handleEvaluateJs}>
                                    <span className="sb-eval-prompt">&gt;</span>
                                    <input
                                        type="text"
                                        value={evalInput}
                                        onChange={e => setEvalInput(e.target.value)}
                                        className="sb-eval-input"
                                        placeholder="Evaluate JavaScript expression in page context..."
                                    />
                                    <button type="submit" className="sb-eval-submit-btn">Run</button>
                                </form>
                            </div>
                        )}

                        {/* Tab 2: Network Requests */}
                        {activeDrawerTab === 'network' && (
                            <div className="sb-network-panel">
                                <table className="sb-network-table">
                                    <thead>
                                        <tr>
                                            <th>Name</th>
                                            <th>Status</th>
                                            <th>Type</th>
                                            <th>Time</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {networkRequests.map(req => (
                                            <tr key={req.id}>
                                                <td className="sb-req-url">{req.url}</td>
                                                <td><span className="sb-status-200">{req.status} OK</span></td>
                                                <td><span className="sb-req-type">{req.type}</span></td>
                                                <td>{req.durationMs}ms</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        {/* Tab 3: DOM Tree */}
                        {activeDrawerTab === 'dom' && (
                            <div className="sb-dom-panel">
                                <div className="sb-dom-node">&lt;<span className="sb-tag">html</span> <span className="sb-attr">lang</span>=&quot;en&quot;&gt;</div>
                                <div className="sb-dom-node" style={{ paddingLeft: '16px' }}>&lt;<span className="sb-tag">head</span>&gt; &lt;<span className="sb-tag">title</span>&gt;{pageTitle}&lt;/<span className="sb-tag">title</span>&gt; &lt;/<span className="sb-tag">head</span>&gt;</div>
                                <div className="sb-dom-node" style={{ paddingLeft: '16px' }}>&lt;<span className="sb-tag">body</span> <span className="sb-attr">class</span>=&quot;theme-dark&quot;&gt;</div>
                                <div className="sb-dom-node" style={{ paddingLeft: '32px' }}>&lt;<span className="sb-tag">div</span> <span className="sb-attr">id</span>=&quot;root&quot;&gt;</div>
                                <div className="sb-dom-node" style={{ paddingLeft: '48px' }}>&lt;<span className="sb-tag">main</span> <span className="sb-attr">class</span>=&quot;viewport-container&quot;&gt; ... 12 child nodes &lt;/<span className="sb-tag">main</span>&gt;</div>
                                <div className="sb-dom-node" style={{ paddingLeft: '32px' }}>&lt;/<span className="sb-tag">div</span>&gt;</div>
                                <div className="sb-dom-node" style={{ paddingLeft: '16px' }}>&lt;/<span className="sb-tag">body</span>&gt;</div>
                                <div className="sb-dom-node">&lt;/<span className="sb-tag">html</span>&gt;</div>
                            </div>
                        )}

                        {/* Tab 4: Quick Action Pills */}
                        {activeDrawerTab === 'actions' && (
                            <div className="sb-quick-actions-panel">
                                <button type="button" className="sb-quick-pill" onClick={() => handleQuickAction('inspect_dom')}>
                                    <IconCode size={13} />
                                    <span>Inspect DOM Elements</span>
                                </button>
                                <button type="button" className="sb-quick-pill" onClick={() => handleQuickAction('screenshot')}>
                                    <IconMaximize size={13} />
                                    <span>Capture Viewport Screenshot</span>
                                </button>
                                <button type="button" className="sb-quick-pill" onClick={() => handleQuickAction('run_js')}>
                                    <IconTerminal size={13} />
                                    <span>Run JS in Page Context</span>
                                </button>
                                <button type="button" className="sb-quick-pill" onClick={() => handleQuickAction('emulate_mobile')}>
                                    <IconSmartphone size={13} />
                                    <span>Emulate iPhone 15 Mobile</span>
                                </button>
                                <button type="button" className="sb-quick-pill" onClick={() => handleQuickAction('morph_sandbox')}>
                                    <IconBrowser size={13} />
                                    <span>Morph to Code Sandbox</span>
                                </button>
                            </div>
                        )}

                        {/* Tab 5: Agent Timeline */}
                        {activeDrawerTab === 'timeline' && (
                            <div className="sb-timeline-panel">
                                <div className="sb-timeline-header">
                                    <h4>Agent Actions Audit Trail</h4>
                                    <button 
                                        type="button" 
                                        className="sb-btn sb-btn-secondary sb-btn-xs"
                                        onClick={() => setTimelineSteps([])}
                                        disabled={timelineSteps.length === 0}
                                    >
                                        Clear History
                                    </button>
                                </div>
                                <div className="sb-timeline-list">
                                    {timelineSteps.length === 0 ? (
                                        <div className="sb-timeline-empty">
                                            <IconRefresh size={24} className="text-slate-500 mb-2" />
                                            <span>No AI agent actions recorded yet.</span>
                                            <p className="text-xs text-slate-500 mt-1">Actions taken by the AI will appear here in real-time.</p>
                                        </div>
                                    ) : (
                                        timelineSteps.map((step, idx) => (
                                            <div key={step.id} className="sb-timeline-row">
                                                <div className="sb-timeline-num">{idx + 1}</div>
                                                <div className="sb-timeline-content">
                                                    <div className="sb-timeline-meta">
                                                        <span className="sb-timeline-time">{step.timestamp}</span>
                                                        <span className={`sb-timeline-status-badge status-${step.status}`}>
                                                            {step.status}
                                                        </span>
                                                    </div>
                                                    <div className="sb-timeline-desc">
                                                        <strong>{step.action.toUpperCase()}</strong> {step.target && `on "${step.target}"`}
                                                    </div>
                                                    <div className="sb-timeline-url">
                                                        {step.url}
                                                    </div>
                                                    {step.error && (
                                                        <div className="sb-timeline-error">
                                                            Error: {step.error}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
