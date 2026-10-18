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
// Demo 3: Native C++20 3D Generation Pipeline Graph
// ----------------------------------------------------------------------------------
const demoNodeGraphData: NodeGraphData = {
    title: 'Native 3D Generation Pipeline Graph',
    subtitle: 'Prompt to C++20 procedural geometry to binary glTF in the viewport',
    nodes: [
        {
            id: 'node-prompt',
            label: 'Prompt Ingestion',
            subtitle: 'Gemini multimodal reasoning',
            category: 'input',
            color: 'cyan',
            x: 80,
            y: 180,
            status: 'completed',
            details: 'Prompt: "Arctic research outpost on a basalt ridge, studio grey clay."'
        },
        {
            id: 'node-capability',
            label: 'Task Capability Resolver',
            subtitle: 'Domain classification & tool-pack selection',
            category: 'ai',
            color: 'amber',
            x: 360,
            y: 80,
            status: 'completed',
            details: 'TaskCapabilityResolver classifies the task as 3D and pre-loads the native generation tools.'
        },
        {
            id: 'node-contract',
            label: 'Adaptive Scene Contract',
            subtitle: 'Continuous physical parameters (70-20-10 hierarchy)',
            category: 'process',
            color: 'purple',
            x: 360,
            y: 280,
            status: 'completed',
            details: 'Adaptive3DSceneSynthesizer projects the prompt into continuous dimensional fields, with no presets.'
        },
        {
            id: 'node-compile',
            label: 'Ephemeral C++20 Compile',
            subtitle: 'NativeCppCompilerService (clang++ -std=c++20)',
            category: 'cli',
            color: 'emerald',
            x: 640,
            y: 180,
            status: 'running',
            details: 'Synthesized generator source includes scratchbox_engine.hpp and is compiled in a sub-process.'
        },
        {
            id: 'node-gate',
            label: 'Geometric Complexity Gate',
            subtitle: 'Vertex / triangle floors & primitive ban',
            category: 'process',
            color: 'purple',
            x: 920,
            y: 180,
            status: 'pending',
            details: 'Rejects toy primitives and under-detailed output before it reaches the stage.'
        },
        {
            id: 'node-output',
            label: 'Binary glTF Viewport Stream',
            subtitle: 'Three.js 3D scene primitive',
            category: 'scene-3d',
            color: 'blue',
            x: 1200,
            y: 180,
            status: 'pending',
            details: 'The .glb streams into the 3d-scene primitive; generator source is kept in data.cppGenerator.sourceCode.'
        }
    ],
    edges: [
        { id: 'e1', source: 'node-prompt', target: 'node-capability', style: 'solid', color: 'cyan' },
        { id: 'e2', source: 'node-prompt', target: 'node-contract', style: 'solid', color: 'cyan' },
        { id: 'e3', source: 'node-capability', target: 'node-compile', style: 'solid', color: 'amber' },
        { id: 'e4', source: 'node-contract', target: 'node-compile', style: 'animated', color: 'purple' },
        { id: 'e5', source: 'node-compile', target: 'node-gate', style: 'animated', color: 'emerald' },
        { id: 'e6', source: 'node-gate', target: 'node-output', style: 'dashed', color: 'blue' }
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
// Demo: Google 3D Vector Roadmap & Cadastral Spatial Intelligence
// ----------------------------------------------------------------------------------
const demoVectorWorldStagingData: Scene3DData = {
    title: 'Google 3D Vector Roadmap & Cadastral Spatial Intelligence',
    subtitle: 'Sub-Millimeter Cadastre · Universal Spatial URNs · Kinematic Splines · Zero Fake Trees',
    sceneType: 'city',
    renderMode: 'clay',
    cameraMode: 'orbit',
    selectedMeshId: 'vector-world-stage',
    groundTileMode: 'vector-world-clay',
    vectorRoadmap: {
        enabled: true,
        groundBlueprint: true,
        groundElevationOffset: 0.05,
        minimap: true,
        groundTileMode: 'vector-world-clay'
    },
    camera: {
        position: [240, 180, 260],
        target: [0, 25, 0],
        fov: 48
    },
    environment: {
        skybox: 'studio',
        lighting: 'studio',
        ground: true,
        groundColor: '#334155',
        ambientIntensity: 0.95,
        sunAzimuth: 29.0, // Aligned to Manhattan 29-degree street grid
        sunElevation: 42.0
    },
    geoAnchor: {
        lat: 40.7484405,
        lng: -73.9856644,
        elevation: 18.53,
        active: true,
        landmarkName: 'Empire State Building Cadastral Anchor',
        castingArchetype: 'Urban Cadastral Massing & Kinematic Splines',
        castingRationale: 'Co-registered at sub-millimeter precision with Google 3D Photorealistic Tiles (LocalTangentPlane ENU)'
    },
    objects: [
        {
            id: 'vector-world-stage',
            content: {
                type: '3d-model',
                durableUri: '/models/omnispatial_stage2_vector_straightened.glb',
                mimeType: 'model/gltf-binary',
                metadata: {
                    materialPreset: '18% Studio Grey Clay (roughness: 0.85, metalness: 0.0)',
                    layers: ['cadastral_buildings', 'kinematic_roads', 'sidewalk_curbs', 'parcels'],
                    zoomLevel: 16,
                    coordinateParity: 'LocalTangentPlane ENU (0.000 mm drift vs Google 3D Tiles)',
                    universalSpatialIds: [
                        'urn:scratchbox:spatial:building:dr5regw3p2:empire-state-building-0',
                        'urn:scratchbox:spatial:road:dr5regw3p2:5th-avenue-1',
                        'urn:scratchbox:spatial:road:dr5regw3p2:west-34th-st-1',
                        'urn:scratchbox:spatial:landuse:dr5regw3p2:greeley-square-park-0'
                    ],
                    verifiedHeights: {
                        'urn:scratchbox:spatial:building:dr5regw3p2:empire-state-building-0': {
                            heightM: 381.0,
                            verified: true,
                            source: 'cadastral_lidar'
                        }
                    },
                    kinematics: {
                        corridors: ['5th Avenue', 'West 34th Street', 'Broadway'],
                        speedLimitKmh: 40,
                        legalHeadingDegrees: 29.0
                    },
                    realityGrounding: {
                        zeroFakeTreesInvariant: true,
                        vegetationNotice: 'Authentic tree locations and canopies are deferred to Google 3D Photorealistic Tiles and Solar 0.1m nDSM canopy classification. Procedural tree hallucination is disabled.'
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
// Demo: Omnispatial Multi-Sensor 3D Synthesis Pipeline (Minimal Orthogonal Basis)
// ----------------------------------------------------------------------------------
// The three real pipeline GLBs are co-registered (identical metric bounds, no node
// transforms), so they share one origin and form a single open variant set. The
// viewport groups objects by `metadata.variantSet` and orders them by `variantOrder`;
// no code branches on stage names or labels. `role: 'environment'` exempts each stage
// from ground snapping so a later-loaded stage never lands on an earlier stage's roof.
const OMNISPATIAL_STAGE_VARIANT_SET = 'omnispatial-pipeline-stages';

const demoOmnispatialSynthesisData: Scene3DData = {
    title: 'Omnispatial Multi-Sensor 3D Synthesis Pipeline',
    subtitle: 'Minimal Orthogonal Basis Proof: 3D Tiles + 2D Vector Cadastre + Street View 360',
    sceneType: 'adaptive',
    // Stages 1 and 2 carry an authored studio-grey clay material; 'pbr' keeps Stage 3's
    // embedded Street View textures instead of swapping every material for clay.
    renderMode: 'pbr',
    cameraMode: 'orbit',
    toolMode: 'view',
    // ~700 m standoff, outside the ~482 m bounding radius, so auto-framing respects it.
    camera: {
        position: [423, 419, 504],
        target: [0, 180, 0],
        fov: 45
    },
    environment: {
        skybox: 'studio',
        lighting: 'studio',
        ground: false,
        ambientIntensity: 0.95,
        // The GLBs already contain the surrounding district; never stream Google tiles over them.
        groundTileMode: 'none'
    },
    geoAnchor: {
        lat: 40.7484,
        lng: -73.9857,
        active: false,
        landmarkName: 'Empire State Building, NYC',
        castingArchetype: 'Omnispatial Digital Twin',
        castingRationale: 'Google 3D Photo Tiles + 2D Vector Cadastre + Street View 360 Fused into Metric 3D Geometry'
    },
    objects: [
        {
            id: 'omnispatial-stage1-raw-scan',
            content: {
                type: '3d-model',
                durableUri: '/models/omnispatial_stage1_real_clay_tile.glb',
                mimeType: 'model/gltf-binary',
                metadata: {
                    role: 'environment',
                    variantSet: OMNISPATIAL_STAGE_VARIANT_SET,
                    variantOrder: 1,
                    variantLabel: 'Stage 1 · ESB raw scan',
                    materialPreset: 'Authored Studio Grey Clay (Mat_StudioGreyClay, roughness: 0.85)',
                    vertexCount: 27311,
                    triangleCount: 19985,
                    meshCount: 1,
                    textureCount: 0
                }
            },
            space: {
                spatial3d: { x: 0, y: 0, z: 0 }
            }
        },
        {
            id: 'omnispatial-stage2-vector-refined',
            content: {
                type: '3d-model',
                durableUri: '/models/omnispatial_stage2_vector_refined.glb',
                mimeType: 'model/gltf-binary',
                metadata: {
                    role: 'environment',
                    variantSet: OMNISPATIAL_STAGE_VARIANT_SET,
                    variantOrder: 2,
                    variantLabel: 'Stage 2 · ESB refined (clay)',
                    materialPreset: 'Authored Studio Grey Clay (Mat_StudioGreyClay, roughness: 0.85)',
                    vertexCount: 352768,
                    triangleCount: 295353,
                    meshCount: 1,
                    textureCount: 0
                }
            },
            space: {
                spatial3d: { x: 0, y: 0, z: 0 }
            }
        },
        {
            id: 'omnispatial-stage3-streetview-pbr',
            content: {
                type: '3d-model',
                durableUri: '/models/omnispatial_real_stage3_streetview_pbr.glb',
                mimeType: 'model/gltf-binary',
                metadata: {
                    role: 'environment',
                    variantSet: OMNISPATIAL_STAGE_VARIANT_SET,
                    variantOrder: 3,
                    variantLabel: 'Stage 3 · ESB refined (photo-textured)',
                    variantDefault: true,
                    materialPreset: 'Original Google 3D Tile photo textures (unlit)',
                    vertexCount: 362484,
                    triangleCount: 295353,
                    meshCount: 24,
                    textureCount: 24
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
        title: '3D Vector Roadmap & Cadastral Spatial Intelligence',
        subtitle: 'Universal Spatial URNs · Kinematic Splines · Sub-Millimeter ENU · Zero Fake Trees',
        category: '3d',
        categoryLabel: '3D & Geospatial',
        description: 'Co-registers Google 2D roadmap vector tiles and cadastral parcels with Google 3D Photorealistic Tiles in 18% Studio Grey Clay. Delivers canonical Universal Spatial Identifiers (URNs), verified building height bounds vs null stencils, kinematic lane centerlines with legal traffic headings, and strictly enforces the Zero-Fake-Trees reality grounding invariant.',
        tags: ['Spatial Intelligence', 'Universal URN', 'Cadastre', 'Kinematic Splines', 'Sub-Millimeter ENU', 'Zero Fake Trees'],
        highlightBadge: 'SPATIAL INTEL',
        artifact: {
            id: 'art-demo-vector-world-staging',
            type: '3d-scene',
            title: '3D Vector Roadmap & Cadastral Spatial Intelligence',
            summary: 'Sub-millimeter co-registered cadastral skeleton with Universal Spatial IDs, kinematic splines, and verified height boundaries in 18% Studio Grey Clay.',
            data: demoVectorWorldStagingData,
            createdAt: new Date().toISOString(),
            version: 2
        },
        introMessage: 'Welcome to the 3D Vector Roadmap & Cadastral Spatial Intelligence demo! This pipeline implements the "Skin & Bones" architecture: decoding Google 2D roadmap vector tiles and cadastral parcels into a sub-millimeter metric skeleton aligned with Google 3D Photorealistic Tiles via LocalTangentPlane ENU. Features canonical Universal Spatial IDs (urn:scratchbox:spatial:...), verified building height boundaries, kinematic lane centerlines with legal traffic headings, and complete reality grounding (zero procedural hallucinated trees).'
    },
    {
        id: 'demo-omnispatial-synthesis',
        title: 'Omnispatial Multi-Sensor 3D Synthesis Pipeline',
        subtitle: 'Minimal Orthogonal Basis Proof · 3D Tiles + Vector + SV 360',
        category: '3d',
        categoryLabel: '3D & Geospatial',
        description: 'Synthesizes the Minimal Orthogonal Basis into human-scale metric digital twins: Google 3D Photo Tiles macro envelope rectified with 2D cadastral vector sharp 90° corners, and fused with Street View 360 for true 0.22m 3D recessed window bays and Art Deco entrance reveals.',
        tags: ['Orthogonal Triad', 'Google 3D Tiles', 'Vector Cadastre', 'Street View 360', '90° Corners', '3D Window Bays', 'C++20 Clang'],
        highlightBadge: 'ORTHOGONAL TRIAD',
        artifact: {
            // New id so stale persisted copies of the old single-GLB artifact (session
            // storage, version history, project graph head) never shadow the real stages.
            id: 'art-demo-omnispatial-real-stages',
            type: '3d-scene',
            title: 'Omnispatial Multi-Sensor 3D Synthesis Pipeline',
            summary: 'The real Google 3D Tile scan of the ESB district: raw, refined by tile_refine (hidden shells culled, facades rectified, photometric relief), and refined with its original photo textures, as one switchable, co-registered stage set.',
            data: demoOmnispatialSynthesisData,
            createdAt: new Date().toISOString(),
            version: 1
        },
        introMessage: 'Welcome to the Omnispatial Multi-Sensor 3D Synthesis Pipeline demo! This scene loads the real pipeline models, not render plates: Stage 1 is the raw Google 3D Tile scan in clay, Stage 2 is the same scan refined by tile_refine (hidden shells culled, facades and corners rectified, relief lifted from the tile photos) in clay, and Stage 3 is the refined scan with its original photo textures. Drag to orbit, Shift-drag or right-drag to pan, and use the mouse wheel to zoom. Click any part of the model to pick it individually, and use the stage switcher in the top-right corner of the viewport to swap between Stage 1, 2 and 3.'
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
        id: 'demo-native-pipeline-graph',
        title: 'Native 3D Generation Pipeline Graph',
        subtitle: 'C++20 Engine Workflow',
        category: 'graph',
        categoryLabel: 'AI & Node Flow',
        description: 'Interactive node graph tracing a prompt through capability resolution, adaptive scene contracts, ephemeral C++20 compilation, the geometric complexity gate, and binary glTF streaming.',
        tags: ['Node Graph', 'C++20 Engine', 'glTF 2.0', 'Pipeline'],
        highlightBadge: 'NATIVE',
        artifact: {
            id: 'art-demo-native-pipeline-graph',
            type: 'node-graph',
            title: 'Native 3D Generation Pipeline Graph',
            summary: 'How a 3D prompt becomes procedural geometry in the viewport.',
            data: demoNodeGraphData,
            createdAt: new Date().toISOString(),
            version: 1
        },
        introMessage: 'This graph traces how Scratchbox turns a 3D prompt into native C++20 procedural geometry and streams it into the viewport.'
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
        introMessage: 'This dashboard provides a telemetry overview of Scratchbox IDE internal performance engines, including native SIMD geometry polygonization and WebGL frame latency.'
    }
];
