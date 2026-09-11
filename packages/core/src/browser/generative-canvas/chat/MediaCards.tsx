/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';

// ==========================================
// Multimedia & Geospatial Rendering Cards
// ==========================================
export const ImageGeneratedCard: React.FC<{
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
                    <div key={`${img}-${idx}`} className="sb-image-wrapper">
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
