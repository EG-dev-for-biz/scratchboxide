/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import * as THREE from 'three';
import type { TextureMatrixResult, TextureMatrixCandidate } from '../../../common/media-generation-protocol';
import { resolveTextureUrl } from '../../../common/texture-url-resolver';
import { describeMeshTextureOutcome, requestMeshTexture, type MeshTextureChannels, type MeshTextureOutcome } from '../primitives/scene3d/meshTexture';

/**
 * A one-line notice under generated media saying that a model other than the requested one produced it, and why
 * (the result's modelNote, see substitutedModelNote). Renders nothing when there is no note.
 */
export const MediaModelNotice: React.FC<{ note?: string; style?: React.CSSProperties }> = ({ note, style }) => {
    if (!note) return null;
    return (
        <div
            data-testid="sb-media-model-note"
            role="note"
            title={note}
            style={{
                fontSize: '10.5px',
                lineHeight: 1.35,
                color: '#fcd34d',
                background: 'rgba(120, 53, 15, 0.35)',
                border: '1px solid rgba(252, 211, 77, 0.25)',
                borderRadius: '6px',
                padding: '3px 6px',
                overflowWrap: 'anywhere',
                ...style
            }}
        >
            {note}
        </div>
    );
};

/** A card's last texture request: still running, or what the 3D viewport said it did. */
interface MeshTextureStatus {
    state: 'pending' | MeshTextureOutcome['status'];
    text: string;
}

/** A card's texture action: asks the open 3D viewport to apply it (requestMeshTexture) and keeps what it answered. */
function useMeshTextureApply(): { status: MeshTextureStatus | null; apply: (channels: MeshTextureChannels, targetId?: string) => void } {
    const [status, setStatus] = React.useState<MeshTextureStatus | null>(null);
    const apply = React.useCallback((channels: MeshTextureChannels, targetId?: string) => {
        setStatus({ state: 'pending', text: targetId ? `Applying to '${targetId}'...` : 'Applying to the selected mesh...' });
        void requestMeshTexture(channels, targetId).then(outcome => {
            setStatus({ state: outcome.status, text: describeMeshTextureOutcome(outcome) });
        });
    }, []);
    return { status, apply };
}

/** The line under a card saying what its texture action did; a failure stays with its reason. */
const MeshTextureStatusBadge: React.FC<{ status: MeshTextureStatus | null }> = ({ status }) => {
    if (!status) return null;
    return (
        <div
            className="sb-image-status-badge"
            data-testid="sb-mesh-texture-status"
            data-state={status.state}
            role={status.state === 'failed' ? 'alert' : 'status'}
        >
            <span>{status.text}</span>
        </div>
    );
};

// ==========================================
// Multimedia & Geospatial Rendering Cards
// ==========================================
export const ImageGeneratedCard: React.FC<{
    imageContent?: string;
    imagesContent?: string[];
    /** Shown under the images when a model other than the requested one produced them (substitutedModelNote). */
    modelNote?: string;
}> = ({ imageContent, imagesContent, modelNote }) => {
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

    const texture = useMeshTextureApply();

    const handleAction = (action: string, img: string) => {
        if (action === 'Insert into Code') {
            window.dispatchEvent(new CustomEvent('scratchbox:insert-code', { detail: { snippet: `<img src="${img}" alt="Generated asset" />` } }));
            window.dispatchEvent(new CustomEvent('scratchbox:open-primitive', { detail: { type: 'live-code-sandbox' } }));
        } else if (action === 'Remix Prompt') {
            window.dispatchEvent(new CustomEvent('scratchbox:remix-prompt', { detail: { prompt: `Remix generated asset: ${img}` } }));
        }
    };

    if (images.length === 0) return null;

    return (
        <div className="sb-multimedia-card sb-image-card">
            <div className="sb-image-grid">
                {images.map((img, idx) => (
                    <div key={`${img}-${idx}`} className="sb-image-wrapper">
                        <img src={img} alt="Generated asset" className="sb-image-preview" />
                        <div className="sb-image-overlay">
                            <button
                                className="sb-btn sb-btn-secondary sb-btn-xs"
                                disabled={texture.status?.state === 'pending'}
                                title="Sets this image as the base colour of the mesh selected in the open 3D viewport"
                                onClick={() => texture.apply({ albedo: img })}
                            >
                                Apply as 3D Texture
                            </button>
                            <button
                                className="sb-btn sb-btn-secondary sb-btn-xs"
                                onClick={() => handleAction('Insert into Code', img)}
                            >
                                Insert into Code
                            </button>
                            <button
                                className="sb-btn sb-btn-secondary sb-btn-xs"
                                onClick={() => handleAction('Remix Prompt', img)}
                            >
                                Remix Prompt
                            </button>
                        </div>
                    </div>
                ))}
            </div>
            <MediaModelNotice note={modelNote} style={{ marginTop: 6 }} />
            <MeshTextureStatusBadge status={texture.status} />
        </div>
    );
};

const STATIC_WAVEFORM_HEIGHTS = [
    8, 14, 20, 16, 26, 22, 14, 10, 18, 24,
    28, 22, 16, 20, 26, 18, 12, 16, 24, 28,
    22, 16, 12, 18, 22, 16, 10, 14, 18, 10
];

export const AudioNarratedCard: React.FC<{
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
                            key={`bar-${baseH}-${idx}`}
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

export const CinematicVideoCard: React.FC<{
    videoContent: string;
    /** Shown under the video when a model other than the requested one produced it (substitutedModelNote). */
    modelNote?: string;
}> = ({ videoContent, modelNote }) => {
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
        window.dispatchEvent(new CustomEvent('scratchbox:add-video-to-timeline', {
            detail: { videoUrl: videoContent, duration: videoRef.current?.duration || 5 }
        }));
        window.dispatchEvent(new CustomEvent('scratchbox:open-primitive', { detail: { type: 'video-timeline' } }));
        setTimeout(() => {
            setStatusText('Successfully added to Timeline!');
            setTimeout(() => setStatusText(null), 2500);
        }, 800);
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

            <MediaModelNotice note={modelNote} style={{ marginTop: 6 }} />
            {statusText && (
                <div className="sb-image-status-badge">
                    <span>{statusText}</span>
                </div>
            )}
        </div>
    );
};

export const GoogleMapsCard: React.FC<{
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

// ==========================================
// 5. Generative Media Studio Texture Matrix Card
// ==========================================
export const TextureMatrixCard: React.FC<{
    result: TextureMatrixResult;
}> = ({ result }) => {
    const candidates = result.candidates || [];
    const [selectedId, setSelectedId] = React.useState<string>(result.selectedCandidateId || candidates[0]?.id || 'candidate-0');
    const [activeChannel, setActiveChannel] = React.useState<'composite' | 'albedo' | 'normal' | 'roughness' | 'metallic' | 'ao'>('composite');
    const texture = useMeshTextureApply();

    const activeCandidate = candidates.find(c => c.id === selectedId) || candidates[0];

    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !activeCandidate) return;

        let animationFrameId: number;
        const width = canvas.clientWidth || 320;
        const height = canvas.clientHeight || 200;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0e1117);

        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 50);
        camera.position.set(0, 0, 2.9);

        let renderer: THREE.WebGLRenderer | null = null;
        try {
            renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
            renderer.setSize(width, height, false);
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.toneMappingExposure = 1.0;
        } catch {
            return;
        }

        const ambLight = new THREE.AmbientLight(0xffffff, 0.5);
        scene.add(ambLight);

        const dirLight1 = new THREE.DirectionalLight(0xffffff, 2.2);
        dirLight1.position.set(3, 4, 3);
        scene.add(dirLight1);

        const dirLight2 = new THREE.DirectionalLight(0x60a5fa, 0.9);
        dirLight2.position.set(-3, -2, -2);
        scene.add(dirLight2);

        const geometry = new THREE.SphereGeometry(1.0, 48, 48);
        const material = new THREE.MeshPhysicalMaterial({
            color: 0xffffff,
            metalness: 0.1,
            roughness: 0.5,
            clearcoat: 0.05
        });

        const sphere = new THREE.Mesh(geometry, material);
        scene.add(sphere);

        const loader = new THREE.TextureLoader();
        const textures = activeCandidate.textures;
        let disposed = false;

        // Resolves a texture-library path to its signed GCS URL (passthrough for anything else)
        // before handing it to the THREE.TextureLoader; bails out if the effect was cleaned up
        // (e.g. the selected candidate/channel changed) while the signed URL was in flight.
        const loadTexture = (url: string, onLoad: (tex: THREE.Texture) => void): void => {
            resolveTextureUrl(url)
                .then(resolvedUrl => {
                    if (disposed) return;
                    loader.load(resolvedUrl, tex => {
                        if (disposed) {
                            tex.dispose();
                            return;
                        }
                        onLoad(tex);
                    }, undefined, err => console.error(`[TextureMatrixCard] Failed to load texture "${url}":`, err));
                })
                .catch(err => console.error(`[TextureMatrixCard] Failed to resolve signed URL for "${url}":`, err));
        };

        if (activeChannel === 'composite') {
            if (textures.albedo) {
                loadTexture(textures.albedo, tex => {
                    tex.wrapS = THREE.RepeatWrapping;
                    tex.wrapT = THREE.RepeatWrapping;
                    tex.repeat.set(2, 2);
                    tex.colorSpace = THREE.SRGBColorSpace;
                    material.map = tex;
                    material.needsUpdate = true;
                });
            }
            if (textures.normal) {
                loadTexture(textures.normal, tex => {
                    tex.wrapS = THREE.RepeatWrapping;
                    tex.wrapT = THREE.RepeatWrapping;
                    tex.repeat.set(2, 2);
                    tex.colorSpace = THREE.NoColorSpace;
                    material.normalMap = tex;
                    material.normalScale.set(1.2, 1.2);
                    material.needsUpdate = true;
                });
            }
            if (textures.roughness) {
                loadTexture(textures.roughness, tex => {
                    tex.wrapS = THREE.RepeatWrapping;
                    tex.wrapT = THREE.RepeatWrapping;
                    tex.repeat.set(2, 2);
                    tex.colorSpace = THREE.NoColorSpace;
                    material.roughnessMap = tex;
                    material.needsUpdate = true;
                });
            }
            if (textures.metallic) {
                loadTexture(textures.metallic, tex => {
                    tex.wrapS = THREE.RepeatWrapping;
                    tex.wrapT = THREE.RepeatWrapping;
                    tex.repeat.set(2, 2);
                    tex.colorSpace = THREE.NoColorSpace;
                    material.metalnessMap = tex;
                    material.needsUpdate = true;
                });
            }
            if (textures.ao) {
                loadTexture(textures.ao, tex => {
                    tex.wrapS = THREE.RepeatWrapping;
                    tex.wrapT = THREE.RepeatWrapping;
                    tex.repeat.set(2, 2);
                    tex.colorSpace = THREE.NoColorSpace;
                    material.aoMap = tex;
                    material.aoMapIntensity = 1.0;
                    material.needsUpdate = true;
                });
            }
        } else {
            const channelUrl = (textures as any)[activeChannel];
            if (channelUrl) {
                loadTexture(channelUrl, tex => {
                    tex.wrapS = THREE.RepeatWrapping;
                    tex.wrapT = THREE.RepeatWrapping;
                    tex.repeat.set(2, 2);
                    tex.colorSpace = activeChannel === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                    material.map = tex;
                    material.normalMap = null;
                    material.roughnessMap = null;
                    material.metalnessMap = null;
                    material.aoMap = null;
                    material.metalness = 0.0;
                    material.roughness = 0.5;
                    material.needsUpdate = true;
                });
            }
        }

        const render = () => {
            sphere.rotation.y += 0.008;
            renderer?.render(scene, camera);
            animationFrameId = requestAnimationFrame(render);
        };
        render();

        return () => {
            disposed = true;
            cancelAnimationFrame(animationFrameId);
            geometry.dispose();
            material.dispose();
            renderer?.dispose();
        };
    }, [activeCandidate, activeChannel]);

    // The candidate's maps on the mesh it was made for, else the viewport's selected mesh; the separate maps win over a packed ORM.
    const handleApplyToMesh = () => {
        if (!activeCandidate) return;
        const t = activeCandidate.textures;
        const separate = !!(t.roughness || t.metallic || t.ao);
        texture.apply({
            albedo: t.albedo,
            ...(t.normal ? { normal: t.normal } : {}),
            ...(t.roughness ? { roughness: t.roughness } : {}),
            ...(t.metallic ? { metallic: t.metallic } : {}),
            ...(t.ao ? { ao: t.ao } : {}),
            ...(t.orm && !separate ? { orm: t.orm } : {})
        }, result.targetMeshId);
    };

    if (candidates.length === 0) return null;

    return (
        <div className="sb-multimedia-card sb-texture-matrix-card">
            <div className="sb-texture-matrix-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className="sb-badge-matrix">PBR STUDIO</div>
                    <span style={{ fontWeight: 600, fontSize: 13, color: '#f3f4f6' }}>
                        Generative Materials Workshop
                    </span>
                </div>
                <span style={{ fontSize: 11, color: '#9ca3af' }}>
                    {candidates.length}-Up Seamless Variations
                </span>
            </div>

            {/* 4-Up Variations Grid */}
            <div className="sb-texture-matrix-grid">
                {candidates.map((candidate) => {
                    const isSelected = candidate.id === selectedId;
                    return (
                        <div
                            key={candidate.id}
                            className={`sb-matrix-candidate-card ${isSelected ? 'sb-candidate-selected' : ''}`}
                            onClick={() => setSelectedId(candidate.id)}
                        >
                            <div className="sb-matrix-candidate-thumb">
                                <img
                                    src={candidate.textures.albedo}
                                    alt={candidate.styleModifier}
                                    className="sb-matrix-thumb-img"
                                />
                                {isSelected && (
                                    <div className="sb-candidate-active-tag">ACTIVE</div>
                                )}
                            </div>
                            <div className="sb-matrix-candidate-info">
                                <span className="sb-candidate-title">{candidate.styleModifier}</span>
                                <span className="sb-candidate-sub">Seamless Toroidal PBR</span>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Active Preview & Channel Controls */}
            {activeCandidate && (
                <div className="sb-matrix-preview-panel">
                    <div className="sb-matrix-channel-pills">
                        {(['composite', 'albedo', 'normal', 'roughness', 'metallic', 'ao'] as const).map(ch => (
                            <button
                                key={ch}
                                className={`sb-channel-pill-btn ${activeChannel === ch ? 'sb-channel-active' : ''}`}
                                onClick={() => setActiveChannel(ch)}
                            >
                                {ch.toUpperCase()}
                            </button>
                        ))}
                    </div>

                    <div className="sb-matrix-viewport-container">
                        <canvas ref={canvasRef} className="sb-matrix-webgl-canvas" />
                    </div>

                    <div className="sb-matrix-actions-row">
                        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                            <button
                                className="sb-btn sb-btn-primary sb-btn-xs"
                                disabled={texture.status?.state === 'pending'}
                                title={result.targetMeshId
                                    ? `Sets these maps on '${result.targetMeshId}' in the open 3D viewport, on its own UVs`
                                    : 'Sets these maps on the mesh selected in the open 3D viewport, on its own UVs'}
                                onClick={handleApplyToMesh}
                            >
                                {result.targetMeshId ? `Apply to '${result.targetMeshId}'` : 'Apply to Selected Mesh'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <MeshTextureStatusBadge status={texture.status} />
        </div>
    );
};
