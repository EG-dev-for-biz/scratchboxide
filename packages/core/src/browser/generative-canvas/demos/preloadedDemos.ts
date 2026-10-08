/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { CanvasArtifact, Scene3DData, NodeGraphData, LiveCodeSandboxData, MetricDashboardData } from '../canvas-types';
import { VideoTimelineData } from '../services/video/videoTypes';

export interface ShowcaseDemoItem {
    id: string;
    title: string;
    subtitle: string;
    category: '3d' | 'video' | 'graph' | 'sandbox' | 'dashboard';
    categoryLabel: string;
    description: string;
    tags: string[];
    highlightBadge: string;
    artifact: CanvasArtifact;
    introMessage: string;
}

// ----------------------------------------------------------------------------------
// Demo 1: 3D Geospatial Engine & Midtown Manhattan Digital Twin
// ----------------------------------------------------------------------------------
const demo3dSceneData: Scene3DData = {
    title: 'Midtown Manhattan 3D Geospatial Digital Twin',
    subtitle: 'Photogrammetric 3D Tile Ingestion & Native C++20 SDF Terrain Reconstruction',
    sceneType: 'city',
    renderMode: 'shaded',
    cameraMode: 'orbit',
    selectedMeshId: 'esb-tower-primary',
    camera: {
        position: [260, 380, 420],
        target: [-47, 200, -26],
        fov: 55
    },
    environment: {
        skybox: 'clear_daylight',
        timeOfDay: 14.5,
        sunElevation: 42,
        sunAzimuth: 195,
        cinematicRig: 'three_point_studio',
        kelvinTemperature: 5600,
        ground: true,
        groundColor: '#1a1d24',
        ambientIntensity: 0.85,
        fog: {
            color: '#1e2330',
            density: 0.0003,
            near: 100,
            far: 3500
        },
        aerialPerspective: {
            enabled: true,
            inscatteringIntensity: 0.8,
            aerialPerspectiveRange: 800,
            albedoScale: 1.0,
            fogDensity: 0.002,
            fogHeight: 150
        },
        cloudShadows: {
            enabled: true,
            intensity: 0.35,
            scale: 250,
            altitude: 800,
            atmosphereShadowLength: 120,
            windVector: [1.2, 0.8]
        },
        tonemapping: {
            curve: 'aces',
            exposure: 1.1,
            vignette: 0.25
        }
    },
    geoAnchor: {
        lat: 40.7484,
        lng: -73.9857,
        elevation: 381,
        active: true,
        landmarkName: 'Empire State Building',
        castingArchetype: 'Digital Twin High-Rise Architecture',
        castingRationale: 'Google Photorealistic 3D Tiles streamed with sub-millimeter geometric error target SSE < 0.5'
    },
    objects: [
        {
            id: 'esb-tower-primary',
            content: {
                type: '3d-model',
                durableUri: '/models/google_midtown_lowpoly_map.glb',
                mimeType: 'model/gltf-binary',
                metadata: {
                    dims: { width: 100, height: 381, depth: 100 },
                    material: {
                        color: '#e2e8f0',
                        roughness: 0.45,
                        metalness: 0.25
                    }
                }
            },
            space: {
                spatial3d: { x: 0, y: 0, z: 0 }
            }
        }
    ]
};

// ----------------------------------------------------------------------------------
// Demo 2: Pro Video Timeline NLE & 6-DoF Matchmove Camera Solve
// ----------------------------------------------------------------------------------
const demoVideoTimelineData: VideoTimelineData = {
    title: 'VFX Matchmove & Neural Restyling NLE Studio',
    subtitle: '6-DoF Camera Solve, Anti-Drift Holdout Mattes & Split-Screen Synthesis',
    currentTime: 2.5,
    duration: 10.0,
    fps: 30,
    aspectRatio: '16:9',
    zoom: 1.2,
    isPlaying: false,
    snappingEnabled: true,
    tracks: [
        {
            id: 'track-vfx-plate',
            name: 'Track 1: 3D Blockout Plate (<VIDEO_REF_0>)',
            type: '3d',
            locked: false,
            visible: true,
            color: '#3b82f6',
            height: 64,
            elements: [
                {
                    id: 'elem-blockout',
                    name: 'Google Photorealistic 3D Tiles Blockout',
                    trackId: 'track-vfx-plate',
                    type: 'video',
                    url: '/videos/google_tiles_textured_blockout_camera.mp4',
                    startTime: 0.0,
                    duration: 10.0,
                    trimStart: 0.0,
                    trimEnd: 10.0,
                    opacity: 1.0,
                    color: '#2563eb',
                    isVfxPlate: true,
                    vfxPlate: {
                        solveConfidence: 0.985,
                        cameraCoordinateSystem: 'RightHandedZUp',
                        groundPlaneTolerance: 0.012
                    }
                }
            ]
        },
        {
            id: 'track-neural-omni',
            name: 'Track 2: Vertex AI Omni 1.1 Restyle',
            type: 'video',
            locked: false,
            visible: true,
            color: '#10b981',
            height: 64,
            elements: [
                {
                    id: 'elem-omni',
                    name: 'Neural Omni Cinematic Synthesis (Golden Hour Restyle)',
                    trackId: 'track-neural-omni',
                    type: 'video',
                    url: '/videos/google_tiles_omni_restyled.mp4',
                    startTime: 0.0,
                    duration: 10.0,
                    trimStart: 0.0,
                    trimEnd: 10.0,
                    opacity: 1.0,
                    color: '#059669'
                }
            ]
        },
        {
            id: 'track-comparison',
            name: 'Track 3: Side-by-Side 50/50 Verification Split',
            type: 'video',
            locked: false,
            visible: true,
            color: '#f59e0b',
            height: 64,
            elements: [
                {
                    id: 'elem-comparison',
                    name: 'Synchronized 50/50 Side-by-Side Inspection',
                    trackId: 'track-comparison',
                    type: 'video',
                    url: '/videos/google_tiles_textured_vs_omni_comparison.mp4',
                    startTime: 0.0,
                    duration: 10.0,
                    trimStart: 0.0,
                    trimEnd: 10.0,
                    opacity: 0.85,
                    blendMode: 'screen',
                    color: '#d97706'
                }
            ]
        }
    ],
    mediaAssets: [
        {
            id: 'asset-blockout',
            name: 'google_tiles_textured_blockout_camera.mp4',
            type: 'video',
            url: '/videos/google_tiles_textured_blockout_camera.mp4',
            duration: 10.0
        },
        {
            id: 'asset-omni',
            name: 'google_tiles_omni_restyled.mp4',
            type: 'video',
            url: '/videos/google_tiles_omni_restyled.mp4',
            duration: 10.0
        },
        {
            id: 'asset-comp',
            name: 'google_tiles_textured_vs_omni_comparison.mp4',
            type: 'video',
            url: '/videos/google_tiles_textured_vs_omni_comparison.mp4',
            duration: 10.0
        }
    ]
};

// ----------------------------------------------------------------------------------
// Demo 3: ComfyUI / Diffusion Node Graph Pipeline
// ----------------------------------------------------------------------------------
const demoNodeGraphData: NodeGraphData = {
    title: 'Autonomous Spatial VFX & Diffusion Pipeline Graph',
    subtitle: 'NVIDIA L4 Cloud Run Acceleration with ComfyUI Dynamic Code Injection',
    nodes: [
        {
            id: 'node-prompt',
            label: 'Multimodal Prompt Ingestion',
            subtitle: 'Gemini 3.7 Flash Reasoning & Spatial Prompt',
            category: 'input',
            color: 'cyan',
            x: 80,
            y: 160,
            status: 'completed',
            details: 'Prompt: "High-altitude cinematic helicopter flight over Midtown Manhattan during sunset with atmospheric haze."'
        },
        {
            id: 'node-dispatcher',
            label: 'Cloud Run GPU Orchestrator',
            subtitle: 'Google Cloud Run (NVIDIA L4 24GB VRAM)',
            category: 'cli',
            color: 'emerald',
            x: 360,
            y: 80,
            status: 'completed',
            details: 'Dynamic Python custom node synthesis via comfyui_inject_dynamic_code'
        },
        {
            id: 'node-checkpoint',
            label: 'Diffusion Checkpoint Loader',
            subtitle: 'Omni 1.1 / SDXL Foundation Weights',
            category: 'process',
            color: 'purple',
            x: 360,
            y: 260,
            status: 'completed',
            details: 'Precision fp16 model loaded in 1.4s with TensorRT graph optimization'
        },
        {
            id: 'node-depth-marigold',
            label: 'Monocular Depth & Normal Estimator',
            subtitle: 'Marigold Dense Surface Normals',
            category: 'scene-3d',
            color: 'blue',
            x: 640,
            y: 100,
            status: 'completed',
            details: 'Geometric depth alignment computed with anti-drift holdout matte destination-out'
        },
        {
            id: 'node-ksampler',
            label: 'Euler Ancestral KSampler',
            subtitle: '30 Steps | CFG 7.5 | Denoise 0.65',
            category: 'ai',
            color: 'amber',
            x: 640,
            y: 280,
            status: 'running',
            details: 'Step 22/30 (Latent temporal smoothing active across 300 keyframes)'
        },
        {
            id: 'node-vae',
            label: 'Tiled VAE Spatial Decoder',
            subtitle: '4K Ultra-HD Latent Decoding',
            category: 'process',
            color: 'purple',
            x: 920,
            y: 180,
            status: 'pending',
            details: 'Assembles uncompressed 3840x2160 frame sequence'
        },
        {
            id: 'node-output',
            label: 'Canvas Stage Video/GLB Streamer',
            subtitle: 'Zero-Copy Shared Memory Framebuffer',
            category: 'output',
            color: 'emerald',
            x: 1200,
            y: 180,
            status: 'pending',
            details: 'Direct playback in VideoTimeline and Three.js Viewport'
        }
    ],
    edges: [
        { id: 'e1', source: 'node-prompt', target: 'node-dispatcher', style: 'solid', color: 'cyan' },
        { id: 'e2', source: 'node-prompt', target: 'node-checkpoint', style: 'solid', color: 'cyan' },
        { id: 'e3', source: 'node-dispatcher', target: 'node-depth-marigold', style: 'solid', color: 'emerald' },
        { id: 'e4', source: 'node-checkpoint', target: 'node-ksampler', style: 'solid', color: 'purple' },
        { id: 'e5', source: 'node-depth-marigold', target: 'node-ksampler', style: 'animated', color: 'blue' },
        { id: 'e6', source: 'node-ksampler', target: 'node-vae', style: 'animated', color: 'amber' },
        { id: 'e7', source: 'node-vae', target: 'node-output', style: 'dashed', color: 'emerald' }
    ]
};

// ----------------------------------------------------------------------------------
// Demo 4: Live Code Sandbox - Playable Retro Space Breakout Game
// ----------------------------------------------------------------------------------
const retroBreakoutAppCode = `import React, { useRef, useEffect, useState, useCallback } from 'react';
import './styles.css';

const CANVAS_WIDTH = 700;
const CANVAS_HEIGHT = 480;
const PADDLE_WIDTH = 90;
const PADDLE_HEIGHT = 12;
const PADDLE_SPEED = 8;
const BALL_RADIUS = 7;
const INITIAL_BALL_SPEED = 5;

const BRICK_ROWS = 5;
const BRICK_COLS = 8;
const BRICK_WIDTH = 70;
const BRICK_HEIGHT = 18;
const BRICK_PAD = 8;
const BRICK_TOP = 40;
const BRICK_LEFT = (CANVAS_WIDTH - (BRICK_COLS * (BRICK_WIDTH + BRICK_PAD))) / 2;

const ROW_COLORS = ['#ef4444', '#f97316', '#eab308', '#10b981', '#3b82f6'];

export default function RetroSpaceBreakout() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [score, setScore] = useState(0);
    const [lives, setLives] = useState(3);
    const [gameState, setGameState] = useState<'idle' | 'playing' | 'gameover' | 'won'>('idle');

    const paddleRef = useRef({ x: (CANVAS_WIDTH - PADDLE_WIDTH) / 2, dx: 0 });
    const ballRef = useRef({ x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT - 40, dx: INITIAL_BALL_SPEED, dy: -INITIAL_BALL_SPEED });
    const bricksRef = useRef<{ active: boolean }[][]>([]);

    const initBricks = useCallback(() => {
        const b = [];
        for (let r = 0; r < BRICK_ROWS; r++) {
            const row = [];
            for (let c = 0; c < BRICK_COLS; c++) {
                row.push({ active: true });
            }
            b.push(row);
        }
        bricksRef.current = b;
    }, []);

    const startGame = () => {
        initBricks();
        setScore(0);
        setLives(3);
        paddleRef.current.x = (CANVAS_WIDTH - PADDLE_WIDTH) / 2;
        ballRef.current = { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT - 40, dx: INITIAL_BALL_SPEED, dy: -INITIAL_BALL_SPEED };
        setGameState('playing');
    };

    useEffect(() => {
        initBricks();
    }, [initBricks]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let frameId: number;

        const loop = () => {
            ctx.fillStyle = '#090d16';
            ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

            // Draw Stars background
            ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
            for (let i = 0; i < 40; i++) {
                const sx = (i * 97) % CANVAS_WIDTH;
                const sy = (i * 131) % CANVAS_HEIGHT;
                ctx.fillRect(sx, sy, 2, 2);
            }

            // Draw Bricks
            let remainingBricks = 0;
            for (let r = 0; r < BRICK_ROWS; r++) {
                for (let c = 0; c < BRICK_COLS; c++) {
                    const brick = bricksRef.current[r]?.[c];
                    if (brick && brick.active) {
                        remainingBricks++;
                        const bx = BRICK_LEFT + c * (BRICK_WIDTH + BRICK_PAD);
                        const by = BRICK_TOP + r * (BRICK_HEIGHT + BRICK_PAD);
                        ctx.fillStyle = ROW_COLORS[r % ROW_COLORS.length];
                        ctx.shadowColor = ROW_COLORS[r % ROW_COLORS.length];
                        ctx.shadowBlur = 8;
                        ctx.fillRect(bx, by, BRICK_WIDTH, BRICK_HEIGHT);
                        ctx.shadowBlur = 0;

                        // Brick highlight
                        ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
                        ctx.fillRect(bx, by, BRICK_WIDTH, 3);
                    }
                }
            }

            // Draw Paddle
            const p = paddleRef.current;
            ctx.fillStyle = '#38bdf8';
            ctx.shadowColor = '#38bdf8';
            ctx.shadowBlur = 12;
            ctx.fillRect(p.x, CANVAS_HEIGHT - 24, PADDLE_WIDTH, PADDLE_HEIGHT);
            ctx.shadowBlur = 0;

            // Draw Ball
            const b = ballRef.current;
            ctx.fillStyle = '#ffffff';
            ctx.shadowColor = '#38bdf8';
            ctx.shadowBlur = 10;
            ctx.beginPath();
            ctx.arc(b.x, b.y, BALL_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;

            if (gameState === 'playing') {
                p.x += p.dx;
                if (p.x < 0) p.x = 0;
                if (p.x + PADDLE_WIDTH > CANVAS_WIDTH) p.x = CANVAS_WIDTH - PADDLE_WIDTH;

                b.x += b.dx;
                b.y += b.dy;

                // Wall bounces
                if (b.x - BALL_RADIUS <= 0 || b.x + BALL_RADIUS >= CANVAS_WIDTH) b.dx = -b.dx;
                if (b.y - BALL_RADIUS <= 0) b.dy = -b.dy;

                // Paddle collision
                if (b.y + BALL_RADIUS >= CANVAS_HEIGHT - 24 && b.y - BALL_RADIUS <= CANVAS_HEIGHT - 12) {
                    if (b.x >= p.x && b.x <= p.x + PADDLE_WIDTH) {
                        const hitOffset = (b.x - (p.x + PADDLE_WIDTH / 2)) / (PADDLE_WIDTH / 2);
                        b.dx = hitOffset * 6.5;
                        b.dy = -Math.abs(b.dy);
                    }
                }

                // Brick collisions
                for (let r = 0; r < BRICK_ROWS; r++) {
                    for (let c = 0; c < BRICK_COLS; c++) {
                        const brick = bricksRef.current[r]?.[c];
                        if (brick && brick.active) {
                            const bx = BRICK_LEFT + c * (BRICK_WIDTH + BRICK_PAD);
                            const by = BRICK_TOP + r * (BRICK_HEIGHT + BRICK_PAD);
                            if (b.x > bx && b.x < bx + BRICK_WIDTH && b.y > by && b.y < by + BRICK_HEIGHT) {
                                brick.active = false;
                                b.dy = -b.dy;
                                setScore(s => s + 25);
                            }
                        }
                    }
                }

                if (remainingBricks === 0) {
                    setGameState('won');
                }

                // Bottom boundary loss
                if (b.y - BALL_RADIUS > CANVAS_HEIGHT) {
                    setLives(prev => {
                        const next = prev - 1;
                        if (next <= 0) {
                            setGameState('gameover');
                        } else {
                            ballRef.current = { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT - 40, dx: INITIAL_BALL_SPEED, dy: -INITIAL_BALL_SPEED };
                        }
                        return next;
                    });
                }
            }

            frameId = requestAnimationFrame(loop);
        };

        frameId = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(frameId);
    }, [gameState]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft' || e.key === 'a') paddleRef.current.dx = -PADDLE_SPEED;
            if (e.key === 'ArrowRight' || e.key === 'd') paddleRef.current.dx = PADDLE_SPEED;
            if (e.key === ' ' && gameState !== 'playing') startGame();
        };
        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'ArrowRight' || e.key === 'd') {
                paddleRef.current.dx = 0;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
        };
    }, [gameState]);

    return (
        <div className="breakout-app">
            <header className="breakout-header">
                <div className="title-glow">RETRO SPACE BREAKOUT</div>
                <div className="stats-row">
                    <span className="badge score-badge">SCORE: {score}</span>
                    <span className="badge lives-badge">LIVES: {'❤️'.repeat(Math.max(0, lives))}</span>
                </div>
            </header>

            <div className="canvas-wrapper">
                <canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} />
                {gameState !== 'playing' && (
                    <div className="overlay-msg">
                        <h2>{gameState === 'gameover' ? '💥 MISSION FAILED' : gameState === 'won' ? '🏆 VICTORY ACHIEVED!' : '🚀 READY FOR LAUNCH'}</h2>
                        <button className="start-btn" onClick={startGame}>
                            {gameState === 'idle' ? 'PRESS SPACE OR CLICK TO PLAY' : 'PLAY AGAIN'}
                        </button>
                    </div>
                )}
            </div>

            <footer className="breakout-footer">
                <span>[← / A] Move Left</span>
                <span>[→ / D] Move Right</span>
                <span>[SPACE] Launch Ball</span>
            </footer>
        </div>
    );
}
`;

const retroBreakoutStyles = `
.breakout-app {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #060911;
    color: #f8fafc;
    font-family: ui-monospace, monospace;
    padding: 24px;
    height: 100%;
    box-sizing: border-box;
}

.breakout-header {
    width: 700px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
}

.title-glow {
    font-size: 18px;
    font-weight: 800;
    letter-spacing: 2px;
    color: #38bdf8;
    text-shadow: 0 0 10px rgba(56, 189, 248, 0.7);
}

.stats-row {
    display: flex;
    gap: 12px;
}

.badge {
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 700;
}

.score-badge {
    background: rgba(56, 189, 248, 0.15);
    border: 1px solid rgba(56, 189, 248, 0.4);
    color: #38bdf8;
}

.lives-badge {
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid rgba(239, 68, 68, 0.4);
    color: #f87171;
}

.canvas-wrapper {
    position: relative;
    border: 2px solid #1e293b;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6);
}

canvas {
    display: block;
}

.overlay-msg {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(6, 9, 17, 0.82);
    backdrop-filter: blur(4px);
}

.overlay-msg h2 {
    font-size: 24px;
    font-weight: 800;
    margin-bottom: 16px;
    color: #f8fafc;
    letter-spacing: 1px;
}

.start-btn {
    background: #0284c7;
    color: white;
    border: none;
    padding: 10px 24px;
    border-radius: 8px;
    font-family: inherit;
    font-weight: 700;
    font-size: 13px;
    cursor: pointer;
    box-shadow: 0 0 15px rgba(2, 132, 199, 0.5);
    transition: all 0.2s ease;
}

.start-btn:hover {
    background: #0369a1;
    transform: translateY(-1px);
}

.breakout-footer {
    width: 700px;
    display: flex;
    justify-content: space-around;
    margin-top: 14px;
    font-size: 11px;
    color: #64748b;
}
`;

const demoLiveSandboxData: LiveCodeSandboxData = {
    title: 'Retro Space Breakout Arcade Sandbox',
    subtitle: 'Playable React 19 Canvas Game with Real-Time Monaco Code Hot Reload',
    template: 'react',
    viewMode: 'split',
    viewportMode: 'desktop',
    activeFileId: 'app-tsx',
    files: [
        {
            id: 'app-tsx',
            name: 'App.tsx',
            language: 'react',
            content: retroBreakoutAppCode,
            isEntry: true
        },
        {
            id: 'styles-css',
            name: 'styles.css',
            language: 'css',
            content: retroBreakoutStyles
        }
    ]
};

// ----------------------------------------------------------------------------------
// Demo 5: Multimodal Bento Studio Stage & Telemetry Cockpit
// ----------------------------------------------------------------------------------
const demoTelemetryDashboardData: MetricDashboardData = {
    title: 'Scratchbox Studio Core Engine Cockpit',
    subtitle: 'Real-Time Hardware Acceleration, SIMD Pipeline & Neural Restyling Benchmarks',
    metrics: [
        {
            id: 'metric-sdf-bandwidth',
            label: 'Marching Cubes SDF Bandwidth',
            value: '1.42M polys/sec',
            change: '+38%',
            trend: 'up',
            color: 'cyan',
            description: 'Clang -O3 AVX2/NEON vector acceleration'
        },
        {
            id: 'metric-sse-error',
            label: 'SSE Target Screen Error',
            value: '0.42 px SSE',
            change: '-62%',
            trend: 'down',
            color: 'emerald',
            description: 'Deepest leaf LOD tile polygonization'
        },
        {
            id: 'metric-frame-latency',
            label: 'Frame Latency (Three.js WebGL)',
            value: '4.8 ms',
            change: '60 FPS',
            trend: 'neutral',
            color: 'blue',
            description: 'Zero-stutter viewport frame delivery'
        },
        {
            id: 'metric-gpu-capacity',
            label: 'NVIDIA L4 24GB Allocation',
            value: '100%',
            trend: 'up',
            color: 'emerald',
            description: 'Google Cloud Run GPU container online'
        },
        {
            id: 'metric-dynamic-nodes',
            label: 'ComfyUI Injected Dynamic Nodes',
            value: '14 nodes',
            trend: 'neutral',
            color: 'indigo',
            description: 'Auto-synthesized Python runtime operators'
        },
        {
            id: 'metric-matchmove-confidence',
            label: 'Camera Solve Matchmove Confidence',
            value: '99.4%',
            trend: 'up',
            color: 'cyan',
            description: 'NOAA Geodetic Ephemeris & Brown-Conrady alignment'
        }
    ]
};

// ----------------------------------------------------------------------------------
// Demo: Google Maps Imagery Grounding (MIG) & 360 Panorama Studio
// ----------------------------------------------------------------------------------
const demoMig360PanoramaData: Scene3DData = {
    title: 'Google Maps Imagery Grounding (MIG) & 360 Panorama Studio',
    subtitle: 'Vertex AI Gemini Grounding via PanoID & Spherical Equirectangular Projection',
    sceneType: 'custom',
    renderMode: 'shaded',
    cameraMode: 'orbit',
    selectedMeshId: 'shibuya-skybox-panorama',
    camera: {
        position: [0, 1.7, 0.1],
        target: [0, 1.7, 10],
        fov: 75
    },
    environment: {
        skybox: 'studio',
        lighting: 'studio',
        ground: false,
        ambientIntensity: 1.0
    },
    geoAnchor: {
        lat: 35.6595,
        lng: 139.7005,
        elevation: 15,
        active: true,
        landmarkName: 'Shibuya Crossing Scramble',
        castingArchetype: 'Urban Street View Grounding',
        castingRationale: 'Grounded via Vertex AI Maps Imagery Grounding to official Street View panoId CAoSF0NJSE0wb2dLRUlDQWdJRHE4NkMtbXdF'
    },
    objects: [
        {
            id: 'shibuya-skybox-panorama',
            content: {
                type: '3d-model',
                durableUri: '/panoramas/streetview_shibuya_crossing_4k.png',
                mimeType: 'image/png',
                metadata: {
                    panoId: 'CAoSF0NJSE0wb2dLRUlDQWdJRHE4NkMtbXdF',
                    groundingSource: 'Vertex AI Maps Imagery Grounding (MIG)',
                    captureDate: '2024-05',
                    projection: 'equirectangular_2_to_1',
                    vehicleMastHeightMeters: 2.5
                }
            },
            space: {
                spatial3d: { x: 0, y: 0, z: 0 }
            }
        }
    ]
};

// ----------------------------------------------------------------------------------
// Demo: Google 3D Vector Tiles World Population Staging
// ----------------------------------------------------------------------------------
const demoVectorWorldStagingData: Scene3DData = {
    title: 'Google 3D Vector Tiles World Population Staging',
    subtitle: 'MVT Roadmap Extrusion in 18% Studio Grey Clay with Road Ribbons & Water Basins',
    sceneType: 'city',
    renderMode: 'clay',
    cameraMode: 'orbit',
    selectedMeshId: 'vector-world-stage',
    camera: {
        position: [200, 160, 220],
        target: [0, 10, 0],
        fov: 50
    },
    environment: {
        skybox: 'studio',
        lighting: 'studio',
        ground: true,
        groundColor: '#475569',
        ambientIntensity: 0.95
    },
    geoAnchor: {
        lat: 40.7484,
        lng: -73.9857,
        elevation: 15,
        active: true,
        landmarkName: 'Midtown Manhattan Staging Grid',
        castingArchetype: 'Urban Architectural Massing',
        castingRationale: 'Extruded directly from Google 2D roadmap vector tiles (zoom 16) in 18% Studio Grey Clay'
    },
    objects: [
        {
            id: 'vector-world-stage',
            content: {
                type: '3d-model',
                durableUri: '/models/vector_world_midtown.glb',
                mimeType: 'model/gltf-binary',
                metadata: {
                    materialPreset: '18% Studio Grey Clay (roughness: 0.85, metalness: 0.0)',
                    layers: ['buildings', 'roads', 'water'],
                    zoomLevel: 16
                }
            },
            space: {
                spatial3d: { x: 0, y: 0, z: 0 }
            }
        }
    ]
};

// ----------------------------------------------------------------------------------
// Complete Preloaded Showcase Demos Catalog
// ----------------------------------------------------------------------------------
export const PRELOADED_SHOWCASE_DEMOS: ShowcaseDemoItem[] = [
    {
        id: 'demo-mig-360-panorama',
        title: 'Maps Imagery Grounding (MIG) & 360 Panorama',
        subtitle: 'Vertex AI Grounding via PanoID & Spherical Projection',
        category: '3d',
        categoryLabel: '3D & Geospatial',
        description: 'Ground natural language landmark queries to official Google Street View panoId via Vertex AI Maps Imagery Grounding (MIG). Projects multi-perspective cubic faces into a 2:1 equirectangular panorama with 360° vehicle rig telemetry, seamless seam healing, and metric camera height.',
        tags: ['Maps Imagery Grounding', 'Vertex AI', 'Pano ID', '360 Panorama', 'Spherical ERP', 'Street View'],
        highlightBadge: 'MIG GROUNDED',
        artifact: {
            id: 'art-demo-mig-360-panorama',
            type: '3d-scene',
            title: 'Google Maps Imagery Grounding (MIG) & 360 Panorama',
            summary: 'Vertex AI Maps Imagery Grounding via PanoID with spherical 2:1 ERP projection and vehicle mast telemetry.',
            data: demoMig360PanoramaData,
            createdAt: new Date().toISOString(),
            version: 1
        },
        introMessage: 'Welcome to the Maps Imagery Grounding (MIG) 360 Panorama demo! This showcase demonstrates how Vertex AI Gemini grounds natural language queries to official Google Street View panoIds, retrieving cubic perspective faces and projecting them into seamless 360° spherical environments.'
    },
    {
        id: 'demo-vector-world-staging',
        title: '3D Vector Tiles World Population Staging',
        subtitle: 'MVT Roadmap Extrusion in 18% Studio Grey Clay',
        category: '3d',
        categoryLabel: '3D & Geospatial',
        description: 'Stage full 3D urban populations and surrounding environments directly from Google 2D roadmap vector tiles (MVT/PBF at zoom 16). Extrudes building footprints with polygon triangulation, road network ribbons, and water basins into a standard binary .glb adhering strictly to the 18% Studio Grey Clay staging invariant.',
        tags: ['Vector Tiles', '3D Staging', 'Grey Clay', 'MVT Protobuf', 'glTF 2.0', 'Urban World'],
        highlightBadge: '3D STAGING',
        artifact: {
            id: 'art-demo-vector-world-staging',
            type: '3d-scene',
            title: 'Google 3D Vector Tiles World Population Staging',
            summary: 'Google 2D roadmap vector tiles extruded into 18% Studio Grey Clay 3D world population for CAD staging.',
            data: demoVectorWorldStagingData,
            createdAt: new Date().toISOString(),
            version: 1
        },
        introMessage: 'Welcome to the 3D Vector Tiles World Population Staging demo! This pipeline decodes Google 2D roadmap vector tiles (MVT/PBF) at zoom 16, triangulates building polygon rings, extrudes volumetric prisms, and bakes 18% Studio Grey Clay materials into a standard binary .glb for immediate scene staging.'
    },
    {
        id: 'demo-nextgen-astra-viewport',
        title: 'Next-Gen Astro 3D Viewport: 100M-Polygon Meshlet & Hybrid 3DGS',
        subtitle: 'Universal 3D Benchmark · GPU Meshlets, SPZ Gaussian Splats & Clustered AgX PBR',
        category: '3d',
        categoryLabel: '3D & Next-Gen Viewport',
        description: 'Universal high-throughput 3D viewport evaluated against the marketplace: renders 100M+ virtualized triangles via GPU meshlet cluster DAGs, blends 3D Gaussian Splats with PBR meshes in a shared depth buffer, and features clustered forward lighting with AgX tone mapping.',
        tags: ['Next-Gen Viewport', 'Meshlet Virtualization', '3D Gaussian Splatting', 'AgX PBR', 'Industry Benchmark', 'C++20 Engine'],
        highlightBadge: 'INDUSTRY BENCHMARK',
        artifact: {
            id: 'art-demo-nextgen-viewport',
            type: 'interactive-browser',
            title: 'Next-Gen Astro 3D Viewport Studio',
            summary: 'Flagship 3D viewport engine running GPU Meshlet Virtualization (100M triangles), SPZ Gaussian Splats, and Clustered Forward PBR.',
            data: {
                url: '/next_gen_astra_viewport_studio.html',
                title: 'Next-Gen Astro Viewport Studio',
                viewportMode: 'desktop'
            },
            createdAt: new Date().toISOString(),
            version: 1
        },
        introMessage: 'Welcome to the **Next-Gen Astro 3D Viewport Studio**. This studio demonstrates our universal 3D architecture evaluated against all major marketplace platforms: 100M virtualized triangles via GPU meshlet clusters, sub-pixel continuous LOD cuts, 3D Gaussian Splatting with shared depth occlusion, and clustered forward lighting with photographic AgX color grading.'
    },
    {
        id: 'demo-nanite-meshlets-pathtracing',
        title: 'Nanite Meshlets & Path-Traced GI Studio',
        subtitle: '1-Trillion Virtual Triangles · Cluster DAGs & WebGPU Indirect Dispatch',
        category: '3d',
        categoryLabel: '3D & WebGPU',
        description: 'Interactive cluster DAG viewport demonstrating sub-pixel continuous LOD cuts (1px error target), zero draw-call CPU overhead, and progressive path-traced global illumination.',
        tags: ['Nanite', 'Meshlets', 'Cluster DAG', 'Path Tracing', 'WebGPU', '1px Error'],
        highlightBadge: 'NANITE + GI',
        artifact: {
            id: 'art-demo-nanite-meshlets',
            type: 'interactive-browser',
            title: 'Nanite Meshlets & Progressive Path Tracing Studio',
            summary: 'Virtualized geometry cluster DAGs with ~1px continuous LOD cuts and progressive Monte Carlo GI.',
            data: {
                url: '/nanite_meshlet_pathtracing_studio.html',
                title: 'Nanite Meshlets & Path Tracing Studio',
                viewportMode: 'desktop'
            },
            createdAt: new Date().toISOString(),
            version: 1
        },
        introMessage: 'Welcome to the **Nanite Meshlets & Progressive Path Tracing Studio**. Explore 1-trillion virtual triangle cluster DAGs, continuous 1-pixel screen-space error cuts, GPU compute frustum & Hi-Z culling, and progressive path-traced global illumination.'
    },
    {
        id: 'demo-image-to-adaptive-pbr',
        title: 'Adaptive Image-to-PBR Relief Studio',
        subtitle: '2D Surface to Displaced Metric 3D Plane',
        category: '3d',
        categoryLabel: '3D & Biophysical PBR',
        description: 'Instant 2D image-to-PBR metric displaced plane generator. Zero external model servers, continuous biophysical signal processing in <150ms, multi-frequency Scharr normals, HBAO, and packed ORM.',
        tags: ['Image to PBR', 'Poisson Relief', 'ORM Textures', 'Zero-Preset', 'Continuous Biophysics', 'glTF 2.0'],
        highlightBadge: 'ZERO-PRESET PBR',
        artifact: {
            id: 'art-demo-image-to-pbr',
            type: 'interactive-browser',
            title: 'Adaptive Image-to-PBR Relief Studio',
            summary: 'Instant 2D image-to-PBR displaced plane generator with multi-frequency Scharr normals, Retinex de-lighting, and packed ORM in <150ms.',
            data: {
                url: '/image_to_adaptive_pbr_studio.html',
                title: 'Adaptive Image-to-PBR Relief Studio',
                viewportMode: 'desktop'
            },
            createdAt: new Date().toISOString(),
            version: 1
        },
        introMessage: 'Welcome to the **Adaptive Image-to-PBR Relief Studio**. This studio transforms 2D surface imagery into physical 3D displaced geometry with intrinsic Retinex de-lighting, multi-frequency Scharr normals, and packed ORM textures in under 150ms.'
    },
    {
        id: 'demo-3d-geospatial',
        title: '3D Geospatial Engine & Midtown Manhattan',
        subtitle: 'Digital Twin Landmark Ingestion',
        category: '3d',
        categoryLabel: '3D & Geospatial',
        description: 'Explore Google Photorealistic 3D Tiles streamed with sub-millimeter leaf precision, PBR lighting, and diurnal sun ephemeris tracking.',
        tags: ['3D Tiles', 'GLTF/GLB', 'C++20 Engine', 'Diurnal Sun', 'Empire State Building'],
        highlightBadge: 'HIGH FIDELITY',
        artifact: {
            id: 'art-demo-3d-geospatial',
            type: '3d-scene',
            title: 'Midtown Manhattan 3D Geospatial Digital Twin',
            summary: 'High-resolution Google 3D Tiles blockout with NOAA diurnal solar tracking and PBR lighting.',
            data: demo3dSceneData,
            createdAt: new Date().toISOString(),
            version: 1
        },
        introMessage: 'Welcome to the Midtown Manhattan 3D Geospatial demo. Here you can inspect photogrammetric 3D tiles with full camera orbit controls, diurnal lighting ephemeris, and native C++20 geometry pipeline integration.'
    },
    {
        id: 'demo-vfx-timeline',
        title: 'VFX Matchmove & Neural Video NLE',
        subtitle: '6-DoF Camera Solve & Omni Restyling',
        category: 'video',
        categoryLabel: 'VFX & Video NLE',
        description: 'Multi-track non-linear video editor with 6-DoF camera trajectory matching, anti-drift holdout mattes, and 50/50 side-by-side comparison mode.',
        tags: ['Video Timeline', 'VFX Plate', 'Omni 1.1 Restyle', 'Matchmove', 'Split-Screen'],
        highlightBadge: 'STUDIO GRADE',
        artifact: {
            id: 'art-demo-vfx-timeline',
            type: 'video-timeline',
            title: 'VFX Matchmove & Neural Restyling NLE Studio',
            summary: 'Multi-track timeline compositing 3D blockout plates with neural restyled outputs and synchronized split playback.',
            data: demoVideoTimelineData,
            createdAt: new Date().toISOString(),
            version: 1
        },
        introMessage: 'This demo showcases the Scratchbox Video Timeline NLE. You can scrub multi-track video plates, test 6-DoF camera solves, and toggle side-by-side comparison mode between 3D blockout and neural synthesis.'
    },
    {
        id: 'demo-ai-node-graph',
        title: 'Autonomous AI Diffusion Pipeline Graph',
        subtitle: 'Cloud Run ComfyUI Workflow',
        category: 'graph',
        categoryLabel: 'AI & Node Flow',
        description: 'Interactive visual workflow connecting prompt ingestion, NVIDIA L4 GPU workers, Marigold depth estimation, and KSampler latent diffusion.',
        tags: ['Node Graph', 'ComfyUI', 'Cloud Run L4', 'KSampler', 'Dynamic Code'],
        highlightBadge: 'AUTONOMOUS',
        artifact: {
            id: 'art-demo-ai-node-graph',
            type: 'node-graph',
            title: 'Autonomous Spatial VFX & Diffusion Pipeline Graph',
            summary: 'End-to-end cloud diffusion pipeline graph with live node execution states and Bezier signal routes.',
            data: demoNodeGraphData,
            createdAt: new Date().toISOString(),
            version: 1
        },
        introMessage: 'Welcome to the AI Diffusion Pipeline Graph demo. This graph visualizes how Scratchbox IDE dispatches spatial diffusion workloads to NVIDIA L4 GPU Cloud Run containers with dynamic Python code synthesis.'
    },
    {
        id: 'demo-retro-breakout',
        title: 'Retro Space Breakout Arcade Game',
        subtitle: 'Playable React 19 Code Sandbox',
        category: 'sandbox',
        categoryLabel: 'Live Sandbox',
        description: 'Instant playable arcade game inside an isolated React 19 sandbox. Edit Monaco code in real-time, tweak paddle speeds, and watch hot reload in action.',
        tags: ['Playable Game', 'React 19', 'Monaco Editor', 'Hot Reload', 'TypeScript'],
        highlightBadge: 'PLAYABLE NOW',
        artifact: {
            id: 'art-demo-retro-breakout',
            type: 'live-code-sandbox',
            title: 'Retro Space Breakout Arcade Sandbox',
            summary: 'Interactive React 19 arcade game with collision physics, lives, high scores, and live editable code.',
            data: demoLiveSandboxData,
            createdAt: new Date().toISOString(),
            version: 1
        },
        introMessage: 'Enjoy this playable Retro Space Breakout game right inside the Scratchbox Code Sandbox! You can play using Arrow Keys and Spacebar, or edit the TypeScript code in the editor to instantly customize the game.'
    },
    {
        id: 'demo-cockpit-dashboard',
        title: 'Scratchbox Studio Core Cockpit',
        subtitle: 'Real-Time System Benchmarks',
        category: 'dashboard',
        categoryLabel: 'Cockpit & Metrics',
        description: 'Comprehensive performance cockpit monitoring C++20 Marching Cubes SDF throughput, WebGL frame rates, and cloud GPU cluster health.',
        tags: ['Telemetry', 'Metrics', 'SIMD Benchmarks', 'GPU Health', 'Performance'],
        highlightBadge: 'SYSTEM TELEMETRY',
        artifact: {
            id: 'art-demo-cockpit-dashboard',
            type: 'metric-dashboard',
            title: 'Scratchbox Studio Core Engine Cockpit',
            summary: 'Real-time telemetry showing C++ Marching Cubes throughput, screen error SSE, and GPU container readiness.',
            data: demoTelemetryDashboardData,
            createdAt: new Date().toISOString(),
            version: 1
        },
        introMessage: 'This dashboard provides a telemetry overview of Scratchbox IDE internal performance engines, including native SIMD geometry polygonization, WebGL frame latency, and Cloud Run GPU status.'
    }
];
