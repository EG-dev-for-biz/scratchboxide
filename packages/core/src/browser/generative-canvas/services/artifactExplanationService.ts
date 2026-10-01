/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    CanvasArtifact,
    Scene3DData,
    LiveCodeSandboxData,
    VideoTimelineData,
    KanbanBoardData,
    MetricDashboardData,
    MarkdownDocumentData,
    NodeGraphData
} from '../canvas-types';

/**
 * Builds a Cursor-grade structured Markdown explanation for any generated canvas artifact.
 * Describes what was created, technical architecture & pipeline specs, and clear viewport navigation controls.
 */
export function buildArtifactExplanationMarkdown(artifact: CanvasArtifact, prompt?: string): string {
    if (!artifact) return '';
    const type = artifact.type;

    switch (type) {
        case '3d-scene': {
            const data = (artifact.data || {}) as Scene3DData;
            const title = artifact.title || data.title || '3D Spatial Scene';
            const summary = artifact.summary || data.subtitle || 'Procedural 3D scene assembled on your visual canvas.';
            const isCpp = !!data.cppGenerator?.sourceCode;
            const engineType = isCpp ? 'Native C++20 Astra Engine (SIMD Geometry)' : 'Three.js Spatial Engine (PBR Shading)';
            const renderMode = (data.renderMode || 'pbr').toUpperCase();
            const cameraMode = (data.cameraMode || 'orbit').toUpperCase();

            const lines: string[] = [
                `### 🪐 ${title}`,
                '',
                summary,
                '',
                '#### 📐 Spatial & Technical Architecture',
                `- **Pipeline Engine**: \`${engineType}\``,
                `- **Render & Shading Mode**: \`${renderMode}\` | Camera: \`${cameraMode}\``
            ];

            if (data.geoAnchor) {
                const lat = data.geoAnchor.lat ?? 0;
                const lng = data.geoAnchor.lng ?? 0;
                const alt = data.geoAnchor.elevation ?? (data.geoAnchor as any).alt ?? 0;
                const latStr = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
                const lngStr = `${Math.abs(lng).toFixed(2)}°${lng >= 0 ? 'W' : 'E'}`;
                lines.push(`- **Geospatial Grounding**: \`${latStr}, ${lngStr}\` (Altitude: \`${alt}m\`)`);
            }

            if (data.environment) {
                const env = data.environment;
                const skybox = env.skybox || 'daylight';
                const lighting = env.lighting || 'cinematic';
                const kelvin = env.lightingKelvin ? `${env.lightingKelvin}K` : '5600K';
                lines.push(`- **Atmosphere & Lighting**: Skybox: \`${skybox}\` | Rig: \`${lighting}\` | Temperature: \`${kelvin}\``);
            }

            const meshes = data.customMeshes || [];
            if (meshes.length > 0) {
                const meshNames = meshes.slice(0, 4).map(m => `\`${m.name || m.id}\``).join(', ');
                const moreSuffix = meshes.length > 4 ? ` + ${meshes.length - 4} more` : '';
                lines.push(`- **Scene Hierarchy**: ${meshes.length} identifiable entities (${meshNames}${moreSuffix})`);
            }

            lines.push(
                '',
                '#### 🎮 Viewport Navigation & Controls',
                '- **Orbit**: Left Click Drag (or press `V` for View Mode)',
                '- **Pan**: Right Click Drag / `Shift` + Left Drag',
                '- **Zoom**: Scroll Wheel or Pinch',
                '- **Object Manipulator**: `W` (Translate), `E` (Rotate), `R` (Scale)',
                '- **Simulation Playhead**: Press `Spacebar` to play/pause animation scrubber',
                '- **Export Asset**: Click **📦 Export GLB** in the top bar to download standardized binary glTF'
            );

            return lines.join('\n');
        }

        case 'live-code-sandbox': {
            const data = (artifact.data || {}) as LiveCodeSandboxData;
            const title = artifact.title || data.title || 'Interactive Application Sandbox';
            const summary = artifact.summary || data.subtitle || 'Full-stack interactive prototype generated on your visual canvas.';
            const files = data.files || [];
            const fileNames = files.map(f => `\`${f.name}\``).join(', ');

            return [
                `### ⚡ ${title}`,
                '',
                summary,
                '',
                '#### 🛠️ Application Stack & Architecture',
                '- **Framework**: `React 18` + `TypeScript` + `Tailwind CSS` + `Lucide Icons`',
                `- **Files Assembled**: ${files.length} modules (${fileNames || '`App.tsx`'})`,
                '- **Transpilation**: In-browser zero-build Babel compiler with instant Hot Module Replacement',
                '',
                '#### 💻 Canvas Controls',
                '- **View Modes**: Toggle **Split**, **Code**, or **Preview** in the canvas header tabs',
                '- **Code Editing**: Directly edit source files in the embedded Monaco editor with live updates',
                '- **Download / Share**: Use the export button in the tab bar'
            ].join('\n');
        }

        case 'video-timeline': {
            const data = (artifact.data || {}) as VideoTimelineData;
            const title = artifact.title || data.title || 'Multi-Track Video Timeline';
            const fps = data.fps || 30;
            const duration = data.duration ? `${data.duration.toFixed(1)}s` : '14.0s';
            const tracks = data.tracks || [];
            const trackList = tracks.map(t => `\`${t.name} (${t.type})\``).join(', ');

            return [
                `### 🎬 ${title}`,
                '',
                artifact.summary || 'Multi-track non-linear video editing timeline generated on your visual canvas.',
                '',
                '#### 🎞️ Timeline Specifications',
                `- **Playback**: \`${fps} FPS\` | Aspect Ratio: \`${data.aspectRatio || '16:9'}\` | Total Duration: \`${duration}\``,
                `- **Track Structure**: ${tracks.length} tracks (${trackList || 'Video + Audio'})`,
                '',
                '#### ✂️ Editing Controls',
                '- **Play / Pause**: Spacebar',
                '- **Scrub**: Drag playhead or click anywhere on the ruler',
                '- **Split Clip**: Select a clip and click **Split** (or press `S`)',
                '- **Ripple Delete**: Select a clip and press `Delete` / `Backspace`'
            ].join('\n');
        }

        case 'kanban-board': {
            const data = (artifact.data || {}) as KanbanBoardData;
            const title = artifact.title || data.title || 'Operational Kanban Board';
            const cols = data.columns || [];
            const totalCards = cols.reduce((sum, c) => sum + (c.cards?.length || 0), 0);

            return [
                `### 📋 ${title}`,
                '',
                artifact.summary || 'Structured Kanban roadmap and task workflow board generated on your visual canvas.',
                '',
                '#### 📊 Board Overview',
                `- **Columns**: ${cols.length} stages (${cols.map(c => `\`${c.title}\``).join(' → ')})`,
                `- **Total Action Items**: ${totalCards} tasks with priorities and subtask checklists`,
                '',
                '#### 📌 Interactions',
                '- Drag and drop cards between stages',
                '- Check off subtask checkboxes directly on each card'
            ].join('\n');
        }

        case 'metric-dashboard': {
            const data = (artifact.data || {}) as MetricDashboardData;
            const title = artifact.title || data.title || 'Telemetry & KPI Metrics Dashboard';
            const metrics = data.metrics || [];

            return [
                `### 📈 ${title}`,
                '',
                artifact.summary || 'Interactive metrics dashboard with real-time KPI telemetry and visual analytics.',
                '',
                '#### 📊 Metrics Telemetry',
                `- **KPI Counters**: ${metrics.length} monitored parameters`,
                `- **Visualization**: Time-series charts, status gauges, and data breakdown table`
            ].join('\n');
        }

        case 'markdown-document': {
            const data = (artifact.data || {}) as MarkdownDocumentData;
            const title = artifact.title || data.title || 'Structured Specification Document';
            const sections = data.sections || [];

            return [
                `### 📄 ${title}`,
                '',
                artifact.summary || 'Structured technical specification document generated on your visual canvas.',
                '',
                '#### 📑 Outline',
                `- **Sections**: ${sections.length} headings formulated with inline diagrams and specifications`
            ].join('\n');
        }

        case 'node-graph': {
            const data = (artifact.data || {}) as NodeGraphData;
            const title = artifact.title || data.title || 'System Architecture Node Graph';
            const nodes = data.nodes || [];
            const edges = data.edges || [];

            return [
                `### 🕸️ ${title}`,
                '',
                artifact.summary || 'Interactive node graph diagram with topology layout and data connections.',
                '',
                '#### 🔗 Topology Breakdown',
                `- **Nodes**: ${nodes.length} functional blocks`,
                `- **Connections**: ${edges.length} directed signal edges`
            ].join('\n');
        }

        default:
            return `I've generated the **${artifact.title || 'Canvas Artifact'}** on your visual canvas.`;
    }
}
