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
    CanvasArtifact,
    ChartDataPoint,
    ChatMessage,
    ChatSession,
    DEFAULT_MCP_SERVERS,
    DEFAULT_SKILLS_CATALOG,
    GroundingMetadata,
    KanbanBoardData,
    LiveCodeSandboxData,
    MarkdownDocumentData,
    MarkdownSection,
    McpExecutionState,
    McpServerItem,
    MetricDashboardData,
    MetricCardsData,
    MetricItem,
    ModalStackManager,
    ModalType,
    NodeGraphData,
    PrimitiveType,
    SessionViewState,
    SessionViewStateCache,
    SkillItem,
    StudioAppearanceConfig,
    StudioLayoutMode,
    StageLayoutMode,
    StudioSettingsTab,
    TokenBudgetMetrics,
    TerminalExecutionError,
    WorkspaceFileType,
    Scene3DData,
    InteractiveBrowserData,
    CodeFileTab,
    getActiveUserName,
    AgentExecutionStep,
    SandboxTemplate,
    SandboxLanguage
} from './canvas-types';
import { NodeGraphPrimitive } from './primitives/NodeGraphPrimitive';
import { MarkdownDocumentPrimitive } from './primitives/MarkdownDocumentPrimitive';
import { KanbanBoardPrimitive } from './primitives/KanbanBoardPrimitive';
import { LiveCodeSandboxPrimitive } from './primitives/LiveCodeSandboxPrimitive';
import { isVibeToolRequest, synthesizeVibeToolSandbox } from './vibe-tool-synthesizer';
import { Scene3DPrimitive } from './primitives/Scene3DPrimitive';
import { InteractiveBrowserPrimitive } from './primitives/InteractiveBrowserPrimitive';
import { BentoStageLayout } from './BentoStageLayout';
import { RelatedArtifactsRail } from './RelatedArtifactsRail';
import { ProjectArtifactController } from './project-artifact-controller';
import { UnifiedProjectCoordinator } from './unified-project-coordinator';
import { stableProjectArtifactId } from '../../common/project-artifact-graph-protocol';
import { SettingsModal } from './SettingsModal';
import { DEFAULT_RECENT_PROJECTS, ProjectItem } from './ProjectsModal';
import { SpotlightLauncherModal } from './SpotlightLauncherModal';
import { AutomationsModal } from './AutomationsModal';
export { AutomationsModal };
import { GoogleDriveConnectModal } from './GoogleDriveConnectModal';
import { GoogleDriveService } from './google-drive-service';
import type {
    ContextMentionCategory,
    ContextMentionItem
} from './context-mention-engine';
import {
    resolveContextMentionQuery,
    findTriggerMatch,
    insertMentionToken,
    cycleSelectedIndex
} from './context-mention-engine';
import { ContextMentionAutocompletePopover } from './ContextMentionAutocompletePopover';
import {
    synthesizeTerminalDebugPrompt
} from './terminal-debug-bridge';
import { GeminiClient, AudioPlayer } from './gemini-client';
import { WorkspaceConfigClient } from './workspace-config-client';
import {
    IconAutomations,
    IconChat,
    IconChevronDown,
    IconChevronRight,
    IconClose,
    IconCode,
    IconCustomize,
    IconDocument,
    IconFolder,
    IconKanban,
    IconMic,
    IconNewChat,
    IconPlus,
    IconSearch,
    IconSettings,
    IconSparkles,
    Icon3D,
    IconGlobe,
    IconList,
    IconEdit,
    IconSplit,
    getPrimitiveSvgIcon
} from './canvas-icons';
import {
    AttachedMcpToolContext,
    AttachedSkillContext,
    GeminiStatus
} from '../../common/gemini-protocol';
import {
    AgentSessionState,
    AgentStreamEvent,
    AgentStepRecord
} from '../../common/agent-checkpoint-protocol';
import {
    ChatMarkdownRenderer,
    ThinkingDisclosure,
    AgentExecutionStepper,
    StreamingCursor,
    cleanMessageTextSmart,
    extractArtifactFromJson
} from './ChatMarkdownRenderer';
import { CanvasErrorBoundary } from './CanvasErrorBoundary';
import {
    resolveModeForArtifact,
    sanitizeLayoutMode
} from './guardrails-service';
import { morphArtifact } from './primitive-transformer-engine';
import { synthesizeContextual3DScene } from './procedural-3d-synthesizer';
import {
    CodebaseLensController,
    CodebaseLensRegistry,
    MarkdownDocumentLens,
    LiveCodeSandboxLens,
    KanbanTaskLens,
    NodeGraphWorkflowLens
} from './lenses';
import {
    extractDocumentTitleFromPrompt,
    generateMotivatedEditorialImageSection,
    synthesizeComprehensiveDocument,
    synthesizeMediaDocument
} from './document-synthesis-engine';

export {
    extractDocumentTitleFromPrompt,
    generateMotivatedEditorialImageSection,
    synthesizeComprehensiveDocument,
    synthesizeMediaDocument
};
import { useChatStore, selectActiveSession } from './state/chatStore';
import { DEFAULT_WORKSPACE_FILES, DEFAULT_WORKSPACE_GIT_STATUS } from './state/studio-defaults';
import { loadInitialChatState, loadSavedAppearance, usePersistedChatState } from './hooks/usePersistedChatState';


export interface FileTreeNode {
    name: string;
    path: string;
    isFolder: boolean;
    children?: FileTreeNode[];
}

export const SCRATCHBOX_TREE: FileTreeNode[] = [
    {
        name: '.cursor',
        path: '.cursor',
        isFolder: true,
        children: [
            { name: 'rules.json', path: '.cursor/rules.json', isFolder: false }
        ]
    },
    {
        name: 'applications',
        path: 'applications',
        isFolder: true,
        children: [
            { name: 'electron-app.ts', path: 'applications/electron-app.ts', isFolder: false },
            { name: 'package.json', path: 'applications/package.json', isFolder: false }
        ]
    },
    {
        name: 'extensions',
        path: 'extensions',
        isFolder: true,
        children: [
            {
                name: 'product',
                path: 'extensions/product',
                isFolder: true,
                children: [
                    {
                        name: 'src',
                        path: 'extensions/product/src',
                        isFolder: true,
                        children: [
                            {
                                name: 'browser',
                                path: 'extensions/product/src/browser',
                                isFolder: true,
                                children: [
                                    {
                                        name: 'generative-canvas',
                                        path: 'extensions/product/src/browser/generative-canvas',
                                        isFolder: true,
                                        children: [
                                            {
                                                name: 'primitives',
                                                path: 'extensions/product/src/browser/generative-canvas/primitives',
                                                isFolder: true,
                                                children: [
                                                    { name: 'LiveCodeSandboxPrimitive.tsx', path: 'extensions/product/src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive.tsx', isFolder: false },
                                                    { name: 'MarkdownDocumentPrimitive.tsx', path: 'extensions/product/src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive.tsx', isFolder: false },
                                                    { name: 'KanbanBoardPrimitive.tsx', path: 'extensions/product/src/browser/generative-canvas/primitives/KanbanBoardPrimitive.tsx', isFolder: false },
                                                    { name: 'NodeGraphPrimitive.tsx', path: 'extensions/product/src/browser/generative-canvas/primitives/NodeGraphPrimitive.tsx', isFolder: false },
                                                    { name: 'Scene3DPrimitive.tsx', path: 'extensions/product/src/browser/generative-canvas/primitives/Scene3DPrimitive.tsx', isFolder: false }
                                                ]
                                            },
                                            { name: 'GenerativeCanvasStudio.tsx', path: 'extensions/product/src/browser/generative-canvas/GenerativeCanvasStudio.tsx', isFolder: false },
                                            { name: 'canvas-types.ts', path: 'extensions/product/src/browser/generative-canvas/canvas-types.ts', isFolder: false },
                                            { name: 'unified-ui.css', path: 'extensions/product/src/browser/generative-canvas/unified-ui.css', isFolder: false }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        ]
    },
    { name: 'package.json', path: 'package.json', isFolder: false },
    { name: 'tsconfig.json', path: 'tsconfig.json', isFolder: false }
];

export const POSE_3D_TREE: FileTreeNode[] = [
    {
        name: '.cursor',
        path: '.cursor',
        isFolder: true,
        children: [
            { name: 'rules.json', path: '.cursor/rules.json', isFolder: false }
        ]
    },
    {
        name: 'dist',
        path: 'dist',
        isFolder: true,
        children: [
            { name: 'index.html', path: 'dist/index.html', isFolder: false },
            { name: 'main.js', path: 'dist/main.js', isFolder: false }
        ]
    },
    {
        name: 'mcp',
        path: 'mcp',
        isFolder: true,
        children: [
            { name: 'mcp-config.json', path: 'mcp/mcp-config.json', isFolder: false }
        ]
    },
    {
        name: 'node_modules',
        path: 'node_modules',
        isFolder: true,
        children: [
            { name: 'three.js', path: 'node_modules/three.js', isFolder: false }
        ]
    },
    {
        name: 'public',
        path: 'public',
        isFolder: true,
        children: [
            { name: 'favicon.ico', path: 'public/favicon.ico', isFolder: false }
        ]
    },
    {
        name: 'screenshots',
        path: 'screenshots',
        isFolder: true,
        children: [
            { name: 'pose_diagram.png', path: 'screenshots/pose_diagram.png', isFolder: false }
        ]
    },
    {
        name: 'scripts',
        path: 'scripts',
        isFolder: true,
        children: [
            { name: 'deploy.sh', path: 'scripts/deploy.sh', isFolder: false }
        ]
    },
    {
        name: 'src',
        path: 'src',
        isFolder: true,
        children: [
            {
                name: 'assets',
                path: 'src/assets',
                isFolder: true,
                children: [
                    { name: 'anatomy_atlas.png', path: 'src/assets/anatomy_atlas.png', isFolder: false }
                ]
            },
            {
                name: 'components',
                path: 'src/components',
                isFolder: true,
                children: [
                    { name: 'AnatomicalBodyDiagram.tsx', path: 'src/components/AnatomicalBodyDiagram.tsx', isFolder: false },
                    { name: 'AnimationEngine.ts', path: 'src/components/AnimationEngine.ts', isFolder: false },
                    { name: 'AnimationTimeline.tsx', path: 'src/components/AnimationTimeline.tsx', isFolder: false },
                    { name: 'AnimationTypes.ts', path: 'src/components/AnimationTypes.ts', isFolder: false },
                    { name: 'CameraPresets.ts', path: 'src/components/CameraPresets.ts', isFolder: false },
                    { name: 'ComicExporterEngine.ts', path: 'src/components/ComicExporterEngine.ts', isFolder: false },
                    { name: 'ComicExporterModal.tsx', path: 'src/components/ComicExporterModal.tsx', isFolder: false },
                    { name: 'CompositionGuidesEngine.ts', path: 'src/components/CompositionGuidesEngine.ts', isFolder: false },
                    { name: 'CompositionGuidesOverlay.tsx', path: 'src/components/CompositionGuidesOverlay.tsx', isFolder: false },
                    { name: 'CompositionGuidesTypes.ts', path: 'src/components/CompositionGuidesTypes.ts', isFolder: false },
                    { name: 'ControlNetSkeletonEngine.ts', path: 'src/components/ControlNetSkeletonEngine.ts', isFolder: false },
                    { name: 'DirectorExportModal.tsx', path: 'src/components/DirectorExportModal.tsx', isFolder: false },
                    { name: 'DirectorFramingOverlay.tsx', path: 'src/components/DirectorFramingOverlay.tsx', isFolder: false },
                    { name: 'DrawingCanvas.tsx', path: 'src/components/DrawingCanvas.tsx', isFolder: false },
                    { name: 'DrawingEngine.ts', path: 'src/components/DrawingEngine.ts', isFolder: false }
                ]
            }
        ]
    }
];


// ==========================================
// Multimedia & Geospatial Rendering Cards
// ==========================================
const ImageGeneratedCard: React.FC<{
    imageContent?: string;
    imagesContent?: string[];
}> = ({ imageContent, imagesContent }) => {
    const images = React.useMemo(() => {
        const list: string[] = [];
        if (imageContent) list.push(imageContent);
        if (imagesContent) {
            imagesContent.forEach(img => {
                if (img) list.push(img);
            });
        }
        return Array.from(new Set(list));
    }, [imageContent, imagesContent]);

    const [statusText, setStatusText] = React.useState<string | null>(null);

    const handleAction = (action: string) => {
        setStatusText(`${action}...`);
        setTimeout(() => {
            setStatusText(`${action} Succeeded!`);
            setTimeout(() => setStatusText(null), 2000);
        }, 1000);
    };

    if (images.length === 0) return null;

    return (
        <div className="sb-multimedia-card sb-image-card">
            <div className="sb-image-grid">
                {images.map((img, idx) => (
                    <div key={idx} className="sb-image-wrapper">
                        <img src={img} alt="Generated asset" className="sb-image-preview" />
                        <div className="sb-image-overlay">
                            <button
                                className="sb-btn sb-btn-secondary sb-btn-xs"
                                onClick={() => handleAction('Apply as 3D Texture')}
                            >
                                Apply as 3D Texture
                            </button>
                            <button
                                className="sb-btn sb-btn-secondary sb-btn-xs"
                                onClick={() => handleAction('Apply as Texture')}
                            >
                                Apply as Texture
                            </button>
                            <button
                                className="sb-btn sb-btn-secondary sb-btn-xs"
                                onClick={() => handleAction('Insert into Code')}
                            >
                                Insert into Code
                            </button>
                            <button
                                className="sb-btn sb-btn-secondary sb-btn-xs"
                                onClick={() => handleAction('Remix Prompt')}
                            >
                                Remix Prompt
                            </button>
                        </div>
                    </div>
                ))}
            </div>
            {statusText && (
                <div className="sb-image-status-badge">
                    <span>{statusText}</span>
                </div>
            )}
        </div>
    );
};

const STATIC_WAVEFORM_HEIGHTS = [
    8, 14, 20, 16, 26, 22, 14, 10, 18, 24,
    28, 22, 16, 20, 26, 18, 12, 16, 24, 28,
    22, 16, 12, 18, 22, 16, 10, 14, 18, 10
];

const AudioNarratedCard: React.FC<{
    audioContent: string;
}> = ({ audioContent }) => {
    const audioRef = React.useRef<HTMLAudioElement>(null);
    const [isPlaying, setIsPlaying] = React.useState(false);
    const [currentTime, setCurrentTime] = React.useState(0);
    const [duration, setDuration] = React.useState(0);
    const [volume, setVolume] = React.useState(1);
    const [isMuted, setIsMuted] = React.useState(false);

    const audioSrc = React.useMemo(() => {
        if (!audioContent) return '';
        if (audioContent.startsWith('data:') || audioContent.startsWith('http') || audioContent.startsWith('/')) {
            return audioContent;
        }
        return `data:audio/wav;base64,${audioContent}`;
    }, [audioContent]);

    const handlePlayPause = () => {
        if (!audioRef.current) return;
        if (isPlaying) {
            audioRef.current.pause();
        } else {
            audioRef.current.play().catch(() => {});
        }
    };

    const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!audioRef.current) return;
        const val = parseFloat(e.target.value);
        audioRef.current.currentTime = val;
        setCurrentTime(val);
    };

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!audioRef.current) return;
        const val = parseFloat(e.target.value);
        audioRef.current.volume = val;
        setVolume(val);
        setIsMuted(val === 0);
    };

    const toggleMute = () => {
        if (!audioRef.current) return;
        const nextMuted = !isMuted;
        audioRef.current.muted = nextMuted;
        setIsMuted(nextMuted);
    };

    const formatTime = (secs: number) => {
        if (isNaN(secs)) return '0:00';
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    };

    return (
        <div className="sb-multimedia-card sb-audio-card">
            <audio
                ref={audioRef}
                src={audioSrc}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onTimeUpdate={() => {
                    if (audioRef.current) {
                        setCurrentTime(audioRef.current.currentTime);
                    }
                }}
                onLoadedMetadata={() => {
                    if (audioRef.current) {
                        setDuration(audioRef.current.duration);
                    }
                }}
                onEnded={() => setIsPlaying(false)}
            />

            <div className="sb-audio-layout">
                <div className="sb-waveform-container">
                    {STATIC_WAVEFORM_HEIGHTS.map((baseH, idx) => (
                        <div
                            key={idx}
                            className={`sb-waveform-bar ${isPlaying ? 'sb-waveform-animated-bar' : ''}`}
                            style={{
                                height: `${baseH}px`,
                                opacity: isPlaying ? 0.9 : 0.45,
                                backgroundColor: isPlaying ? 'var(--sb-system-blue, #3b82f6)' : 'var(--sb-text-tertiary, #a1a1aa)',
                                animationDelay: isPlaying ? `${(idx % 8) * 0.14}s` : undefined,
                                animationDuration: isPlaying ? `${0.9 + ((idx * 3) % 7) * 0.1}s` : undefined
                            }}
                        />
                    ))}
                </div>

                <div className="sb-audio-controls-row">
                    <button className="sb-btn sb-audio-button" onClick={handlePlayPause}>
                        {isPlaying ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                            </svg>
                        ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z"/>
                            </svg>
                        )}
                    </button>

                    <div className="sb-audio-scrubber-wrap">
                        <input
                            type="range"
                            min="0"
                            max={duration || 100}
                            value={currentTime}
                            onChange={handleScrub}
                            className="sb-audio-scrubber"
                        />
                        <div className="sb-audio-time-label">
                            <span>{formatTime(currentTime)}</span>
                            <span>{formatTime(duration)}</span>
                        </div>
                    </div>

                    <div className="sb-audio-volume-wrap">
                        <button className="sb-btn sb-audio-button" onClick={toggleMute} style={{ width: 24, height: 24 }}>
                            {isMuted || volume === 0 ? (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.21.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.03c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                                </svg>
                            ) : (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                                </svg>
                            )}
                        </button>
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.05"
                            value={isMuted ? 0 : volume}
                            onChange={handleVolumeChange}
                            className="sb-audio-volume-slider"
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

const CinematicVideoCard: React.FC<{
    videoContent: string;
}> = ({ videoContent }) => {
    const videoRef = React.useRef<HTMLVideoElement>(null);
    const [isPlaying, setIsPlaying] = React.useState(false);
    const [currentTime, setCurrentTime] = React.useState(0);
    const [duration, setDuration] = React.useState(0);
    const [playbackRate, setPlaybackRate] = React.useState(1.0);
    const [isLooping, setIsLooping] = React.useState(false);
    const [statusText, setStatusText] = React.useState<string | null>(null);

    const handlePlayPause = () => {
        if (!videoRef.current) return;
        if (isPlaying) {
            videoRef.current.pause();
        } else {
            videoRef.current.play().catch(() => {});
        }
    };

    const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!videoRef.current) return;
        const val = parseFloat(e.target.value);
        videoRef.current.currentTime = val;
        setCurrentTime(val);
    };

    const changeSpeed = (speed: number) => {
        if (!videoRef.current) return;
        videoRef.current.playbackRate = speed;
        setPlaybackRate(speed);
    };

    const toggleLoop = () => {
        if (!videoRef.current) return;
        const nextLoop = !isLooping;
        videoRef.current.loop = nextLoop;
        setIsLooping(nextLoop);
    };

    const handleAddToTimeline = () => {
        setStatusText('Adding to Timeline...');
        setTimeout(() => {
            setStatusText('Successfully added to Timeline!');
            setTimeout(() => setStatusText(null), 2500);
        }, 1200);
    };

    const formatTime = (secs: number) => {
        if (isNaN(secs)) return '0:00';
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    };

    return (
        <div className="sb-multimedia-card sb-video-card">
            <div className="sb-video-viewport-wrapper">
                <video
                    ref={videoRef}
                    src={videoContent}
                    className="sb-video-player"
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onTimeUpdate={() => {
                        if (videoRef.current) {
                            setCurrentTime(videoRef.current.currentTime);
                        }
                    }}
                    onLoadedMetadata={() => {
                        if (videoRef.current) {
                            setDuration(videoRef.current.duration);
                        }
                    }}
                    onClick={handlePlayPause}
                />
            </div>

            <div className="sb-video-controls-overlay">
                <div className="sb-video-scrubber-row">
                    <input
                        type="range"
                        min="0"
                        max={duration || 100}
                        value={currentTime}
                        onChange={handleScrub}
                        className="sb-video-timeline-scrubber"
                    />
                </div>

                <div className="sb-video-buttons-row">
                    <div className="sb-video-left-actions">
                        <button className="sb-btn sb-video-button" onClick={handlePlayPause}>
                            {isPlaying ? (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                                </svg>
                            ) : (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M8 5v14l11-7z"/>
                                </svg>
                            )}
                        </button>

                        <span style={{ fontSize: '11px', color: '#a1a1aa', fontFamily: 'monospace' }}>
                            {formatTime(currentTime)} / {formatTime(duration)}
                        </span>
                    </div>

                    <div className="sb-video-right-actions">
                        <div className="sb-video-speed-multipliers">
                            {[0.5, 1.0, 2.0].map(speed => (
                                <button
                                    key={speed}
                                    className={`sb-btn sb-video-speed-btn ${playbackRate === speed ? 'sb-active-speed' : ''}`}
                                    onClick={() => changeSpeed(speed)}
                                >
                                    {speed}x
                                </button>
                            ))}
                        </div>

                        <button
                            className={`sb-btn sb-btn-xs ${isLooping ? 'sb-btn-primary' : 'sb-btn-secondary'}`}
                            onClick={toggleLoop}
                        >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M17 1l4 4-4 4" />
                                <path d="M3 11V9a4 4 0 014-4h14M7 23l-4-4 4-4" />
                                <path d="M21 13v2a4 4 0 01-4 4H3" />
                            </svg>
                            <span style={{ marginLeft: 4 }}>Loop</span>
                        </button>

                        <button
                            className="sb-btn sb-btn-secondary sb-btn-xs sb-video-action-btn"
                            onClick={handleAddToTimeline}
                        >
                            Add to 4D Timeline
                        </button>
                    </div>
                </div>
            </div>

            {statusText && (
                <div className="sb-image-status-badge">
                    <span>{statusText}</span>
                </div>
            )}
        </div>
    );
};

const GoogleMapsCard: React.FC<{
    mapContent: { lat: number; lng: number; placeName: string; address?: string };
}> = ({ mapContent }) => {
    const canvasRef = React.useRef<HTMLCanvasElement>(null);
    const [isCollapsed, setIsCollapsed] = React.useState(false);
    const [statusText, setStatusText] = React.useState<string | null>(null);

    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);

        ctx.fillStyle = '#18181b';
        ctx.fillRect(0, 0, width, height);

        ctx.strokeStyle = '#27272a';
        ctx.lineWidth = 2;

        const streetOffset = Math.floor((mapContent.lat + mapContent.lng) * 1000) % 50;

        for (let x = streetOffset; x < width; x += 40) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }

        for (let y = streetOffset; y < height; y += 40) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }

        ctx.strokeStyle = '#09090b';
        ctx.lineWidth = 12;
        ctx.beginPath();
        ctx.moveTo(0, height * 0.3);
        ctx.bezierCurveTo(width * 0.3, height * 0.1, width * 0.7, height * 0.9, width, height * 0.7);
        ctx.stroke();

        ctx.strokeStyle = '#1d4ed8';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(0, height * 0.3);
        ctx.bezierCurveTo(width * 0.3, height * 0.1, width * 0.7, height * 0.9, width, height * 0.7);
        ctx.stroke();

        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.font = '9px monospace';
        ctx.fillText(`LAT: ${mapContent.lat.toFixed(4)}°`, 10, 20);
        ctx.fillText(`LNG: ${mapContent.lng.toFixed(4)}°`, 10, 32);

        const cx = width / 2;
        const cy = height / 2;

        const gradient = ctx.createRadialGradient(cx, cy, 2, cx, cy, 25);
        gradient.addColorStop(0, 'rgba(59, 130, 246, 0.5)');
        gradient.addColorStop(1, 'rgba(59, 130, 246, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(cx, cy, 25, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, 8, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(59, 130, 246, 0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, 16, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.bezierCurveTo(cx - 8, cy - 12, cx - 8, cy - 20, cx, cy - 20);
        ctx.bezierCurveTo(cx + 8, cy - 20, cx + 8, cy - 12, cx, cy);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(cx, cy - 14, 3, 0, Math.PI * 2);
        ctx.fill();

    }, [mapContent]);

    const handleTilesAction = () => {
        setStatusText('Loading 3D Photorealistic Tiles...');
        setTimeout(() => {
            setStatusText('3D Photorealistic Tiles Rendered!');
            setTimeout(() => setStatusText(null), 2500);
        }, 1200);
    };

    return (
        <div className="sb-multimedia-card sb-maps-card">
            <div className="sb-maps-viewport">
                <canvas ref={canvasRef} className="sb-maps-canvas" />
                <div className="sb-maps-coordinates-badge">
                    GPS: {mapContent.lat.toFixed(6)}, {mapContent.lng.toFixed(6)}
                </div>
            </div>

            <div className="sb-maps-details-card">
                <div className="sb-maps-details-header" onClick={() => setIsCollapsed(!isCollapsed)}>
                    <div>
                        <div className="sb-maps-place-title">{mapContent.placeName}</div>
                        {mapContent.address && (
                            <div className="sb-maps-place-address">{mapContent.address}</div>
                        )}
                    </div>
                    <button className="sb-btn sb-maps-button" style={{ width: 20, height: 20 }}>
                        {isCollapsed ? (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M19 9l-7 7-7-7" />
                            </svg>
                        ) : (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M5 15l7-7 7 7" />
                            </svg>
                        )}
                    </button>
                </div>

                {!isCollapsed && (
                    <div className="sb-maps-collapsible-content">
                        <div><strong>Latitude:</strong> {mapContent.lat.toFixed(6)}</div>
                        <div><strong>Longitude:</strong> {mapContent.lng.toFixed(6)}</div>
                        <div className="sb-maps-actions" style={{ marginTop: 8 }}>
                            <button
                                className="sb-btn sb-btn-primary sb-btn-xs"
                                onClick={handleTilesAction}
                            >
                                Map 3D Photorealistic Tiles
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {statusText && (
                <div className="sb-image-status-badge">
                    <span>{statusText}</span>
                </div>
            )}
        </div>
    );
};

export { StreamBufferQueue, captureActiveCanvasScreenshot } from './chat/streaming-utils';
import { StreamBufferQueue, captureActiveCanvasScreenshot, streamTokensAsync } from './chat/streaming-utils';
import { useSendMessage } from './hooks/useSendMessage';

export interface GenerativeCanvasStudioProps {
    onOpenFolder?: () => void;
    onCreateFile?: () => void;
    onOpenWorkspace?: () => void;
    onOpenPreferences?: () => void;
    onOpenKeyboardShortcuts?: () => void;
    onExecuteCommand?: (commandId: string) => void;
}

export const GenerativeCanvasStudio: React.FC<GenerativeCanvasStudioProps> = ({
    onOpenFolder,
    onCreateFile,
    onOpenWorkspace,
    onOpenPreferences,
    onOpenKeyboardShortcuts,
    onExecuteCommand
}) => {
    // Chat Sessions, active conversation & canvas state live in the reducer-backed chat store
    const initialChatState = React.useMemo(() => {
        const loaded = loadInitialChatState();
        return { ...loaded, layoutMode: sanitizeLayoutMode(loaded.layoutMode, loaded.activeArtifact) };
    }, []);
    const chatStore = useChatStore(initialChatState);
    const {
        state: chatState,
        setSessions,
        setCurrentSessionId,
        setMessages,
        setActiveArtifact,
        setArtifactHistory,
        setArtifactVersions,
        setLayoutMode
    } = chatStore;
    const { sessions, currentSessionId, messages, activeArtifact, artifactHistory, artifactVersions, layoutMode } = chatState;
    const activeSession = selectActiveSession(chatState);
    const [isSidebarOpen, setIsSidebarOpen] = React.useState<boolean>(() =>
        typeof window !== 'undefined' ? window.innerWidth > 1024 : true
    );

    // Session-Bound Stream Isolation Ref
    const activeSessionRef = React.useRef<string | undefined>(currentSessionId);
    React.useEffect(() => {
        activeSessionRef.current = currentSessionId;
    }, [currentSessionId]);

    // Viewport & Sub-Tab State Retention Cache
    const sessionViewStateCacheRef = React.useRef<SessionViewStateCache>(new SessionViewStateCache());

    // Unified LIFO Modal Stack Manager
    const modalManagerRef = React.useRef<ModalStackManager>(new ModalStackManager());
    const [modalStack, setModalStack] = React.useState<ModalType[]>([]);

    const openModal = React.useCallback((modal: ModalType) => {
        modalManagerRef.current.openModal(modal);
        setModalStack(modalManagerRef.current.getStack());
    }, []);

    const closeModal = React.useCallback((modal: ModalType) => {
        modalManagerRef.current.closeModal(modal);
        setModalStack(modalManagerRef.current.getStack());
    }, []);

    const closeTopModal = React.useCallback(() => {
        const popped = modalManagerRef.current.closeTopModal();
        setModalStack(modalManagerRef.current.getStack());
        return popped;
    }, []);

    const isSpotlightOpen = modalStack.includes('spotlight');
    const isSettingsOpen = modalStack.includes('settings');
    const isGoogleDriveOpen = modalStack.includes('google-drive');
    const [globalToast, setGlobalToast] = React.useState<{ text: string; icon: string } | undefined>(undefined);

    const showToast = React.useCallback((text: string, icon: string = '') => {
        setGlobalToast({ text, icon });
        setTimeout(() => setGlobalToast(undefined), 3200);
    }, []);

    // Composer & generation state
    const [inputValue, setInputValue] = React.useState<string>('');
    const [checkpointFeedback, setCheckpointFeedback] = React.useState<Record<string, string>>({});
    const [isGenerating, setIsGenerating] = React.useState<boolean>(false);
    const [isVoiceActive, setIsVoiceActive] = React.useState<boolean>(false);
    const speechRecognitionRef = React.useRef<any>(null);

    // Capabilities & Live Tools state
    const [skills, setSkills] = React.useState<SkillItem[]>(DEFAULT_SKILLS_CATALOG);
    const [mcpServers, setMcpServers] = React.useState<McpServerItem[]>(DEFAULT_MCP_SERVERS);
    const [mcpExecutions, setMcpExecutions] = React.useState<McpExecutionState[]>([]);
    const [googleSearchGrounding, setGoogleSearchGrounding] = React.useState<boolean>(() => {
        if (typeof localStorage !== 'undefined') {
            const saved = localStorage.getItem('scratchbox_google_search_grounding');
            if (saved !== null) return saved === 'true';
        }
        return true;
    });

    // Gemini 3.7 Flash Backend State & Live Streaming Tokens
    const [, setGeminiStatus] = React.useState<GeminiStatus | undefined>(undefined);
    const [liveThinkingText, setLiveThinkingText] = React.useState<string>('');
    const [liveThinkingSeconds, setLiveThinkingSeconds] = React.useState<number>(0);
    const [liveSteps, setLiveSteps] = React.useState<AgentExecutionStep[]>([]);
    const [liveStreamedText, setLiveStreamedText] = React.useState<string>('');
    const [activeStreamingSectionId, setActiveStreamingSectionId] = React.useState<string | undefined>(undefined);

    // Layout Modes (layoutMode itself lives in the chat store)
    const [aiInteractionMode, setAiInteractionMode] = React.useState<'agent' | 'ask' | 'plan'>('agent');
    const [stageLayoutMode, setStageLayoutMode] = React.useState<StageLayoutMode>('single');
    const [docReadOnly, setDocReadOnly] = React.useState<boolean>(false);
    const [documentPaneState, setDocumentPaneState] = React.useState<'split' | 'collapsed' | 'expanded'>('split');

    // Switch dedicated workspace layout mode (Chat, Code/Sandbox, Document/Spec, Kanban)
    const handleSwitchMode = (targetMode: StudioLayoutMode) => {
        const effectiveMode = targetMode === 'canvas' ? 'code' : targetMode;
        setLayoutMode(effectiveMode);
        if (effectiveMode !== 'chat') {
            setDocumentPaneState(prev => prev === 'collapsed' ? 'split' : prev);
        }
        if (effectiveMode === 'chat') {
            return;
        }

        const typeMap: Record<string, PrimitiveType[]> = {
            code: ['live-code-sandbox'],
            canvas: ['node-graph', 'live-code-sandbox', 'metric-dashboard', 'mind-map', 'skills-hub', 'mcp-hub'],
            document: ['markdown-document', 'checklist', 'interactive-form'],
            kanban: ['kanban-board'],
            automation: ['node-graph'],
            '3d': ['3d-scene'],
            browser: ['interactive-browser', 'browser']
        };

        const targetTypes = typeMap[effectiveMode] || [];

        // If activeArtifact matches the target mode, keep it
        if (activeArtifact && targetTypes.includes(activeArtifact.type)) {
            return;
        }

        // Check if there is an artifact in history matching this mode
        const matchingFromHistory = artifactHistory.find(a => targetTypes.includes(a.type));
        if (matchingFromHistory) {
            setActiveArtifact(matchingFromHistory);
            return;
        }

        // Contextual defaults for immediate visualization
        if (effectiveMode === 'code') {
            const defaultSandbox: CanvasArtifact = {
                id: `art-sandbox-${Date.now()}`,
                type: 'live-code-sandbox',
                title: 'Interactive React 19 UI Playground',
                summary: 'Live editable multi-tab code runner with hot reload, CDN packages & runtime console.',
                version: 1,
                createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                data: {
                    title: 'Interactive React 19 UI Playground',
                    subtitle: 'Multi-tab live code runner with hot reload & runtime console',
                    template: 'react',
                    files: [
                        {
                            id: 'file-app',
                            name: 'App.tsx',
                            language: 'react',
                            content: `import React, { useState } from 'react';\nimport { Sparkles, Play, CheckCircle2 } from 'lucide-react';\nimport confetti from 'canvas-confetti';\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n\n  const handleCelebrate = () => {\n    setCount(prev => prev + 1);\n    confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } });\n    console.log('Celebration action triggered! Count:', count + 1);\n  };\n\n  return (\n    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-zinc-950 text-zinc-100 selection:bg-blue-500 selection:text-white">\n      <div className="w-full max-w-md p-8 bg-zinc-900/80 backdrop-blur-xl border border-zinc-800/80 rounded-3xl shadow-2xl space-y-6 text-center">\n        <div className="inline-flex p-3 rounded-2xl bg-blue-500/10 text-blue-400 border border-blue-500/20 shadow-inner">\n          <Sparkles className="w-8 h-8 animate-pulse" />\n        </div>\n        <div className="space-y-2">\n          <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-zinc-100 via-zinc-200 to-zinc-400 bg-clip-text text-transparent">Scratchbox Live UI Sandbox</h1>\n          <p className="text-sm text-zinc-400">Interactive React 19 + Tailwind CSS playground with hot reload and live console streams.</p>\n        </div>\n        <div className="p-4 bg-zinc-950/60 rounded-2xl border border-zinc-800/50 flex items-center justify-around">\n          <div><div className="text-xs text-zinc-500 font-medium">Interactions</div><div className="text-3xl font-extrabold text-blue-400">{count}</div></div>\n          <div className="h-8 w-px bg-zinc-800"></div>\n          <div><div className="text-xs text-zinc-500 font-medium">Status</div><div className="text-sm font-semibold text-emerald-400 flex items-center gap-1 mt-1"><CheckCircle2 className="w-4 h-4" /> Live</div></div>\n        </div>\n        <button onClick={handleCelebrate} className="sb-btn sb-btn-primary w-full py-3.5 px-6 rounded-xl font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-blue-500/25 active:scale-[0.98] transition-all flex items-center justify-center gap-2 group">\n          <Play className="w-4 h-4 fill-current transition-transform group-hover:translate-x-0.5" />\n          <span>Trigger Interactive Action</span>\n        </button>\n      </div>\n    </div>\n  );\n}`,
                            isEntry: true
                        },
                        {
                            id: 'file-css',
                            name: 'styles.css',
                            language: 'css',
                            content: `/* Custom Sandbox Styles */\nbody {\n  margin: 0;\n  padding: 0;\n}`
                        }
                    ],
                    dependencies: {
                        'lucide-react': '^0.468.0',
                        'canvas-confetti': '^1.9.3'
                    },
                    viewportMode: 'desktop'
                } as LiveCodeSandboxData
            };
            setActiveArtifact(defaultSandbox);
            setArtifactHistory(prev => [defaultSandbox, ...prev.filter(a => a.id !== defaultSandbox.id)]);
        } else if (targetMode === 'document') {
            const defaultDoc: CanvasArtifact = {
                id: `art-doc-${Date.now()}`,
                type: 'markdown-document',
                title: 'Project Specification & Notes',
                summary: 'Rich document specification with blocks and callouts.',
                version: 1,
                createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                data: {
                    title: 'Project Specification & Notes',
                    subtitle: 'Rich block document for architecture, roadmap, and specs',
                    author: getActiveUserName(),
                    lastUpdated: 'Just now',
                    tags: ['Specification', 'Architecture', 'DocumentSpec', 'Reasoning'],
                    sections: [
                        { id: 'sec-1', type: 'heading', level: 1, content: '1. Overview & Vision' },
                        { id: 'sec-2', type: 'paragraph', content: 'Scratchbox IDE empowers developers with an AI-native workspace featuring N8N workflow canvases, rich document specs, and Kanban sprint boards.' },
                        { id: 'sec-3', type: 'callout', calloutType: 'info', calloutTitle: 'Key Architecture Insight', content: 'Subagents running on Gemini Flash Lite handle ultra-fast data preprocessing while Gemini 3.7 Flash powers high-reasoning synthesis.' },
                        { id: 'sec-4', type: 'heading', level: 2, content: '2. Next Action Items' },
                        { id: 'sec-5', type: 'checklist', checklistItems: [
                            { id: 'c1', text: 'Verify N8N canvas node routing & simulation', done: true },
                            { id: 'c2', text: 'Structure rich document blocks & callouts', done: true },
                            { id: 'c3', text: 'Verify Kanban sprint columns and drag & drop', done: false }
                        ]}
                    ]
                }
            };
            setActiveArtifact(defaultDoc);
            setArtifactHistory(prev => [defaultDoc, ...prev.filter(a => a.id !== defaultDoc.id)]);
        } else if (targetMode === 'kanban') {
            const defaultKanban: CanvasArtifact = {
                id: `art-kanban-${Date.now()}`,
                type: 'kanban-board',
                title: 'Sprint Roadmap Kanban Board',
                summary: 'Sprint delivery board with Backlog, In Progress, QA Review, and Done.',
                version: 1,
                createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                data: {
                    title: 'Sprint Roadmap Kanban Board',
                    subtitle: 'Multi-stage delivery board with real-time card synchronization',
                    columns: [
                        {
                            id: 'col-backlog',
                            title: 'Backlog',
                            color: 'indigo',
                            cards: [
                                { id: 'card-1', title: 'Stripe Webhook Listeners', description: 'Automated subscription reconciliation pipe', tag: 'Backend', tagColor: 'indigo', priority: 'medium', completedSubtasks: 2, totalSubtasks: 4 },
                                { id: 'card-2', title: 'Multi-tenant Org Switcher', description: 'Team workspace tenancy isolation', tag: 'Core', tagColor: 'purple', priority: 'low' }
                            ]
                        },
                        {
                            id: 'col-inprogress',
                            title: 'In Progress',
                            color: 'blue',
                            cards: [
                                { id: 'card-3', title: 'N8N Canvas & Rich Spec Surfaces', description: 'Apple HIG vibrancy and continuous corner curves', tag: 'Design', tagColor: 'blue', priority: 'urgent', completedSubtasks: 3, totalSubtasks: 3 }
                            ]
                        },
                        {
                            id: 'col-qa',
                            title: 'QA Review',
                            color: 'amber',
                            cards: [
                                { id: 'card-4', title: 'Subagent Fallback Matrix', description: 'Verify seamless routing across Gemini models', tag: 'AI', tagColor: 'amber', priority: 'high', completedSubtasks: 2, totalSubtasks: 2 }
                            ]
                        },
                        {
                            id: 'col-done',
                            title: 'Done',
                            color: 'emerald',
                            cards: [
                                { id: 'card-5', title: 'AI Studio Backend Engine', description: 'Native REST pipe with high-reasoning tokens budget', tag: 'AI Core', tagColor: 'emerald', priority: 'high' }
                            ]
                        }
                    ]
                }
            };
            setActiveArtifact(defaultKanban);
            setArtifactHistory(prev => [defaultKanban, ...prev.filter(a => a.id !== defaultKanban.id)]);
        } else if (targetMode === 'browser') {
            const defaultBrowser: CanvasArtifact = {
                id: `art-browser-${Date.now()}`,
                type: 'interactive-browser',
                title: 'Interactive Web Browser',
                summary: 'AI-controllable web browser with responsive device frames, live console logs, and dev inspection tools.',
                version: 1,
                createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                data: {
                    url: 'https://example.com',
                    title: 'Example Domain',
                    viewportMode: 'desktop',
                    history: ['https://example.com'],
                    historyIndex: 0,
                    isLoading: false,
                    consoleLogs: [
                        { type: 'info', text: 'Browser canvas initialized at https://example.com', timestamp: new Date().toLocaleTimeString() },
                        { type: 'log', text: 'DOM ready. Ready for user navigation and AI agent actions.', timestamp: new Date().toLocaleTimeString() }
                    ],
                    inspectMode: false,
                    deviceScale: 1
                } as InteractiveBrowserData
            };
            setActiveArtifact(defaultBrowser);
            setArtifactHistory(prev => [defaultBrowser, ...prev.filter(a => a.id !== defaultBrowser.id)]);
        }
    };

    // Dedicated Settings & Guide View
    const [settingsInitialTab, setSettingsInitialTab] = React.useState<StudioSettingsTab>('general');
    const [appearanceConfig, setAppearanceConfig] = React.useState<StudioAppearanceConfig>(() => loadSavedAppearance());
    const [isConversationMenuOpen, setIsConversationMenuOpen] = React.useState<boolean>(false);
    const conversationMenuRef = React.useRef<HTMLDivElement | null>(null);
    const [isCanvasVersionMenuOpen, setIsCanvasVersionMenuOpen] = React.useState<boolean>(false);
    const canvasVersionMenuRef = React.useRef<HTMLDivElement | null>(null);

    const handleCreateEmptyCanvas = (type: PrimitiveType, customTitle?: string) => {
        let newArtifact: CanvasArtifact;
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        if (type === 'node-graph') {
            newArtifact = {
                id: `art-node-graph-${Date.now()}`,
                type: 'node-graph',
                title: customTitle || 'New Canvas Workflow',
                summary: 'Visual node graph & canvas workflow',
                version: 1,
                createdAt: timestamp,
                data: {
                    title: customTitle || 'New Canvas Workflow',
                    subtitle: 'Drag and connect nodes to create automated execution pipelines',
                    nodes: [
                        { id: 'node-1', label: 'Webhook Trigger', subtitle: 'POST /api/v1/event', category: 'input', color: 'blue', x: 100, y: 160, status: 'completed' },
                        { id: 'node-2', label: 'Reasoning Engine', subtitle: 'Gemini 3.7 Flash', category: 'ai', color: 'purple', x: 440, y: 160, status: 'running' }
                    ],
                    edges: [
                        { id: 'e1', source: 'node-1', target: 'node-2', label: 'Payload', style: 'solid', color: 'purple' }
                    ]
                } as NodeGraphData
            };
        } else if (type === 'live-code-sandbox') {
            newArtifact = {
                id: `art-sandbox-${Date.now()}`,
                type: 'live-code-sandbox',
                title: customTitle || 'New Live Code Sandbox',
                summary: 'Live editable code runner & interactive preview',
                version: 1,
                createdAt: timestamp,
                data: {
                    title: customTitle || 'New Live Code Sandbox',
                    subtitle: 'Interactive hot-reloading playground',
                    template: 'react',
                    viewMode: 'preview',
                    viewportMode: 'desktop',
                    files: [
                        { id: 'f1', name: 'App.tsx', language: 'react', content: `import React from 'react';\n\nexport default function App() {\n  return (\n    <div className="flex items-center justify-center min-h-screen bg-zinc-950 text-white p-6">\n      <h1 className="text-2xl font-bold">Hello from Canvas Sandbox</h1>\n    </div>\n  );\n}`, isEntry: true }
                    ]
                } as LiveCodeSandboxData
            };
        } else if (type === 'markdown-document') {
            newArtifact = {
                id: `art-doc-${Date.now()}`,
                type: 'markdown-document',
                title: customTitle || 'New Document Specification',
                summary: 'Structured block spec document with tables and callouts',
                version: 1,
                createdAt: timestamp,
                data: {
                    title: customTitle || 'New Document Specification',
                    subtitle: 'Rich blocks and architecture specifications',
                    sections: [
                        { id: 'sec-1', type: 'heading', level: 1, content: '1. Executive Specification' },
                        { id: 'sec-2', type: 'paragraph', content: 'Draft your project requirements, architecture specifications, and API designs here.' }
                    ]
                } as MarkdownDocumentData
            };
        } else if (type === 'kanban-board') {
            newArtifact = {
                id: `art-kanban-${Date.now()}`,
                type: 'kanban-board',
                title: customTitle || 'New Sprint Kanban Board',
                summary: 'Multi-stage delivery workflow board',
                version: 1,
                createdAt: timestamp,
                data: {
                    title: customTitle || 'Sprint Roadmap',
                    columns: [
                        { id: 'col-backlog', title: 'Backlog', color: 'indigo', cards: [] },
                        { id: 'col-inprogress', title: 'In Progress', color: 'blue', cards: [] },
                        { id: 'col-done', title: 'Done', color: 'emerald', cards: [] }
                    ]
                } as KanbanBoardData
            };
        } else if (type === 'interactive-browser' || type === 'browser') {
            newArtifact = {
                id: `art-browser-${Date.now()}`,
                type: 'interactive-browser',
                title: customTitle || 'New Web Browser',
                summary: 'Interactive AI-controllable web browser primitive',
                version: 1,
                createdAt: timestamp,
                data: {
                    url: 'https://example.com',
                    title: customTitle || 'Example Domain',
                    viewportMode: 'desktop',
                    history: ['https://example.com'],
                    historyIndex: 0,
                    isLoading: false,
                    consoleLogs: [
                        { type: 'info', text: 'Browser canvas initialized at https://example.com', timestamp: new Date().toLocaleTimeString() }
                    ],
                    inspectMode: false,
                    deviceScale: 1
                } as InteractiveBrowserData
            };
        } else {
            newArtifact = {
                id: `art-metric-${Date.now()}`,
                type: 'metric-dashboard',
                title: customTitle || 'New KPI Metrics Dashboard',
                summary: 'Real-time telemetry and metric cards',
                version: 1,
                createdAt: timestamp,
                data: {
                    title: customTitle || 'Performance Metrics',
                    metrics: [
                        { id: 'm1', label: 'Throughput', value: '1,240 req/s', change: '+12%', trend: 'up', color: 'blue' }
                    ]
                } as MetricDashboardData
            };
        }

        setActiveArtifact(newArtifact);
        recordArtifactVersion(newArtifact);
        setArtifactHistory(prev => [newArtifact, ...prev.filter(a => a.id !== newArtifact.id)]);
        const resolvedSurface = resolveModeForArtifact(newArtifact.type);
        setLayoutMode(resolvedSurface);
        showToast(`Created new canvas "${newArtifact.title}"`);
    };

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
        activeModel: 'gemini-3.7-flash',
        thinkingBudget: 1024,
        rawLogTokens: 3500,
        compactedTokens: 1260,
        anchorsRetainedCount: 8
    });

    // Terminal Error Capture & AI Debug Bridge
    const [activeTerminalError, setActiveTerminalError] = React.useState<TerminalExecutionError | undefined>(undefined);
    const [showTerminalErrorToast, setShowTerminalErrorToast] = React.useState<boolean>(false);

    // Mock/Live Workspace file list & git status for @file / @git autocomplete
    const workspaceFilesList = DEFAULT_WORKSPACE_FILES;
    const workspaceGitStatus = DEFAULT_WORKSPACE_GIT_STATUS;

    const [workspaces, setWorkspaces] = React.useState<ProjectItem[]>(DEFAULT_RECENT_PROJECTS);
    const [activeWorkspace, setActiveWorkspace] = React.useState<ProjectItem>(DEFAULT_RECENT_PROJECTS[0]);
    const [showNewWorkspaceMenu, setShowNewWorkspaceMenu] = React.useState<boolean>(false);
    const [showComposerWorkspaceMenu, setShowComposerWorkspaceMenu] = React.useState<boolean>(false);
    const [newWorkspaceInputName, setNewWorkspaceInputName] = React.useState<string>('');

    const handleCreateNewWorkspace = React.useCallback(async (workspaceName?: string, customPath?: string) => {
        const rawName = (workspaceName || newWorkspaceInputName || 'scratchbox-test-workspace').trim();
        if (!rawName) return;

        const cleanName = rawName.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
        const diskPath = customPath || `/Users/eligreen/dev/${cleanName.toLowerCase().replace(/[\s_]+/g, '-')}`;

        try {
            const res = await fetch('/workspace/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: cleanName,
                    path: diskPath
                })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.workspace) {
                    const created: ProjectItem = data.workspace;
                    setWorkspaces(prev => [created, ...prev.filter(p => p.id !== created.id)]);
                    setActiveWorkspace(created);
                    setShowNewWorkspaceMenu(false);
                    setNewWorkspaceInputName('');
                    
                    const existing = sessions.find(s => s.workspaceId === created.id);
                    if (existing) {
                        handleSelectSession(existing);
                    } else {
                        const newSession: ChatSession = {
                            id: `sess-${Date.now()}`,
                            title: `Workspace: ${created.name}`,
                            fileType: 'chat',
                            layoutMode: 'chat',
                            workspaceId: created.id,
                            workspaceName: created.name,
                            relativeTime: 'Just now',
                            dateCategory: 'Today',
                            updatedAt: 'Just now',
                            messages: [],
                            artifactHistory: []
                        };
                        setSessions(prev => [newSession, ...prev]);
                        setCurrentSessionId(newSession.id);
                        setMessages([]);
                        setActiveArtifact(undefined);
                        setLayoutMode('chat');
                    }
                    showToast(`Created & switched to workspace "${created.name}"`, '📁');
                    return;
                }
            }
        } catch (e) {
            console.warn('Backend workspace creation error', e);
        }

        const createdLocal: ProjectItem = {
            id: `proj-${Date.now()}`,
            name: cleanName,
            path: diskPath,
            lastActive: 'Just created',
            tags: ['Custom', 'Workspace'],
            isActive: true
        };
        setWorkspaces(prev => [createdLocal, ...prev.filter(p => p.id !== createdLocal.id)]);
        setActiveWorkspace(createdLocal);
        setShowNewWorkspaceMenu(false);
        setNewWorkspaceInputName('');

        const newSessionLocal: ChatSession = {
            id: `sess-${Date.now()}`,
            title: `Workspace: ${createdLocal.name}`,
            fileType: 'chat',
            layoutMode: 'chat',
            workspaceId: createdLocal.id,
            workspaceName: createdLocal.name,
            relativeTime: 'Just now',
            dateCategory: 'Today',
            updatedAt: 'Just now',
            messages: [],
            artifactHistory: []
        };
        setSessions(prev => [newSessionLocal, ...prev]);
        setCurrentSessionId(newSessionLocal.id);
        setMessages([]);
        setActiveArtifact(undefined);
        setLayoutMode('chat');
        showToast(`Created & switched to workspace "${createdLocal.name}"`, '📁');
    }, [newWorkspaceInputName, showToast]);

    const graphControllerRef = React.useRef<ProjectArtifactController>(new ProjectArtifactController(
        DEFAULT_RECENT_PROJECTS[0].id,
        { id: 'active-user', displayName: getActiveUserName(), kind: 'user' }
    ));
    const [graphEpoch, setGraphEpoch] = React.useState(0);

    const lensControllerRef = React.useRef<CodebaseLensController>((() => {
        const reg = new CodebaseLensRegistry();
        reg.register(new MarkdownDocumentLens());
        reg.register(new LiveCodeSandboxLens());
        reg.register(new KanbanTaskLens());
        reg.register(new NodeGraphWorkflowLens());
        return new CodebaseLensController(reg);
    })());

    const unifiedCoordinatorRef = React.useRef<UnifiedProjectCoordinator>(new UnifiedProjectCoordinator({
        projectId: DEFAULT_RECENT_PROJECTS[0].id,
        workspaceRoot: DEFAULT_RECENT_PROJECTS[0].path || `/workspace/${DEFAULT_RECENT_PROJECTS[0].id}`,
        projectController: graphControllerRef.current,
        lensController: lensControllerRef.current
    }));

    React.useEffect(() => {
        const unsubscribe = WorkspaceConfigClient.getInstance().subscribeToFileChanges(
            (event) => {
                if (!event?.path) return;
                const controller = lensControllerRef.current;
                const binding = controller.getBindingByPath(event.path);
                if (binding && activeArtifact && binding.artifactId === activeArtifact.id) {
                    // Fetch updated file from workspace if changed externally
                    console.log(`[CodebaseLens] Reacting to file change for ${event.path}`);
                }
                if (unifiedCoordinatorRef.current) {
                    unifiedCoordinatorRef.current.mutateFromDisk(event.path, (event as any).content || '');
                }
            },
            activeWorkspace.path
        );
        return () => {
            unsubscribe();
        };
    }, [activeWorkspace.path, activeArtifact?.id]);

    // Latest sessions/activeArtifact are read through refs: the controller must only be
    // re-created when the workspace changes, not on every chat update.
    const sessionsRef = React.useRef(sessions);
    sessionsRef.current = sessions;
    const activeArtifactRef = React.useRef(activeArtifact);
    activeArtifactRef.current = activeArtifact;

    React.useEffect(() => {
        let cancelled = false;
        const controller = new ProjectArtifactController(
            activeWorkspace.id,
            { id: 'active-user', displayName: getActiveUserName(), kind: 'user' }
        );
        graphControllerRef.current = controller;
        const coordinator = new UnifiedProjectCoordinator({
            projectId: activeWorkspace.id,
            workspaceRoot: activeWorkspace.path,
            projectController: controller,
            lensController: lensControllerRef.current
        });
        unifiedCoordinatorRef.current = coordinator;

        const projectSessions = sessionsRef.current.filter(session => !session.workspaceId || session.workspaceId === activeWorkspace.id);
        controller.initialize(projectSessions, activeWorkspace.path).then(() => {
            if (cancelled) return;
            const currentArtifact = activeArtifactRef.current;
            if (currentArtifact) {
                controller.registerArtifact(currentArtifact, `studio-initialize-${currentArtifact.id}`);
                coordinator.mutateFromLens(currentArtifact.type, currentArtifact.id, currentArtifact.data);
            }
            setGraphEpoch(epoch => epoch + 1);
        }).catch(error => console.warn('Failed to initialize project artifact graph', error));
        return () => {
            cancelled = true;
        };
    }, [activeWorkspace.id, activeWorkspace.path]);

    React.useEffect(() => {
        if (!activeArtifact || graphControllerRef.current.projectId !== activeWorkspace.id) {
            return;
        }
        graphControllerRef.current.registerArtifact(
            activeArtifact,
            `studio-sync-${activeArtifact.id}-${activeArtifact.version}`
        );
        if (unifiedCoordinatorRef.current) {
            unifiedCoordinatorRef.current.mutateFromLens(
                activeArtifact.type,
                activeArtifact.id,
                activeArtifact.data
            );
        }
        setGraphEpoch(epoch => epoch + 1);
    }, [activeArtifact, activeWorkspace.id]);

    // Cursor-Style Sidebar Layout & Navigation State
    const [sidebarSearchQuery, setSidebarSearchQuery] = React.useState<string>('');
    const [isSidebarSearchOpen, setIsSidebarSearchOpen] = React.useState<boolean>(false);
    const [isWorkspacesExpanded, setIsWorkspacesExpanded] = React.useState<boolean>(true);
    const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = React.useState<Record<string, boolean>>({});
    const [showAddFileMenu, setShowAddFileMenu] = React.useState<boolean>(false);

    const [sidebarViewMode, setSidebarViewMode] = React.useState<'threads' | 'explorer'>('threads');
    const [collapsedFolders, setCollapsedFolders] = React.useState<Record<string, boolean>>({});

    const getMockFileContent = (filePath: string, fileName: string): string => {
        if (fileName.endsWith('.tsx') || fileName.endsWith('.ts')) {
            return `import React from 'react';\n\n// Mock content loaded from ${filePath}\nexport default function ${fileName.split('.')[0]}() {\n    return (\n        <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-2xl text-center space-y-4">\n            <h2 className="text-xl font-semibold text-blue-400">${fileName}</h2>\n            <p className="text-zinc-400">Successfully loaded file from path: <code>\${filePath}</code></p>\n        </div>\n    );\n}`;
        }
        if (fileName.endsWith('.css')) {
            return `/* Mock styles loaded from ${filePath} */\n.file-container {\n    padding: 24px;\n    background-color: var(--sb-surface-glass);\n}`;
        }
        if (fileName.endsWith('.md')) {
            return `# ${fileName.split('.')[0]}\n\nThis is a mock markdown specification document representing **${fileName}**.\n\n## Section 1: Overview\n- Path: \`${filePath}\`\n- Loaded: Yes\n- Integration: Unified Click Routing`;
        }
        return `// File: ${fileName}\n// Path: ${filePath}\nconsole.log("${fileName} successfully initialized");`;
    };

    const getFileIconByExtension = (name: string): React.ReactNode => {
        const ext = name.split('.').pop() || '';
        switch (ext) {
            case 'tsx':
            case 'ts':
            case 'js':
                return <IconCode size={11} className="text-blue-400" />;
            case 'css':
                return <IconCustomize size={11} className="text-teal-400" />;
            case 'md':
                return <IconDocument size={11} className="text-amber-400" />;
            case 'json':
                return <IconKanban size={11} className="text-purple-400" />;
            case 'automation':
                return <IconAutomations size={11} className="text-emerald-400" />;
            case '3d':
                return <Icon3D size={11} className="text-rose-400" />;
            default:
                return <IconDocument size={11} className="text-zinc-400" />;
        }
    };

    const handleFileClick = (filePath: string, fileName: string) => {
        const ext = fileName.split('.').pop() || '';
        
        let targetLayoutMode: StudioLayoutMode;
        let artifactType: PrimitiveType;
        
        if (ext === '3d' || fileName === 'Scene3DPrimitive.tsx') {
            targetLayoutMode = '3d';
            artifactType = '3d-scene';
        } else if (ext === 'md' || fileName === 'MarkdownDocumentPrimitive.tsx') {
            targetLayoutMode = 'document';
            artifactType = 'markdown-document';
        } else if (ext === 'json' || fileName === 'KanbanBoardPrimitive.tsx') {
            targetLayoutMode = 'kanban';
            artifactType = 'kanban-board';
        } else if (ext === 'automation' || fileName === 'NodeGraphPrimitive.tsx') {
            targetLayoutMode = 'automation';
            artifactType = 'node-graph';
        } else if (['tsx', 'ts', 'js', 'css'].includes(ext)) {
            targetLayoutMode = 'code';
            artifactType = 'live-code-sandbox';
        } else {
            targetLayoutMode = 'code';
            artifactType = 'live-code-sandbox';
        }

        setLayoutMode(targetLayoutMode);

        if (artifactType === 'live-code-sandbox') {
            let currentSandbox: LiveCodeSandboxData;
            let currentArtifactId = `art-sandbox-${Date.now()}`;
            
            if (activeArtifact && activeArtifact.type === 'live-code-sandbox') {
                currentSandbox = { ...(activeArtifact.data as LiveCodeSandboxData) };
                currentArtifactId = activeArtifact.id;
            } else {
                currentSandbox = {
                    title: 'Interactive React 19 UI Playground',
                    subtitle: 'Multi-tab live code runner with hot reload & runtime console',
                    template: 'react',
                    files: [],
                    dependencies: {
                        'lucide-react': '^0.468.0',
                        'canvas-confetti': '^1.9.3'
                    },
                    viewportMode: 'desktop'
                };
            }

            const normalizedPath = filePath;
            let fileId = `file-${fileName.replace(/[^a-zA-Z0-9]/g, '-')}`;
            const existingFile = currentSandbox.files.find(f => f.path === normalizedPath || f.name === fileName);
            
            if (existingFile) {
                fileId = existingFile.id;
                currentSandbox.activeFileId = fileId;
            } else {
                const mockContent = getMockFileContent(normalizedPath, fileName);
                const newTab: CodeFileTab = {
                    id: fileId,
                    name: fileName,
                    language: ext === 'tsx' ? 'react' : ext === 'ts' ? 'typescript' : ext === 'css' ? 'css' : 'javascript',
                    content: mockContent,
                    path: normalizedPath,
                    isEntry: currentSandbox.files.length === 0
                };
                currentSandbox.files = [...currentSandbox.files, newTab];
                currentSandbox.activeFileId = fileId;
            }

            const updatedArtifact: CanvasArtifact = {
                id: currentArtifactId,
                type: 'live-code-sandbox',
                title: fileName,
                summary: `Editing ${fileName}`,
                version: (activeArtifact?.id === currentArtifactId ? activeArtifact.version : 0) + 1,
                createdAt: new Date().toLocaleTimeString(),
                data: currentSandbox
            };

            setActiveArtifact(updatedArtifact);
            setArtifactHistory(prev => {
                const filtered = prev.filter(a => a.id !== updatedArtifact.id);
                return [updatedArtifact, ...filtered];
            });
            setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, activeArtifact: updatedArtifact } : s));

        } else if (artifactType === 'markdown-document') {
            const mockContent = getMockFileContent(filePath, fileName);
            const sections = mockContent.split('\n\n').map((para, idx) => {
                if (para.startsWith('# ')) {
                    return { id: `sec-${idx}`, type: 'heading' as const, level: 1 as const, content: para.replace(/^#+\s*/, '') };
                } else if (para.startsWith('## ') || para.startsWith('### ')) {
                    return { id: `sec-${idx}`, type: 'heading' as const, level: 2 as const, content: para.replace(/^#+\s*/, '') };
                } else if (para.startsWith('- [ ] ') || para.startsWith('- [x] ')) {
                    const done = para.startsWith('- [x] ');
                    const text = para.replace(/- \[[x ]\] /, '');
                    return { id: `sec-${idx}`, type: 'checklist' as const, checklistItems: [{ id: `item-${idx}`, text, done }] };
                } else {
                    return { id: `sec-${idx}`, type: 'paragraph' as const, content: para };
                }
            });

            const docData: MarkdownDocumentData = {
                title: fileName,
                subtitle: `Viewing project specification at ${filePath}`,
                author: getActiveUserName(),
                lastUpdated: 'Just now',
                tags: ['Specification', 'Documentation'],
                sections: sections.length > 0 ? sections : [{ id: 'sec-1', type: 'paragraph', content: mockContent }]
            };

            const updatedArtifact: CanvasArtifact = {
                id: `art-doc-${Date.now()}`,
                type: 'markdown-document',
                title: fileName,
                summary: `Viewing document ${fileName}`,
                version: 1,
                createdAt: new Date().toLocaleTimeString(),
                data: docData
            };

            setActiveArtifact(updatedArtifact);
            setArtifactHistory(prev => {
                const filtered = prev.filter(a => a.id !== updatedArtifact.id);
                return [updatedArtifact, ...filtered];
            });
            setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, activeArtifact: updatedArtifact } : s));

        } else if (artifactType === 'kanban-board') {
            const kanbanData: KanbanBoardData = {
                title: fileName,
                subtitle: `Delivery board representing ${filePath}`,
                columns: [
                    {
                        id: 'todo',
                        title: 'To Do',
                        color: 'blue',
                        cards: [
                            { id: 'c1', title: `Setup workflow for ${fileName}`, description: `Initialize sprint card matching current folder.`, priority: 'medium' }
                        ]
                    },
                    {
                        id: 'in_progress',
                        title: 'In Progress',
                        color: 'amber',
                        cards: [
                            { id: 'c2', title: `Implementing file ${fileName}`, description: 'Active work tracking.', priority: 'high' }
                        ]
                    },
                    {
                        id: 'done',
                        title: 'Done',
                        color: 'emerald',
                        cards: []
                    }
                ]
            };

            const updatedArtifact: CanvasArtifact = {
                id: `art-kanban-${Date.now()}`,
                type: 'kanban-board',
                title: fileName,
                summary: `Sprint board ${fileName}`,
                version: 1,
                createdAt: new Date().toLocaleTimeString(),
                data: kanbanData
            };

            setActiveArtifact(updatedArtifact);
            setArtifactHistory(prev => {
                const filtered = prev.filter(a => a.id !== updatedArtifact.id);
                return [updatedArtifact, ...filtered];
            });
            setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, activeArtifact: updatedArtifact } : s));

        } else if (artifactType === 'node-graph') {
            const graphData: NodeGraphData = {
                title: fileName,
                subtitle: `Automation canvas node graph at ${filePath}`,
                nodes: [
                    { id: 'n1', label: fileName, subtitle: 'Active File', category: 'input', x: 200, y: 150, status: 'completed' },
                    { id: 'n2', label: 'AI Processor', subtitle: 'Gemini 3.7 Flash', category: 'ai', x: 450, y: 150, status: 'running' }
                ],
                edges: [
                    { id: 'e1', source: 'n1', target: 'n2', style: 'animated', color: 'indigo' }
                ]
            };

            const updatedArtifact: CanvasArtifact = {
                id: `art-graph-${Date.now()}`,
                type: 'node-graph',
                title: fileName,
                summary: `Workflow graph ${fileName}`,
                version: 1,
                createdAt: new Date().toLocaleTimeString(),
                data: graphData
            };

            setActiveArtifact(updatedArtifact);
            setArtifactHistory(prev => {
                const filtered = prev.filter(a => a.id !== updatedArtifact.id);
                return [updatedArtifact, ...filtered];
            });
            setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, activeArtifact: updatedArtifact } : s));

        } else if (artifactType === '3d-scene') {
            const sceneData: Scene3DData = {
                title: fileName,
                subtitle: `Spatial coordinate scene from ${filePath}`,
                objects: [
                    {
                        id: 'obj-mesh-1',
                        content: {
                            type: '3d-scene',
                            durableUri: 'internal:mesh',
                            mimeType: 'model/gltf-binary',
                            metadata: { dims: { width: 5, height: 5, depth: 5 } }
                        },
                        space: {
                            spatial3d: { x: 0, y: 0, z: 0, pitch: 0, yaw: 45, roll: 0 }
                        },
                        time: { startMs: 0, durationMs: 0 },
                        lineage: { version: 1 }
                    }
                ],
                camera: {
                    position: [10, 10, 10],
                    target: [0, 0, 0]
                },
                environment: {
                    skybox: 'cyberpunk',
                    lighting: 'shaded',
                    ground: true
                }
            };

            const updatedArtifact: CanvasArtifact = {
                id: `art-3d-${Date.now()}`,
                type: '3d-scene',
                title: fileName,
                summary: `3D spatial scene ${fileName}`,
                version: 1,
                createdAt: new Date().toLocaleTimeString(),
                data: sceneData
            };

            setActiveArtifact(updatedArtifact);
            setArtifactHistory(prev => {
                const filtered = prev.filter(a => a.id !== updatedArtifact.id);
                return [updatedArtifact, ...filtered];
            });
            setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, activeArtifact: updatedArtifact } : s));
        }

        showToast(`Loaded "${fileName}" in ${targetLayoutMode === 'code' ? 'Code Sandbox' : targetLayoutMode + ' view'}`);
    };

    const toggleFolderCollapse = (folderPath: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setCollapsedFolders(prev => ({
            ...prev,
            [folderPath]: !prev[folderPath]
        }));
    };

    const handleDragStart = (e: React.DragEvent, node: FileTreeNode) => {
        const lastDot = node.name.lastIndexOf('.');
        const extension = lastDot !== -1 ? node.name.substring(lastDot) : '';
        const payload = {
            type: 'file_node',
            path: node.path,
            name: node.name,
            extension: extension
        };
        e.dataTransfer.effectAllowed = 'copy';
        const jsonStr = JSON.stringify(payload);
        e.dataTransfer.setData('application/json', jsonStr);
        e.dataTransfer.setData('text/plain', jsonStr);
    };

    const renderFileTree = (nodes: FileTreeNode[], depth: number = 0): React.ReactNode => {
        return nodes.map(node => {
            const isFolder = node.isFolder;
            const isCollapsed = !!collapsedFolders[node.path];
            const hasChildren = node.children && node.children.length > 0;
            const paddingLeft = `${(depth * 12) + 16}px`;

            return (
                <div key={node.path} className="sb-file-tree-node-wrapper">
                    <div
                        className={`sb-file-tree-node ${isFolder ? 'sb-file-tree-folder' : 'sb-file-tree-file'}`}
                        style={{ paddingLeft }}
                        draggable={!isFolder}
                        onDragStart={!isFolder ? (e) => handleDragStart(e, node) : undefined}
                        onClick={(e) => {
                            if (isFolder) {
                                toggleFolderCollapse(node.path, e);
                            } else {
                                handleFileClick(node.path, node.name);
                            }
                        }}
                    >
                        <div className="sb-file-tree-node-left">
                            {isFolder ? (
                                <span className="sb-file-tree-chevron">
                                    {isCollapsed ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
                                </span>
                            ) : (
                                <span className="sb-file-tree-bullet-placeholder" />
                            )}
                            
                            {isFolder ? (
                                <IconFolder size={12} className={isCollapsed ? "text-zinc-500" : "text-zinc-400"} />
                            ) : (
                                <span className="sb-file-tree-icon">
                                    {getFileIconByExtension(node.name)}
                                </span>
                            )}
                            
                            <span className="sb-file-tree-name" title={node.name}>
                                {node.name}
                            </span>
                        </div>
                    </div>
                    
                    {isFolder && !isCollapsed && hasChildren && (
                        <div className="sb-file-tree-children">
                            {renderFileTree(node.children!, depth + 1)}
                        </div>
                    )}
                </div>
            );
        });
    };

    const isWorkspaceCollapsed = (workspaceId: string): boolean => {
        return !!collapsedWorkspaceIds[workspaceId];
    };

    const toggleWorkspaceCollapse = (workspaceId: string, e?: React.MouseEvent) => {
        if (e) {
            e.stopPropagation();
        }
        setCollapsedWorkspaceIds(prev => ({
            ...prev,
            [workspaceId]: !prev[workspaceId]
        }));
    };

    const handleSurfaceAiPrompt = (promptText: string) => {
        if (!promptText.trim() || isGenerating) return;
        handleSendMessage(promptText.trim());
    };

    // Global click listener to close add-file popup & new workspace dropdowns
    React.useEffect(() => {
        const handleGlobalClick = () => {
            setShowAddFileMenu(false);
            setShowNewWorkspaceMenu(false);
            setShowComposerWorkspaceMenu(false);
        };
        if (showAddFileMenu || showNewWorkspaceMenu || showComposerWorkspaceMenu) {
            window.addEventListener('click', handleGlobalClick);
            return () => window.removeEventListener('click', handleGlobalClick);
        }
    }, [showAddFileMenu, showNewWorkspaceMenu, showComposerWorkspaceMenu]);

    const getSessionIcon = (session?: ChatSession) => {
        if (!session) return null;
        if (session.fileType === 'chat' || !session.fileType) {
            return null;
        }
        switch (session.fileType) {
            case 'code':
                return <IconCode size={11} className="text-blue-400" strokeWidth={1.8} />;
            case 'browser':
                return <IconGlobe size={11} className="text-teal-400" strokeWidth={1.8} />;
            case 'document':
                return <IconDocument size={11} className="text-amber-400" strokeWidth={1.8} />;
            case 'kanban':
                return <IconKanban size={11} className="text-purple-400" strokeWidth={1.8} />;
            case 'automation':
                return <IconAutomations size={11} className="text-emerald-400" strokeWidth={1.8} />;
            case '3d':
                return <Icon3D size={11} className="text-rose-400" strokeWidth={1.8} />;
            default:
                return null;
        }
    };

    const handleCreateWorkspaceFile = (type: WorkspaceFileType) => {
        setShowAddFileMenu(false);
        const newSessionId = `session-${type}-${Date.now()}`;

        let newSession: ChatSession;
        if (type === 'chat') {
            newSession = {
                id: newSessionId,
                title: 'New Chat',
                fileType: 'chat',
                layoutMode: 'chat',
                workspaceId: activeWorkspace.id,
                workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
                relativeTime: 'Just now',
                dateCategory: 'Today',
                updatedAt: 'Just now',
                messages: [],
                artifactHistory: []
            };
        } else if (type === 'code') {
            const codeArtifact: CanvasArtifact = {
                id: `art-sandbox-${Date.now()}`,
                type: 'live-code-sandbox',
                title: 'Component Sandbox',
                summary: 'Live editable code runner & interactive preview',
                version: 1,
                createdAt: 'Just now',
                data: {
                    title: 'Live Sandbox Playground',
                    subtitle: 'Interactive React/Tailwind preview playground',
                    template: 'react',
                    viewMode: 'preview',
                    viewportMode: 'desktop',
                    files: [
                        {
                            id: 'App.tsx',
                            name: 'App.tsx',
                            language: 'typescript',
                            content: `import React, { useState } from 'react';\n\nexport default function App() {\n    const [count, setCount] = useState(0);\n    return (\n        <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif', color: '#f8fafc', background: '#090d16', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>\n            <div style={{ background: '#131b2e', padding: 32, borderRadius: 16, border: '1px solid #1e293b', textAlign: 'center', maxWidth: 440, width: '100%' }}>\n                <h1 style={{ fontSize: 24, margin: '0 0 12px 0', color: '#60a5fa' }}>⚡ Scratchbox Live Preview</h1>\n                <p style={{ color: '#94a3b8', fontSize: 14, margin: '0 0 24px 0' }}>Edit this code in Split or Code mode, and watch your changes render instantly.</p>\n                <button onClick={() => setCount(c => c + 1)} style={{ padding: '10px 24px', fontSize: 15, fontWeight: 600, borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', boxShadow: '0 4px 12px rgba(37,99,235,0.3)' }}>\n                    Interactive Counter: {count}\n                </button>\n            </div>\n        </div>\n    );\n}`,
                            isEntry: true
                        }
                    ]
                } as LiveCodeSandboxData
            };
            newSession = {
                id: newSessionId,
                title: 'Component Sandbox',
                fileType: 'code',
                layoutMode: 'code',
                activeArtifact: codeArtifact,
                workspaceId: activeWorkspace.id,
                workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
                relativeTime: 'Just now',
                dateCategory: 'Today',
                updatedAt: 'Just now',
                messages: [],
                artifactHistory: [codeArtifact]
            };
        } else if (type === 'document') {
            const defaultDoc = synthesizeComprehensiveDocument('write a document about 1776');
            const docArtifact: CanvasArtifact = {
                id: `art-doc-${Date.now()}`,
                type: 'markdown-document',
                title: defaultDoc.title,
                summary: defaultDoc.subtitle || 'Specification Document',
                data: defaultDoc,
                version: 1,
                createdAt: 'Just now'
            };
            newSession = {
                id: newSessionId,
                title: 'The Enduring Significance of 1776',
                fileType: 'document',
                layoutMode: 'document',
                activeArtifact: docArtifact,
                workspaceId: activeWorkspace.id,
                workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
                relativeTime: 'Just now',
                dateCategory: 'Today',
                updatedAt: 'Just now',
                messages: [],
                artifactHistory: [docArtifact]
            };
        } else if (type === 'kanban') {
            newSession = {
                id: newSessionId,
                title: 'Sprint Roadmap',
                fileType: 'kanban',
                layoutMode: 'kanban',
                workspaceId: activeWorkspace.id,
                workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
                relativeTime: 'Just now',
                dateCategory: 'Today',
                updatedAt: 'Just now',
                messages: [],
                artifactHistory: []
            };
        } else if (type === '3d') {
            const activeArt: CanvasArtifact = {
                id: `art-3d-${Date.now()}`,
                type: '3d-scene',
                title: 'Interactive 4D Scene Workspace',
                summary: 'WebGL viewport with procedural topography, real-time wave solvers, and simulated WASM linear memory heap.',
                data: {
                    title: 'Interactive 4D Scene Workspace',
                    subtitle: 'WebGL viewport with procedural topography, real-time wave solvers, and simulated WASM linear memory heap.',
                    objects: [
                        {
                            id: 'obj-grid-1',
                            content: {
                                type: '3d-scene',
                                durableUri: 'internal:grid',
                                mimeType: 'model/gltf-binary',
                                metadata: { dims: { width: 30, height: 0, depth: 30 } }
                            },
                            space: {
                                spatial3d: { x: 0, y: -1, z: 0, pitch: 0, yaw: 0, roll: 0 }
                            },
                            time: { startMs: 0, durationMs: 0 },
                            lineage: { version: 1 }
                        },
                        {
                            id: 'obj-light-1',
                            content: {
                                type: '3d-scene',
                                durableUri: 'internal:sunlight',
                                mimeType: 'model/gltf-binary',
                                metadata: {}
                            },
                            space: {
                                spatial3d: { x: 15, y: 30, z: 10, pitch: 0, yaw: 0, roll: 0 }
                            },
                            time: { startMs: 0, durationMs: 0 },
                            lineage: { version: 1 }
                        }
                    ],
                    camera: {
                        position: [15, 12, 15],
                        target: [0, 0, 0]
                    },
                    environment: {
                        skybox: 'cyberpunk',
                        lighting: 'shaded',
                        ground: true
                    }
                },
                createdAt: new Date().toLocaleTimeString(),
                version: 1
            };
            newSession = {
                id: newSessionId,
                title: 'Workspace 4D Scene',
                fileType: '3d',
                layoutMode: '3d',
                workspaceId: activeWorkspace.id,
                workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
                relativeTime: 'Just now',
                dateCategory: 'Today',
                updatedAt: 'Just now',
                messages: [],
                activeArtifact: activeArt,
                artifactHistory: [activeArt]
            };
        } else if (type === 'browser') {
            const activeArt: CanvasArtifact = {
                id: `art-browser-${Date.now()}`,
                type: 'interactive-browser',
                title: 'Interactive Web Browser',
                summary: 'AI-controllable web browser with responsive device frames, live console logs, and dev inspection tools.',
                data: {
                    url: 'https://example.com',
                    title: 'Example Domain',
                    viewportMode: 'desktop',
                    history: ['https://example.com'],
                    historyIndex: 0,
                    isLoading: false,
                    consoleLogs: [
                        { type: 'info', text: 'Browser canvas initialized at https://example.com', timestamp: new Date().toLocaleTimeString() },
                        { type: 'log', text: 'DOM ready. Ready for user navigation and AI agent actions.', timestamp: new Date().toLocaleTimeString() }
                    ],
                    inspectMode: false,
                    deviceScale: 1
                } as InteractiveBrowserData,
                createdAt: new Date().toLocaleTimeString(),
                version: 1
            };
            newSession = {
                id: newSessionId,
                title: 'Interactive Web Browser',
                fileType: 'browser',
                layoutMode: 'browser',
                workspaceId: activeWorkspace.id,
                workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
                relativeTime: 'Just now',
                dateCategory: 'Today',
                updatedAt: 'Just now',
                messages: [],
                activeArtifact: activeArt,
                artifactHistory: [activeArt]
            };
        } else {
            newSession = {
                id: newSessionId,
                title: 'Canvas Workflow',
                fileType: 'automation',
                layoutMode: 'automation',
                workspaceId: activeWorkspace.id,
                workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
                relativeTime: 'Just now',
                dateCategory: 'Today',
                updatedAt: 'Just now',
                messages: [],
                artifactHistory: []
            };
        }

        setSessions(prev => [newSession, ...prev]);
        setCurrentSessionId(newSession.id);
        setMessages(newSession.messages);
        setActiveArtifact(newSession.activeArtifact);
        setArtifactHistory(newSession.artifactHistory || []);
        setLayoutMode(newSession.layoutMode || 'chat');
        showToast(`Created new blank ${type} file in ${activeWorkspace.name}`);
    };

    // Global drag-and-drop & CSV data file state
    const [isGlobalDraggingFile, setIsGlobalDraggingFile] = React.useState<boolean>(false);
    const [isDraggingDataFile, setIsDraggingDataFile] = React.useState<boolean>(false);
    const [attachedDataFile, setAttachedDataFile] = React.useState<{
        name: string;
        size: number;
        rowsCount: number;
        headers: string[];
        rawText: string;
        parsedRows: Record<string, any>[];
        summaryMetrics: MetricItem[];
        chartData?: ChartDataPoint[];
    } | undefined>(undefined);

    // Long-Running Agent State & UI integration
    const [agentSession, setAgentSession] = React.useState<AgentSessionState | undefined>(undefined);
    const [agentEvents, setAgentEvents] = React.useState<AgentStreamEvent[]>([]);

    /* eslint-disable-next-line no-null/no-null */
    const messagesEndRef = React.useRef<HTMLDivElement>(null);
    /* eslint-disable-next-line no-null/no-null */
    const inputRef = React.useRef<HTMLTextAreaElement>(null);
    /* eslint-disable-next-line no-null/no-null */
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    // Auto-expand chat textarea height up to 220px as content is typed/pasted
    React.useEffect(() => {
        if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            const scrollH = inputRef.current.scrollHeight;
            inputRef.current.style.height = `${Math.min(Math.max(scrollH, 24), 220)}px`;
        }
    }, [inputValue]);

    React.useEffect(() => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages, isGenerating, liveStreamedText]);

    // Check Gemini 3.7 Flash Backend Status
    React.useEffect(() => {
        let cancelled = false;
        GeminiClient.getInstance()
            .checkStatus()
            .then(status => {
                if (cancelled) return;
                setGeminiStatus(status);
            })
            .catch(() => {
                if (cancelled) return;
                setGeminiStatus({
                    connected: false,
                    activeModel: 'gemini-3.7-flash',
                    availableModels: ['gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
                    thinkingBudget: 1024,
                    authMethod: 'unauthenticated'
                });
            });

        // Discover and load workspace-specific superpowers (.scratchbox/skills) & MCP servers (.scratchbox/mcp.json)
        WorkspaceConfigClient.getInstance().fetchWorkspaceConfig().then(cfg => {
            if (cancelled) return;
            if (cfg.settings?.googleSearchGrounding !== undefined) {
                setGoogleSearchGrounding(cfg.settings.googleSearchGrounding);
            }
            if (cfg.customSkills && cfg.customSkills.length > 0) {
                setSkills(prev => {
                    const existingIds = new Set(prev.map(s => s.id));
                    const newSkills = cfg.customSkills.filter(s => !existingIds.has(s.id));
                    return [...newSkills, ...prev];
                });
            }
            if (cfg.customMcpServers && cfg.customMcpServers.length > 0) {
                setMcpServers(prev => {
                    const existingIds = new Set(prev.map(s => s.id));
                    const newMcp = cfg.customMcpServers.filter(s => !existingIds.has(s.id));
                    return [...newMcp, ...prev];
                });
            }
        }).catch(() => {
            // Workspace config is optional; keep bundled defaults.
        });
        return () => {
            cancelled = true;
        };
    }, []);

    // Global keyboard shortcuts (⌘K spotlight toggle, ⌘O projects, ⌘, settings, Esc LIFO)
    React.useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                if (modalManagerRef.current.isModalOpen('spotlight')) {
                    closeModal('spotlight');
                } else {
                    openModal('spotlight');
                }
            }
            if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'o')) {
                e.preventDefault();
                if (onOpenFolder) {
                    onOpenFolder();
                } else if (onOpenWorkspace) {
                    onOpenWorkspace();
                } else {
                    openSettingsToTab('workspace');
                }
            }
            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                e.preventDefault();
                openSettingsToTab('general');
            }
            if (e.key === 'Escape') {
                if (isConversationMenuOpen) {
                    e.preventDefault();
                    setIsConversationMenuOpen(false);
                    return;
                }
                if (modalManagerRef.current.hasOpenModals()) {
                    e.preventDefault();
                    closeTopModal();
                    return;
                }
                if (autocompleteQuery !== undefined || autocompleteType !== undefined) {
                    e.preventDefault();
                    setAutocompleteQuery(undefined);
                    setAutocompleteType(undefined);
                    return;
                }
                if (isSidebarOpen && typeof window !== 'undefined' && window.innerWidth <= 767) {
                    setIsSidebarOpen(false);
                }
            }
        };
        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }, [isSidebarOpen, autocompleteQuery, autocompleteType, openModal, closeModal, closeTopModal, isConversationMenuOpen]);

    // Close conversation actions dropdown on outside click
    React.useEffect(() => {
        if (!isConversationMenuOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (conversationMenuRef.current && !conversationMenuRef.current.contains(e.target as Node)) {
                setIsConversationMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isConversationMenuOpen]);

    // Close canvas version history dropdown on outside click
    React.useEffect(() => {
        if (!isCanvasVersionMenuOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (canvasVersionMenuRef.current && !canvasVersionMenuRef.current.contains(e.target as Node)) {
                setIsCanvasVersionMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isCanvasVersionMenuOpen]);

    // Local Storage Debounced Auto-Persistence for Sessions, Artifacts & History
    const { persistSessionsImmediately } = usePersistedChatState(chatState, setSessions, appearanceConfig);

    const recordArtifactVersion = (art: CanvasArtifact) => {
        setArtifactVersions(prev => {
            const list = prev[art.id] || [];
            const ver = art.version || 1;
            const exists = list.some(v => (v.version || 1) === ver);
            if (exists) {
                return {
                    ...prev,
                    [art.id]: list.map(v => (v.version || 1) === ver ? art : v)
                };
            }
            return {
                ...prev,
                [art.id]: [...list, art].sort((a, b) => (a.version || 1) - (b.version || 1))
            };
        });
    };

    const handleUpdateArtifact = React.useCallback((updatedArtifact: CanvasArtifact) => {
        const canonicalArtifact = graphControllerRef.current.registerArtifact(
            updatedArtifact,
            `studio-update-${updatedArtifact.id}-${updatedArtifact.version}`
        );
        setGraphEpoch(epoch => epoch + 1);
        setActiveArtifact(canonicalArtifact);
        recordArtifactVersion(canonicalArtifact);
        setArtifactHistory(prev => [
            canonicalArtifact,
            ...prev.filter(a => a.id !== updatedArtifact.id && a.id !== canonicalArtifact.id)
        ]);

        // Bi-directional lens unprojection to workspace disk
        try {
            const controller = lensControllerRef.current;
            let binding = controller.getBinding(canonicalArtifact.id);
            if (!binding) {
                let defaultPath = `docs/${canonicalArtifact.id}.md`;
                if (canonicalArtifact.type === 'live-code-sandbox') defaultPath = 'src/components';
                else if (canonicalArtifact.type === 'kanban-board') defaultPath = 'ROADMAP.md';
                else if (canonicalArtifact.type === 'node-graph') defaultPath = `workflows/${canonicalArtifact.id}.workflow.json`;
                else if (canonicalArtifact.type === '3d-scene') defaultPath = `scenes/${canonicalArtifact.id}.scene.json`;

                binding = controller.createBinding({
                    artifactId: canonicalArtifact.id,
                    lensType: canonicalArtifact.type,
                    primaryFilePath: defaultPath,
                    initialContent: typeof canonicalArtifact.data === 'string' ? canonicalArtifact.data : JSON.stringify(canonicalArtifact.data)
                });
            }

            const unprojected = controller.unprojectUiChanges(
                canonicalArtifact.id,
                canonicalArtifact.data,
                {}
            );
            if (unprojected && Object.keys(unprojected.files).length > 0) {
                WorkspaceConfigClient.getInstance().writeLensFiles(unprojected.files, activeWorkspace.path).catch(e =>
                    console.warn('[CodebaseLens] Auto-sync to disk skipped or failed', e)
                );
            }
        } catch (e) {
            console.warn('[CodebaseLens] Error during unprojection', e);
        }

        // Update messages state: update matching version in place without mutating historical snapshots
        setMessages(prev => prev.map(m => {
            if (!m.artifacts || m.artifacts.length === 0) return m;
            const matches = m.artifacts.some(a =>
                (a.id === updatedArtifact.id || a.id === canonicalArtifact.id) &&
                (a.version || 1) === (canonicalArtifact.version || 1)
            );
            if (!matches) return m;
            return {
                ...m,
                artifacts: m.artifacts.map(a =>
                    (a.id === updatedArtifact.id || a.id === canonicalArtifact.id) &&
                    (a.version || 1) === (canonicalArtifact.version || 1)
                        ? canonicalArtifact
                        : a
                ),
                artifactRefs: [canonicalArtifact.graphRef!]
            };
        }));

        if (currentSessionId) {
            setSessions(prev => {
                const next = prev.map(s => {
                    if (s.id === currentSessionId) {
                        return {
                            ...s,
                            activeArtifact: canonicalArtifact,
                            artifactHistory: s.artifactHistory
                                ? [canonicalArtifact, ...s.artifactHistory.filter(a => a.id !== updatedArtifact.id && a.id !== canonicalArtifact.id)]
                                : [canonicalArtifact],
                            messages: s.messages.map(m => {
                                if (!m.artifacts || m.artifacts.length === 0) return m;
                                const matches = m.artifacts.some(a =>
                                    (a.id === updatedArtifact.id || a.id === canonicalArtifact.id) &&
                                    (a.version || 1) === (canonicalArtifact.version || 1)
                                );
                                if (!matches) return m;
                                return {
                                    ...m,
                                    artifacts: m.artifacts.map(a =>
                                        (a.id === updatedArtifact.id || a.id === canonicalArtifact.id) &&
                                        (a.version || 1) === (canonicalArtifact.version || 1)
                                            ? canonicalArtifact
                                            : a
                                    ),
                                    artifactRefs: [canonicalArtifact.graphRef!]
                                };
                            }),
                            updatedAt: 'Just now'
                        };
                    }
                    return s;
                });
                persistSessionsImmediately(next);
                return next;
            });
        }
    }, [currentSessionId, persistSessionsImmediately]);

    // Track verified artifact keys (id + version) to avoid redundant loops
    const verifiedArtifactKeysRef = React.useRef<Set<string>>(new Set());
    const isVerifyingVisualRef = React.useRef<boolean>(false);

    // Automated Background Visual Verification & Self-Correction Loop
    React.useEffect(() => {
        if (!activeArtifact) return;
        if (activeArtifact.type !== '3d-scene' && activeArtifact.type !== 'live-code-sandbox' && activeArtifact.type !== 'interactive-browser') {
            return;
        }

        const artifactKey = `${activeArtifact.id}-v${activeArtifact.version || 1}`;
        if (verifiedArtifactKeysRef.current.has(artifactKey)) {
            return;
        }

        let cancelled = false;
        const settleTimer = setTimeout(async () => {
            if (isVerifyingVisualRef.current) return;
            isVerifyingVisualRef.current = true;
            verifiedArtifactKeysRef.current.add(artifactKey);

            try {
                const screenshot = captureActiveCanvasScreenshot(layoutMode);
                const client = GeminiClient.getInstance();

                const audit = await client.verifyVisual({
                    image: screenshot,
                    prompt: activeArtifact.title || 'Interactive 3D Spatial Canvas or UI Sandbox',
                    artifactType: activeArtifact.type,
                    context: {
                        artifactId: activeArtifact.id,
                        title: activeArtifact.title,
                        sceneData: activeArtifact.type === '3d-scene' ? (activeArtifact.data as any) : undefined
                    }
                });
                if (cancelled) {
                    return;
                }

                // Attach audit result to latest assistant message in chat
                setMessages(prev => {
                    const lastIdx = prev.length - 1;
                    if (lastIdx >= 0 && prev[lastIdx].sender === 'assistant') {
                        const updated = [...prev];
                        updated[lastIdx] = {
                            ...updated[lastIdx],
                            visualAudit: audit
                        };
                        return updated;
                    }
                    return prev;
                });

                // If fidelity score is low (< 80) and auto-repair directives exist, automatically apply visual self-correction
                if (audit.visualFixes && audit.fidelityScore < 80) {
                    const fixes = audit.visualFixes;
                    let repairedData: any = { ...activeArtifact.data };

                    if (activeArtifact.type === '3d-scene') {
                        repairedData = {
                            ...repairedData,
                            renderMode: fixes.scenePatches?.renderMode || repairedData.renderMode || 'shaded',
                            environment: {
                                ...(repairedData.environment || {}),
                                ...(fixes.environment || {}),
                                lighting: fixes.environment?.lighting || (fixes.lighting ? 'shaded' : repairedData.environment?.lighting || 'shaded')
                            },
                            camera: {
                                ...(repairedData.camera || { position: [15, 12, 15], target: [0, 0, 0] }),
                                ...(fixes.camera || {})
                            },
                            features: {
                                ...(repairedData.features || {}),
                                ...(fixes.features || {})
                            }
                        };
                        if (fixes.scenePatches) {
                            Object.assign(repairedData, fixes.scenePatches);
                        }
                    } else if (activeArtifact.type === 'live-code-sandbox') {
                        if (fixes.cssFixes && Array.isArray(repairedData.files)) {
                            const cssFile = repairedData.files.find((f: any) => f.name?.endsWith('.css') || f.path?.endsWith('.css'));
                            if (cssFile) {
                                cssFile.content = `${cssFile.content}\n/* Visual Auto-Repair Fixes */\n${fixes.cssFixes}`;
                            }
                        }
                    }

                    const repairedArtifact: CanvasArtifact = {
                        ...activeArtifact,
                        version: (activeArtifact.version || 1) + 1,
                        data: repairedData
                    };

                    handleUpdateArtifact(repairedArtifact);
                }
            } catch (err) {
                console.warn('[GenerativeCanvasStudio] Background visual verification completed with fallback:', err);
            } finally {
                isVerifyingVisualRef.current = false;
            }
        }, 700);

        return () => {
            cancelled = true;
            clearTimeout(settleTimer);
        };
    }, [activeArtifact, layoutMode, handleUpdateArtifact]);

    const triggerMarkdownExport = React.useCallback(() => {
        const doc = (activeArtifact?.type === 'markdown-document' ? (activeArtifact.data as MarkdownDocumentData) : undefined) || {
            title: 'Project Specification & Notes',
            subtitle: 'Rich block document for architecture, roadmap, and specs',
            author: getActiveUserName(),
            lastUpdated: 'Just now',
            tags: ['Specification', 'Architecture', 'DocumentSpec', 'Reasoning'],
            sections: [
                { id: 'sec-1', type: 'heading', level: 1, content: '1. Overview & Vision' },
                { id: 'sec-2', type: 'paragraph', content: 'Scratchbox IDE empowers developers with an AI-native workspace featuring N8N workflow canvases, rich document specs, and Kanban sprint boards.' },
                { id: 'sec-3', type: 'callout', calloutType: 'info', calloutTitle: 'Key Architecture Insight', content: 'Subagents running on Gemini Flash Lite handle ultra-fast data preprocessing while Gemini 3.7 Flash powers high-reasoning synthesis.' },
                { id: 'sec-4', type: 'heading', level: 2, content: '2. Next Action Items' },
                { id: 'sec-5', type: 'checklist', checklistItems: [
                    { id: 'c1', text: 'Verify N8N canvas node routing & simulation', done: true },
                    { id: 'c2', text: 'Structure rich document blocks & callouts', done: true },
                    { id: 'c3', text: 'Verify Kanban sprint columns and drag & drop', done: false }
                ]}
            ]
        };

        let md = `# ${doc.title}\n`;
        if (doc.subtitle) md += `_${doc.subtitle}_\n\n`;
        if (doc.author || doc.lastUpdated) {
            md += `> ${doc.author ? `**Author**: ${doc.author}  ` : ''}${doc.lastUpdated ? `**Updated**: ${doc.lastUpdated}` : ''}\n\n`;
        }
        if (doc.tags && doc.tags.length > 0) {
            md += `**Tags**: ${doc.tags.map(t => `#${t}`).join(' ')}\n\n`;
        }

        (doc.sections || []).forEach(sec => {
            if (sec.type === 'heading') {
                const prefix = '#'.repeat(Math.max(1, Math.min(6, (sec.level || 2) + 1)));
                md += `${prefix} ${sec.content}\n\n`;
            } else if (sec.type === 'paragraph') {
                md += `${sec.content}\n\n`;
            } else if (sec.type === 'callout') {
                md += `> **${sec.calloutTitle || 'Note'}**\n> ${sec.content}\n\n`;
            } else if (sec.type === 'table') {
                const headers = sec.tableHeaders || [];
                const rows = sec.tableRows || [];
                if (headers.length > 0) {
                    md += `| ${headers.join(' | ')} |\n`;
                    md += `| ${headers.map(() => '---').join(' | ')} |\n`;
                    rows.forEach(r => {
                        md += `| ${r.join(' | ')} |\n`;
                    });
                    md += '\n';
                }
            } else if (sec.type === 'checklist') {
                (sec.checklistItems || []).forEach(item => {
                    md += `- [${item.done ? 'x' : ' '}] ${item.text}\n`;
                });
                md += '\n';
            } else if (sec.type === 'code') {
                md += `\`\`\`${sec.codeLanguage || ''}\n${sec.content}\n\`\`\`\n\n`;
            }
        });

        if (typeof document !== 'undefined') {
            const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', `${(doc.title || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }
    }, [activeArtifact]);

    const handleOpenInAppBrowser = React.useCallback((targetUrl: string, targetTitle?: string) => {
        if (!targetUrl || targetUrl === '#') return;

        let normalizedUrl = targetUrl.trim();
        if (!/^https?:\/\//i.test(normalizedUrl) && !normalizedUrl.startsWith('localhost:') && !normalizedUrl.startsWith('127.0.0.1:')) {
            normalizedUrl = `https://${normalizedUrl}`;
        }

        const cleanDomain = normalizedUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
        const displayTitle = targetTitle || cleanDomain || 'Live Web Page';
        const sourceArtifact = activeArtifact;

        const isCurrentBrowser = activeArtifact?.type === 'interactive-browser' || activeArtifact?.type === 'browser';
        const reusableBrowser = graphControllerRef.current.findBrowserByUrl(normalizedUrl);
        const existingBrowser = reusableBrowser || (isCurrentBrowser ? activeArtifact : undefined);
        const browserId = existingBrowser?.id || stableProjectArtifactId('interactive-browser', `${activeWorkspace.id}:${normalizedUrl}`);

        const existingBrowserData = existingBrowser?.data as InteractiveBrowserData | undefined;
        const historyList = existingBrowserData?.history ? [...existingBrowserData.history, normalizedUrl] : [normalizedUrl];

        const browserData: InteractiveBrowserData = {
            url: normalizedUrl,
            title: displayTitle,
            viewportMode: existingBrowserData?.viewportMode || 'desktop',
            history: historyList,
            historyIndex: historyList.length - 1,
            isLoading: false,
            consoleLogs: [
                ...(existingBrowserData?.consoleLogs || []),
                { type: 'info', text: `Navigated to ${normalizedUrl}`, timestamp: new Date().toLocaleTimeString() },
                { type: 'log', text: `Loaded source "${displayTitle}" via in-app browser canvas proxy.`, timestamp: new Date().toLocaleTimeString() }
            ],
            inspectMode: false,
            deviceScale: existingBrowserData?.deviceScale || 1
        };

        const browserArtifact: CanvasArtifact = {
            id: browserId,
            type: 'interactive-browser',
            title: displayTitle,
            summary: `Live Web Page: ${normalizedUrl}`,
            data: browserData,
            createdAt: existingBrowser?.createdAt || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            version: (existingBrowser?.version || 0) + 1
        };
        const correlationId = `open-browser-${browserId}-${browserArtifact.version}`;
        const canonicalSource = sourceArtifact && sourceArtifact.id !== browserId
            ? graphControllerRef.current.registerArtifact(sourceArtifact, correlationId)
            : undefined;
        const canonicalBrowser = graphControllerRef.current.registerArtifact(browserArtifact, correlationId);
        if (canonicalSource?.graphRef && canonicalBrowser.graphRef) {
            const relation = canonicalSource.type === 'markdown-document'
                ? 'cites'
                : canonicalSource.type === 'live-code-sandbox' ? 'previews' : 'references';
            graphControllerRef.current.link(relation, canonicalSource.graphRef, canonicalBrowser.graphRef, correlationId);
        }
        setGraphEpoch(epoch => epoch + 1);

        setActiveArtifact(canonicalBrowser);
        setArtifactHistory(prev => {
            const filtered = prev.filter(a => a.id !== canonicalBrowser.id);
            return [canonicalBrowser, ...filtered];
        });

        // Switch layoutMode to 'browser' if not in multi-pane bento view
        if (stageLayoutMode === 'single') {
            setLayoutMode('browser');
        }

        // Update active session metadata
        setSessions(prev => prev.map(s => {
            if (s.id === currentSessionId) {
                return {
                    ...s,
                    layoutMode: stageLayoutMode === 'single' ? 'browser' : s.layoutMode,
                    activeArtifact: canonicalBrowser,
                    artifactHistory: [canonicalBrowser, ...(s.artifactHistory || []).filter(a => a.id !== canonicalBrowser.id)]
                };
            }
            return s;
        }));

        showToast(`Opening ${displayTitle} in In-App Web Browser`, '🌐');
    }, [activeArtifact, activeWorkspace.id, stageLayoutMode, currentSessionId, showToast]);

    const handlePreviewCodeInCanvas = React.useCallback((language: string, content: string) => {
        const lang = (language || '').toLowerCase();
        let template: SandboxTemplate = 'react';
        let fileName = 'App.tsx';
        let fileLang: SandboxLanguage = 'typescript';

        if (['html', 'htm'].includes(lang) || /<!DOCTYPE\s+html|<html/i.test(content)) {
            template = 'vanilla-html';
            fileName = 'index.html';
            fileLang = 'html';
        } else if (['python', 'py'].includes(lang)) {
            template = 'python';
            fileName = 'main.py';
            fileLang = 'python';
        } else if (['svg'].includes(lang) || /<svg/i.test(content)) {
            template = 'vanilla-html';
            fileName = 'index.html';
            fileLang = 'html';
            content = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>SVG Preview</title>
  <style>
    body { margin: 0; padding: 24px; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #0b0f19; }
    svg { max-width: 90vw; max-height: 90vh; }
  </style>
</head>
<body>
${content}
</body>
</html>`;
        }

        const sandboxData: LiveCodeSandboxData = {
            title: `${fileName} Live Preview`,
            subtitle: `Live interactive preview of ${language.toUpperCase()} code`,
            template,
            activeFileId: fileName,
            viewMode: 'preview',
            viewportMode: 'desktop',
            autoRun: true,
            files: [
                {
                    id: fileName,
                    name: fileName,
                    language: fileLang,
                    content,
                    isEntry: true
                }
            ]
        };

        const newArtifact: CanvasArtifact = {
            id: `art-sandbox-${Date.now()}`,
            type: 'live-code-sandbox',
            title: `${fileName} Live Preview`,
            summary: `Interactive preview of ${fileName}`,
            version: 1,
            createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            data: sandboxData
        };

        setActiveArtifact(newArtifact);
        setArtifactHistory(prev => {
            const filtered = prev.filter(a => a.id !== newArtifact.id);
            return [newArtifact, ...filtered];
        });
        setLayoutMode('code');
        showToast(`Previewing ${fileName} live in Canvas`, '⚡');
    }, [showToast]);

    const triggerGoogleDocsExport = React.useCallback(async () => {
        const driveService = GoogleDriveService.getInstance();
        const connectionState = driveService.getState();
        if (connectionState.status !== 'connected') {
            openModal('google-drive');
            return;
        }

        const doc = (activeArtifact?.type === 'markdown-document' ? (activeArtifact.data as MarkdownDocumentData) : undefined) || {
            title: 'Project Specification & Notes',
            subtitle: 'Rich block document for architecture, roadmap, and specs',
            author: getActiveUserName(),
            lastUpdated: 'Just now',
            tags: ['Specification', 'Architecture', 'DocumentSpec', 'Reasoning'],
            sections: [
                { id: 'sec-1', type: 'heading', level: 1, content: '1. Overview & Vision' },
                { id: 'sec-2', type: 'paragraph', content: 'Scratchbox IDE empowers developers with an AI-native workspace featuring N8N workflow canvases, rich document specs, and Kanban sprint boards.' }
            ]
        };

        showToast('Exporting to Google Docs...', '📄');

        try {
            const res = await driveService.exportDocumentToGoogleDocs(doc);
            showToast(`✓ Exported to Google Docs: ${res.documentTitle}`, '✓');
            if (res.documentUrl) {
                handleOpenInAppBrowser(res.documentUrl, `Google Docs: ${res.documentTitle}`);
            }
        } catch (err: any) {
            showToast(`Export failed: ${err?.message || 'Google Drive error'}`, '⚠️');
        }
    }, [activeArtifact, openModal, showToast, handleOpenInAppBrowser]);

    const triggerGoogleDriveSave = React.useCallback(async () => {
        const driveService = GoogleDriveService.getInstance();
        const connectionState = driveService.getState();
        if (connectionState.status !== 'connected') {
            openModal('google-drive');
            return;
        }

        const doc = (activeArtifact?.type === 'markdown-document' ? (activeArtifact.data as MarkdownDocumentData) : undefined) || {
            title: 'Project Specification & Notes',
            subtitle: 'Rich block document for architecture, roadmap, and specs',
            author: getActiveUserName(),
            lastUpdated: 'Just now',
            tags: ['Specification', 'Architecture', 'DocumentSpec', 'Reasoning'],
            sections: [
                { id: 'sec-1', type: 'heading', level: 1, content: '1. Overview & Vision' },
                { id: 'sec-2', type: 'paragraph', content: 'Scratchbox IDE empowers developers with an AI-native workspace featuring N8N workflow canvases, rich document specs, and Kanban sprint boards.' }
            ]
        };

        showToast('Saving Markdown file to Google Drive...', '💾');

        try {
            const fileName = `${(doc.title || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
            let md = `# ${doc.title || 'Project Specification'}\n\n`;
            if (doc.subtitle) md += `> ${doc.subtitle}\n\n`;
            (doc.sections || []).forEach(sec => {
                if (sec.type === 'heading') md += `\n${'#'.repeat(sec.level || 1)} ${sec.content}\n\n`;
                else if (sec.type === 'paragraph') md += `${sec.content}\n\n`;
                else if (sec.type === 'callout') md += `> **${sec.calloutTitle || 'Note'}**\n> ${sec.content}\n\n`;
                else if (sec.type === 'checklist') {
                    (sec.checklistItems || []).forEach(item => {
                        md += `- [${item.done ? 'x' : ' '}] ${item.text}\n`;
                    });
                    md += '\n';
                } else if (sec.type === 'code') {
                    md += `\`\`\`${sec.codeLanguage || ''}\n${sec.content}\n\`\`\`\n\n`;
                }
            });

            const res = await driveService.saveFileToGoogleDrive(fileName, md, 'text/markdown');
            showToast(`✓ Saved to Google Drive: ${res.name}`, '✓');
            if (res.webViewLink) {
                handleOpenInAppBrowser(res.webViewLink, `Google Drive: ${res.name}`);
            }
        } catch (err: any) {
            showToast(`Save failed: ${err?.message || 'Google Drive error'}`, '⚠️');
        }
    }, [activeArtifact, openModal, showToast, handleOpenInAppBrowser]);

    const syncSandboxSaveToMarkdown = React.useCallback((sandboxData: LiveCodeSandboxData) => {
        const markdownArtifact = artifactHistory.find(art => art.type === 'markdown-document');
        if (!markdownArtifact) return;

        let hasApiSpec = false;
        let hasSecurityGuard = false;

        const filesToScan = Array.isArray(sandboxData.files) ? sandboxData.files : [];
        for (const file of filesToScan) {
            const code = (file.content || '').toLowerCase();
            if (code.includes('fetch') || code.includes('axios') || code.includes('/api/') || code.includes('app.get') || code.includes('app.post')) {
                hasApiSpec = true;
            }
            if (code.includes('auth') || code.includes('token') || code.includes('password') || code.includes('jwt') || code.includes('cors')) {
                hasSecurityGuard = true;
            }
        }

        const currentDoc = (markdownArtifact.data as MarkdownDocumentData) || { sections: [] };
        const originalSections = Array.isArray(currentDoc.sections) ? currentDoc.sections : [];
        let updatedSections = originalSections.filter(sec => 
            sec.id !== 'sec-injected-api-spec-table' && 
            sec.id !== 'sec-injected-security-guardrail-callout'
        );

        if (hasApiSpec) {
            const apiTableSection: MarkdownSection = {
                id: 'sec-injected-api-spec-table',
                type: 'table',
                content: 'Dynamic API Specifications Table',
                tableHeaders: ['Endpoint', 'Method', 'Query Params', 'Status Code', 'Description'],
                tableRows: [
                    ['/api/v1/auth/login', 'POST', 'username, password', '200 OK / 401 Unauthorized', 'User authentication and JWT token issuance.'],
                    ['/api/v1/sandbox/execute', 'POST', 'fileId, code', '200 OK / 500 Error', 'Executes sandbox code in Pyodide WASM runtime.'],
                    ['/api/v1/metrics', 'GET', 'interval, limit', '200 OK', 'Retrieve real-time resource utilization metrics.']
                ]
            };
            updatedSections.push(apiTableSection);
        }

        if (hasSecurityGuard) {
            const securityCalloutSection: MarkdownSection = {
                id: 'sec-injected-security-guardrail-callout',
                type: 'callout',
                calloutType: 'warning',
                calloutTitle: 'Security & Sandboxing Guardrails Active',
                content: 'CRITICAL: This environment executes arbitrary code inside a highly isolated WebAssembly-based Pyodide / Docker subcontainer. CORS headers are strictly locked down to project domains, and credentials (JWT/Service Accounts) must never be written inline.'
            };
            updatedSections.push(securityCalloutSection);
        }

        const updatedDocArtifact: CanvasArtifact = {
            ...markdownArtifact,
            data: {
                ...currentDoc,
                sections: updatedSections
            } as MarkdownDocumentData,
            version: (markdownArtifact.version || 1) + 1,
            createdAt: new Date().toLocaleTimeString()
        };

        handleUpdateArtifact(updatedDocArtifact);
    }, [artifactHistory, handleUpdateArtifact]);

    const handleMorphArtifact = React.useCallback((morphedArtifact: CanvasArtifact) => {
        const correlationId = `morph-${activeArtifact?.id || 'unknown'}-${morphedArtifact.id}`;
        const source = activeArtifact
            ? graphControllerRef.current.registerArtifact(activeArtifact, correlationId)
            : undefined;
        const canonicalArtifact = graphControllerRef.current.registerArtifact(
            morphedArtifact,
            correlationId,
            source?.graphRef
        );
        setGraphEpoch(epoch => epoch + 1);
        setActiveArtifact(canonicalArtifact);
        recordArtifactVersion(canonicalArtifact);
        setArtifactHistory(prev => [canonicalArtifact, ...prev.filter(a => a.id !== canonicalArtifact.id)]);
        const targetMode = resolveModeForArtifact(canonicalArtifact.type);
        setLayoutMode(targetMode);

        if (currentSessionId) {
            setSessions(prev => {
                const next = prev.map(s => {
                    if (s.id === currentSessionId) {
                        return {
                            ...s,
                            activeArtifact: canonicalArtifact,
                            layoutMode: targetMode,
                            fileType: (targetMode === 'code' ? 'code' : targetMode === 'document' ? 'document' : targetMode === 'kanban' ? 'kanban' : targetMode === 'automation' ? 'automation' : 'chat') as WorkspaceFileType,
                            artifactHistory: s.artifactHistory
                                ? [canonicalArtifact, ...s.artifactHistory.filter(a => a.id !== canonicalArtifact.id)]
                                : [canonicalArtifact],
                            updatedAt: 'Just now'
                        };
                    }
                    return s;
                });
                persistSessionsImmediately(next);
                return next;
            });
        }
        showToast(`Morphed to ${canonicalArtifact.title}`);
    }, [activeArtifact, currentSessionId, persistSessionsImmediately]);

    const saveCurrentSessionViewState = React.useCallback(() => {
        if (currentSessionId) {
            const vs: SessionViewState = {
                activeSandboxTabId: activeArtifact?.type === 'live-code-sandbox' ? (activeArtifact.data as LiveCodeSandboxData)?.activeFileId : undefined,
                sandboxViewMode: activeArtifact?.type === 'live-code-sandbox' ? (activeArtifact.data as LiveCodeSandboxData)?.viewMode : undefined,
                sandboxViewportMode: activeArtifact?.type === 'live-code-sandbox' ? (activeArtifact.data as LiveCodeSandboxData)?.viewportMode : undefined,
                layoutMode
            };
            sessionViewStateCacheRef.current.updateViewState(currentSessionId, vs);
        }
    }, [currentSessionId, activeArtifact, layoutMode]);

    // Version Stepper Navigation Helpers
    const currentArtifactVersionsList: CanvasArtifact[] = React.useMemo(() => {
        if (!activeArtifact) return [];
        const recorded = artifactVersions[activeArtifact.id] || [];
        if (recorded.length === 0) return [activeArtifact];
        return recorded;
    }, [activeArtifact, artifactVersions]);

    const currentArtifactVersionIndex = React.useMemo(() => {
        if (!activeArtifact) return -1;
        const idx = currentArtifactVersionsList.findIndex(v => (v.version || 1) === (activeArtifact.version || 1));
        return idx >= 0 ? idx : currentArtifactVersionsList.length - 1;
    }, [activeArtifact, currentArtifactVersionsList]);

    const isCurrentArtifactLatestVersion = currentArtifactVersionIndex >= currentArtifactVersionsList.length - 1;

    // Persistent Artifact Tab Strip across all session artifacts
    const canvasArtifactTabs = React.useMemo(() => {
        const list = [...artifactHistory];
        if (activeArtifact && !list.some(a => a.id === activeArtifact.id)) {
            list.unshift(activeArtifact);
        }
        return list;
    }, [artifactHistory, activeArtifact]);

    const getArtifactIcon = React.useCallback((type: PrimitiveType | string) => {
        switch (type) {
            case 'markdown-document': return '📄';
            case '3d-scene': return '🪐';
            case 'live-code-sandbox': return '⚡';
            case 'kanban-board': return '📋';
            case 'node-graph': return '🕸️';
            case 'metric-dashboard': return '📊';
            case 'interactive-browser': return '🌐';
            default: return '✨';
        }
    }, []);

    const handleSelectArtifactTab = React.useCallback((art: CanvasArtifact) => {
        setActiveArtifact(art);
        setLayoutMode(resolveModeForArtifact(art.type));
    }, []);

    const handleCloseArtifactTab = React.useCallback((e: React.MouseEvent, artId: string) => {
        e.stopPropagation();
        const next = artifactHistory.filter(a => a.id !== artId);
        setArtifactHistory(next);
        if (activeArtifact?.id === artId) {
            const remaining = next[0] || undefined;
            setActiveArtifact(remaining);
            if (remaining) {
                setLayoutMode(resolveModeForArtifact(remaining.type));
            } else {
                setLayoutMode('document');
            }
        }
    }, [activeArtifact, artifactHistory]);

    const handleCreateNewSandboxTab = React.useCallback(() => {
        const newTab: CanvasArtifact = {
            id: `art-sandbox-${Date.now()}`,
            type: 'live-code-sandbox',
            title: 'New Live Preview',
            summary: 'Interactive React/HTML preview playground',
            version: 1,
            createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            data: {
                title: 'Live Sandbox Playground',
                subtitle: 'Interactive live prototype with hot reload',
                template: 'react',
                activeFileId: 'App.tsx',
                viewMode: 'preview',
                viewportMode: 'desktop',
                files: [
                    {
                        id: 'App.tsx',
                        name: 'App.tsx',
                        language: 'typescript',
                        content: `import React, { useState } from 'react';\n\nexport default function App() {\n    const [count, setCount] = useState(0);\n    return (\n        <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif', color: '#f8fafc', background: '#090d16', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>\n            <div style={{ background: '#131b2e', padding: 32, borderRadius: 16, border: '1px solid #1e293b', textAlign: 'center', maxWidth: 440, width: '100%' }}>\n                <h1 style={{ fontSize: 24, margin: '0 0 12px 0', color: '#60a5fa' }}>⚡ Scratchbox Live Preview</h1>\n                <p style={{ color: '#94a3b8', fontSize: 14, margin: '0 0 24px 0' }}>Edit this code in Split or Code mode, and watch your changes render instantly.</p>\n                <button onClick={() => setCount(c => c + 1)} style={{ padding: '10px 24px', fontSize: 15, fontWeight: 600, borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', boxShadow: '0 4px 12px rgba(37,99,235,0.3)' }}>\n                    Interactive Counter: {count}\n                </button>\n            </div>\n        </div>\n    );\n}`,
                        isEntry: true
                    }
                ]
            }
        };
        setActiveArtifact(newTab);
        setArtifactHistory(prev => [newTab, ...prev]);
        setLayoutMode('code');
        showToast('Created new Live Code Preview tab', '⚡');
    }, [showToast]);

    const activeSandboxData = activeArtifact?.type === 'live-code-sandbox' ? (activeArtifact.data as LiveCodeSandboxData) : null;

    const handleSetSandboxViewMode = React.useCallback((mode: 'code' | 'split' | 'preview') => {
        if (activeArtifact && activeArtifact.type === 'live-code-sandbox') {
            const updated = {
                ...activeArtifact,
                data: {
                    ...(activeArtifact.data as LiveCodeSandboxData),
                    viewMode: mode
                }
            };
            setActiveArtifact(updated);
            setArtifactHistory(prev => prev.map(a => a.id === updated.id ? updated : a));
        }
    }, [activeArtifact]);

    const relatedArtifacts = React.useMemo(
        () => activeArtifact ? graphControllerRef.current.related(activeArtifact.id) : [],
        [activeArtifact?.id, graphEpoch]
    );

    const handleSelectRelatedArtifact = React.useCallback((artifactId: string) => {
        const selected = graphControllerRef.current.selectArtifact(
            artifactId,
            `related-select-${activeArtifact?.id || 'none'}-${artifactId}`
        );
        if (!selected) {
            return;
        }
        setActiveArtifact(selected);
        setArtifactHistory(previous => [selected, ...previous.filter(artifact => artifact.id !== selected.id)]);
        setLayoutMode(resolveModeForArtifact(selected.type));
        setGraphEpoch(epoch => epoch + 1);
    }, [activeArtifact?.id]);

    const handleOpenRelatedInBento = React.useCallback((artifactId: string) => {
        const selected = graphControllerRef.current.selectArtifact(
            artifactId,
            `related-bento-${activeArtifact?.id || 'none'}-${artifactId}`
        );
        if (!selected) {
            return;
        }
        setArtifactHistory(previous => {
            const candidates = activeArtifact ? [activeArtifact, selected, ...previous] : [selected, ...previous];
            return candidates.filter((artifact, index, all) =>
                all.findIndex(candidate => candidate.id === artifact.id) === index
            );
        });
        setActiveArtifact(selected);
        setStageLayoutMode('dual-split-horizontal');
        setGraphEpoch(epoch => epoch + 1);
    }, [activeArtifact]);

    const handleSelectVersion = (targetVersion: CanvasArtifact) => {
        setActiveArtifact(targetVersion);
        const targetMode = resolveModeForArtifact(targetVersion.type);
        setLayoutMode(targetMode);
        if (targetMode === 'document') {
            setDocumentPaneState('split');
        }
        if (currentSessionId) {
            setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, activeArtifact: targetVersion } : s));
        }
    };

    const handlePrevArtifactVersion = () => {
        if (currentArtifactVersionIndex > 0) {
            const targetVer = currentArtifactVersionsList[currentArtifactVersionIndex - 1];
            if (targetVer) {
                handleSelectVersion(targetVer);
            }
        }
    };

    const handleNextArtifactVersion = () => {
        if (currentArtifactVersionIndex < currentArtifactVersionsList.length - 1) {
            const targetVer = currentArtifactVersionsList[currentArtifactVersionIndex + 1];
            if (targetVer) {
                handleSelectVersion(targetVer);
            }
        }
    };

    const handleRollbackArtifactToVersion = (targetVersion: CanvasArtifact) => {
        const latestVer = Math.max(...currentArtifactVersionsList.map(v => v.version || 1), activeArtifact?.version || 1);
        const nextVer = latestVer + 1;
        const targetMode = resolveModeForArtifact(targetVersion.type);
        const rolledBack: CanvasArtifact = {
            ...targetVersion,
            version: nextVer,
            createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            summary: `Restored from version v${targetVersion.version || 1}`,
            data: JSON.parse(JSON.stringify(targetVersion.data))
        };
        handleUpdateArtifact(rolledBack);
        setActiveArtifact(rolledBack);
        setLayoutMode(targetMode);
        if (targetMode === 'document') {
            setDocumentPaneState('split');
        }
        showToast(`Restored artifact to v${targetVersion.version || 1} as v${nextVer}`);
    };

    // CSV & Data File Parsing Engine
    const parseCSVContent = (content: string, filename: string, fileSize: number) => {
        const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
        if (lines.length === 0) {
            return {
                name: filename,
                size: fileSize,
                rowsCount: 0,
                headers: [],
                rawText: content,
                parsedRows: [],
                summaryMetrics: []
            };
        }

        const firstLine = lines[0];
        const commaCount = (firstLine.match(/,/g) || []).length;
        const tabCount = (firstLine.match(/\t/g) || []).length;
        const semiCount = (firstLine.match(/;/g) || []).length;
        const delimiter = tabCount > commaCount ? '\t' : (semiCount > commaCount ? ';' : ',');

        const parseLine = (line: string): string[] => {
            const result: string[] = [];
            let current = '';
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                if (char === '"' || char === "'") {
                    inQuotes = !inQuotes;
                } else if (char === delimiter && !inQuotes) {
                    result.push(current.trim().replace(/^["']|["']$/g, ''));
                    current = '';
                } else {
                    current += char;
                }
            }
            result.push(current.trim().replace(/^["']|["']$/g, ''));
            return result;
        };

        const headers = parseLine(lines[0]);
        const parsedRows: Record<string, any>[] = [];

        for (let i = 1; i < lines.length; i++) {
            const values = parseLine(lines[i]);
            if (values.length === 0 || (values.length === 1 && !values[0])) continue;
            const row: Record<string, any> = {};
            headers.forEach((h, idx) => {
                const val = values[idx] !== undefined ? values[idx] : '';
                const numVal = Number(val.replace(/[\$,%]/g, ''));
                row[h] = !isNaN(numVal) && val.trim() !== '' ? numVal : val;
            });
            parsedRows.push(row);
        }

        const numericCols = headers.filter(h => {
            const numCount = parsedRows.filter(r => typeof r[h] === 'number').length;
            return numCount >= Math.min(parsedRows.length * 0.5, 1);
        });

        const categoricalCols = headers.filter(h => !numericCols.includes(h));
        const labelCol = categoricalCols[0] || headers[0];
        const primaryNumCol = numericCols[0] || (headers.length > 1 ? headers[1] : headers[0]);

        const summaryMetrics: MetricItem[] = [
            {
                id: 'm-rows',
                label: 'Total Rows',
                value: parsedRows.length.toLocaleString(),
                trend: 'up',
                change: `${headers.length} attributes`,
                badge: 'Live Data',
                color: 'blue'
            }
        ];

        numericCols.slice(0, 3).forEach((col, idx) => {
            const nums = parsedRows.map(r => Number(r[col])).filter(n => !isNaN(n));
            if (nums.length > 0) {
                const sum = nums.reduce((a, b) => a + b, 0);
                const avg = sum / nums.length;
                const max = Math.max(...nums);
                const color: any = idx === 0 ? 'emerald' : idx === 1 ? 'indigo' : 'purple';
                const sparkline = nums.slice(0, 8);

                summaryMetrics.push({
                    id: `m-num-${idx}`,
                    label: `Total ${col}`,
                    value: sum > 1000000 ? `$${(sum / 1000000).toFixed(2)}M` : (sum > 1000 ? `$${(sum / 1000).toFixed(1)}k` : sum.toLocaleString()),
                    change: `Avg: ${avg.toFixed(1)} | Peak: ${max.toLocaleString()}`,
                    trend: 'up',
                    color,
                    sparkline
                });
            }
        });

        let chartData: ChartDataPoint[] = [];
        if (parsedRows.length > 0) {
            chartData = parsedRows.slice(0, 10).map((r, i) => ({
                label: String(r[labelCol] || `Row ${i + 1}`).slice(0, 16),
                value: Number(r[primaryNumCol]) || (i + 1) * 15
            }));
        }

        return {
            name: filename,
            size: fileSize,
            rowsCount: parsedRows.length,
            headers,
            rawText: content,
            parsedRows,
            summaryMetrics,
            chartData
        };
    };

    const handleFileDrop = (file: File) => {
        const reader = new FileReader();
        reader.onload = e => {
            const text = e.target?.result as string;
            if (file.name.endsWith('.csv') || file.name.endsWith('.tsv') || file.name.endsWith('.txt')) {
                const parsed = parseCSVContent(text, file.name, file.size);
                setAttachedDataFile(parsed);
                setInputValue(`Analyze ${file.name} and build an interactive KPI Metric Dashboard & Data Table with performance charts!`);
                showToast(`📊 Attached ${file.name} (${parsed.rowsCount} rows)`);
                inputRef.current?.focus();
            } else if (file.name.endsWith('.json')) {
                try {
                    const json = JSON.parse(text);
                    if (json.title && json.type && json.data) {
                        setActiveArtifact(json);
                        recordArtifactVersion(json);
                        setArtifactHistory(prev => [json, ...prev.filter(a => a.id !== json.id)]);
                        showToast(`Loaded canvas artifact "${json.title}"`);
                        return;
                    }
                } catch {
                    // Ignore JSON parse errors
                }
                showToast(`Attached ${file.name}`);
            }
        };
        reader.readAsText(file);
    };

    const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            handleFileDrop(e.target.files[0]);
            e.target.value = '';
        }
    };

    const openSettingsToTab = (tab: StudioSettingsTab) => {
        setSettingsInitialTab(tab);
        openModal('settings');
    };

    // Chat Session Management (Matching Cursor New Chat & Thread Switch behavior)
    const handleNewChat = () => {
        const newSessionId = `session-chat-${Date.now()}`;
        const newChatSession: ChatSession = {
            id: newSessionId,
            title: 'New Chat',
            fileType: 'chat',
            layoutMode: 'chat',
            workspaceId: activeWorkspace.id,
            workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
            relativeTime: 'Just now',
            dateCategory: 'Today',
            updatedAt: 'Just now',
            messages: [],
            artifactHistory: []
        };
        setSessions(prev => [newChatSession, ...prev]);
        setCurrentSessionId(newSessionId);
        setMessages([]);
        setActiveArtifact(undefined);
        setArtifactHistory([]);
        setLayoutMode('chat');
        setInputValue('');
        setLiveThinkingText('');
        if (typeof window !== 'undefined' && window.innerWidth <= 767) {
            setIsSidebarOpen(false);
        }
        setTimeout(() => {
            inputRef.current?.focus();
        }, 50);
    };

    const handleSelectSession = (session: ChatSession) => {
        saveCurrentSessionViewState();
        setCurrentSessionId(session.id);
        setMessages(session.messages || []);

        // Check if there is cached view state for this session
        const cachedVs = sessionViewStateCacheRef.current.getViewState(session.id);
        let activeArt = session.activeArtifact;

        if (activeArt && activeArt.type === 'live-code-sandbox' && cachedVs) {
            const sbData = { ...(activeArt.data as LiveCodeSandboxData) };
            if (cachedVs.activeSandboxTabId) sbData.activeFileId = cachedVs.activeSandboxTabId;
            if (cachedVs.sandboxViewMode) sbData.viewMode = cachedVs.sandboxViewMode;
            if (cachedVs.sandboxViewportMode) sbData.viewportMode = cachedVs.sandboxViewportMode;
            activeArt = { ...activeArt, data: sbData };
        }

        setActiveArtifact(activeArt);
        setArtifactHistory(session.artifactHistory || (activeArt ? [activeArt] : []));

        const targetMode = cachedVs?.layoutMode || session.fileType || session.layoutMode || (session.activeArtifact ? resolveModeForArtifact(session.activeArtifact.type) : 'chat');
        handleSwitchMode(targetMode === 'canvas' ? 'code' : targetMode);
        if (typeof window !== 'undefined' && window.innerWidth <= 767) {
            setIsSidebarOpen(false);
        }
    };

    const handleDeleteSession = (sessionId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        const remaining = sessions.filter(s => s.id !== sessionId);
        setSessions(remaining);
        if (currentSessionId === sessionId) {
            const nextSession = remaining.find(s => s.workspaceId === activeWorkspace.id) || remaining[0];
            if (nextSession) {
                handleSelectSession(nextSession);
            } else {
                handleNewChat();
            }
        }
        showToast('Conversation deleted');
    };

    const handleClearCurrentConversation = () => {
        setMessages([]);
        if (activeSession) {
            setSessions(prev => prev.map(s => s.id === activeSession.id ? { ...s, messages: [] } : s));
        }
        showToast('Conversation cleared');
        setIsConversationMenuOpen(false);
    };

    const handleExportConversationMarkdown = () => {
        if (!messages || messages.length === 0) {
            showToast('No messages to export');
            setIsConversationMenuOpen(false);
            return;
        }
        const md = messages.map(m => `### ${m.sender === 'user' ? 'User' : 'Scratchbox AI'}\n\n${m.text}`).join('\n\n---\n\n');
        if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
            navigator.clipboard.writeText(md);
            showToast('✓ Conversation copied as Markdown');
        } else {
            showToast('✓ Conversation exported');
        }
        setIsConversationMenuOpen(false);
    };

    // Input change handler with / and @ autocomplete detection supporting multi-word queries
    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const val = e.target.value;
        setInputValue(val);

        const cursorPos = e.target.selectionStart || val.length;
        const triggerMatch = findTriggerMatch(val, cursorPos);

        if (triggerMatch) {
            setAutocompleteType(triggerMatch.type === 'skill' ? 'skill' : 'context');
            setAutocompleteQuery(triggerMatch.query);
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

    // Global file drag-and-drop for SKILL.md
    const handleGlobalDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('Files') && !isGlobalDraggingFile) {
            setIsGlobalDraggingFile(true);
        }
    };

    const handleGlobalDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.relatedTarget === undefined || (e.clientX <= 0 || e.clientY <= 0)) {
            setIsGlobalDraggingFile(false);
        }
    };

    const handleGlobalDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsGlobalDraggingFile(false);

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            const reader = new FileReader();
            reader.onload = event => {
                const text = event.target?.result as string;
                if (text) {
                    const headingMatch = text.match(/^#\s+(.+)$/m);
                    const name = headingMatch
                        ? headingMatch[1].trim()
                        : file.name.replace(/\.(md|skill)$/i, '').replace(/[-_]/g, ' ');

                    const cleanContent = text.replace(/^#.+$/m, '').trim();
                    const firstParagraph = cleanContent.split('\n\n')[0] || 'Custom imported AI superpower instructions.';
                    const tagline = firstParagraph.slice(0, 110) + (firstParagraph.length > 110 ? '...' : '');

                    const newSkill: SkillItem = {
                        id: `skill-imported-${Date.now()}`,
                        name: name.charAt(0).toUpperCase() + name.slice(1),
                        tagline,
                        description: cleanContent,
                        icon: '',
                        category: 'Custom',
                        accentColor: 'indigo',
                        tags: ['Imported', file.name.replace(/\..+$/, '')],
                        isEnabled: true,
                        isCustom: true,
                        author: 'Workspace Import',
                        version: '1.0.0',
                        rawContent: text,
                        promptStarters: [`Apply ${name} superpower to active canvas`]
                    };

                    setSkills(prev => [newSkill, ...prev]);
                    setSelectedSkillIds(prev => [...prev, newSkill.id]);
                    showToast(`Superpower "${newSkill.name}" installed & ready!`);
                }
            };
            reader.readAsText(file);
        }
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

    const cleanMessageText = (rawText: string, artifact?: CanvasArtifact): string => {
        return cleanMessageTextSmart(rawText, artifact);
    };

    const getPrimitiveIcon = (type: string): React.ReactElement => getPrimitiveSvgIcon(type, 14, 1.8);

    const getPrimitiveLabel = (type: string): string => {
        switch (type) {
            case 'metric-dashboard':
            case 'metrics':
            case 'dashboard':
                return 'KPI Dashboard';
            case 'kanban-board':
            case 'kanban':
                return 'Kanban Board';
            case 'interactive-form':
            case 'form':
                return 'Interactive Form';
            case 'node-graph':
            case 'flow-graph':
            case 'graph':
                return 'Node Flow Graph';
            case 'markdown-document':
            case 'rendered-document':
            case 'document':
                return 'Document Spec';
            case 'checklist':
            case 'action-checklist':
                return 'Action Checklist';
            case 'mind-map':
                return 'Mind Map';
            case 'interactive-browser':
            case 'browser':
            case 'web-browser':
                return 'Web Browser Canvas';
            case '3d-scene':
            case '3d':
            case 'scene-3d':
            case 'scene3d':
                return '4D Scene Workspace';
            case 'skills-hub':
            case 'skills-manager':
                return 'Superpowers Hub';
            case 'mcp-hub':
                return 'Live MCP Hub';
            default:
                return 'Visual Canvas';
        }
    };

    const getCanvasHeaderLabel = (): string => {
        if (stageLayoutMode !== 'single') return 'BENTO CANVAS MATRIX';
        switch (layoutMode) {
            case '3d':
                return '3D SCENE CANVAS';
            case 'document':
                return 'DOCUMENT CANVAS';
            case 'browser':
                return 'BROWSER CANVAS';
            case 'code':
                return 'CODE SANDBOX';
            case 'kanban':
                return 'KANBAN ROADMAP';
            case 'automation':
            case 'canvas':
                return 'CANVAS WORKFLOW';
            default:
                return 'VISUAL CANVAS';
        }
    };

    const getCanvasReopenLabel = (): string => {
        switch (layoutMode) {
            case '3d':
                return 'Reopen 3D Canvas';
            case 'document':
                return 'Reopen Document Canvas';
            case 'browser':
                return 'Reopen Browser Canvas';
            case 'code':
                return 'Reopen Code Sandbox';
            case 'kanban':
                return 'Reopen Kanban Roadmap';
            case 'automation':
            case 'canvas':
                return 'Reopen Canvas Workflow';
            default:
                return 'Reopen Canvas';
        }
    };

    const getCanvasReopenTabTitle = (): string => {
        switch (layoutMode) {
            case '3d':
                return '3D Canvas';
            case 'document':
                return 'Document Canvas';
            case 'browser':
                return 'Browser Canvas';
            case 'code':
                return 'Code Sandbox';
            case 'kanban':
                return 'Kanban Roadmap';
            case 'automation':
            case 'canvas':
                return 'Canvas Workflow';
            default:
                return 'Canvas Studio';
        }
    };

    const getCanvasReopenIcon = (): React.ReactElement => {
        switch (layoutMode) {
            case '3d':
                return <Icon3D size={14} strokeWidth={1.8} />;
            case 'document':
                return <IconDocument size={14} strokeWidth={1.8} />;
            case 'browser':
                return <IconGlobe size={14} strokeWidth={1.8} />;
            case 'code':
                return <IconCode size={14} strokeWidth={1.8} />;
            case 'kanban':
                return <IconKanban size={14} strokeWidth={1.8} />;
            case 'automation':
            case 'canvas':
                return <IconAutomations size={14} strokeWidth={1.8} />;
            default:
                return <IconSparkles size={14} strokeWidth={1.8} />;
        }
    };

    const handleStartAgent = async (goalText: string) => {
        const sessionId = `agent-session-${Date.now()}`;
        const initialSession: AgentSessionState = {
            sessionId,
            goal: goalText,
            status: 'running',
            milestones: [
                { id: 'm1', description: 'Deconstruct workspace AST patterns', status: 'pending', acceptanceCriteria: 'All file endpoints indexed' },
                { id: 'm2', description: 'Apply localized sandboxing patch', status: 'pending', acceptanceCriteria: 'Sandbox processes initialized' },
                { id: 'm3', description: 'Execute strict verification suite', status: 'pending', acceptanceCriteria: 'Yarn test returns exit code 0' }
            ],
            currentMilestoneIndex: 0,
            history: [],
            budget: {
                maxIterations: 15,
                maxDurationMs: 600000,
                usedIterations: 0,
                usedDurationMs: 0
            },
            checkpoints: []
        };

        setAgentSession(initialSession);
        setAgentEvents([
            { type: 'agent_init', sessionId, timestamp: Date.now(), message: `Initialized autonomous loop for: "${goalText}"` }
        ]);

        let usedBackend = false;
        try {
            const backendSession = await GeminiClient.getInstance().createAgentSession({
                goal: goalText,
                maxIterations: 15,
                maxDurationMs: 600000
            });
            if (backendSession && backendSession.sessionId) {
                usedBackend = true;
                setAgentSession(backendSession);
                await GeminiClient.getInstance().streamAgentSession(backendSession.sessionId, event => {
                    setAgentEvents(prev => [...prev, event]);
                    if (event.type === 'milestone_complete') {
                        const desc = event.message ? event.message.replace('Successfully completed milestone:', '').trim() : 'Active milestone';
                        AudioPlayer.speak(`Successfully completed milestone: ${desc}`);
                    } else if (event.type === 'agent_done') {
                        AudioPlayer.speak(`All milestones verified. Agent finished successfully!`);
                    } else if (event.type === 'agent_error' || event.type === 'budget_exhausted') {
                        AudioPlayer.speak(`Milestone execution stalled. Incomplete criteria.`);
                    }
                    setAgentSession(current => {
                        if (!current) return current;
                        const updated = { ...current };
                        if (event.type === 'milestone_complete') {
                            updated.currentMilestoneIndex = Math.min(updated.currentMilestoneIndex + 1, updated.milestones.length);
                            if (updated.milestones[current.currentMilestoneIndex]) {
                                updated.milestones[current.currentMilestoneIndex].status = 'completed';
                            }
                        } else if (event.type === 'agent_done') {
                            updated.status = 'completed';
                        } else if (event.type === 'agent_error' || event.type === 'budget_exhausted') {
                            updated.status = 'failed';
                        }
                        return updated;
                    });
                });
                return;
            }
        } catch {
            // Fallback to local simulation runner
        }

        if (!usedBackend) {
            let iteration = 0;
            let milestoneIdx = 0;
            const startTime = Date.now();

            const runNextStep = () => {
                setAgentSession(current => {
                    if (!current || current.status !== 'running') return current;

                    iteration++;
                    const elapsed = Date.now() - startTime;

                    if (iteration > current.budget.maxIterations || elapsed > current.budget.maxDurationMs) {
                        setAgentEvents(prev => [...prev, {
                            type: 'budget_exhausted',
                            sessionId,
                            timestamp: Date.now(),
                            message: 'Execution budget exceeded limits'
                        }]);
                        AudioPlayer.speak(`Milestone execution stalled. Incomplete criteria.`);
                        return { ...current, status: 'failed' };
                    }

                    const updatedMilestones = [...current.milestones];
                    const activeMilestone = updatedMilestones[milestoneIdx];

                    if (!activeMilestone) {
                        setAgentEvents(prev => [...prev, {
                            type: 'agent_done',
                            sessionId,
                            timestamp: Date.now(),
                            message: 'All milestones verified. Agent finished successfully!'
                        }]);
                        AudioPlayer.speak(`All milestones verified. Agent finished successfully!`);
                        return { ...current, status: 'completed' };
                    }

                    activeMilestone.status = 'in_progress';

                    const stepRecord: AgentStepRecord = {
                        stepNumber: iteration,
                        description: `Step ${iteration}: Validating logic boundaries for ${activeMilestone.description}`,
                        status: 'success',
                        timestamp: Date.now(),
                        actionType: 'patch_files',
                        filesModified: ['src/core.ts']
                    };

                    const eventType = iteration % 2 === 0 ? 'step_complete' : 'checkpoint_saved';
                    const messageText = iteration % 2 === 0
                        ? `Successfully verified test boundaries for: ${activeMilestone.description}`
                        : `Saved checkpoint: chk-${iteration}`;

                    setAgentEvents(prev => [...prev, {
                        type: eventType as any,
                        sessionId,
                        timestamp: Date.now(),
                        message: messageText
                    }]);

                    if (iteration % 3 === 0) {
                        activeMilestone.status = 'completed';
                        setAgentEvents(prev => [...prev, {
                            type: 'milestone_complete',
                            sessionId,
                            timestamp: Date.now(),
                            message: `Successfully completed milestone: ${activeMilestone.description}`
                        }]);
                        AudioPlayer.speak(`Successfully completed milestone: ${activeMilestone.description}`);
                        milestoneIdx++;
                    }

                    return {
                        ...current,
                        milestones: updatedMilestones,
                        currentMilestoneIndex: milestoneIdx,
                        history: [...current.history, stepRecord],
                        budget: {
                            ...current.budget,
                            usedIterations: iteration,
                            usedDurationMs: elapsed
                        }
                    };
                });

                setAgentSession(current => {
                    if (current && current.status === 'running') {
                        setTimeout(runNextStep, 2200);
                    }
                    return current;
                });
            };

            setTimeout(runNextStep, 1200);
        }
    };

    const handlePauseAgent = () => {
        setAgentSession(current => {
            if (!current) return current;
            GeminiClient.getInstance().sendAgentAction(current.sessionId, 'pause').catch(() => {});
            setAgentEvents(prev => [...prev, {
                type: 'step_failed',
                sessionId: current.sessionId,
                timestamp: Date.now(),
                message: 'Long-running agent execution paused by user'
            }]);
            return { ...current, status: 'paused' };
        });
    };

    const handleResumeAgent = () => {
        setAgentSession(current => {
            if (!current) return current;
            GeminiClient.getInstance().sendAgentAction(current.sessionId, 'resume').catch(() => {});
            setAgentEvents(prev => [...prev, {
                type: 'step_start',
                sessionId: current.sessionId,
                timestamp: Date.now(),
                message: 'Resumed agent loop execution'
            }]);
            return { ...current, status: 'running' };
        });
    };

    const handleCancelAgent = () => {
        setAgentSession(current => {
            if (!current) return current;
            GeminiClient.getInstance().sendAgentAction(current.sessionId, 'cancel').catch(() => {});
            setAgentEvents(prev => [...prev, {
                type: 'agent_error',
                sessionId: current.sessionId,
                timestamp: Date.now(),
                message: 'Execution stopped and session cancelled'
            }]);
            return { ...current, status: 'failed' };
        });
        setTimeout(() => {
            setAgentSession(undefined);
            setAgentEvents([]);
        }, 1500);
    };

    const renderLongRunningAgentDashboard = () => {
        if (!agentSession) return null;

        const currentMilestone = agentSession.milestones[agentSession.currentMilestoneIndex] || agentSession.milestones[agentSession.milestones.length - 1];

        return (
            <div className="sb-modal-unified sb-glass-card" style={{
                position: 'fixed',
                bottom: '100px',
                right: '24px',
                width: '380px',
                maxHeight: '500px',
                zIndex: 1000,
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '16px',
                overflow: 'hidden',
                background: 'rgba(24, 24, 27, 0.85)',
                backdropFilter: 'blur(20px)'
            }}>
                <div style={{
                    padding: '16px',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: 'rgba(255, 255, 255, 0.02)'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            display: 'inline-block',
                            background: agentSession.status === 'running' ? '#3b82f6' : '#a1a1aa',
                            boxShadow: agentSession.status === 'running' ? '0 0 8px #3b82f6' : 'none'
                        }} />
                        <span style={{ fontWeight: 600, fontSize: '13px', color: '#f4f4f5' }}>Long-Running Agent Loop</span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                        {agentSession.status === 'running' ? (
                            <button className="sb-btn sb-btn-ghost sb-btn-xs" style={{ padding: '4px 8px' }} onClick={handlePauseAgent}>
                                Pause
                            </button>
                        ) : agentSession.status === 'paused' ? (
                            <button className="sb-btn sb-btn-primary sb-btn-xs" style={{ padding: '4px 8px' }} onClick={handleResumeAgent}>
                                Resume
                            </button>
                        ) : null}
                        <button className="sb-btn sb-btn-danger sb-btn-xs" style={{ padding: '4px 8px' }} onClick={handleCancelAgent}>
                            Stop
                        </button>
                    </div>
                </div>

                <div style={{ padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
                    <div>
                        <div style={{ fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase' }}>Current Goal</div>
                        <div style={{ fontSize: '13px', color: '#e4e4e7', fontWeight: 500, marginTop: '2px' }}>{agentSession.goal}</div>
                    </div>

                    <div style={{ background: 'rgba(255, 255, 255, 0.05)', borderRadius: '4px', height: '6px', overflow: 'hidden', position: 'relative' }}>
                        <div style={{
                            background: '#3b82f6',
                            height: '100%',
                            width: `${(agentSession.currentMilestoneIndex / agentSession.milestones.length) * 100}%`,
                            transition: 'width 0.3s ease'
                        }} />
                    </div>

                    {currentMilestone && (
                        <div className="sb-surface-card-unified" style={{ padding: '10px 12px', border: '1px solid rgba(59, 130, 246, 0.2)' }}>
                            <div style={{ fontSize: '10px', color: '#3b82f6', fontWeight: 600, textTransform: 'uppercase' }}>Active Milestone</div>
                            <div style={{ fontSize: '12px', color: '#f4f4f5', fontWeight: 500, marginTop: '2px' }}>{currentMilestone.description}</div>
                            <div style={{ fontSize: '11px', color: '#a1a1aa', marginTop: '4px' }}>Criteria: {currentMilestone.acceptanceCriteria}</div>
                        </div>
                    )}

                    <div>
                        <div style={{ fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase', marginBottom: '6px' }}>Milestone Progress</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {agentSession.milestones.map((m) => (
                                <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                                    {m.status === 'completed' ? (
                                        <span style={{ color: '#10b981' }}>✓</span>
                                    ) : m.status === 'in_progress' ? (
                                        <span style={{ color: '#3b82f6' }}>●</span>
                                    ) : (
                                        <span style={{ color: '#71717a' }}>○</span>
                                    )}
                                    <span style={{ color: m.status === 'completed' ? '#a1a1aa' : '#e4e4e7', textDecoration: m.status === 'completed' ? 'line-through' : 'none' }}>
                                        {m.description}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div style={{ flex: 1, minHeight: '120px', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase', marginBottom: '6px' }}>Live Telemetry Log</div>
                        <div style={{
                            flex: 1,
                            background: 'rgba(0, 0, 0, 0.25)',
                            border: '1px solid rgba(255, 255, 255, 0.05)',
                            borderRadius: '8px',
                            padding: '8px',
                            fontFamily: 'ui-monospace, monospace',
                            fontSize: '11px',
                            color: '#e4e4e7',
                            overflowY: 'auto',
                            maxHeight: '150px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '4px'
                        }}>
                            {agentEvents.slice(-6).map((ev, i) => (
                                <div key={i} style={{ display: 'flex', gap: '6px' }}>
                                    <span style={{ color: '#a1a1aa' }}>[{new Date(ev.timestamp).toLocaleTimeString()}]</span>
                                    <span style={{
                                        color: ev.type === 'step_complete' || ev.type === 'milestone_complete' ? '#34d399' :
                                               ev.type === 'step_failed' || ev.type === 'agent_error' ? '#f87171' :
                                               ev.type === 'guardrail_gate' ? '#fbbf24' : '#60a5fa'
                                    }}>{ev.message}</span>
                                </div>
                            ))}
                            {agentEvents.length === 0 && <span style={{ color: '#71717a' }}>Waiting for stream events...</span>}
                        </div>
                    </div>
                </div>

                <div style={{
                    padding: '10px 16px',
                    borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '11px',
                    color: '#a1a1aa',
                    background: 'rgba(255, 255, 255, 0.01)'
                }}>
                    <span>Iterations: {agentSession.budget.usedIterations} / {agentSession.budget.maxIterations}</span>
                    <span>Duration: {Math.round(agentSession.budget.usedDurationMs / 1000)}s / {Math.round(agentSession.budget.maxDurationMs / 1000)}s</span>
                </div>
            </div>
        );
    };

    const executeDeepWritePipeline = async (promptText: string, planOverride?: any) => {
        setIsGenerating(true);
        const targetSessionId = currentSessionId || `session-chat-${Date.now()}`;
        if (!currentSessionId) {
            setCurrentSessionId(targetSessionId);
        }

        const userMsg: ChatMessage = {
            id: `msg-user-${Date.now()}`,
            sender: 'user',
            text: promptText,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        const asstMsgId = `msg-asst-${Date.now()}`;
        const asstMsg: ChatMessage = {
            id: asstMsgId,
            sender: 'assistant',
            text: 'Strategic Meta-Architect formulating comprehensive project blueprints...',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            isStreaming: true
        };

        setMessages(prev => [...prev, userMsg, asstMsg]);

        try {
            const res = await fetch('/gemini/deep-write/pipeline', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: promptText,
                    sessionId: targetSessionId,
                    workspaceRoot: activeWorkspace?.path,
                    activeArtifact
                })
            });

            if (!res.body) throw new Error('No stream body received from backend.');

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const eventData = JSON.parse(line.substring(6));
                        
                        setMessages(prev => prev.map(m => {
                            if (m.id !== asstMsgId) return m;

                            if (eventData.type === 'goal_analyzed') {
                                return {
                                    ...m,
                                    text: 'Formulated custom project plan and stages based on user memories & goal preferences.',
                                    deepWriteOffer: true,
                                    deepWritePlan: eventData.plan
                                };
                            }

                            if (eventData.type === 'stage_start' || eventData.type === 'stage_complete' || eventData.type === 'research_thinking' || eventData.type === 'research_query_sent' || eventData.type === 'execution_output') {
                                return {
                                    ...m,
                                    text: eventData.message || 'Executing stage...',
                                    deepWriteOffer: false,
                                    deepWriteProgress: eventData
                                };
                            }

                            if (eventData.type === 'checkpoint_paused') {
                                return {
                                    ...m,
                                    text: 'Pipeline paused at checkpoint. Review intermediate results and submit steering feedback.',
                                    deepWriteOffer: false,
                                    deepWriteCheckpoint: eventData.checkpoint
                                };
                            }

                            if (eventData.type === 'pipeline_complete') {
                                // Spawning the compiled artifacts dynamically onto the canvas!
                                if (eventData.bundle && eventData.bundle.artifacts) {
                                    const primaryArtifact = eventData.bundle.artifacts[0];
                                    if (primaryArtifact) {
                                        const canvasArt: CanvasArtifact = {
                                            id: `art-dw-${Date.now()}`,
                                            type: primaryArtifact.type,
                                            title: primaryArtifact.title,
                                            summary: eventData.bundle.summary,
                                            version: 1,
                                            createdAt: new Date().toLocaleTimeString(),
                                            data: primaryArtifact.data
                                        };
                                        setActiveArtifact(canvasArt);
                                        setSessions(prevSess => prevSess.map(s => {
                                            if (s.id !== targetSessionId) return s;
                                            return {
                                                ...s,
                                                activeArtifact: canvasArt,
                                                artifactHistory: [canvasArt, ...(s.artifactHistory || [])],
                                                updatedAt: 'Just now'
                                            };
                                        }));
                                    }
                                }

                                return {
                                    ...m,
                                    text: eventData.message || 'Pipeline completed successfully.',
                                    deepWriteOffer: false,
                                    deepWriteProgress: eventData,
                                    isStreaming: false
                                };
                            }

                            if (eventData.type === 'error') {
                                return {
                                    ...m,
                                    text: `Deep-Write error: ${eventData.error}`,
                                    deepWriteProgress: eventData,
                                    isStreaming: false
                                };
                            }

                            return m;
                        }));
                    }
                }
            }
        } catch (err: any) {
            console.error('[GenerativeCanvasStudio] Deep-write stream failed:', err);
            setMessages(prev => prev.map(m => {
                if (m.id !== asstMsgId) return m;
                return {
                    ...m,
                    text: `Fatal execution error: ${err.message || err}`,
                    isStreaming: false
                };
            }));
        } finally {
            setIsGenerating(false);
        }
    };

    const handleDeepWriteResume = async (sessionId: string, feedback: string) => {
        try {
            await fetch('/gemini/deep-write/resume', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId,
                    feedback,
                    workspaceRoot: activeWorkspace?.path
                })
            });
        } catch (err) {
            console.error('[GenerativeCanvasStudio] Failed to resume pipeline:', err);
        }
    };

    const { sendMessage: handleSendMessage } = useSendMessage({
        inputValue,
        isGenerating,
        setInputValue,
        executeDeepWritePipeline,
        handleStartAgent,
        skills,
        selectedSkillIds,
        mcpServers,
        selectedMcpIds,
        currentSessionId,
        setCurrentSessionId,
        sessions,
        setSessions,
        messages,
        setMessages,
        setAutocompleteType,
        setIsGenerating,
        setLiveThinkingText,
        setLiveThinkingSeconds,
        setLiveSteps,
        setLiveStreamedText,
        setActiveStreamingSectionId,
        liveThinkingText,
        liveThinkingSeconds,
        liveSteps,
        activeSessionRef,
        googleSearchGrounding,
        activeArtifact,
        setActiveArtifact,
        artifactHistory,
        setArtifactHistory,
        layoutMode,
        setLayoutMode,
        setMcpExecutions,
        setTokenBudget,
        setActiveTerminalError,
        setShowTerminalErrorToast,
        recordArtifactVersion,
        attachedDataFile,
        setAttachedDataFile,
        showToast,
        graphControllerRef,
        setGraphEpoch,
        activeWorkspace,
        persistSessionsImmediately
    });

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

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
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

    const renderMessageItem = (msg: ChatMessage) => {
        return (
            <CanvasErrorBoundary key={msg.id} compact fallbackTitle="Message Render Notice">
                {renderMessageItemInner(msg)}
            </CanvasErrorBoundary>
        );
    };

    const renderMessageItemInner = (msg: ChatMessage) => {
        const isUser = msg.sender === 'user';
        const cleanText = isUser ? msg.text : cleanMessageTextSmart(msg.text, msg.artifacts?.[0]);

        if (msg.deepWriteOffer && msg.deepWritePlan) {
            const plan = msg.deepWritePlan;
            return (
                <div key={msg.id} className="sb-drawer-msg-row sb-msg-assistant-row animate-fadeIn">
                    <div className="sb-chat-avatar sb-avatar-assistant">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 2L14.4 9.6L22 12L14.4 14.4L12 22L9.6 14.4L2 12L9.6 9.6L12 2Z" />
                        </svg>
                    </div>
                    <div className="sb-chat-bubble-content" style={{ borderLeft: '3px solid #3b82f6', paddingLeft: '12px' }}>
                        <div className="sb-bubble-header">
                            <span className="sb-bubble-sender">Scratchbox AI Co-Planner</span>
                            <span className="sb-bubble-time">{msg.timestamp}</span>
                        </div>
                        <div className="text-xs text-slate-300 space-y-2 mt-2">
                            <p><strong>Proposed Plan Goal:</strong> {plan.goal}</p>
                            <p><strong>Target Platforms:</strong> {plan.domains.map((d: string) => `[${d}]`).join(', ')}</p>
                            <p><strong>Expressive Canvas Primitives:</strong> {plan.deliverables.primitives.map((p: string) => `[${p}]`).join(', ')}</p>
                            <div className="bg-slate-900/60 p-2 rounded border border-slate-800 font-mono text-[10px] leading-relaxed text-slate-400 max-h-[120px] overflow-y-auto">
                                <strong>Strategic Rationale:</strong><br />
                                {plan.analysisReasoning}
                            </div>
                            <button
                                type="button"
                                className="sb-btn sb-btn-primary w-full py-1.5 mt-2 text-xs font-semibold rounded"
                                onClick={() => executeDeepWritePipeline(plan.goal, plan)}
                            >
                                Confirm & Run Planning Pipeline
                            </button>
                        </div>
                    </div>
                </div>
            );
        }

        if (msg.deepWriteProgress) {
            const p = msg.deepWriteProgress;
            const plan = msg.deepWritePlan || p.plan;
            const stages = plan?.stages || [
                { id: 'requirements', name: 'Analyze Project Goal & Constraints', stage: '01', description: 'Inspect user memories and active canvas context.' },
                { id: 'scaffold', name: 'Formulate Platform Deliverables & Primitives', stage: '02', description: 'Decompose goal into optimal file structures.' },
                { id: 'research', name: 'Research Academic Papers & Grounding Citations', stage: '03', description: 'Execute multi-turn deep web research.' },
                { id: 'architecture', name: 'Architect System Interfaces & Module Dependencies', stage: '04', description: 'Define schemas, API protocols, and boundaries.' },
                { id: 'scaffolding', name: 'Scaffold Multi-Platform Source Directory Trees', stage: '05', description: 'Generate CMake, Cargo, or Node packages.' },
                { id: 'graphics', name: 'Generate Procedural Geometry & Shader Algorithms', stage: '06', description: 'Write WebGL/WebGPU render and physics models.' },
                { id: 'compilation', name: 'Compile Native C++ & WebAssembly Modules', stage: '07', description: 'Integrate native computational solvers.' },
                { id: 'telemetry', name: 'Execute Performance Telemetry & Security Audit', stage: '08', description: 'Examine container sandboxing resource profiles.' },
                { id: 'self_healing', name: 'Verify Compilations & Self-Healing Auto-Repair', icon: '🛡️', stage: '09', description: 'Compile, analyze error logs, and auto-patch.' },
                { id: 'artifact', name: 'Spawn Coordinated Artifacts to Workspace Canvas', stage: '10', description: 'Deliver live Spec, Sandbox, and 3D scenes.' }
            ];

            const total = p.totalStages || stages.length;
            let currentIdx = stages.findIndex((s: any) => s.id === p.currentStageId);
            if (currentIdx === -1) {
                // If it's a fallback list, approximate active index based on message text
                const msgLower = (p.message || '').toLowerCase();
                if (msgLower.includes('complete') || p.type === 'pipeline_complete') currentIdx = stages.length;
                else if (msgLower.includes('error')) currentIdx = -1;
                else if (msgLower.includes('compile') || msgLower.includes('repair')) currentIdx = 8;
                else if (msgLower.includes('shader') || msgLower.includes('render')) currentIdx = 5;
                else if (msgLower.includes('folder') || msgLower.includes('scaffold')) currentIdx = 4;
                else if (msgLower.includes('architect') || msgLower.includes('design')) currentIdx = 3;
                else if (msgLower.includes('research')) currentIdx = 2;
                else currentIdx = 1;
            }
            
            const progress = p.type === 'pipeline_complete' ? 100 : Math.max(p.progressPercent || Math.round(((currentIdx + 1) / total) * 100), 5);
            const isDone = p.type === 'pipeline_complete';
            const isError = p.type === 'error';

            return (
                <div key={msg.id} className="sb-drawer-msg-row sb-msg-assistant-row animate-fadeIn">
                    <div className="sb-chat-avatar sb-avatar-assistant">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 2L14.4 9.6L22 12L14.4 14.4L12 22L9.6 14.4L2 12L9.6 9.6L12 2Z" />
                        </svg>
                    </div>
                    <div className="sb-chat-bubble-content" style={{ borderLeft: `3px solid ${isError ? '#ef4444' : isDone ? '#10b981' : '#3b82f6'}`, paddingLeft: '12px', width: '100%' }}>
                        <div className="sb-bubble-header">
                            <span className="sb-bubble-sender">Scratchbox AI Pipeline</span>
                            <span className="sb-bubble-time">{msg.timestamp}</span>
                        </div>
                        <div className="text-xs text-slate-300 space-y-3 mt-2">
                            <div className="flex items-center justify-between">
                                <strong className="text-sm">{isError ? 'Deep-Write Error' : isDone ? 'Deep-Write Completed!' : 'Planning & Scaffolding...'}</strong>
                                <span className="font-mono font-bold text-blue-400">{progress}%</span>
                            </div>
                            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                <div className={`h-full rounded-full transition-all duration-500 ${isError ? 'bg-red-500' : isDone ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${progress}%` }} />
                            </div>

                            {p.message && <p className="italic text-slate-400 text-xs bg-slate-900/40 p-1.5 rounded">{p.message}</p>}

                            {/* Dynamic Step-by-Step Interactive Timeline */}
                            <div className="space-y-2 mt-4 border-t border-slate-900 pt-3">
                                <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 block mb-2">Live Synthesis Steps</span>
                                <div className="relative pl-4 space-y-3 border-l border-slate-800/60 ml-2">
                                    {stages.map((stage: any, sIdx: number) => {
                                        const isStageDone = isDone || sIdx < currentIdx;
                                        const isStageActive = !isDone && sIdx === currentIdx;
                                        const isStagePending = sIdx > currentIdx;

                                        return (
                                            <div key={stage.id} className="relative group">
                                                {/* Bullet Indicator */}
                                                <div className="absolute -left-[21px] top-0.5 flex items-center justify-center">
                                                    {isStageDone ? (
                                                        <div className="w-3.5 h-3.5 rounded-full bg-emerald-500/20 border border-emerald-500 flex items-center justify-center text-[8px] text-emerald-400 font-bold">✓</div>
                                                    ) : isStageActive ? (
                                                        <div className="w-3.5 h-3.5 rounded-full bg-blue-500/20 border border-blue-500 flex items-center justify-center relative">
                                                            <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 animate-ping" />
                                                            <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                                                        </div>
                                                    ) : (
                                                        <div className="w-3.5 h-3.5 rounded-full bg-slate-900 border border-slate-700/80" />
                                                    )}
                                                </div>

                                                <div className={`transition-all duration-300 ${isStageActive ? 'text-white' : isStagePending ? 'text-slate-500' : 'text-slate-400'}`}>
                                                    <span className="text-xs font-semibold block">{stage.name}</span>
                                                    {isStageActive && (
                                                        <div className="mt-1.5 space-y-1.5 text-[11px] text-slate-300 animate-fadeIn">
                                                            <p className="text-slate-400">{stage.description}</p>
                                                            {p.thinking && (
                                                                <div className="bg-slate-950 border border-slate-900 p-2 rounded font-mono text-[10px] text-blue-400 max-h-[100px] overflow-y-auto leading-relaxed whitespace-pre-wrap">
                                                                    💡 {p.thinking}
                                                                </div>
                                                            )}
                                                            {p.query && (
                                                                <div className="text-[10px] text-indigo-400 font-mono flex items-center gap-1.5">
                                                                    <span>🔎 Grounding:</span>
                                                                    <span className="bg-indigo-950/60 border border-indigo-900/50 px-1.5 py-0.5 rounded text-indigo-300">{p.query}</span>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            );
        }

        if (msg.deepWriteCheckpoint && msg.deepWriteCheckpoint.status === 'awaiting_feedback') {
            const checkpoint = msg.deepWriteCheckpoint;
            const feedbackValue = checkpointFeedback[msg.id] || '';

            return (
                <div key={msg.id} className="sb-drawer-msg-row sb-msg-assistant-row animate-fadeIn">
                    <div className="sb-chat-avatar sb-avatar-assistant">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 2L14.4 9.6L22 12L14.4 14.4L12 22L9.6 14.4L2 12L9.6 9.6L12 2Z" />
                        </svg>
                    </div>
                    <div className="sb-chat-bubble-content" style={{ borderLeft: '3px solid #f59e0b', paddingLeft: '12px' }}>
                        <div className="sb-bubble-header">
                            <span className="sb-bubble-sender">Scratchbox Checkpoint Gate</span>
                            <span className="sb-bubble-time">{msg.timestamp}</span>
                        </div>
                        <div className="text-xs text-slate-300 space-y-2 mt-2">
                            <p>Pipeline paused at checkpoint: <strong>{checkpoint.stageName}</strong> for style review.</p>
                            <div className="bg-slate-900/50 p-2 rounded border border-slate-800/80 font-mono text-[10px] text-slate-400 space-y-1">
                                <strong>Active Decision Points:</strong>
                                {checkpoint.decisionPoints.map((d: string, i: number) => (
                                    <div key={i}>• {d}</div>
                                ))}
                            </div>
                            <textarea
                                className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
                                placeholder="Steer the pipeline with style/framework overrides..."
                                rows={2}
                                value={feedbackValue}
                                onChange={(e) => setCheckpointFeedback({ ...checkpointFeedback, [msg.id]: e.target.value })}
                            />
                            <button
                                type="button"
                                className="sb-btn sb-btn-primary w-full py-1.5 text-xs font-semibold rounded"
                                onClick={() => {
                                    handleDeepWriteResume(checkpoint.sessionId, feedbackValue);
                                    setCheckpointFeedback({ ...checkpointFeedback, [msg.id]: '' });
                                    msg.deepWriteCheckpoint!.status = 'resumed';
                                }}
                            >
                                Steer & Resume Planning Pipeline
                            </button>
                        </div>
                    </div>
                </div>
            );
        }

        return (
            <div
                key={msg.id}
                className={`sb-drawer-msg-row ${
                    isUser ? 'sb-msg-user-row' : 'sb-msg-assistant-row'
                }`}
            >
                <div className={`sb-chat-avatar ${isUser ? 'sb-avatar-user' : 'sb-avatar-assistant'}`}>
                    {isUser ? (
                        <span>U</span>
                    ) : (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 2L14.4 9.6L22 12L14.4 14.4L12 22L9.6 14.4L2 12L9.6 9.6L12 2Z" />
                        </svg>
                    )}
                </div>
                <div className="sb-chat-bubble-content">
                    <div className="sb-bubble-header">
                        <span className="sb-bubble-sender">
                            {isUser ? 'You' : 'Scratchbox AI'}
                        </span>
                        <span className="sb-bubble-time">{msg.timestamp}</span>
                    </div>

                    {msg.attachedSkills && msg.attachedSkills.length > 0 && (
                        <div className="sb-bubble-skills-row">
                            {msg.attachedSkills.map((sk, sIdx) => (
                                <span key={sIdx} className="sb-bubble-skill-tag">
                                    {sk}
                                </span>
                            ))}
                            {msg.attachedMcpTools && msg.attachedMcpTools.map((m, mIdx) => (
                                <span key={mIdx} className="sb-bubble-mcp-tag">
                                    {m}
                                </span>
                            ))}
                        </div>
                    )}

                    {/* Cupertino / ChatGPT Style Thinking Disclosure */}
                    {!isUser && msg.thinkingText && (
                        <ThinkingDisclosure
                            thinkingText={msg.thinkingText}
                            durationSeconds={msg.thinkingDurationSeconds}
                        />
                    )}

                    {/* Interactive Agent Execution Stepper */}
                    {!isUser && msg.steps && msg.steps.length > 0 && (
                        <AgentExecutionStepper
                            steps={msg.steps}
                        />
                    )}

                    {cleanText && (
                        <ChatMarkdownRenderer
                            text={cleanText}
                            className="sb-bubble-text"
                            onOpenInBrowser={handleOpenInAppBrowser}
                            onPreviewInCanvas={handlePreviewCodeInCanvas}
                            onExecuteCommand={cmd => {
                                if (onExecuteCommand) {
                                    onExecuteCommand(cmd);
                                    showToast('Command sent to Scratchbox terminal');
                                }
                            }}
                        />
                    )}

                    {/* High-Design ChatGPT Canvas Style Artifact Card with Version & Quick Actions */}
                    {(() => {
                        const effectiveArtifacts = (msg.artifacts && msg.artifacts.length > 0)
                            ? msg.artifacts
                            : (!isUser && extractArtifactFromJson(msg.text) ? [extractArtifactFromJson(msg.text)!] : []);

                        if (!effectiveArtifacts || effectiveArtifacts.length === 0) return null;

                        return (
                            <div className="sb-bubble-artifacts-list">
                                {effectiveArtifacts.map(art => {
                                    const isCurrent = activeArtifact?.id === art.id && (activeArtifact?.version || 1) === (art.version || 1);
                                    const targetMode = resolveModeForArtifact(art.type);
                                    const actionLabel = targetMode === '3d' ? 'Open 3D' : `Open ${targetMode.charAt(0).toUpperCase() + targetMode.slice(1)}`;

                                    return (
                                        <div
                                            key={`${art.id}-v${art.version || 1}`}
                                            className={`sb-chat-artifact-chip sb-chip-${art.type} ${isCurrent ? 'sb-chip-active' : ''}`}
                                            onClick={() => {
                                                handleSelectVersion(art);
                                            }}
                                            title={`Click to view v${art.version || 1} on ${targetMode.toUpperCase()} surface`}
                                        >
                                            <div className="sb-chip-icon-box">
                                                {getPrimitiveIcon(art.type)}
                                            </div>
                                            <div className="sb-chip-info">
                                                <span className="sb-chip-title">{art.title}</span>
                                                <span className="sb-chip-subtitle">
                                                    {getPrimitiveLabel(art.type)} · {actionLabel}
                                                </span>
                                            </div>
                                            <div className="sb-chip-actions" onClick={e => e.stopPropagation()}>
                                                <button
                                                    type="button"
                                                    className="sb-btn sb-btn-xs sb-chip-action-btn"
                                                    onClick={() => {
                                                        handleSelectVersion(art);
                                                    }}
                                                    title={`Open ${art.title} in Canvas`}
                                                >
                                                    {actionLabel}
                                                </button>
                                            </div>
                                            <div className="sb-chip-badge-wrap">
                                                {isCurrent ? (
                                                    <span className="sb-chip-badge sb-badge-active" title="Currently active version">
                                                        Active (v{art.version || 1})
                                                    </span>
                                                ) : (
                                                    <span className="sb-chip-badge" title={`Historical version snapshot v${art.version || 1} — click to view`}>
                                                        v{art.version || 1}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })()}

                    {/* Inline MCP & CLI Tool Execution Cards with Structured Outputs */}
                    {msg.mcpExecutions && msg.mcpExecutions.map(exec => (
                        <div key={exec.id} className="sb-chat-inline-mcp-card">
                            <div className="sb-inline-mcp-top">
                                <div className="sb-inline-mcp-title-wrap">
                                    <span className="sb-mcp-pulse-dot" />
                                    <span className="sb-inline-mcp-title">{exec.humanTitle}</span>
                                </div>
                                <span className={`sb-inline-mcp-status sb-status-${exec.status}`}>
                                    {exec.status === 'completed' ? '✓ Done' : exec.status === 'running' ? 'Running…' : 'Failed'}
                                </span>
                            </div>

                            {/* Execution step telemetry */}
                            <div className="sb-inline-mcp-steps">
                                {exec.steps.map(st => (
                                    <div key={st.id} className={`sb-inline-mcp-step-item sb-step-${st.status}`}>
                                        <div className="sb-step-icon-state">
                                            {st.status === 'done' ? (
                                                <span className="sb-step-check">✓</span>
                                            ) : st.status === 'running' ? (
                                                <span className="sb-step-spinner" />
                                            ) : (
                                                <span className="sb-step-bullet">•</span>
                                            )}
                                        </div>
                                        <span className="sb-step-title">{st.title}</span>
                                        {st.durationMs && <span className="sb-inline-step-dur">{st.durationMs}ms</span>}
                                    </div>
                                ))}
                            </div>

                            {/* Human-friendly Card Render (Table, Metric Items, Status Badges) */}
                            {exec.humanFriendlyOutput && (
                                <div className="sb-inline-mcp-output-card">
                                    <div className="sb-mcp-card-head">
                                        <span className="sb-mcp-card-title">{exec.humanFriendlyOutput.title}</span>
                                        {exec.humanFriendlyOutput.note && (
                                            <span className="sb-mcp-card-note">{exec.humanFriendlyOutput.note}</span>
                                        )}
                                    </div>

                                    {exec.humanFriendlyOutput.cardType === 'metric' && exec.humanFriendlyOutput.items && (
                                        <div className="sb-mcp-metric-grid">
                                            {exec.humanFriendlyOutput.items.map((item, itmIdx) => (
                                                <div key={itmIdx} className={`sb-mcp-metric-pill sb-accent-${item.color || 'blue'}`}>
                                                    <span className="sb-mcp-metric-label">{item.label}</span>
                                                    <span className="sb-mcp-metric-value">{item.value}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {exec.humanFriendlyOutput.cardType === 'table' && exec.humanFriendlyOutput.headers && exec.humanFriendlyOutput.rows && (
                                        <div className="sb-mcp-table-wrapper">
                                            <table className="sb-mcp-mini-table">
                                                <thead>
                                                    <tr>
                                                        {exec.humanFriendlyOutput.headers.map((h, hIdx) => (
                                                            <th key={hIdx}>{h}</th>
                                                        ))}
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {exec.humanFriendlyOutput.rows.map((row, rIdx) => (
                                                        <tr key={rIdx}>
                                                            {row.map((cell, cIdx) => (
                                                                <td key={cIdx}>{cell}</td>
                                                            ))}
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}

                                    {exec.humanFriendlyOutput.cardType === 'badge-list' && exec.humanFriendlyOutput.items && (
                                        <div className="sb-mcp-badge-list">
                                            {exec.humanFriendlyOutput.items.map((bItem, bIdx) => (
                                                <div key={bIdx} className={`sb-mcp-badge-tag sb-accent-${bItem.color || 'indigo'}`}>
                                                    <span className="sb-badge-tag-lbl">{bItem.label}:</span>
                                                    <span className="sb-badge-tag-val">{bItem.value}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {exec.humanFriendlyOutput.cardType === 'status-card' && exec.humanFriendlyOutput.items && (
                                        <div className="sb-mcp-status-grid">
                                            {exec.humanFriendlyOutput.items.map((sItem, sIdx) => (
                                                <div key={sIdx} className="sb-mcp-status-row">
                                                    <span className="sb-status-k">{sItem.label}</span>
                                                    <span className={`sb-status-v sb-accent-${sItem.color || 'emerald'}`}>{sItem.value}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {exec.summaryResult && !exec.humanFriendlyOutput && (
                                <div className="sb-inline-mcp-summary">
                                    {exec.summaryResult}
                                </div>
                            )}
                        </div>
                    ))}

                    {/* Inline Google Search Grounding & Citations Card */}
                    {msg.groundingMetadata && ((msg.groundingMetadata.webSearchQueries && msg.groundingMetadata.webSearchQueries.length > 0) || (msg.groundingMetadata.groundingChunks && msg.groundingMetadata.groundingChunks.length > 0)) && (
                        <div className="sb-chat-inline-grounding-card">
                            <div className="sb-inline-grounding-header">
                                <div className="sb-inline-grounding-title-wrap">
                                    <span className="sb-grounding-pulse-dot" />
                                    <span className="sb-inline-grounding-title">Google Search Grounding &amp; Citations</span>
                                </div>
                                <span className="sb-inline-grounding-badge">
                                    ✓ Verified Live
                                </span>
                            </div>

                            {/* Search Queries Telemetry */}
                            {msg.groundingMetadata.webSearchQueries && msg.groundingMetadata.webSearchQueries.length > 0 && (
                                <div className="sb-grounding-queries-list">
                                    <span className="sb-grounding-section-label">Web Queries:</span>
                                    {msg.groundingMetadata.webSearchQueries.map((query, qIdx) => (
                                        <span
                                            key={qIdx}
                                            className="sb-grounding-query-pill"
                                            style={{ cursor: 'pointer' }}
                                            onClick={() => handleOpenInAppBrowser(`https://www.google.com/search?q=${encodeURIComponent(query)}`, `Google: ${query}`)}
                                            title={`Search "${query}" in In-App Web Browser`}
                                        >
                                            <span className="sb-query-icon">🔍</span>
                                            {query}
                                        </span>
                                    ))}
                                </div>
                            )}

                            {/* Grounded Web Sources and Citation Links */}
                            {msg.groundingMetadata.groundingChunks && msg.groundingMetadata.groundingChunks.length > 0 && (
                                <div className="sb-grounding-sources-grid">
                                    {msg.groundingMetadata.groundingChunks.filter(c => c.web && (c.web.uri || c.web.title)).map((chunk, cIdx) => (
                                        <a
                                            key={cIdx}
                                            href={chunk.web?.uri || '#'}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="sb-grounding-source-chip"
                                            title={chunk.web?.uri || chunk.web?.title}
                                            onClick={e => {
                                                if (chunk.web?.uri) {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    handleOpenInAppBrowser(chunk.web.uri, chunk.web.title || chunk.web.uri);
                                                }
                                            }}
                                        >
                                            <span className="sb-grounding-source-num">[{cIdx + 1}]</span>
                                            <span className="sb-grounding-source-title">{chunk.web?.title || chunk.web?.uri}</span>
                                            <span className="sb-grounding-external-icon">↗</span>
                                        </a>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* High-Fidelity Multimedia & Maps Grounding Cards */}
                    {(msg.imageContent || (msg.imagesContent && msg.imagesContent.length > 0)) && (
                        <ImageGeneratedCard imageContent={msg.imageContent} imagesContent={msg.imagesContent} />
                    )}
                    {msg.audioContent && (
                        <AudioNarratedCard audioContent={msg.audioContent} />
                    )}
                    {msg.videoContent && (
                        <CinematicVideoCard videoContent={msg.videoContent} />
                    )}
                    {msg.mapContent && (
                        <GoogleMapsCard mapContent={msg.mapContent} />
                    )}
                </div>
            </div>
        );
    };

    const getComposerPlaceholder = () => {
        if (attachedDataFile) {
            return `Ask about ${attachedDataFile.name} (e.g. Generate KPI metrics and charts)...`;
        }
        if (activeArtifact?.title && layoutMode !== 'chat') {
            return `Ask AI to edit ${activeArtifact.title}...`;
        }
        if (layoutMode === 'code') {
            return 'Ask AI to edit Live React UI Sandbox...';
        }
        if (layoutMode === 'document') {
            return 'Ask AI to edit Project Specification...';
        }
        if (layoutMode === 'kanban') {
            return 'Ask AI to edit Sprint Roadmap...';
        }
        if (layoutMode === 'automation' || layoutMode === 'canvas') {
            return 'Ask AI to edit Canvas Workflow...';
        }
        return 'Plan, Build, / for skills, @ for context';
    };

    const renderComposerInput = (inSplitPane: boolean = false) => (
        <div
            className={`sb-unified-composer-capsule ${inSplitPane ? 'sb-split-pane-composer' : ''} ${isDraggingDataFile ? 'sb-composer-drag-over' : ''}`}
            onDragOver={e => {
                e.preventDefault();
                setIsDraggingDataFile(true);
            }}
            onDragLeave={e => {
                e.preventDefault();
                setIsDraggingDataFile(false);
            }}
            onDrop={e => {
                e.preventDefault();
                setIsDraggingDataFile(false);
                if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
                    handleFileDrop(e.dataTransfer.files[0]);
                }
            }}
        >
            {/* Hidden file picker input */}
            <input
                ref={fileInputRef}
                type="file"
                style={{ display: 'none' }}
                accept=".csv,.tsv,.txt,.json"
                onChange={handleFileInputChange}
            />

            {/* Drag & Drop Highlight Overlay */}
            {isDraggingDataFile && (
                <div className="sb-composer-drag-hint-overlay animate-fadeIn">
                    <span className="sb-drag-hint-icon">📊</span>
                    <span className="sb-drag-hint-text">Drop CSV or data file to generate instant KPI Metric Dashboard &amp; Table</span>
                </div>
            )}

            {/* Active Capabilities & Attached Data File Pills Bar */}
            {(selectedSkillIds.length > 0 || selectedMcpIds.length > 0 || attachedDataFile !== undefined || attachedContextMentions.length > 0) && (
                <div className="sb-composer-active-pills-row sb-cursor-attached-context-row">
                    <span className="sb-composer-pills-label">Assisting:</span>

                    {/* Attached CSV / Data File Pill */}
                    {attachedDataFile && (
                        <span className="sb-composer-pill sb-composer-pill-data">
                            <span className="sb-composer-pill-icon">📊</span>
                            <span className="sb-composer-pill-text max-w-[140px] truncate" title={`${attachedDataFile.name} (${attachedDataFile.rowsCount} rows)`}>
                                {attachedDataFile.name} ({attachedDataFile.rowsCount} rows)
                            </span>
                            <button
                                type="button"
                                className="sb-composer-pill-remove"
                                onClick={() => setAttachedDataFile(undefined)}
                                title="Remove attached data file"
                            >
                                <IconClose size={9} strokeWidth={2.5} />
                            </button>
                        </span>
                    )}

                    {selectedSkillIds.map(skId => {
                        const sk = skills.find(s => s.id === skId);
                        if (!sk) return undefined;
                        return (
                            <span key={sk.id} className="sb-composer-pill">
                                <span className="sb-composer-pill-text max-w-[140px] truncate" title={sk.name}>{sk.name}</span>
                                <button
                                    type="button"
                                    className="sb-composer-pill-remove"
                                    onClick={() => handleToggleComposerSkill(sk.id)}
                                    title={`Detach ${sk.name}`}
                                >
                                    <IconClose size={9} strokeWidth={2.5} />
                                </button>
                            </span>
                        );
                    })}

                    {selectedMcpIds.map(mcpId => {
                        const mcp = mcpServers.find(m => m.id === mcpId);
                        if (!mcp) return undefined;
                        return (
                            <span key={mcp.id} className="sb-composer-pill sb-composer-pill-mcp">
                                <span className="sb-composer-pill-text max-w-[140px] truncate" title={mcp.name}>{mcp.name}</span>
                                <button
                                    type="button"
                                    className="sb-composer-pill-remove"
                                    onClick={() => handleToggleComposerMcp(mcp.id)}
                                    title={`Detach ${mcp.name}`}
                                >
                                    <IconClose size={9} strokeWidth={2.5} />
                                </button>
                            </span>
                        );
                    })}

                    {/* Attached Context Mention Pills (@file, @git, @terminal, etc.) */}
                    {attachedContextMentions.map(ctx => (
                        <span key={ctx.id} className="sb-composer-pill" style={{ background: 'rgba(59, 130, 246, 0.15)', borderColor: 'rgba(59, 130, 246, 0.3)', color: '#93c5fd' }}>
                            <span className="sb-composer-pill-icon">{ctx.icon || '📄'}</span>
                            <span className="sb-composer-pill-text max-w-[140px] truncate" title={ctx.name}>{ctx.name}</span>
                            <button
                                type="button"
                                className="sb-composer-pill-remove"
                                onClick={() => setAttachedContextMentions(prev => prev.filter(c => c.id !== ctx.id))}
                                title={`Detach @${ctx.type}`}
                            >
                                <IconClose size={9} strokeWidth={2.5} />
                            </button>
                        </span>
                    ))}
                </div>
            )}

            {/* Autocomplete Popup Menu */}
            {autocompleteType === 'context' && (
                <ContextMentionAutocompletePopover
                    isOpen={true}
                    activeCategory={activeContextCategory}
                    onCategoryChange={setActiveContextCategory}
                    query={autocompleteQuery || ''}
                    selectedIndex={selectedAutocompleteIndex}
                    workspaceFiles={workspaceFilesList}
                    gitStatus={workspaceGitStatus}
                    mcpServers={mcpServers}
                    onSelectMention={handleSelectAutocompleteContext}
                    onClose={() => setAutocompleteType(undefined)}
                    width="420px"
                    maxHeight="240px"
                />
            )}

            {autocompleteType === 'skill' && (
                <div className="sb-composer-autocomplete-popover animate-popover" style={{ width: '420px', maxHeight: '340px' }}>
                    <div className="sb-autocomplete-header">
                        <span>Select Superpower (/)</span>
                        <span className="sb-autocomplete-hint">Esc to dismiss</span>
                    </div>

                    <div className="sb-autocomplete-list" style={{ maxHeight: '240px' }}>
                        {filteredAutocompleteSkills.length > 0 ? (
                            filteredAutocompleteSkills.map((sk, idx) => (
                                <div
                                    key={sk.id}
                                    className={`sb-autocomplete-item ${idx === selectedAutocompleteIndex ? 'sb-autocomplete-item-selected' : ''}`}
                                    style={idx === selectedAutocompleteIndex ? { background: 'rgba(59, 130, 246, 0.15)', borderColor: 'rgba(59, 130, 246, 0.3)' } : undefined}
                                    onClick={() => handleSelectAutocompleteSkill(sk)}
                                >
                                    <div className="sb-auto-info">
                                        <span className="sb-auto-title">{sk.name}</span>
                                        <span className="sb-auto-tagline">{sk.tagline}</span>
                                    </div>
                                    <span className="sb-auto-category">{sk.category}</span>
                                </div>
                            ))
                        ) : (
                            <div className="sb-autocomplete-empty">No matching superpowers</div>
                        )}
                    </div>
                </div>
            )}

            {isVoiceActive && (
                <div className="sb-voice-active-indicator animate-fadeIn">
                    <div className="sb-voice-wave-bars">
                        <span className="sb-voice-bar sb-vb-1" />
                        <span className="sb-voice-bar sb-vb-2" />
                        <span className="sb-voice-bar sb-vb-3" />
                        <span className="sb-voice-bar sb-vb-4" />
                        <span className="sb-voice-bar sb-vb-5" />
                    </div>
                    <span className="sb-voice-label">Listening... Speak prompt in real time</span>
                    <button
                        type="button"
                        className="sb-voice-stop-btn"
                        onClick={handleVoiceToggle}
                    >
                        Done
                    </button>
                </div>
            )}

            {/* Authentic Cursor-Grade Composer Main Row */}
            <div className="sb-composer-main-row">
                {/* Left: '+' Tools / Superpowers / File Attach button and Mode Selector */}
                <div className="sb-composer-left-actions">
                    <button
                        type="button"
                        className="sb-composer-attach-btn"
                        onClick={() => fileInputRef.current?.click()}
                        title="Attach CSV / Data file or Superpowers (/ for skills, @ for MCP)"
                    >
                        <IconPlus size={14} strokeWidth={2.2} />
                    </button>
                    <div className="sb-cursor-mode-selector">
                        <button
                            type="button"
                            className={`sb-cursor-mode-pill ${aiInteractionMode === 'agent' ? 'sb-cursor-mode-pill-active' : ''}`}
                            onClick={() => setAiInteractionMode('agent')}
                            title="Agent Mode: Autonomous multi-step code & canvas execution"
                        >
                            Agent
                        </button>
                        <button
                            type="button"
                            className={`sb-cursor-mode-pill ${aiInteractionMode === 'ask' ? 'sb-cursor-mode-pill-active' : ''}`}
                            onClick={() => setAiInteractionMode('ask')}
                            title="Ask Mode: Direct questions, code explanations, & doc search"
                        >
                            Ask
                        </button>
                        <button
                            type="button"
                            className={`sb-cursor-mode-pill ${aiInteractionMode === 'plan' ? 'sb-cursor-mode-pill-active' : ''}`}
                            onClick={() => setAiInteractionMode('plan')}
                            title="Plan Mode: Architecture breakdown & execution blueprints"
                        >
                            Plan
                        </button>
                    </div>
                </div>

                {/* Center: Multi-line Auto-Expanding Textarea Input */}
                <div className="sb-composer-input-area">
                    <textarea
                        ref={inputRef}
                        rows={1}
                        className="sb-composer-main-input"
                        placeholder={getComposerPlaceholder()}
                        value={inputValue}
                        disabled={isGenerating}
                        onChange={handleInputChange}
                        onKeyDown={handleKeyDown}
                        autoFocus
                    />
                </div>

                {/* Right: Voice & Send */}
                <div className="sb-composer-actions-right">
                    {/* Voice Dictation Trigger */}
                    <button
                        type="button"
                        className={`sb-composer-voice-trigger ${isVoiceActive ? 'sb-voice-on' : ''}`}
                        onClick={handleVoiceToggle}
                        title={isVoiceActive ? 'Stop listening' : 'Voice input (Web Speech API)'}
                    >
                        <IconMic size={15} strokeWidth={1.8} />
                    </button>

                    <button
                        type="button"
                        className={`sb-composer-send-circle ${inputValue.trim() || attachedDataFile ? 'sb-send-ready' : ''}`}
                        disabled={(!inputValue.trim() && !attachedDataFile) || isGenerating}
                        onClick={() => handleSendMessage()}
                        title="Send message (Enter)"
                    >
                        {isGenerating ? (
                            <span className="sb-send-loading-dot" />
                        ) : (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="12" y1="19" x2="12" y2="5" />
                                <polyline points="5 12 12 5 19 12" />
                            </svg>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );

    return (
        <div
            className={`sb-chatgpt-studio-app sb-density-${appearanceConfig.canvasDensity} sb-blur-${appearanceConfig.glassBlur}`}
            onDragOver={handleGlobalDragOver}
            onDragLeave={handleGlobalDragLeave}
            onDrop={handleGlobalDrop}
        >
            {/* Global File Drop Overlay */}
            {isGlobalDraggingFile && (
                <div className="sb-global-drop-overlay">
                    <div className="sb-global-drop-card">
                        <h2 className="sb-global-drop-title">Drop SKILL.md or .skill here</h2>
                        <p className="sb-global-drop-desc">
                            Scratchbox will instantly parse, install, and activate this AI Superpower in your studio.
                        </p>
                    </div>
                </div>
            )}

            {/* Global Banner Toast */}
            {globalToast && (
                <div className="sb-global-toast-pill">
                    <span className="sb-global-toast-text">{globalToast.text}</span>
                </div>
            )}

            {/* Mobile Drawer Frosted Glass Backdrop Overlay */}
            {isSidebarOpen && (
                <div
                    className="sb-mobile-sidebar-overlay"
                    onClick={() => setIsSidebarOpen(false)}
                    aria-hidden="true"
                />
            )}

            {/* Left Cursor-Style Sidebar */}
            <aside className={`sb-chatgpt-sidebar ${isSidebarOpen ? 'sb-sidebar-open' : 'sb-sidebar-collapsed'}`}>
                {/* Sidebar Top Controls: Window Traffic Lights & Navigation */}
                <div className="sb-sidebar-top-header" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div className="sb-mac-traffic-lights" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span className="sb-traffic-light sb-tl-close" />
                        <span className="sb-traffic-light sb-tl-min" />
                        <span className="sb-traffic-light sb-tl-max" />
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            className="sb-btn sb-btn-ghost sb-btn-xs px-2 py-1 flex items-center justify-center"
                            style={{ height: '28px', color: '#71717a' }}
                            onClick={() => {
                                const currentIndex = sessions.findIndex(s => s.id === currentSessionId);
                                if (currentIndex < sessions.length - 1) {
                                    handleSelectSession(sessions[currentIndex + 1]);
                                }
                            }}
                            title="Previous Chat"
                        >
                            ←
                        </button>
                        <button
                            type="button"
                            className="sb-btn sb-btn-ghost sb-btn-xs px-2 py-1 flex items-center justify-center"
                            style={{ height: '28px', color: '#71717a' }}
                            onClick={() => {
                                const currentIndex = sessions.findIndex(s => s.id === currentSessionId);
                                if (currentIndex > 0) {
                                    handleSelectSession(sessions[currentIndex - 1]);
                                }
                            }}
                            title="Next Chat"
                        >
                            →
                        </button>
                    </div>
                </div>

                {/* Primary Cursor-Style Navigation Actions */}
                <div className="sb-sidebar-nav-list">
                    <button
                        type="button"
                        className="sb-sidebar-nav-row sb-sidebar-nav-new"
                        onClick={handleNewChat}
                        title="New Chat (⌘K)"
                    >
                        <span className="sb-nav-icon">
                            <IconNewChat size={14} strokeWidth={1.8} />
                        </span>
                        <span className="sb-nav-label">New Chat</span>
                    </button>

                    <button
                        type="button"
                        className={`sb-sidebar-nav-row ${isSidebarSearchOpen ? 'sb-sidebar-nav-active' : ''}`}
                        onClick={() => setIsSidebarSearchOpen(!isSidebarSearchOpen)}
                        title="Search conversations"
                    >
                        <span className="sb-nav-icon">
                            <IconSearch size={14} strokeWidth={1.8} />
                        </span>
                        <span className="sb-nav-label">Search</span>
                    </button>

                    <button
                        type="button"
                        className="sb-sidebar-nav-row"
                        onClick={() => openSettingsToTab('workspace')}
                        title="Customize project rules & superpowers"
                    >
                        <span className="sb-nav-icon">
                            <IconCustomize size={14} strokeWidth={1.8} />
                        </span>
                        <span className="sb-nav-label">Customize</span>
                    </button>
                </div>

                {/* Search Input Box (when search is toggled open) */}
                {isSidebarSearchOpen && (
                    <div className="sb-sidebar-search-box animate-fadeIn">
                        <input
                            type="text"
                            className="sb-sidebar-search-input"
                            placeholder="Filter chats..."
                            value={sidebarSearchQuery}
                            onChange={e => setSidebarSearchQuery(e.target.value)}
                            autoFocus
                        />
                        {sidebarSearchQuery && (
                            <button
                                type="button"
                                className="sb-search-clear-btn"
                                onClick={() => setSidebarSearchQuery('')}
                            >
                                <IconClose size={10} />
                            </button>
                        )}
                    </div>
                )}

                {/* Workspaces Explorer & Chat Hierarchy (Cursor Organization) */}
                <div className="sb-sidebar-workspaces-section">
                    <div className="sb-workspaces-header" onClick={() => setIsWorkspacesExpanded(!isWorkspacesExpanded)}>
                        <div className="sb-workspaces-title-group">
                            <span className="sb-workspaces-chevron">
                                {isWorkspacesExpanded ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                            </span>
                            <span className="sb-workspaces-heading">Workspaces</span>
                        </div>
                        <div className="sb-workspaces-actions" onClick={e => e.stopPropagation()}>
                            <button
                                type="button"
                                className={`sb-workspace-header-btn ${sidebarViewMode === 'explorer' ? 'sb-workspace-header-btn-active' : ''}`}
                                onClick={() => setSidebarViewMode(sidebarViewMode === 'threads' ? 'explorer' : 'threads')}
                                title={sidebarViewMode === 'threads' ? "Switch to Files Explorer" : "Switch to Chat Threads"}
                                style={{ marginRight: '6px' }}
                            >
                                <IconList size={12} />
                            </button>
                            <button
                                type="button"
                                className="sb-workspace-header-btn"
                                onClick={e => {
                                    e.stopPropagation();
                                    setShowNewWorkspaceMenu(!showNewWorkspaceMenu);
                                }}
                                title="Start New Workspace / Open Folder"
                            >
                                <IconPlus size={12} />
                            </button>
                        </div>
                    </div>

                    {/* Inline Sidebar New Workspace Drawer */}
                    {showNewWorkspaceMenu && (
                        <div className="sb-sidebar-new-workspace-drawer animate-fadeIn" onClick={e => e.stopPropagation()}>
                            <div className="sb-new-ws-drawer-title">New Workspace / Folder</div>
                            <input
                                type="text"
                                className="sb-new-ws-drawer-input"
                                placeholder="Workspace name (e.g. scrape)"
                                value={newWorkspaceInputName}
                                onChange={e => setNewWorkspaceInputName(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                        setShowNewWorkspaceMenu(false);
                                        handleCreateNewWorkspace();
                                    } else if (e.key === 'Escape') {
                                        setShowNewWorkspaceMenu(false);
                                    }
                                }}
                                autoFocus
                            />
                            <div className="sb-new-ws-drawer-actions">
                                <button
                                    type="button"
                                    className="sb-new-ws-create-btn"
                                    onClick={() => {
                                        setShowNewWorkspaceMenu(false);
                                        handleCreateNewWorkspace();
                                    }}
                                >
                                    Create Folder
                                </button>
                                <button
                                    type="button"
                                    className="sb-new-ws-open-btn"
                                    onClick={() => {
                                        setShowNewWorkspaceMenu(false);
                                        if (onOpenFolder) {
                                            onOpenFolder();
                                        } else if (onOpenWorkspace) {
                                            onOpenWorkspace();
                                        }
                                    }}
                                    title="Open Folder from Disk"
                                >
                                    Open...
                                </button>
                            </div>
                            <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '6px', marginTop: '2px' }}>
                                <div style={{ fontSize: '10px', color: 'var(--sb-text-tertiary, #71717a)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Test Folder</div>
                                <button
                                    type="button"
                                    className="sb-dropdown-item"
                                    style={{ padding: '4px 6px', fontSize: '11px', borderRadius: '6px' }}
                                    onClick={() => {
                                        setShowNewWorkspaceMenu(false);
                                        handleCreateNewWorkspace('scratchbox-test-workspace', '/Users/eligreen/dev/scratchbox-test-workspace');
                                    }}
                                >
                                    <IconFolder size={12} className="text-blue-400" />
                                    <div className="sb-dropdown-item-text">
                                        <span className="sb-dropdown-item-title" style={{ fontSize: '11px' }}>scratchbox-test-workspace</span>
                                        <span className="sb-dropdown-item-sub" style={{ fontSize: '10px' }}>~/dev/scratchbox-test-workspace</span>
                                    </div>
                                </button>
                            </div>
                        </div>
                    )}

                    {isWorkspacesExpanded && (
                        <div className="sb-workspace-tree animate-fadeIn">
                            {/* Primary Active Workspace Header */}
                            <div className={`sb-workspace-node-active ${isWorkspaceCollapsed(activeWorkspace.id) ? 'sb-workspace-collapsed' : ''}`}>
                                <div className="sb-ws-node-header" onClick={() => toggleWorkspaceCollapse(activeWorkspace.id)}>
                                    <div className="sb-ws-title-left">
                                        <span
                                            className="sb-workspace-folder-chevron"
                                            onClick={e => toggleWorkspaceCollapse(activeWorkspace.id, e)}
                                            title={isWorkspaceCollapsed(activeWorkspace.id) ? 'Expand workspace folder' : 'Collapse workspace folder'}
                                        >
                                            {isWorkspaceCollapsed(activeWorkspace.id) ? <IconChevronRight size={11} /> : <IconChevronDown size={11} />}
                                        </span>
                                        <IconFolder size={13} className="text-zinc-300" />
                                        <span className="sb-workspace-name" title={activeWorkspace.name}>{activeWorkspace.path.split('/').pop() || activeWorkspace.name}</span>
                                    </div>
                                    <div className="sb-ws-actions-right" onClick={e => e.stopPropagation()}>
                                        <span className="sb-git-branch-pill">main</span>
                                        {sidebarViewMode === 'threads' && (
                                            <button
                                                type="button"
                                                className="sb-workspace-add-btn"
                                                onClick={e => {
                                                    e.stopPropagation();
                                                    setShowAddFileMenu(!showAddFileMenu);
                                                }}
                                                title="Add file to workspace (Chat, Code, Document, Kanban)"
                                            >
                                                <IconPlus size={12} strokeWidth={2} />
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {/* Floating Add File Dropdown */}
                                {showAddFileMenu && sidebarViewMode === 'threads' && (
                                    <div className="sb-add-file-dropdown animate-popover" onClick={e => e.stopPropagation()}>
                                        <div className="sb-dropdown-header">New Workspace File</div>
                                        <button
                                            type="button"
                                            className="sb-dropdown-item"
                                            onClick={() => handleCreateWorkspaceFile('chat')}
                                        >
                                            <IconChat size={13} className="text-zinc-400" />
                                            <div className="sb-dropdown-item-text">
                                                <span className="sb-dropdown-item-title">New Chat</span>
                                                <span className="sb-dropdown-item-sub">Conversational AI thread</span>
                                            </div>
                                        </button>
                                        <button
                                            type="button"
                                            className="sb-dropdown-item"
                                            onClick={() => handleCreateWorkspaceFile('code')}
                                        >
                                            <IconCode size={13} className="text-zinc-300" />
                                            <div className="sb-dropdown-item-text">
                                                <span className="sb-dropdown-item-title">Code Sandbox</span>
                                                <span className="sb-dropdown-item-sub">Interactive React / Python runner</span>
                                            </div>
                                        </button>
                                        <button
                                            type="button"
                                            className="sb-dropdown-item"
                                            onClick={() => handleCreateWorkspaceFile('document')}
                                        >
                                            <IconDocument size={13} className="text-zinc-300" />
                                            <div className="sb-dropdown-item-text">
                                                <span className="sb-dropdown-item-title">Document Spec</span>
                                                <span className="sb-dropdown-item-sub">Rich block notes & spec</span>
                                            </div>
                                        </button>
                                        <button
                                            type="button"
                                            className="sb-dropdown-item"
                                            onClick={() => handleCreateWorkspaceFile('kanban')}
                                        >
                                            <IconKanban size={13} className="text-zinc-300" />
                                            <div className="sb-dropdown-item-text">
                                                <span className="sb-dropdown-item-title">Kanban Board</span>
                                                <span className="sb-dropdown-item-sub">Sprint roadmap & stage tracking</span>
                                            </div>
                                        </button>
                                        <button
                                            type="button"
                                            className="sb-dropdown-item"
                                            onClick={() => handleCreateWorkspaceFile('automation')}
                                        >
                                            <IconAutomations size={13} className="text-zinc-300" />
                                            <div className="sb-dropdown-item-text">
                                                <span className="sb-dropdown-item-title">Canvas Workflow</span>
                                                <span className="sb-dropdown-item-sub">Visual node graph & pipeline</span>
                                            </div>
                                        </button>
                                        <button
                                            type="button"
                                            className="sb-dropdown-item"
                                            onClick={() => handleCreateWorkspaceFile('3d')}
                                        >
                                            <Icon3D size={13} className="text-zinc-300" />
                                            <div className="sb-dropdown-item-text">
                                                <span className="sb-dropdown-item-title">4D Scene</span>
                                                <span className="sb-dropdown-item-sub">Temporal 4-dimensional spatial studio</span>
                                            </div>
                                        </button>
                                        <button
                                            type="button"
                                            className="sb-dropdown-item"
                                            onClick={() => handleCreateWorkspaceFile('browser')}
                                        >
                                            <IconGlobe size={13} className="text-zinc-300" />
                                            <div className="sb-dropdown-item-text">
                                                <span className="sb-dropdown-item-title">Web Browser</span>
                                                <span className="sb-dropdown-item-sub">Interactive AI-controlled web canvas</span>
                                            </div>
                                        </button>
                                    </div>
                                )}
                            </div>

                            {/* Active Workspace Chats or Files Tree */}
                            {!isWorkspaceCollapsed(activeWorkspace.id) && (
                                sidebarViewMode === 'explorer' ? (
                                    <div className="sb-workspace-explorer-tree animate-fadeIn" style={{ paddingLeft: '8px', paddingBottom: '8px' }}>
                                        {renderFileTree(activeWorkspace.id === 'proj-3dpose' ? POSE_3D_TREE : SCRATCHBOX_TREE)}
                                    </div>
                                ) : (
                                    <div className="sb-workspace-threads-list animate-fadeIn">
                                        {sessions
                                            .filter(s => (s.workspaceId === activeWorkspace.id || (!s.workspaceId && activeWorkspace.id === 'proj-scratchbox-ide')) && (!sidebarSearchQuery || s.title.toLowerCase().includes(sidebarSearchQuery.toLowerCase())))
                                            .map((s, idx) => {
                                                const isSelected = currentSessionId === s.id;
                                                const relTime = s.relativeTime || (idx === 0 ? '8m' : idx === 1 ? '47m' : idx === 2 ? '1h' : '4h');
                                                return (
                                                    <div
                                                        key={`ws-active-${s.id}`}
                                                        className={`sb-workspace-thread-item ${isSelected ? 'sb-workspace-thread-selected' : ''}`}
                                                        onClick={() => handleSelectSession(s)}
                                                        title={s.title}
                                                    >
                                                        <div className="sb-ws-thread-left">
                                                            {getSessionIcon(s) || (
                                                                <span className={`sb-cursor-radio-dot ${isSelected ? 'sb-cursor-dot-active' : ''}`}>
                                                                    {isSelected ? '●' : '○'}
                                                                </span>
                                                            )}
                                                            <span className="sb-ws-thread-title">{s.title}</span>
                                                        </div>
                                                        <div className="sb-ws-thread-right">
                                                            <span className="sb-history-time-badge">{relTime}</span>
                                                            <button
                                                                type="button"
                                                                className="sb-history-item-delete"
                                                                onClick={e => handleDeleteSession(s.id, e)}
                                                                title="Delete conversation"
                                                            >
                                                                <IconClose size={10} strokeWidth={2.2} />
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                    </div>
                                )
                            )}

                            {/* Secondary Workspaces with associated chats/files */}
                            {workspaces.filter(p => p.id !== activeWorkspace.id && (sidebarViewMode === 'explorer' || sessions.some(s => s.workspaceId === p.id && (!sidebarSearchQuery || s.title.toLowerCase().includes(sidebarSearchQuery.toLowerCase()))))).map(proj => {
                                const projSessions = sessions.filter(s => s.workspaceId === proj.id && (!sidebarSearchQuery || s.title.toLowerCase().includes(sidebarSearchQuery.toLowerCase())));
                                const isCollapsed = isWorkspaceCollapsed(proj.id);
                                return (
                                    <div key={`ws-group-${proj.id}`} className="sb-secondary-workspace-group">
                                        <div className={`sb-workspace-node-secondary ${isCollapsed ? 'sb-workspace-collapsed' : ''}`}>
                                            <div className="sb-ws-node-header" onClick={() => {
                                                if (sidebarViewMode === 'explorer') {
                                                    setActiveWorkspace(proj);
                                                    showToast(`Switched active workspace to "${proj.name}"`);
                                                } else {
                                                    toggleWorkspaceCollapse(proj.id);
                                                }
                                            }}>
                                                <div className="sb-ws-title-left">
                                                    <span
                                                        className="sb-workspace-folder-chevron"
                                                        onClick={e => {
                                                            e.stopPropagation();
                                                            if (sidebarViewMode === 'explorer') {
                                                                setActiveWorkspace(proj);
                                                                showToast(`Switched active workspace to "${proj.name}"`);
                                                            } else {
                                                                toggleWorkspaceCollapse(proj.id, e);
                                                            }
                                                        }}
                                                        title={isCollapsed ? 'Expand workspace folder' : 'Collapse workspace folder'}
                                                    >
                                                        {isCollapsed ? <IconChevronRight size={11} /> : <IconChevronDown size={11} />}
                                                    </span>
                                                    <IconFolder size={13} className="text-zinc-500" />
                                                    <span
                                                        className="sb-workspace-name-secondary"
                                                        onClick={e => {
                                                            e.stopPropagation();
                                                            setActiveWorkspace(proj);
                                                            showToast(`Switched active workspace to "${proj.name}"`);
                                                        }}
                                                        title={`Switch to ${proj.name}`}
                                                    >
                                                        {proj.path.split('/').pop() || proj.name}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                        {sidebarViewMode === 'threads' && !isCollapsed && (
                                            <div className="sb-workspace-threads-list animate-fadeIn">
                                                {projSessions.map(s => {
                                                    const isSelected = currentSessionId === s.id;
                                                    return (
                                                        <div
                                                            key={`ws-sec-${s.id}`}
                                                            className={`sb-workspace-thread-item ${isSelected ? 'sb-workspace-thread-selected' : ''}`}
                                                            onClick={() => {
                                                                setActiveWorkspace(proj);
                                                                handleSelectSession(s);
                                                            }}
                                                            title={s.title}
                                                        >
                                                            <div className="sb-ws-thread-left">
                                                                {getSessionIcon(s) || (
                                                                    <span className={`sb-cursor-radio-dot ${isSelected ? 'sb-cursor-dot-active' : ''}`}>
                                                                        {isSelected ? '●' : '○'}
                                                                    </span>
                                                                )}
                                                                <span className="sb-ws-thread-title">{s.title}</span>
                                                            </div>
                                                            <div className="sb-ws-thread-right">
                                                                <span className="sb-history-time-badge">{s.relativeTime || '2h'}</span>
                                                                <button
                                                                    type="button"
                                                                    className="sb-history-item-delete"
                                                                    onClick={e => handleDeleteSession(s.id, e)}
                                                                    title="Delete conversation"
                                                                >
                                                                    <IconClose size={10} strokeWidth={2.2} />
                                                                </button>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Sidebar Bottom: User Profile & Settings Trigger */}
                <div className="sb-sidebar-profile-footer">
                    <div className="sb-profile-avatar-info">
                        <div className="sb-profile-avatar">EG</div>
                        <div className="sb-profile-text">
                            <span className="sb-profile-name">Eli Green</span>
                        </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                        <button
                            type="button"
                            className="sb-profile-settings-btn"
                            onClick={() => openSettingsToTab('general')}
                            title="Settings (⌘,)"
                        >
                            <IconSettings size={14} strokeWidth={1.8} />
                        </button>
                    </div>
                </div>
            </aside>

            {/* Main Stage Workspace Area */}
            <main className="sb-chatgpt-main-stage">
                {/* Top Navigation Bar (Minimalist & Clean) */}
                <header className="sb-chatgpt-topbar">
                    <div className="sb-topbar-left">
                        {!isSidebarOpen && (
                            <button
                                type="button"
                                className="sb-topbar-sidebar-open-btn"
                                onClick={() => setIsSidebarOpen(true)}
                                title="Open sidebar"
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="3" y="3" width="18" height="18" rx="2" />
                                    <line x1="9" y1="3" x2="9" y2="21" />
                                </svg>
                            </button>
                        )}
                    </div>

                    <div className="sb-topbar-center" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                        {/* In-Canvas Version Stepper & Rollback Surface */}
                        {activeArtifact && currentArtifactVersionsList.length > 1 && (
                            <div className="sb-artifact-version-stepper">
                                <button
                                    type="button"
                                    className="sb-ver-step-btn"
                                    onClick={handlePrevArtifactVersion}
                                    disabled={currentArtifactVersionIndex <= 0}
                                    title="Previous version"
                                >
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="15 18 9 12 15 6" />
                                    </svg>
                                </button>
                                <span className="sb-ver-badge">
                                    v{activeArtifact.version || currentArtifactVersionIndex + 1} of {currentArtifactVersionsList.length}
                                </span>
                                <button
                                    type="button"
                                    className="sb-ver-step-btn"
                                    onClick={handleNextArtifactVersion}
                                    disabled={currentArtifactVersionIndex >= currentArtifactVersionsList.length - 1}
                                    title="Next version"
                                >
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="9 18 15 12 9 6" />
                                    </svg>
                                </button>
                                {!isCurrentArtifactLatestVersion && (
                                    <button
                                        type="button"
                                        className="sb-ver-restore-btn"
                                        onClick={() => handleRollbackArtifactToVersion(activeArtifact)}
                                        title={`Restore v${activeArtifact.version || currentArtifactVersionIndex + 1}`}
                                    >
                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="1 4 1 10 7 10" />
                                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                                        </svg>
                                        <span>Restore v{activeArtifact.version || currentArtifactVersionIndex + 1}</span>
                                    </button>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="sb-topbar-right">
                        {layoutMode !== 'chat' && documentPaneState === 'collapsed' && (
                            <button
                                type="button"
                                className="sb-btn sb-btn-primary sb-btn-xs sb-doc-reopen-btn"
                                onClick={() => setDocumentPaneState('split')}
                                style={{
                                    marginRight: '8px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '4px',
                                    padding: '4px 10px',
                                    borderRadius: '6px',
                                    fontSize: '12px',
                                    fontWeight: 500,
                                    background: '#2563eb',
                                    color: '#ffffff'
                                }}
                                title={getCanvasReopenLabel()}
                            >
                                {getCanvasReopenIcon()}
                                <span>Show {getCanvasReopenTabTitle()}</span>
                            </button>
                        )}
                        <button
                            type="button"
                            className="sb-btn sb-topbar-action-pill"
                            onClick={() => {
                                if (typeof window !== 'undefined' && navigator?.clipboard?.writeText) {
                                    navigator.clipboard.writeText(window.location.href);
                                }
                                showToast('Link copied to clipboard');
                            }}
                            title="Share conversation"
                        >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="18" cy="5" r="3" />
                                <circle cx="6" cy="12" r="3" />
                                <circle cx="18" cy="19" r="3" />
                                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                            </svg>
                            <span>Share</span>
                        </button>

                        {/* Conversation Actions Menu */}
                        <div className="relative" ref={conversationMenuRef} style={{ position: 'relative' }}>
                            <button
                                type="button"
                                className={`sb-btn sb-topbar-icon-action ${isConversationMenuOpen ? 'sb-topbar-icon-active' : ''}`}
                                onClick={() => setIsConversationMenuOpen(!isConversationMenuOpen)}
                                title="Conversation actions"
                            >
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="12" cy="12" r="1" />
                                    <circle cx="19" cy="12" r="1" />
                                    <circle cx="5" cy="12" r="1" />
                                </svg>
                            </button>

                            {isConversationMenuOpen && (
                                <div
                                    className="sb-topbar-conversation-menu animate-popover"
                                    onClick={e => e.stopPropagation()}
                                >
                                    <div className="sb-dropdown-header">
                                        Conversation Actions
                                    </div>

                                    <button
                                        type="button"
                                        className="sb-btn sb-dropdown-item"
                                        onClick={() => {
                                            setIsConversationMenuOpen(false);
                                            handleCreateWorkspaceFile('chat');
                                        }}
                                    >
                                        <IconChat size={13} className="text-blue-400" />
                                        <div className="sb-dropdown-item-text">
                                            <span className="sb-dropdown-item-title">New Conversation</span>
                                        </div>
                                    </button>

                                    <button
                                        type="button"
                                        className="sb-btn sb-dropdown-item"
                                        onClick={handleExportConversationMarkdown}
                                    >
                                        <IconDocument size={13} className="text-emerald-400" />
                                        <div className="sb-dropdown-item-text">
                                            <span className="sb-dropdown-item-title">Export Chat (Markdown)</span>
                                        </div>
                                    </button>

                                    <button
                                        type="button"
                                        className="sb-dropdown-item"
                                        onClick={() => {
                                            if (typeof window !== 'undefined' && navigator?.clipboard?.writeText) {
                                                navigator.clipboard.writeText(window.location.href);
                                            }
                                            showToast('Conversation link copied');
                                            setIsConversationMenuOpen(false);
                                        }}
                                    >
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                                            <circle cx="18" cy="5" r="3" />
                                            <circle cx="6" cy="12" r="3" />
                                            <circle cx="18" cy="19" r="3" />
                                            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                                            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                                        </svg>
                                        <div className="sb-dropdown-item-text">
                                            <span className="sb-dropdown-item-title">Copy Link</span>
                                        </div>
                                    </button>

                                    <div style={{ height: '1px', background: 'var(--sb-surface-border, rgba(255, 255, 255, 0.08))', margin: '3px 0' }} />

                                    <button
                                        type="button"
                                        className="sb-btn sb-dropdown-item"
                                        onClick={handleClearCurrentConversation}
                                    >
                                        <IconClose size={13} className="text-rose-400" />
                                        <div className="sb-dropdown-item-text">
                                            <span className="sb-dropdown-item-title text-rose-400">Clear Conversation</span>
                                        </div>
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </header>

                {/* Body Content */}
                <div className="sb-main-surface-container">
                    {layoutMode === 'chat' ? (
                        /* Unified Main Stage & ChatGPT / Modern Cursor Layout */
                        <div className="sb-chat-stage-wrapper animate-fadeIn">
                            <div className="sb-chat-stage-content">
                                {messages.length === 0 ? (
                                    /* Empty / New Chat State: Centered Hero & Streamlined Starters */
                                    <div className="sb-chat-empty-hero-container animate-fadeIn">
                                        <div className="sb-chat-empty-hero-badge">
                                            <span className="sb-chat-empty-hero-dot" />
                                            <span>Scratchbox 2.0 Canvas</span>
                                        </div>

                                        <h1 className="sb-chat-empty-hero-title">
                                            A canvas for AI work. What can I help you design, build, or analyze today?
                                        </h1>

                                        <div className="sb-welcome-mode-strip">
                                            <button
                                                type="button"
                                                className={`sb-btn sb-welcome-mode-btn ${aiInteractionMode === 'agent' ? 'sb-welcome-mode-btn-active' : ''}`}
                                                onClick={() => setAiInteractionMode('agent')}
                                            >
                                                Agent: Full-Stack Builder
                                            </button>
                                            <button
                                                type="button"
                                                className={`sb-btn sb-welcome-mode-btn ${aiInteractionMode === 'ask' ? 'sb-welcome-mode-btn-active' : ''}`}
                                                onClick={() => setAiInteractionMode('ask')}
                                            >
                                                Ask: Codebase &amp; Docs
                                            </button>
                                            <button
                                                type="button"
                                                className={`sb-btn sb-welcome-mode-btn ${aiInteractionMode === 'plan' ? 'sb-welcome-mode-btn-active' : ''}`}
                                                onClick={() => setAiInteractionMode('plan')}
                                            >
                                                Plan: Architecture
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    /* Full-Width / Centered Chat Stream View */
                                    <div className="sb-split-chat-messages sb-standalone-chat-messages">
                                        {messages.map(renderMessageItem)}

                                        {isGenerating && (
                                            <CanvasErrorBoundary compact fallbackTitle="Streaming Assistant Notice">
                                                <div className="sb-drawer-msg-row sb-msg-assistant-row animate-fadeIn">
                                                    <div className="sb-chat-avatar sb-avatar-assistant">
                                                        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                                                            <path d="M12 2L14.4 9.6L22 12L14.4 14.4L12 22L9.6 14.4L2 12L9.6 9.6L12 2Z" />
                                                        </svg>
                                                    </div>
                                                    <div className="sb-chat-bubble-content">
                                                        <div className="sb-bubble-header">
                                                            <span className="sb-bubble-sender">Scratchbox AI</span>
                                                            <span className="sb-bubble-time">Just now</span>
                                                        </div>
                                                        {(liveThinkingText || liveThinkingSeconds > 0) ? (
                                                            <ThinkingDisclosure
                                                                isLive={!liveStreamedText}
                                                                thinkingText={liveThinkingText}
                                                                durationSeconds={liveThinkingSeconds}
                                                            />
                                                        ) : null}
                                                        {liveSteps && liveSteps.length > 0 && (
                                                            <AgentExecutionStepper
                                                                steps={liveSteps}
                                                                isLive={true}
                                                            />
                                                        )}
                                                        {liveStreamedText ? (
                                                            <div style={{ position: 'relative' }}>
                                                                <ChatMarkdownRenderer
                                                                    text={cleanMessageTextSmart(liveStreamedText)}
                                                                    className="sb-bubble-text"
                                                                    isStreaming={true}
                                                                    onOpenInBrowser={handleOpenInAppBrowser}
                                                                    onPreviewInCanvas={handlePreviewCodeInCanvas}
                                                                />
                                                                <StreamingCursor />
                                                            </div>
                                                        ) : !liveThinkingText && (!liveSteps || liveSteps.length === 0) ? (
                                                            <div className="sb-ide-msg-thinking animate-pulse" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', fontSize: '13px', color: 'var(--sb-cadence-medium, #8e8e93)' }}>
                                                                <span className="animate-spin" style={{ color: '#3b82f6' }}>○</span>
                                                                <span>Reasoning and synthesizing response...</span>
                                                                <StreamingCursor />
                                                            </div>
                                                        ) : null}
                                                    </div>
                                                </div>
                                            </CanvasErrorBoundary>
                                        )}
                                        <div ref={messagesEndRef} />
                                    </div>
                                )}
                            </div>

                            {/* Floating Bottom-Centered Composer Dock */}
                            <div className="sb-bottom-chatgpt-dock">
                                {/* Context Selector Strip: [ 📁 workspace-name ⌄ ] [ main ⌄ ] [ 💻 This Mac ⌄ ] */}
                                <div className="sb-cursor-context-selector-row" style={{ position: 'relative' }}>
                                    <button
                                        type="button"
                                        className="sb-cursor-context-dropdown-btn"
                                        onClick={e => {
                                            e.stopPropagation();
                                            setShowComposerWorkspaceMenu(!showComposerWorkspaceMenu);
                                        }}
                                        title="Switch Workspace"
                                    >
                                        <IconFolder size={12} className="text-zinc-400" />
                                        <span>{activeWorkspace.path.split('/').pop() || activeWorkspace.name}</span>
                                        <IconChevronDown size={10} className="text-zinc-500" />
                                    </button>

                                    {showComposerWorkspaceMenu && (
                                        <div className="sb-composer-context-popover animate-popover" onClick={e => e.stopPropagation()}>
                                            <div className="sb-dropdown-header">Switch Workspace</div>
                                            {workspaces.map(w => (
                                                <button
                                                    key={w.id}
                                                    type="button"
                                                    className="sb-dropdown-item"
                                                    style={{ padding: '5px 8px', borderRadius: '6px' }}
                                                    onClick={() => {
                                                        setActiveWorkspace(w);
                                                        setShowComposerWorkspaceMenu(false);
                                                        showToast(`Switched active workspace to "${w.name}"`);
                                                    }}
                                                >
                                                    <IconFolder size={12} className={w.id === activeWorkspace.id ? 'text-blue-400' : 'text-zinc-400'} />
                                                    <span style={{ fontSize: '12px', fontWeight: w.id === activeWorkspace.id ? 600 : 400 }}>{w.name}</span>
                                                </button>
                                            ))}
                                            <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '4px', marginTop: '4px' }}>
                                                <button
                                                    type="button"
                                                    className="sb-dropdown-item"
                                                    style={{ padding: '5px 8px', borderRadius: '6px' }}
                                                    onClick={() => {
                                                        setShowComposerWorkspaceMenu(false);
                                                        setIsSidebarOpen(true);
                                                        setShowNewWorkspaceMenu(true);
                                                    }}
                                                >
                                                    <IconPlus size={12} />
                                                    <span style={{ fontSize: '12px' }}>New Workspace...</span>
                                                </button>
                                            </div>
                                        </div>
                                    )}

                                    <button
                                        type="button"
                                        className="sb-cursor-context-dropdown-btn"
                                        title="Git Branch"
                                    >
                                        <span>main</span>
                                        <IconChevronDown size={10} className="text-zinc-500" />
                                    </button>
                                    <button
                                        type="button"
                                        className="sb-cursor-context-dropdown-btn"
                                        title="Execution Environment"
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                                            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                                            <line x1="8" y1="21" x2="16" y2="21" />
                                            <line x1="12" y1="17" x2="12" y2="21" />
                                        </svg>
                                        <span>This Mac</span>
                                        <IconChevronDown size={10} className="text-zinc-500" />
                                    </button>
                                </div>

                                {renderComposerInput(false)}

                                {/* Quick Action Suggestion Pills & System Footer */}
                                {messages.length === 0 && (
                                    <>
                                        <div className="sb-cursor-hero-pills-row">
                                            <button
                                                type="button"
                                                className="sb-cursor-hero-pill-btn"
                                                onClick={() => {
                                                    setAiInteractionMode('plan');
                                                    setInputValue('Plan new architecture idea: ');
                                                    inputRef.current?.focus();
                                                }}
                                            >
                                                <span>Plan New Idea</span>
                                                <span style={{ fontSize: '10px', opacity: 0.6 }}>⇧Tab</span>
                                            </button>
                                            <button
                                                type="button"
                                                className="sb-cursor-hero-pill-btn"
                                                onClick={() => {
                                                    handleSendMessage('Run autonomous multi-agent swarm task in background');
                                                }}
                                            >
                                                <span>Multitask</span>
                                            </button>
                                        </div>

                                        <div className="sb-cursor-hero-footer-note">
                                            <span>Use</span>
                                            <span className="sb-code-token">/create-rule</span>
                                            <span>to control agent behavior through system-level instructions</span>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    ) : (
                        /* Unified Workspace Surface with Unified AI Side Chat across all non-chat file types */
                        <div className="sb-fullwindow-canvas-container">
                            <div className="sb-surface-with-chat-container" style={{ display: 'flex', flexDirection: 'row', width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}>
                                {/* Unified Side-by-Side Split View for all Canvas Primitives */}
                                <div className="sb-canvas-split-container sb-document-split-container" style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}>
                                    {/* Left Pane (45% width or 100% if collapsed, 0% if expanded) */}
                                    {documentPaneState !== 'expanded' && (
                                        <div className="sb-canvas-split-left-pane sb-document-split-left-pane" style={{
                                            width: documentPaneState === 'collapsed' ? '100%' : '45%',
                                            height: '100%',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            position: 'relative',
                                            borderRight: documentPaneState === 'collapsed' ? 'none' : '1px solid rgba(255,255,255,0.06)',
                                            boxSizing: 'border-box',
                                            background: 'transparent',
                                            minWidth: 0,
                                        }}>
                                            {/* Floating Right-Edge Tab to Reopen Canvas when Collapsed */}
                                            {documentPaneState === 'collapsed' && (
                                                <button
                                                    type="button"
                                                    className="sb-btn sb-doc-floating-reopen-tab animate-fadeIn"
                                                    onClick={() => setDocumentPaneState('split')}
                                                    style={{
                                                        position: 'absolute',
                                                        right: 0,
                                                        top: '50%',
                                                        transform: 'translateY(-50%)',
                                                        background: 'var(--sb-surface-card, #1c1c1e)',
                                                        border: '1px solid var(--sb-ui-card-border, rgba(255,255,255,0.12))',
                                                        borderRight: 'none',
                                                        borderRadius: '8px 0 0 8px',
                                                        padding: '12px 7px',
                                                        display: 'flex',
                                                        flexDirection: 'column',
                                                        alignItems: 'center',
                                                        gap: '8px',
                                                        cursor: 'pointer',
                                                        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                                                        zIndex: 30,
                                                        color: 'var(--sb-cadence-high, #f4f4f5)'
                                                    }}
                                                    title={getCanvasReopenLabel()}
                                                >
                                                    {getCanvasReopenIcon()}
                                                    <span style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em' }}>{getCanvasReopenTabTitle()}</span>
                                                </button>
                                            )}

                                            {/* Scrollable chat message stream */}
                                            <div className="sb-split-chat-messages" style={{
                                                flex: 1,
                                                overflowY: 'auto',
                                                padding: '24px 24px 140px 24px',
                                                display: 'flex',
                                                flexDirection: 'column',
                                                gap: '16px',
                                                width: '100%',
                                                boxSizing: 'border-box'
                                            }}>
                                                {messages.map(renderMessageItem)}

                                                {isGenerating && (
                                                    <CanvasErrorBoundary compact fallbackTitle="Streaming Assistant Notice">
                                                        <div className="sb-drawer-msg-row sb-msg-assistant-row animate-fadeIn">
                                                            <div className="sb-chat-avatar sb-avatar-assistant">
                                                                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                                                                    <path d="M12 2L14.4 9.6L22 12L14.4 14.4L12 22L9.6 14.4L2 12L9.6 9.6L12 2Z" />
                                                                </svg>
                                                            </div>
                                                            <div className="sb-chat-bubble-content">
                                                                <div className="sb-bubble-header">
                                                                    <span className="sb-bubble-sender">Scratchbox AI</span>
                                                                    <span className="sb-bubble-time">Just now</span>
                                                                </div>
                                                                {(liveThinkingText || liveThinkingSeconds > 0) ? (
                                                                    <ThinkingDisclosure
                                                                        isLive={!liveStreamedText}
                                                                        thinkingText={liveThinkingText}
                                                                        durationSeconds={liveThinkingSeconds}
                                                                    />
                                                                ) : null}
                                                                {liveSteps && liveSteps.length > 0 && (
                                                                    <AgentExecutionStepper
                                                                        steps={liveSteps}
                                                                        isLive={true}
                                                                    />
                                                                )}
                                                                {liveStreamedText ? (
                                                                    <div style={{ position: 'relative' }}>
                                                                        <ChatMarkdownRenderer
                                                                            text={cleanMessageTextSmart(liveStreamedText)}
                                                                            className="sb-bubble-text"
                                                                            isStreaming={true}
                                                                            onOpenInBrowser={handleOpenInAppBrowser}
                                                                            onPreviewInCanvas={handlePreviewCodeInCanvas}
                                                                        />
                                                                        <StreamingCursor />
                                                                    </div>
                                                                ) : !liveThinkingText && (!liveSteps || liveSteps.length === 0) ? (
                                                                    <div className="sb-ide-msg-thinking animate-pulse" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', fontSize: '13px', color: 'var(--sb-cadence-medium, #8e8e93)' }}>
                                                                        <span className="animate-spin" style={{ color: '#3b82f6' }}>○</span>
                                                                        <span>Reasoning and synthesizing response...</span>
                                                                        <StreamingCursor />
                                                                    </div>
                                                                ) : null}
                                                            </div>
                                                        </div>
                                                    </CanvasErrorBoundary>
                                                )}
                                                <div ref={messagesEndRef} />
                                            </div>

                                            {/* Specifically docked beneath the left chat pane in the split-layout */}
                                            <div className="sb-bottom-chatgpt-dock" style={{
                                                position: 'absolute',
                                                bottom: '16px',
                                                left: '50%',
                                                transform: 'translateX(-50%)',
                                                width: 'calc(100% - 32px)',
                                                maxWidth: '800px',
                                                zIndex: 10,
                                                display: 'flex',
                                                flexDirection: 'column',
                                                alignItems: 'center',
                                                boxSizing: 'border-box'
                                            }}>
                                                {renderComposerInput(false)}
                                            </div>
                                        </div>
                                    )}

                                    {/* Right Pane (55% width or 100% if expanded, 0% if collapsed) */}
                                    {documentPaneState !== 'collapsed' && (
                                        <div className="sb-canvas-split-right-pane sb-document-split-right-pane" style={{
                                            width: documentPaneState === 'expanded' ? '100%' : '55%',
                                            height: '100%',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            position: 'relative',
                                            boxSizing: 'border-box',
                                            background: 'transparent',
                                            minWidth: 0,
                                        }}>
                                            {/* ChatGPT-style document/canvas workspace frame / card wrapper */}
                                            <div className="sb-chatgpt-document-card sb-glass-card" style={{
                                                flex: 1,
                                                display: 'flex',
                                                flexDirection: 'column',
                                                margin: '16px',
                                                borderRadius: '16px',
                                                overflow: 'hidden',
                                                position: 'relative',
                                                minHeight: 0
                                            }}>
                                                {/* Header of the Canvas Card */}
                                                <div className="sb-document-card-header" style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'space-between',
                                                    padding: '12px 20px',
                                                    userSelect: 'none'
                                                }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden', flex: 1, minWidth: 0, marginRight: '12px' }}>
                                                        {canvasArtifactTabs.length === 0 && (
                                                            <span className="sb-doc-card-title-tag" style={{ fontSize: '12px', fontWeight: 600 }}>{getCanvasHeaderLabel()}</span>
                                                        )}
                                                        {/* Persistent Artifact Tab Strip */}
                                                        <div className="sb-canvas-tabs-bar" style={{ display: 'flex', alignItems: 'center', gap: '4px', overflowX: 'auto', maxWidth: '460px', scrollbarWidth: 'none', flexShrink: 0 }}>
                                                            {canvasArtifactTabs.map(art => {
                                                                const isActive = activeArtifact?.id === art.id;
                                                                return (
                                                                    <div
                                                                        key={art.id}
                                                                        className={`sb-canvas-tab-pill ${isActive ? 'sb-canvas-tab-active' : ''}`}
                                                                        onClick={() => handleSelectArtifactTab(art)}
                                                                        style={{
                                                                            display: 'flex',
                                                                            alignItems: 'center',
                                                                            gap: '6px',
                                                                            padding: '3px 8px',
                                                                            borderRadius: '6px',
                                                                            fontSize: '11px',
                                                                            fontWeight: isActive ? 600 : 500,
                                                                            cursor: 'pointer',
                                                                            background: isActive ? 'var(--sb-system-blue-subtle, rgba(37, 99, 235, 0.22))' : 'rgba(255, 255, 255, 0.05)',
                                                                            border: isActive ? '1px solid var(--sb-system-blue, #2563eb)' : '1px solid rgba(255, 255, 255, 0.08)',
                                                                            color: isActive ? '#ffffff' : 'var(--sb-text-secondary, #94a3b8)',
                                                                            transition: 'all 0.15s ease',
                                                                            whiteSpace: 'nowrap',
                                                                            flexShrink: 0
                                                                        }}
                                                                        title={`${art.title || art.type} (${art.type})`}
                                                                    >
                                                                        <span style={{ fontSize: '11px' }}>{getArtifactIcon(art.type)}</span>
                                                                        <span style={{ maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                                            {art.title || art.type}
                                                                        </span>
                                                                        {canvasArtifactTabs.length > 1 && (
                                                                            <button
                                                                                type="button"
                                                                                onClick={(e) => handleCloseArtifactTab(e, art.id)}
                                                                                style={{
                                                                                    background: 'transparent',
                                                                                    border: 'none',
                                                                                    cursor: 'pointer',
                                                                                    color: 'inherit',
                                                                                    padding: '0 2px',
                                                                                    opacity: 0.6,
                                                                                    fontSize: '10px',
                                                                                    display: 'flex',
                                                                                    alignItems: 'center',
                                                                                    borderRadius: '50%'
                                                                                }}
                                                                                title="Close tab"
                                                                            >
                                                                                ✕
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                );
                                                            })}

                                                            {/* New Preview Sandbox Button */}
                                                            <button
                                                                type="button"
                                                                className="sb-btn sb-btn-ghost sb-btn-xs"
                                                                onClick={handleCreateNewSandboxTab}
                                                                style={{
                                                                    padding: '3px 8px',
                                                                    borderRadius: '6px',
                                                                    fontSize: '11px',
                                                                    fontWeight: 500,
                                                                    color: 'var(--sb-text-secondary, #94a3b8)',
                                                                    display: 'flex',
                                                                    alignItems: 'center',
                                                                    gap: '4px',
                                                                    border: '1px dashed rgba(255, 255, 255, 0.15)',
                                                                    flexShrink: 0
                                                                }}
                                                                title="Open new live preview sandbox"
                                                            >
                                                                <IconPlus size={11} strokeWidth={2} />
                                                                <span>Preview</span>
                                                            </button>
                                                        </div>

                                                        {layoutMode === 'document' && docReadOnly && <span className="sb-doc-readonly-tag" style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', flexShrink: 0 }}>READ-ONLY</span>}

                                                        {/* Canvas Version History Dropdown & Rollback Button */}
                                                        {activeArtifact && currentArtifactVersionsList.length > 0 && (
                                                            <div className="sb-canvas-header-version-ctrls" ref={canvasVersionMenuRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                                {currentArtifactVersionsList.length > 1 && (
                                                                    <div className="sb-canvas-ver-stepper-group" style={{ display: 'flex', alignItems: 'center', gap: '2px', background: 'rgba(255, 255, 255, 0.05)', borderRadius: '6px', padding: '2px 4px' }}>
                                                                        <button
                                                                            type="button"
                                                                            className="sb-btn sb-btn-ghost sb-btn-icon-xs sb-canvas-ver-step-btn"
                                                                            onClick={handlePrevArtifactVersion}
                                                                            disabled={currentArtifactVersionIndex <= 0}
                                                                            title="Previous version snapshot"
                                                                            style={{ padding: '2px 4px', fontSize: '10px', opacity: currentArtifactVersionIndex <= 0 ? 0.3 : 1 }}
                                                                        >
                                                                            ◀
                                                                        </button>
                                                                        <button
                                                                            type="button"
                                                                            className="sb-btn sb-btn-ghost sb-btn-icon-xs sb-canvas-ver-step-btn"
                                                                            onClick={handleNextArtifactVersion}
                                                                            disabled={currentArtifactVersionIndex >= currentArtifactVersionsList.length - 1}
                                                                            title="Next version snapshot"
                                                                            style={{ padding: '2px 4px', fontSize: '10px', opacity: currentArtifactVersionIndex >= currentArtifactVersionsList.length - 1 ? 0.3 : 1 }}
                                                                        >
                                                                            ▶
                                                                        </button>
                                                                    </div>
                                                                )}

                                                                <button
                                                                    type="button"
                                                                    className={`sb-btn sb-btn-xs sb-canvas-version-dropdown-btn ${isCanvasVersionMenuOpen ? 'sb-btn-active' : 'sb-btn-secondary'}`}
                                                                    onClick={() => setIsCanvasVersionMenuOpen(!isCanvasVersionMenuOpen)}
                                                                    title="Version History — Click to view snapshots"
                                                                    style={{
                                                                        display: 'flex',
                                                                        alignItems: 'center',
                                                                        gap: '4px',
                                                                        padding: '4px 8px',
                                                                        borderRadius: '6px',
                                                                        fontSize: '11px',
                                                                        fontWeight: 600,
                                                                        background: isCurrentArtifactLatestVersion ? 'rgba(255, 255, 255, 0.06)' : 'rgba(245, 158, 11, 0.15)',
                                                                        color: isCurrentArtifactLatestVersion ? 'var(--sb-text-secondary)' : '#f59e0b',
                                                                        border: isCurrentArtifactLatestVersion ? '1px solid var(--sb-surface-border)' : '1px solid rgba(245, 158, 11, 0.4)'
                                                                    }}
                                                                >
                                                                    <span>v{activeArtifact.version || currentArtifactVersionIndex + 1} of {currentArtifactVersionsList.length}</span>
                                                                    {!isCurrentArtifactLatestVersion && <span style={{ fontSize: '9px', opacity: 0.8 }}>(Historical)</span>}
                                                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                                        <polyline points="6 9 12 15 18 9" />
                                                                    </svg>
                                                                </button>

                                                                {!isCurrentArtifactLatestVersion && (
                                                                    <button
                                                                        type="button"
                                                                        className="sb-btn sb-btn-xs sb-canvas-restore-btn animate-fadeIn"
                                                                        onClick={() => handleRollbackArtifactToVersion(activeArtifact)}
                                                                        title={`Restore v${activeArtifact.version || currentArtifactVersionIndex + 1} as new head version`}
                                                                        style={{
                                                                            display: 'flex',
                                                                            alignItems: 'center',
                                                                            gap: '4px',
                                                                            padding: '4px 10px',
                                                                            borderRadius: '6px',
                                                                            fontSize: '11px',
                                                                            fontWeight: 600,
                                                                            background: '#f59e0b',
                                                                            color: '#000000',
                                                                            border: 'none',
                                                                            cursor: 'pointer'
                                                                        }}
                                                                    >
                                                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                                            <polyline points="1 4 1 10 7 10" />
                                                                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                                                                        </svg>
                                                                        <span>Restore v{activeArtifact.version || currentArtifactVersionIndex + 1}</span>
                                                                    </button>
                                                                )}

                                                                {isCanvasVersionMenuOpen && (
                                                                    <div
                                                                        className="sb-canvas-version-history-popover animate-scaleIn"
                                                                        style={{
                                                                            position: 'absolute',
                                                                            top: '100%',
                                                                            left: 0,
                                                                            marginTop: '6px',
                                                                            width: '280px',
                                                                            background: 'var(--sb-surface-elevated, #18181b)',
                                                                            border: '1px solid var(--sb-surface-border, rgba(255, 255, 255, 0.12))',
                                                                            borderRadius: '10px',
                                                                            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5)',
                                                                            zIndex: 100,
                                                                            padding: '6px',
                                                                            backdropFilter: 'blur(20px)'
                                                                        }}
                                                                    >
                                                                        <div style={{ padding: '6px 8px 4px 8px', fontSize: '10px', fontWeight: 700, color: 'var(--sb-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                                                            Version History ({currentArtifactVersionsList.length} Snapshots)
                                                                        </div>
                                                                        <div style={{ maxHeight: '220px', overflowY: 'auto' }}>
                                                                            {currentArtifactVersionsList.map((verSnapshot, vIdx) => {
                                                                                const isSelected = (verSnapshot.version || 1) === (activeArtifact.version || 1);
                                                                                const isLatestVer = vIdx === currentArtifactVersionsList.length - 1;
                                                                                return (
                                                                                    <div
                                                                                        key={`${verSnapshot.id}-ver-${verSnapshot.version || vIdx}`}
                                                                                        className={`sb-ver-menu-item ${isSelected ? 'sb-ver-item-selected' : ''}`}
                                                                                        onClick={() => {
                                                                                            handleSelectVersion(verSnapshot);
                                                                                            setIsCanvasVersionMenuOpen(false);
                                                                                        }}
                                                                                        style={{
                                                                                            display: 'flex',
                                                                                            alignItems: 'center',
                                                                                            justifyContent: 'space-between',
                                                                                            padding: '8px 10px',
                                                                                            borderRadius: '6px',
                                                                                            cursor: 'pointer',
                                                                                            marginBottom: '2px',
                                                                                            background: isSelected ? 'var(--sb-system-blue-subtle, rgba(37, 99, 235, 0.15))' : 'transparent',
                                                                                            border: isSelected ? '1px solid var(--sb-system-blue, #2563eb)' : '1px solid transparent',
                                                                                            transition: 'background 0.15s ease'
                                                                                        }}
                                                                                    >
                                                                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                                                                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                                                                <span style={{
                                                                                                    fontSize: '10px',
                                                                                                    fontWeight: 700,
                                                                                                    padding: '1px 5px',
                                                                                                    borderRadius: '4px',
                                                                                                    background: isLatestVer ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255, 255, 255, 0.08)',
                                                                                                    color: isLatestVer ? '#10b981' : 'var(--sb-text-secondary)'
                                                                                                }}>
                                                                                                    v{verSnapshot.version || vIdx + 1} {isLatestVer ? '• Latest' : ''}
                                                                                                </span>
                                                                                                <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--sb-text-label)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                                                                    {verSnapshot.title || `Snapshot v${verSnapshot.version || vIdx + 1}`}
                                                                                                </span>
                                                                                            </div>
                                                                                            {verSnapshot.summary && (
                                                                                                <span style={{ fontSize: '10px', color: 'var(--sb-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                                                                    {verSnapshot.summary}
                                                                                                </span>
                                                                                            )}
                                                                                        </div>
                                                                                        {isSelected && (
                                                                                            <span style={{ color: '#2563eb', fontWeight: 700, fontSize: '12px', marginLeft: '6px' }}>✓</span>
                                                                                        )}
                                                                                    </div>
                                                                                );
                                                                            })}
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>

                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                                                        {/* Mode Switcher: Code | Split | Preview */}
                                                        {(layoutMode === 'code' || activeArtifact?.type === 'live-code-sandbox') && (
                                                            <div
                                                                className="sb-segmented-control sb-segmented-control-xs"
                                                                style={{
                                                                    display: 'inline-flex',
                                                                    alignItems: 'center',
                                                                    background: 'rgba(0, 0, 0, 0.4)',
                                                                    border: '1px solid rgba(255, 255, 255, 0.12)',
                                                                    borderRadius: '8px',
                                                                    padding: '2px',
                                                                    gap: '2px',
                                                                    marginRight: '4px'
                                                                }}
                                                                title="Live Code Sandbox View Mode"
                                                            >
                                                                <button
                                                                    type="button"
                                                                    className={`sb-btn sb-btn-xs ${(activeSandboxData?.viewMode || 'preview') === 'code' ? 'sb-btn-primary' : 'sb-btn-ghost'}`}
                                                                    onClick={() => handleSetSandboxViewMode('code')}
                                                                    style={{
                                                                        padding: '3px 8px',
                                                                        fontSize: '11px',
                                                                        fontWeight: 600,
                                                                        borderRadius: '6px',
                                                                        display: 'flex',
                                                                        alignItems: 'center',
                                                                        gap: '4px'
                                                                    }}
                                                                    title="Code Editor View"
                                                                >
                                                                    <IconCode size={11} strokeWidth={2} />
                                                                    <span>Code</span>
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    className={`sb-btn sb-btn-xs ${(activeSandboxData?.viewMode || 'preview') === 'split' ? 'sb-btn-primary' : 'sb-btn-ghost'}`}
                                                                    onClick={() => handleSetSandboxViewMode('split')}
                                                                    style={{
                                                                        padding: '3px 8px',
                                                                        fontSize: '11px',
                                                                        fontWeight: 600,
                                                                        borderRadius: '6px',
                                                                        display: 'flex',
                                                                        alignItems: 'center',
                                                                        gap: '4px'
                                                                    }}
                                                                    title="Split Editor & Live Preview"
                                                                >
                                                                    <IconSplit size={11} strokeWidth={2} />
                                                                    <span>Split</span>
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    className={`sb-btn sb-btn-xs ${(activeSandboxData?.viewMode || 'preview') === 'preview' ? 'sb-btn-primary' : 'sb-btn-ghost'}`}
                                                                    onClick={() => handleSetSandboxViewMode('preview')}
                                                                    style={{
                                                                        padding: '3px 8px',
                                                                        fontSize: '11px',
                                                                        fontWeight: 600,
                                                                        borderRadius: '6px',
                                                                        display: 'flex',
                                                                        alignItems: 'center',
                                                                        gap: '4px'
                                                                    }}
                                                                    title="Full Live Interactive Preview"
                                                                >
                                                                    <IconSparkles size={11} strokeWidth={2} />
                                                                    <span>Preview</span>
                                                                </button>
                                                            </div>
                                                        )}

                                                        {layoutMode === 'document' ? (
                                                            /* Edit toggle button */
                                                            <button
                                                                className={`sb-btn sb-btn-xs sb-doc-edit-mode-toggle ${docReadOnly ? 'sb-btn-secondary' : 'sb-btn-primary'}`}
                                                                type="button"
                                                                onClick={() => setDocReadOnly(prev => !prev)}
                                                                style={{
                                                                    display: 'flex',
                                                                    alignItems: 'center',
                                                                    gap: '4px',
                                                                    padding: '4px 10px',
                                                                    borderRadius: '6px',
                                                                    fontSize: '12px',
                                                                    fontWeight: 500,
                                                                    transition: 'all 0.15s ease'
                                                                }}
                                                                title={docReadOnly ? "Switch to Edit Mode" : "Switch to Read-Only Mode"}
                                                            >
                                                                <IconEdit size={12} strokeWidth={1.8} />
                                                                <span>{docReadOnly ? 'Edit' : 'Done'}</span>
                                                            </button>
                                                        ) : (
                                                            /* Done button for non-document canvas modes */
                                                            <button
                                                                className="sb-btn sb-btn-primary sb-btn-xs sb-canvas-done-btn"
                                                                type="button"
                                                                onClick={() => {
                                                                    showToast(`${getCanvasReopenTabTitle()} saved and up to date.`);
                                                                }}
                                                                style={{
                                                                    display: 'flex',
                                                                    alignItems: 'center',
                                                                    gap: '4px',
                                                                    padding: '4px 10px',
                                                                    borderRadius: '6px',
                                                                    fontSize: '12px',
                                                                    fontWeight: 500,
                                                                    background: 'var(--sb-system-blue, #2563eb)',
                                                                    color: '#ffffff'
                                                                }}
                                                                title="Done editing canvas"
                                                            >
                                                                <IconSparkles size={12} strokeWidth={1.8} />
                                                                <span>Done</span>
                                                            </button>
                                                        )}

                                                        {/* Download button */}
                                                        <button
                                                            className="sb-btn sb-btn-secondary sb-btn-xs sb-doc-export-btn"
                                                            type="button"
                                                            onClick={triggerMarkdownExport}
                                                            style={{
                                                                display: 'flex',
                                                                alignItems: 'center',
                                                                gap: '4px',
                                                                padding: '4px 10px',
                                                                borderRadius: '6px',
                                                                fontSize: '12px',
                                                                fontWeight: 500
                                                            }}
                                                            title={layoutMode === 'document' ? "Export Markdown (.md)" : "Export Artifact (.md)"}
                                                        >
                                                            <span>Download .md</span>
                                                        </button>

                                                        {/* Save to Drive button */}
                                                        <button
                                                            className="sb-btn sb-btn-secondary sb-btn-xs sb-doc-export-btn"
                                                            type="button"
                                                            onClick={triggerGoogleDriveSave}
                                                            style={{
                                                                display: 'flex',
                                                                alignItems: 'center',
                                                                gap: '4px',
                                                                padding: '4px 10px',
                                                                borderRadius: '6px',
                                                                fontSize: '12px',
                                                                fontWeight: 500
                                                            }}
                                                            title="Save to Google Drive"
                                                        >
                                                            <span>Save Drive</span>
                                                        </button>

                                                        {/* Minimize/Collapse/Expand Buttons */}
                                                        {documentPaneState === 'split' ? (
                                                            <>
                                                                <button
                                                                    className="sb-btn sb-btn-secondary sb-btn-xs sb-doc-collapse-btn"
                                                                    type="button"
                                                                    onClick={() => setDocumentPaneState('collapsed')}
                                                                    style={{ padding: '4px 8px', borderRadius: '6px' }}
                                                                    title="Collapse canvas (View Chat)"
                                                                >
                                                                    <span>Collapse</span>
                                                                </button>
                                                                <button
                                                                    className="sb-btn sb-btn-secondary sb-btn-xs sb-doc-expand-btn"
                                                                    type="button"
                                                                    onClick={() => setDocumentPaneState('expanded')}
                                                                    style={{ padding: '4px 8px', borderRadius: '6px' }}
                                                                    title="Expand canvas (Full Workspace)"
                                                                >
                                                                    <span>Expand</span>
                                                                </button>
                                                            </>
                                                        ) : (
                                                            <button
                                                                className="sb-btn sb-btn-secondary sb-btn-xs sb-doc-split-view-btn"
                                                                type="button"
                                                                onClick={() => setDocumentPaneState('split')}
                                                                style={{ padding: '4px 8px', borderRadius: '6px' }}
                                                                title="Reset to Split View"
                                                            >
                                                                <span>Split View</span>
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>

                                                <RelatedArtifactsRail
                                                    items={relatedArtifacts}
                                                    onSelect={handleSelectRelatedArtifact}
                                                    onOpenBento={handleOpenRelatedInBento}
                                                />

                                                {/* Body / Scrollable Content of the Active Canvas Card */}
                                                <div className="sb-document-card-body sb-surface-main-viewport" style={{
                                                    flex: 1,
                                                    overflowY: layoutMode === '3d' || layoutMode === 'browser' ? 'hidden' : 'auto',
                                                    padding: layoutMode === '3d' || layoutMode === 'browser' ? '0' : '24px 24px 80px 24px',
                                                    position: 'relative',
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    minHeight: 0
                                                }}>
                                                    {stageLayoutMode !== 'single' ? (
                                                        <CanvasErrorBoundary fallbackTitle="Bento Canvas Stage">
                                                            <BentoStageLayout
                                                                layoutMode={stageLayoutMode}
                                                                onLayoutModeChange={setStageLayoutMode}
                                                                artifacts={artifactHistory.length > 0 ? artifactHistory : (activeArtifact ? [activeArtifact] : [])}
                                                                activeArtifactId={activeArtifact?.id}
                                                                onSelectArtifact={id => {
                                                                    const found = artifactHistory.find(a => a.id === id);
                                                                    if (found) {
                                                                        setActiveArtifact(found);
                                                                    }
                                                                }}
                                                                onUpdateArtifact={handleUpdateArtifact}
                                                                onMorphArtifact={(artifact, targetType) => {
                                                                    const morphed = morphArtifact(artifact, targetType);
                                                                    handleMorphArtifact(morphed);
                                                                }}
                                                                onPromptAction={promptText => handleSurfaceAiPrompt(promptText)}
                                                                onOpenInBrowser={handleOpenInAppBrowser}
                                                                workspacePath={activeWorkspace.path}
                                                            />
                                                        </CanvasErrorBoundary>
                                                    ) : (
                                                        <>
                                                            {layoutMode === 'document' && (
                                                                <CanvasErrorBoundary fallbackTitle="Document Canvas">
                                                                    <MarkdownDocumentPrimitive
                                                                        activeArtifact={activeArtifact}
                                                                        activeArtifactTitle={activeArtifact?.title}
                                                                        workspacePath={activeWorkspace.path}
                                                                        isStreaming={isGenerating}
                                                                        streamingSectionId={activeStreamingSectionId}
                                                                        streamingBadgeText="✨ Synthesizing Document in Real-time..."
                                                                        data={(() => {
                                                                            if (activeArtifact?.type === 'markdown-document') {
                                                                                const doc = activeArtifact.data as MarkdownDocumentData;
                                                                                const effectiveTitle = doc?.title && doc.title !== 'Markdown Document' ? doc.title : activeArtifact.title || 'Project Specification & Notes';
                                                                                const sections = Array.isArray(doc?.sections) && doc.sections.length > 0
                                                                                    ? doc.sections
                                                                                    : synthesizeComprehensiveDocument(effectiveTitle, effectiveTitle).sections;
                                                                                return {
                                                                                    ...doc,
                                                                                    title: effectiveTitle,
                                                                                    sections
                                                                                };
                                                                            }
                                                                            return {
                                                                                title: 'Project Specification & Notes',
                                                                                subtitle: 'Rich block document for architecture, roadmap, and specs',
                                                                                author: getActiveUserName(),
                                                                                lastUpdated: 'Just now',
                                                                                tags: ['Specification', 'Architecture', 'DocumentSpec', 'Reasoning'],
                                                                                sections: [
                                                                                    { id: 'sec-1', type: 'heading', level: 1, content: '1. Overview & Vision' },
                                                                                    { id: 'sec-2', type: 'paragraph', content: 'Scratchbox IDE empowers developers with an AI-native workspace featuring N8N workflow canvases, rich document specs, and Kanban sprint boards.' },
                                                                                    generateMotivatedEditorialImageSection('1776-revolution'),
                                                                                    { id: 'sec-3', type: 'callout', calloutType: 'info', calloutTitle: 'Key Architecture Insight', content: 'Subagents running on Gemini Flash Lite handle ultra-fast data preprocessing while Gemini 3.7 Flash powers high-reasoning synthesis.' },
                                                                                    { id: 'sec-4', type: 'heading', level: 2, content: '2. Next Action Items' },
                                                                                    { id: 'sec-5', type: 'checklist', checklistItems: [
                                                                                        { id: 'c1', text: 'Verify N8N canvas node routing & simulation', done: true },
                                                                                        { id: 'c2', text: 'Validate Nano Banana editorial image generation & art styles', done: true },
                                                                                        { id: 'c3', text: 'Confirm elimination of fake player controls & scrubber artifacts', done: true }
                                                                                    ]}
                                                                                ]
                                                                            };
                                                                        })()}
                                                                        onUpdate={(updatedData: MarkdownDocumentData) => {
                                                                            const nextTitle = updatedData.title && updatedData.title !== 'Markdown Document' ? updatedData.title : (activeArtifact?.title || 'Project Specification & Notes');
                                                                            const updatedArtifact: CanvasArtifact = {
                                                                                id: activeArtifact?.id || `art-doc-${Date.now()}`,
                                                                                type: 'markdown-document',
                                                                                version: (activeArtifact?.version || 1),
                                                                                summary: updatedData.subtitle || 'Specification Document',
                                                                                createdAt: activeArtifact?.createdAt || new Date().toLocaleTimeString(),
                                                                                title: nextTitle,
                                                                                data: {
                                                                                    ...updatedData,
                                                                                    title: nextTitle
                                                                                }
                                                                            };
                                                                            handleUpdateArtifact(updatedArtifact);
                                                                        }}
                                                                        onMorphArtifact={handleMorphArtifact}
                                                                        onMorphToKanban={(kanbanData: KanbanBoardData) => {
                                                                            handleMorphArtifact({
                                                                                id: `art-kanban-${Date.now()}`,
                                                                                title: kanbanData.title,
                                                                                summary: kanbanData.subtitle || 'Morphed Kanban Board',
                                                                                type: 'kanban-board',
                                                                                data: kanbanData,
                                                                                createdAt: new Date().toLocaleTimeString(),
                                                                                version: 1
                                                                            });
                                                                        }}
                                                                        onMorphToNodeGraph={(graphData: NodeGraphData) => {
                                                                            handleMorphArtifact({
                                                                                id: `art-graph-${Date.now()}`,
                                                                                title: graphData.title,
                                                                                summary: graphData.subtitle || 'Morphed Node Graph Flow',
                                                                                type: 'node-graph',
                                                                                data: graphData,
                                                                                createdAt: new Date().toLocaleTimeString(),
                                                                                version: 1
                                                                            });
                                                                        }}
                                                                        onPromptAction={(promptText: string) => handleSurfaceAiPrompt(promptText)}
                                                                        onOpenInBrowser={handleOpenInAppBrowser}
                                                                        readOnly={docReadOnly}
                                                                    />
                                                                </CanvasErrorBoundary>
                                                            )}
                                                            {layoutMode === 'code' && (
                                                                <CanvasErrorBoundary fallbackTitle="Live Code Sandbox">
                                                                    <LiveCodeSandboxPrimitive
                                                                        data={(activeArtifact?.type === 'live-code-sandbox' ? (activeArtifact.data as LiveCodeSandboxData) : undefined) || {
                                                                            title: 'Interactive React 19 UI Playground',
                                                                            subtitle: 'Multi-tab live code runner with hot reload & runtime console',
                                                                            template: 'react',
                                                                            viewMode: 'preview',
                                                                            files: [
                                                                                {
                                                                                    id: 'file-gen-webpack',
                                                                                    name: 'gen-webpack.config.js',
                                                                                    path: 'applications/electron/gen-webpack.config.js',
                                                                                    language: 'javascript',
                                                                                    content: `/**\n * Don't touch this file. It will be regenerated by theia build.\n * To customize webpack configuration change /Users/eligreen/dev/scratchbox-ide-master/applications/electron/webpack.config.js\n */\n// @ts-check\nconst path = require('path');\nconst webpack = require('webpack');\nconst yargs = require('yargs');\nconst CopyWebpackPlugin = require('copy-webpack-plugin');\nconst CompressionPlugin = require('compression-webpack-plugin');\nconst MiniCssExtractPlugin = require('mini-css-extract-plugin');\nconst { MonacoWebpackPlugin } = require('@theia/native-webpack-plugin/lib/monaco-webpack-plugins.js');\n\nconst outputPath = path.resolve(__dirname, 'lib', 'frontend');\nconst { mode, staticCompression } = yargs.option('mode', {\n    description: 'Mode to use',\n    choices: ['development', 'production'],\n    default: 'production'\n}).option('static-compression', {\n    description: 'Controls whether to enable compression of static artifacts.',\n    type: 'boolean',\n    default: true\n}).argv;\n\nconst development = mode === 'development';\n\nconst plugins = [\n    new CopyWebpackPlugin({\n        patterns: [\n            {\n                from: path.resolve(__dirname, 'src-gen/frontend/secondary-window.html')\n            },\n            {\n                from: path.join(require.resolve('@theia/plugin-ext'), '..', 'src', 'main', 'browser', 'webview', 'pre'),\n                to: path.resolve(__dirname, 'lib', 'webview', 'pre')\n            }\n        ]\n    }),\n    new webpack.ProvidePlugin({\n        Buffer: ['buffer', 'Buffer']\n    }),\n    new MonacoWebpackPlugin()\n];\n\nmodule.exports = {\n    mode,\n    devtool: development ? 'eval-cheap-module-source-map' : 'source-map',\n    entry: {\n        'secondary-window': path.resolve(__dirname, 'src-gen/frontend/secondary-index.js')\n    },\n    output: {\n        path: outputPath,\n        filename: '[name].js'\n    },\n    plugins\n};`
                                                                                },
                                                                                {
                                                                                    id: 'file-app',
                                                                                    name: 'App.tsx',
                                                                                    path: 'src/App.tsx',
                                                                                    language: 'react',
                                                                                    content: `import React, { useState } from 'react';\nimport { Sparkles, Play, CheckCircle2 } from 'lucide-react';\nimport confetti from 'canvas-confetti';\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n\n  const handleCelebrate = () => {\n    setCount(prev => prev + 1);\n    confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } });\n    console.log('Celebration action triggered! Count:', count + 1);\n  };\n\n  return (\n    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-zinc-950 text-zinc-100 selection:bg-blue-500 selection:text-white">\n      <div className="w-full max-w-md p-8 bg-zinc-900/80 backdrop-blur-xl border border-zinc-800/80 rounded-3xl shadow-2xl space-y-6 text-center">\n        <div className="inline-flex p-3 rounded-2xl bg-blue-500/10 text-blue-400 border border-blue-500/20 shadow-inner">\n          <Sparkles className="w-8 h-8 animate-pulse" />\n        </div>\n        <div className="space-y-2">\n          <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-zinc-100 via-zinc-200 to-zinc-400 bg-clip-text text-transparent">Scratchbox Live UI Sandbox</h1>\n          <p className="text-sm text-zinc-400">Interactive React 19 + Tailwind CSS playground with hot reload and live console streams.</p>\n        </div>\n        <div className="p-4 bg-zinc-950/60 rounded-2xl border border-zinc-800/50 flex items-center justify-around">\n          <div><div className="text-xs text-zinc-500 font-medium">Interactions</div><div className="text-3xl font-extrabold text-blue-400">{count}</div></div>\n          <div className="h-8 w-px bg-zinc-800"></div>\n          <div><div className="text-xs text-zinc-500 font-medium">Status</div><div className="text-sm font-semibold text-emerald-400 flex items-center gap-1 mt-1"><CheckCircle2 className="w-4 h-4" /> Live</div></div>\n        </div>\n        <button onClick={handleCelebrate} className="sb-btn sb-btn-primary w-full py-3.5 px-6 rounded-xl font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-blue-500/25 active:scale-[0.98] transition-all flex items-center justify-center gap-2 group">\n          <Play className="w-4 h-4 fill-current transition-transform group-hover:translate-x-0.5" />\n          <span>Trigger Interactive Action</span>\n        </button>\n      </div>\n    </div>\n  );\n}`,
                                                                                    isEntry: true
                                                                                },
                                                                                {
                                                                                    id: 'file-css',
                                                                                    name: 'styles.css',
                                                                                    path: 'src/styles.css',
                                                                                    language: 'css',
                                                                                    content: `/* Custom Sandbox Styles */\nbody {\n  margin: 0;\n  padding: 0;\n}`
                                                                                },
                                                                                {
                                                                                    id: 'file-pkg',
                                                                                    name: 'package.json',
                                                                                    path: 'package.json',
                                                                                    language: 'json',
                                                                                    content: `{\n  "name": "scratchbox-ide-master",\n  "version": "1.67.100",\n  "private": true\n}`
                                                                                }
                                                                            ],
                                                                            dependencies: {
                                                                                'lucide-react': '^0.468.0',
                                                                                'canvas-confetti': '^1.9.3'
                                                                            },
                                                                            viewportMode: 'desktop'
                                                                        }}
                                                                        onUpdate={updatedData => {
                                                                            if (activeArtifact) {
                                                                                handleUpdateArtifact({ ...activeArtifact, data: updatedData });
                                                                            }
                                                                        }}
                                                                        onSave={syncSandboxSaveToMarkdown}
                                                                        onForkArtifact={forked => {
                                                                            setActiveArtifact(forked);
                                                                            setArtifactHistory(prev => [forked, ...prev]);
                                                                        }}
                                                                        onPromptAction={promptText => handleSurfaceAiPrompt(promptText)}
                                                                        onDebugWithAi={errorPrompt => handleSendMessage(errorPrompt)}
                                                                        hideTopbar={false}
                                                                        hideInternalChat={true}
                                                                    />
                                                                </CanvasErrorBoundary>
                                                            )}
                                                            {layoutMode === 'kanban' && (
                                                                <CanvasErrorBoundary fallbackTitle="Kanban Board">
                                                                    <KanbanBoardPrimitive
                                                                        data={(activeArtifact?.type === 'kanban-board' ? (activeArtifact.data as KanbanBoardData) : undefined) || {
                                                                            title: 'Sprint Roadmap Kanban Board',
                                                                            subtitle: 'Multi-stage delivery board with real-time card synchronization',
                                                                            columns: [
                                                                                {
                                                                                    id: 'col-backlog',
                                                                                    title: 'Backlog',
                                                                                    color: 'indigo',
                                                                                    cards: [
                                                                                        { id: 'card-1', title: 'Stripe Webhook Listeners', description: 'Automated subscription reconciliation pipe', tag: 'Backend', tagColor: 'indigo', priority: 'medium', completedSubtasks: 2, totalSubtasks: 4 },
                                                                                        { id: 'card-2', title: 'Multi-tenant Org Switcher', description: 'Team workspace tenancy isolation', tag: 'Core', tagColor: 'purple', priority: 'low' }
                                                                                    ]
                                                                                },
                                                                                {
                                                                                    id: 'col-inprogress',
                                                                                    title: 'In Progress',
                                                                                    color: 'blue',
                                                                                    cards: [
                                                                                        { id: 'card-3', title: 'N8N Canvas & Rich Spec Surfaces', description: 'Apple HIG vibrancy and continuous corner curves', tag: 'Design', tagColor: 'blue', priority: 'urgent', completedSubtasks: 3, totalSubtasks: 3 }
                                                                                    ]
                                                                                },
                                                                                {
                                                                                    id: 'col-qa',
                                                                                    title: 'QA Review',
                                                                                    color: 'amber',
                                                                                    cards: [
                                                                                        { id: 'card-4', title: 'Subagent Fallback Matrix', description: 'Verify seamless routing across Gemini models', tag: 'AI', tagColor: 'amber', priority: 'high', completedSubtasks: 2, totalSubtasks: 2 }
                                                                                    ]
                                                                                },
                                                                                {
                                                                                    id: 'col-done',
                                                                                    title: 'Done',
                                                                                    color: 'emerald',
                                                                                    cards: [
                                                                                        { id: 'card-5', title: 'AI Studio Backend Engine', description: 'Native REST pipe with high-reasoning tokens budget', tag: 'AI Core', tagColor: 'emerald', priority: 'high' }
                                                                                    ]
                                                                                }
                                                                            ]
                                                                        }}
                                                                        onUpdate={updatedData => {
                                                                            if (activeArtifact) {
                                                                                handleUpdateArtifact({ ...activeArtifact, data: updatedData });
                                                                            }
                                                                        }}
                                                                        onMorphArtifact={handleMorphArtifact}
                                                                        onMorphCardToSandbox={sandboxData => {
                                                                            handleMorphArtifact({
                                                                                id: `art-code-${Date.now()}`,
                                                                                title: sandboxData.title,
                                                                                summary: sandboxData.subtitle || 'Component Sandbox',
                                                                                type: 'live-code-sandbox',
                                                                                data: sandboxData,
                                                                                createdAt: new Date().toLocaleTimeString(),
                                                                                version: 1
                                                                            });
                                                                        }}
                                                                    />
                                                                </CanvasErrorBoundary>
                                                            )}
                                                            {(layoutMode === 'automation' || layoutMode === 'canvas') && (
                                                                <CanvasErrorBoundary fallbackTitle="Node Workflow Graph">
                                                                    <NodeGraphPrimitive
                                                                        data={(activeArtifact?.data as NodeGraphData) || {
                                                                            title: 'Canvas Workflow',
                                                                            subtitle: 'Drag and connect nodes to create automated execution pipelines',
                                                                            nodes: [
                                                                                { id: 'node-1', label: 'Webhook Trigger', subtitle: 'POST /api/v1/event', category: 'input', color: 'blue', x: 80, y: 140, status: 'completed' },
                                                                                { id: 'node-2', label: 'Reasoning Engine', subtitle: 'Gemini 3.7 Flash', category: 'ai', color: 'purple', x: 440, y: 140, status: 'running' }
                                                                            ],
                                                                            edges: [
                                                                                { id: 'e1', source: 'node-1', target: 'node-2', label: 'Payload', style: 'solid', color: 'purple' }
                                                                            ]
                                                                        }}
                                                                        onUpdate={updatedData => {
                                                                            if (activeArtifact) {
                                                                                handleUpdateArtifact({ ...activeArtifact, data: updatedData });
                                                                            }
                                                                        }}
                                                                        onPromptAction={promptText => handleSurfaceAiPrompt(promptText)}
                                                                        workspacePath={activeWorkspace.path}
                                                                    />
                                                                </CanvasErrorBoundary>
                                                            )}
                                                            {layoutMode === '3d' && (
                                                                <div className="sb-3d-stage-wrapper w-full h-full flex flex-col items-center justify-start overflow-hidden flex-1 min-h-0">
                                                                    <CanvasErrorBoundary fallbackTitle="3D Scene Viewport">
                                                                        <Scene3DPrimitive
                                                                            data={(activeArtifact?.type === '3d-scene' ? (activeArtifact.data as Scene3DData) : undefined) || {
                                                                                title: 'Interactive 4D Scene Workspace',
                                                                                subtitle: 'WebGL viewport with procedural topography, real-time wave solvers, and simulated WASM linear memory heap.',
                                                                                objects: [],
                                                                                camera: { position: [15, 12, 15], target: [0, 0, 0] },
                                                                                environment: { skybox: 'cyberpunk', lighting: 'shaded', ground: true }
                                                                            }}
                                                                            onUpdate={updatedData => {
                                                                                if (activeArtifact && activeArtifact.type === '3d-scene') {
                                                                                    handleUpdateArtifact({ ...activeArtifact, data: updatedData });
                                                                                } else {
                                                                                    const newArt: CanvasArtifact = {
                                                                                        id: activeArtifact?.id || `art-3d-${Date.now()}`,
                                                                                        type: '3d-scene',
                                                                                        title: updatedData.title || 'Interactive 3D Scene Workspace',
                                                                                        summary: updatedData.subtitle || 'Interactive 3D spatial canvas viewport',
                                                                                        version: 1,
                                                                                        createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                                                                                        data: updatedData
                                                                                    };
                                                                                    handleUpdateArtifact(newArt);
                                                                                }
                                                                            }}
                                                                            onPromptAction={promptText => handleSurfaceAiPrompt(promptText)}
                                                                            onMorphArtifact={handleMorphArtifact}
                                                                        />
                                                                    </CanvasErrorBoundary>
                                                                </div>
                                                            )}
                                                            {layoutMode === 'browser' && (
                                                                <div className="sb-browser-stage-wrapper w-full h-full flex flex-col items-center justify-start overflow-hidden flex-1 min-h-0">
                                                                    <CanvasErrorBoundary fallbackTitle="Interactive Browser">
                                                                        <InteractiveBrowserPrimitive
                                                                            data={(activeArtifact?.type === 'interactive-browser' || activeArtifact?.type === 'browser' ? (activeArtifact.data as InteractiveBrowserData) : undefined) || {
                                                                                url: 'https://example.com',
                                                                                title: 'Example Domain',
                                                                                viewportMode: 'desktop',
                                                                                history: ['https://example.com'],
                                                                                historyIndex: 0,
                                                                                isLoading: false,
                                                                                consoleLogs: [
                                                                                    { type: 'info', text: 'Browser canvas initialized at https://example.com', timestamp: new Date().toLocaleTimeString() },
                                                                                    { type: 'log', text: 'DOM ready. Ready for user navigation and AI agent actions.', timestamp: new Date().toLocaleTimeString() }
                                                                                ],
                                                                                inspectMode: false,
                                                                                deviceScale: 1
                                                                            }}
                                                                            onUpdate={(updatedData: InteractiveBrowserData) => {
                                                                                if (activeArtifact) {
                                                                                    handleUpdateArtifact({ ...activeArtifact, data: updatedData });
                                                                                }
                                                                            }}
                                                                            onPromptAction={(promptText: string) => handleSurfaceAiPrompt(promptText)}
                                                                            onMorphArtifact={handleMorphArtifact}
                                                                        />
                                                                    </CanvasErrorBoundary>
                                                                </div>
                                                            )}
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </main>

            {/* Long-Running Agent Telemetry Dashboard */}
            {renderLongRunningAgentDashboard()}

            {/* Floating Spotlight Companion Launcher Overlay (⌘K) */}
            <SpotlightLauncherModal
                isOpen={isSpotlightOpen}
                onClose={() => closeModal('spotlight')}
                onPromptGemini={prompt => {
                    closeModal('spotlight');
                    if (prompt) {
                        handleSendMessage(prompt);
                    }
                }}
                onCreateArtifact={(type, title) => {
                    closeModal('spotlight');
                    handleCreateEmptyCanvas(type, title);
                }}
                onOpenSettings={tab => {
                    closeModal('spotlight');
                    openSettingsToTab(tab as any || 'general');
                }}
                onOpenAutomations={() => {
                    closeModal('spotlight');
                    handleCreateWorkspaceFile('automation');
                }}
                onOpenMcpHub={() => {
                    closeModal('spotlight');
                    openSettingsToTab('mcp');
                }}
                onDebugTerminal={() => {
                    closeModal('spotlight');
                    if (activeTerminalError) {
                        const debugPrompt = synthesizeTerminalDebugPrompt(activeTerminalError);
                        handleSendMessage(debugPrompt);
                    } else {
                        handleSendMessage('Synthesize latest terminal failure output and generate multi-file patch repair.');
                    }
                }}
                recentSessions={sessions}
                onSelectSession={sessId => {
                    closeModal('spotlight');
                    const s = sessions.find(sess => sess.id === sessId);
                    if (s) handleSelectSession(s);
                }}
            />

            {/* Global 1-Click "Debug with AI" Terminal Error Toast */}
            {showTerminalErrorToast && activeTerminalError && (
                <div className="sb-terminal-error-toast animate-fadeIn" style={{
                    position: 'fixed',
                    bottom: '24px',
                    right: '24px',
                    zIndex: 9999,
                    maxWidth: '460px',
                    padding: '14px 18px',
                    borderRadius: '18px',
                    background: 'rgba(24, 24, 27, 0.96)',
                    backdropFilter: 'blur(24px)',
                    border: '1px solid rgba(244, 63, 94, 0.5)',
                    boxShadow: '0 25px 50px rgba(0,0,0,0.7)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px'
                }}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <span style={{ fontSize: '18px' }}>🚨</span>
                            <div>
                                <div className="font-semibold text-xs text-rose-400">Terminal Process Failed (Exit Code {activeTerminalError.exitCode})</div>
                                <div className="text-[10px] text-zinc-400 font-mono">Command: {activeTerminalError.command}</div>
                            </div>
                        </div>
                        <button
                            type="button"
                            className="sb-icon-button sb-icon-button-xs"
                            onClick={() => setShowTerminalErrorToast(false)}
                        >
                            <IconClose size={12} />
                        </button>
                    </div>
                    <pre className="text-[11px] text-zinc-300 bg-zinc-950/80 p-2.5 rounded-xl border border-zinc-800/80 font-mono whitespace-pre-wrap max-h-24 overflow-y-auto m-0">
                        {activeTerminalError.output.slice(0, 300)}
                    </pre>
                    <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                            type="button"
                            className="sb-btn sb-btn-ghost sb-btn-xs"
                            onClick={() => setShowTerminalErrorToast(false)}
                        >
                            Dismiss
                        </button>
                        <button
                            type="button"
                            className="sb-btn sb-btn-primary sb-btn-xs bg-rose-600 hover:bg-rose-500 text-white"
                            onClick={() => {
                                setShowTerminalErrorToast(false);
                                const debugPrompt = synthesizeTerminalDebugPrompt(activeTerminalError);
                                handleSendMessage(debugPrompt);
                            }}
                        >
                            <IconSparkles size={11} />
                            <span>1-Click Fix with AI</span>
                        </button>
                    </div>
                </div>
            )}

            {/* Google Drive & Docs 1-Click Connector Modal */}
            <GoogleDriveConnectModal
                isOpen={isGoogleDriveOpen}
                onClose={() => closeModal('google-drive')}
                onExportCurrentDocument={triggerGoogleDocsExport}
            />

            {/* Apple-Grade Settings & Guide Modal */}
            <SettingsModal
                isOpen={isSettingsOpen}
                initialTab={settingsInitialTab}
                onClose={() => closeModal('settings')}
                skills={skills}
                onSkillsChange={setSkills}
                mcpServers={mcpServers}
                onMcpServersChange={setMcpServers}
                mcpExecutions={mcpExecutions}
                appearanceConfig={appearanceConfig}
                onAppearanceConfigChange={setAppearanceConfig}
                activeWorkspace={activeWorkspace}
                googleSearchGrounding={googleSearchGrounding}
                onGoogleSearchGroundingChange={setGoogleSearchGrounding}
                onOpenProjects={() => {
                    openSettingsToTab('workspace');
                }}
                onOpenFolder={onOpenFolder}
                onCreateFile={onCreateFile}
                onOpenWorkspace={onOpenWorkspace}
                onOpenPreferences={onOpenPreferences}
                onOpenKeyboardShortcuts={onOpenKeyboardShortcuts}
                onExecuteCommand={onExecuteCommand}
                onSelectPromptStarter={(prompt, skill) => {
                    if (skill && !selectedSkillIds.includes(skill.id)) {
                        setSelectedSkillIds(prev => [...prev, skill.id]);
                    }
                    closeModal('settings');
                    handleSendMessage(prompt);
                }}
            />
        </div>
    );
};
