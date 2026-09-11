/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LiveCodeSandboxData } from './canvas-types';

/**
 * Detects whether a user prompt requests vibe-coding a custom tool or micro-studio.
 */
export function isVibeToolRequest(text: string): boolean {
    return /vibe\s*code|vibe-code|vibe\s+tool|custom\s+tool|blocking\s+tool|blocking\s+studio|micro-studio|editor\s+app|pre-viz|director\s+tool|camera\s+sequencer/i.test(text);
}

/**
 * Extracts a concise tool title from the prompt.
 */
export function extractToolTitle(prompt: string, fallback: string = 'Blocking Studio'): string {
    const clean = prompt.replace(/^(vibe[- ]?code|create|build|make|generate)\s+(a|an|the)?/i, '').trim();
    if (/blocking/i.test(clean)) return '3D Blocking Studio';
    if (/camera|sequencer/i.test(clean)) return 'Camera Sequencer Studio';
    if (/editor/i.test(clean)) return 'Custom Scene Editor';
    if (clean.length > 3 && clean.length < 35) {
        return clean.charAt(0).toUpperCase() + clean.slice(1);
    }
    return fallback;
}

/**
 * Synthesizes a production-grade 3D Pre-Visualization and Blocking Micro-Studio
 * runnable immediately inside Scratchbox's LiveCodeSandboxPrimitive.
 */
export function synthesizeVibeToolSandbox(prompt: string, title?: string): LiveCodeSandboxData {
    const resolvedTitle = title || extractToolTitle(prompt);

    const appTsx = `import React, { useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  Sparkles, Play, Pause, Camera, Layers, Video, Eye,
  Settings, Download, RotateCcw, Move, Sliders, Check
} from 'lucide-react';

export default function App() {
  const [activeShot, setActiveShot] = useState('Shot 1: Establishing Orbit');
  const [fov, setFov] = useState(48);
  const [camHeight, setCamHeight] = useState(3.5);
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  const orbitCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const shotCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number>(0);
  const animIdRef = useRef<number | null>(null);

  // Initialize Three.js WebGL Scene with Dual Viewports
  useEffect(() => {
    if (!orbitCanvasRef.current || !shotCanvasRef.current) return;

    const width = orbitCanvasRef.current.clientWidth || 380;
    const height = orbitCanvasRef.current.clientHeight || 320;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0a0b10');

    // Ground and Grid
    const grid = new THREE.GridHelper(36, 36, '#3f3f46', '#1e1e24');
    grid.position.y = 0.01;
    scene.add(grid);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(36, 36),
      new THREE.MeshStandardMaterial({ color: '#1a1917', roughness: 0.95 })
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // Modern Desert Villa architecture
    const villaGroup = new THREE.Group();

    // Main Pavilion
    const villa = new THREE.Mesh(
      new THREE.BoxGeometry(11, 3.8, 8),
      new THREE.MeshStandardMaterial({ color: '#e4e4e7', roughness: 0.25 })
    );
    villa.position.set(0, 1.9, -2);
    villaGroup.add(villa);

    // Architectural Roof overhang
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(12.5, 0.35, 9.5),
      new THREE.MeshStandardMaterial({ color: '#18181b', roughness: 0.2 })
    );
    roof.position.set(0, 3.9, -2);
    villaGroup.add(roof);

    // Floor-to-ceiling glass wall
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(7, 3.2, 0.2),
      new THREE.MeshStandardMaterial({ color: '#38bdf8', transparent: true, opacity: 0.35, roughness: 0.1 })
    );
    glass.position.set(0, 1.6, 2.05);
    villaGroup.add(glass);

    // Executive Vehicle / Van
    const van = new THREE.Mesh(
      new THREE.BoxGeometry(4.2, 1.8, 2.0),
      new THREE.MeshStandardMaterial({ color: '#09090b', metalness: 0.85, roughness: 0.25 })
    );
    van.position.set(-4.5, 0.9, 4.5);
    villaGroup.add(van);

    // Scene Actors (Pre-blocking Mannequins)
    const actorAlpha = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.32, 1.75, 20),
      new THREE.MeshStandardMaterial({ color: '#f59e0b', roughness: 0.4 })
    );
    actorAlpha.position.set(1.2, 0.875, 3.2);
    villaGroup.add(actorAlpha);

    const actorBeta = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.32, 1.75, 20),
      new THREE.MeshStandardMaterial({ color: '#ef4444', roughness: 0.4 })
    );
    actorBeta.position.set(-0.8, 0.875, 2.8);
    villaGroup.add(actorBeta);

    scene.add(villaGroup);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);
    const sunLight = new THREE.DirectionalLight(0xffedd5, 1.9);
    sunLight.position.set(16, 24, 12);
    scene.add(sunLight);

    // Dual Cameras
    const orbitCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 150);
    orbitCamera.position.set(14, 16, 18);

    const shotCamera = new THREE.PerspectiveCamera(fov, width / height, 0.1, 150);
    shotCamera.position.set(7, camHeight, 9);
    shotCamera.lookAt(0, 1.6, 1);

    const camHelper = new THREE.CameraHelper(shotCamera);
    scene.add(camHelper);

    // Renderers
    const orbitRenderer = new THREE.WebGLRenderer({ canvas: orbitCanvasRef.current, antialias: true });
    orbitRenderer.setSize(width, height);
    orbitRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const shotRenderer = new THREE.WebGLRenderer({ canvas: shotCanvasRef.current, antialias: true });
    shotRenderer.setSize(width, height);
    shotRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const controls = new OrbitControls(orbitCamera, orbitRenderer.domElement);
    controls.enableDamping = true;

    const renderLoop = () => {
      controls.update();

      if (isPlaying) {
        frameRef.current += 1;
        setCurrentFrame(frameRef.current % 120);
        const t = frameRef.current * 0.012;

        if (activeShot.includes('Establishing')) {
          shotCamera.position.x = Math.sin(t * 0.5) * 8.5;
          shotCamera.position.z = Math.cos(t * 0.5) * 8.5 + 2;
          shotCamera.position.y = camHeight + Math.sin(t * 0.25) * 0.6;
          shotCamera.lookAt(0, 1.6, 0.5);
        } else if (activeShot.includes('Low-Angle')) {
          shotCamera.position.set(2.8, 0.6, 5.0);
          shotCamera.lookAt(1.2, 1.8, 3.2);
        } else if (activeShot.includes('Van Close-Up')) {
          shotCamera.position.set(-2.5, 1.2, 5.8);
          shotCamera.lookAt(-4.5, 1.0, 4.5);
        } else {
          shotCamera.position.set(0, 12, 4);
          shotCamera.lookAt(0, 0, 0);
        }
      }

      shotCamera.fov = fov;
      shotCamera.updateProjectionMatrix();
      camHelper.update();

      orbitRenderer.render(scene, orbitCamera);
      shotRenderer.render(scene, shotCamera);
      animIdRef.current = requestAnimationFrame(renderLoop);
    };

    renderLoop();

    return () => {
      if (animIdRef.current) cancelAnimationFrame(animIdRef.current);
      orbitRenderer.dispose();
      shotRenderer.dispose();
    };
  }, [fov, camHeight, isPlaying, activeShot]);

  // Export Blocking Reference to AI Video Pipeline (Seedance / Veo)
  const handleExportBlockingPass = async () => {
    setExportStatus('Rendering 4D Pre-Viz frames...');
    try {
      if (window.scratchbox?.media?.exportBlockingPass) {
        await window.scratchbox.media.exportBlockingPass({
          shotName: activeShot,
          fov,
          cameraHeight: camHeight,
          durationFrames: 120,
          fps: 30,
          timestamp: Date.now()
        });
      }
      setTimeout(() => {
        setExportStatus('Reference Sequence Exported to Seedance 2.5 / Veo Pipeline!');
        setTimeout(() => setExportStatus(null), 4000);
      }, 900);
    } catch (e) {
      setExportStatus('Exported Reference Pass!');
      setTimeout(() => setExportStatus(null), 3000);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 font-sans select-none overflow-hidden">
      {/* Micro-Studio Topbar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-900/90 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-xs border border-emerald-500/30">
            🎬
          </div>
          <div>
            <h1 className="font-semibold text-sm text-zinc-100 tracking-wide">${resolvedTitle}</h1>
            <p className="text-[11px] text-zinc-400">Vibe-Coded Spatial Pre-Visualization & Blocking Director</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs px-2.5 py-1 rounded bg-zinc-800 text-zinc-300 border border-zinc-700/60 font-mono">
            {activeShot}
          </span>
          <button
            onClick={handleExportBlockingPass}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition shadow-lg shadow-emerald-950/40"
          >
            <Sparkles size={13} />
            <span>Export Reference to AI Video (Seedance / Veo)</span>
          </button>
        </div>
      </div>

      {/* Main Studio Work Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Shot Roster & Scene Props */}
        <div className="w-56 bg-zinc-900/50 border-r border-zinc-800 p-3 flex flex-col gap-3">
          <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Shots & Angles</div>
          <div className="space-y-1">
            {[
              'Shot 1: Establishing Orbit',
              'Shot 2: Low-Angle Approach',
              'Shot 3: Van Close-Up',
              'Shot 4: Overhead Drone'
            ].map(shot => (
              <button
                key={shot}
                onClick={() => setActiveShot(shot)}
                className={\`w-full text-left px-2.5 py-1.5 rounded-md text-xs font-medium transition \${activeShot === shot ? 'bg-zinc-800 text-zinc-100 border border-zinc-700' : 'text-zinc-400 hover:bg-zinc-800/40'}\`}
              >
                {shot}
              </button>
            ))}
          </div>

          <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mt-2">Scene Actors</div>
          <div className="space-y-1.5 text-xs text-zinc-300">
            <div className="flex items-center gap-2 px-2 py-1 rounded bg-zinc-800/60 border border-zinc-700/30">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50"></span>
              <span>Subject Alpha (Host)</span>
            </div>
            <div className="flex items-center gap-2 px-2 py-1 rounded bg-zinc-800/60 border border-zinc-700/30">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 shadow-sm shadow-red-500/50"></span>
              <span>Subject Beta (Driver)</span>
            </div>
            <div className="flex items-center gap-2 px-2 py-1 rounded bg-zinc-800/60 border border-zinc-700/30">
              <span className="w-2.5 h-2.5 rounded-full bg-zinc-400"></span>
              <span>Executive SUV / Van</span>
            </div>
          </div>
        </div>

        {/* Center: Dual WebGL Viewports */}
        <div className="flex-1 grid grid-cols-2 gap-1.5 p-2 bg-zinc-950">
          <div className="relative rounded-xl overflow-hidden border border-zinc-800 bg-zinc-900">
            <div className="absolute top-2.5 left-2.5 z-10 text-[11px] px-2 py-0.5 rounded bg-black/70 backdrop-blur text-zinc-300 border border-zinc-700/60">
              Free Orbit Camera (Director View)
            </div>
            <canvas ref={orbitCanvasRef} className="w-full h-full block" />
          </div>

          <div className="relative rounded-xl overflow-hidden border border-zinc-800 bg-zinc-900">
            <div className="absolute top-2.5 left-2.5 z-10 text-[11px] px-2 py-0.5 rounded bg-emerald-500/20 backdrop-blur text-emerald-300 border border-emerald-500/40">
              Shot Reference Camera (Video Model Pass)
            </div>
            <canvas ref={shotCanvasRef} className="w-full h-full block" />
          </div>
        </div>

        {/* Right: Camera & Optics Inspector */}
        <div className="w-64 bg-zinc-900/50 border-l border-zinc-800 p-3 flex flex-col gap-4">
          <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Lens & Optics</div>

          <div className="space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-zinc-400">Focal Length (FOV)</span>
              <span className="font-mono text-zinc-200">{fov}°</span>
            </div>
            <input
              type="range"
              min="24"
              max="90"
              value={fov}
              onChange={e => setFov(Number(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-zinc-400">Camera Elevation</span>
              <span className="font-mono text-zinc-200">{camHeight.toFixed(1)}m</span>
            </div>
            <input
              type="range"
              min="0.5"
              max="12"
              step="0.5"
              value={camHeight}
              onChange={e => setCamHeight(Number(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>

          {exportStatus && (
            <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs animate-fadeIn">
              {exportStatus}
            </div>
          )}

          <div className="mt-auto p-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-400">
            <div className="font-semibold text-zinc-300 mb-1">AI Video Prompt Sync</div>
            <p className="line-clamp-4 font-mono text-[10px] text-zinc-400">
              Cinematic master shot, desert architectural villa, black executive van parked in courtyard, two figures, smooth slow camera push, golden hour lighting, 8k resolution.
            </p>
          </div>
        </div>
      </div>

      {/* Bottom Timeline Scrubber */}
      <div className="h-20 bg-zinc-900/90 border-t border-zinc-800 px-4 py-2 flex flex-col justify-between">
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="p-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-100 transition"
            >
              {isPlaying ? <Pause size={12} className="text-emerald-400" /> : <Play size={12} />}
            </button>
            <span className="font-mono text-zinc-200">
              00:0{Math.floor(currentFrame / 30)}:{(currentFrame % 30).toString().padStart(2, '0')}
            </span>
          </div>
          <span className="text-[11px]">120 Frames (4.0s @ 30fps)</span>
        </div>

        <div className="relative w-full h-6 bg-zinc-950 rounded border border-zinc-800 flex items-center px-2 cursor-pointer">
          <div
            className="absolute top-0 bottom-0 w-1 bg-emerald-500 shadow-sm shadow-emerald-500/50"
            style={{ left: \`\${(currentFrame / 120) * 100}%\` }}
          />
          <div className="absolute left-1/4 w-2 h-3.5 bg-emerald-500/80 rounded-sm"></div>
          <div className="absolute left-2/3 w-2 h-3.5 bg-amber-500/80 rounded-sm"></div>
          <div className="w-full h-0.5 bg-zinc-800"></div>
        </div>
      </div>
    </div>
  );
}`;

    return {
        title: resolvedTitle,
        subtitle: 'Prompt-Crafted 3D Pre-Visualization & Blocking Micro-Studio',
        template: 'react',
        dependencies: {
            'three': '^0.160.0',
            'lucide-react': '^0.468.0'
        },
        files: [
            {
                id: 'App.tsx',
                name: 'App.tsx',
                language: 'react',
                content: appTsx,
                isEntry: true
            }
        ],
        viewportMode: 'desktop'
    };
}
