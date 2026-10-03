/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';
import { PRELOADED_SHOWCASE_DEMOS, ShowcaseDemoItem } from '../../demos/preloadedDemos';
import { IconExternalLink, IconSparkles } from '../../canvas-icons';

export interface StandaloneStudioItem {
    id: string;
    title: string;
    subtitle: string;
    category: 'VFX & Matchmove' | '3DGS & Splats' | 'Geospatial & 3D Tiles' | 'Texture & PBR' | 'Lighting & Atmosphere' | 'Botany & Nature';
    path: string;
    description: string;
    tags: string[];
    badge: string;
}

export const STANDALONE_STUDIOS_CATALOG: StandaloneStudioItem[] = [
    // 0. Nanite Meshlets & Progressive Path Tracing Studio
    {
        id: 'nanite-meshlet-pathtracing-studio',
        title: 'Nanite Meshlets & Progressive Path Tracing Studio',
        subtitle: 'Virtualized Geometry DAG · ~1px Continuous LOD & WebGPU Indirect GI',
        category: 'Geospatial & 3D Tiles',
        path: '/nanite_meshlet_pathtracing_studio.html',
        description: 'Interactive real-time cluster DAG inspector with ~1px screen-space error cuts, GPU compute frustum & Hi-Z culling, and progressive Monte Carlo GI.',
        tags: ['Nanite', 'Meshlets', 'Cluster DAG', 'WebGPU Indirect', 'Path Tracing', 'SVGF'],
        badge: 'NANITE WEBGPU'
    },
    // 1. Architecture 2: Offline Texture Atlas Re-grade Proof
    {
        id: 'colosseum-recolor-proof',
        title: 'Architecture 2: Offline Texture Atlas Re-grade Proof',
        subtitle: 'Real Google 3D Tiles · Rome Colosseum CIELAB Regrade & Toksvig Coupling',
        category: 'Texture & PBR',
        path: '/colosseum_recolor_proof.html',
        description: 'Dual-viewport 3D inspection comparing raw daytime photogrammetry against 1K PBR suite (de-lighted travertine, normal relief, roughness, soot crusting).',
        tags: ['PBR Pipeline', 'Rome Colosseum', 'CIELAB', 'Toksvig Roughness', 'Dual Viewport'],
        badge: 'PBR PIPELINE'
    },
    // 2. 3D Testing Workbench · Modular Layers (High-Fidelity 3DGS Engine)
    {
        id: 'spatial-photoreal-3dgs',
        title: '3D Testing Workbench (Modular Layers) · High-Fidelity 3DGS Engine',
        subtitle: 'Rome Colosseum 1K PBR & 3DGS Hybrid with 15 Modular Inspection Layers',
        category: '3DGS & Splats',
        path: '/spatial_photoreal_3dgs_demo.html',
        description: 'Complete 3D Testing Workbench featuring Compositing, Assets Hub, 1K PBR Suite, Micro-Depth, UTDRA Mesh, Matchmove, Atmosphere, VFX Lens & Optics, Pro GI & Bounces, Cinematic Shadows, Diagnostics, Clearance, Reshaper, and AI Beautify.',
        tags: ['3D Testing Workbench', 'Modular Layers', 'Rome Colosseum', 'Compositing', '1K PBR Suite', '3DGS Engine', 'VFX Optics', 'GI Bounces', '1.3M Splats'],
        badge: 'MODULAR WORKBENCH'
    },
    // 3. Agent 3D Scene Lighting Intelligence & Photographic Matching
    {
        id: 'agent-lighting-proof',
        title: 'Agent 3D Scene Lighting Intelligence & Photographic Matching',
        subtitle: '6-Panel Photometric Resection & Closed-Loop Gaffer Rigs',
        category: 'Lighting & Atmosphere',
        path: '/agent_lighting_proof.html',
        description: 'Ground-truth shadow penumbra matching (≥95% sub-pixel convergence), Rembrandt chiaroscuro rigs, procedural gobo cookies, and travertine de-lighting.',
        tags: ['Lighting Intelligence', 'Gaffer Rigs', 'Closed-Loop Resection', 'Gobo Cookies', 'De-Lighting'],
        badge: 'GAFFER INTEL'
    },
    // 4. Nano Banana 3D Tile Texture Super-Resolution & Distortion Experiment
    {
        id: 'nano-banana-texture-upscale',
        title: 'Nano Banana 3D Tile Texture Super-Resolution & Distortion',
        subtitle: 'Shape-Grounded Rewrap & 4x Extreme Micro-Detail Loupe',
        category: 'Texture & PBR',
        path: '/nano_banana_texture_upscale_experiment.html',
        description: 'Interactive 2D atlas & 3D Colosseum viewports evaluating 0.000 mm spatial lock, ashlar joint deepening, and travertine cavitation pores.',
        tags: ['Nano Banana', '4x Loupe', 'Shape-Grounded Rewrap', '0.000mm Drift', 'Micro-Detail'],
        badge: '0.000MM DRIFT'
    },
    // 5. GeoBox Geolocation Model Evaluation
    {
        id: 'geobox-eval-report',
        title: 'GeoBox Geolocation Model Evaluation',
        subtitle: 'SigLIP-2 Multi-Resolution Spherical Hash Grid Inference Engine',
        category: 'Geospatial & 3D Tiles',
        path: '/geobox_eval_report.html',
        description: 'Global satellite map evaluation with Haversine geodesic error calculations and top-5 landmark candidate ranking against Google Maps Platform.',
        tags: ['SigLIP-2', 'Spherical Hash Grid', 'Paris Satellite', 'Eiffel Tower', 'Haversine Metrology'],
        badge: 'SIGLIP-2 AI'
    },
    // 6. SCRATCHBOX STUDIO: VFX Plate Coordination & Real-Time Anti-Drift Engine
    {
        id: 'vfx-plate-anti-drift-demo',
        title: 'SCRATCHBOX STUDIO: VFX Plate Coordination Anti-Drift Engine',
        subtitle: '4-Quadrant Studio: 6-DoF Matchmove, Distortion & Holdout Mattes',
        category: 'VFX & Matchmove',
        path: '/vfx_plate_anti_drift_demo.html',
        description: 'Real-time camera solve alignment against 4K plates, Brown-Conrady optical lens distortion, and foreground actor depth holdouts.',
        tags: ['Anti-Drift Engine', '4-Quadrant Cockpit', 'Brown-Conrady', 'NOAA Sun Lock', 'Depth Holdout'],
        badge: 'ANTI-DRIFT'
    },
    // 7. COLMAP / GLOMAP 3D Reconstruction Viewer
    {
        id: 'colmap-visualizer',
        title: 'COLMAP / GLOMAP 3D Reconstruction Viewer',
        subtitle: 'Structure-from-Motion Sparse Rig & OpenCV-to-OpenGL Frame Bridge',
        category: 'Geospatial & 3D Tiles',
        path: '/colmap_visualizer.html',
        description: 'Interactive 3D inspection of sparse SfM point cloud reconstructions with multi-camera orbital frustums and C++20 SIMD telemetry.',
        tags: ['COLMAP / GLOMAP', 'C++20 Native', 'SfM Sparse Rig', 'Optical Poses', 'Frustum Viz'],
        badge: 'C++20 NATIVE'
    },
    // 8. Botanical & Vegetation Pipeline Visualizer
    {
        id: 'botanical-visualizer',
        title: 'Botanical & Vegetation Pipeline Visualizer',
        subtitle: 'Conformal Street Tree (7.98m) & Transferred Foliage Normals',
        category: 'Botany & Nature',
        path: '/botanical_visualizer.html',
        description: 'Interactive 15-stage botanical synthesis testing space colonization, allometric trunk tapering, and radial canopy envelope normals.',
        tags: ['Botanical Engine', 'Conformal Tree', 'Transferred Normals', 'Allometric Taper', 'Foliage PBR'],
        badge: 'BOTANICAL PBR'
    },
    // 9. Plaza Hotel 6-DoF Matchmove Studio
    {
        id: 'plaza-matchmove',
        title: 'Plaza Hotel 6-DoF Matchmove Studio',
        subtitle: 'Central Park South 361-Frame Continuous Solve & 3-Model Arena',
        category: 'VFX & Matchmove',
        path: '/plaza_matchmove_demo.html',
        description: 'Production-grade VFX plate matchmoving with physical optical camera frustum, interactive 50/50 wipe split, and AI restyling comparison.',
        tags: ['6-DoF Matchmove', 'Central Park South', '361 Frames', '50/50 Wipe', 'Model Arena'],
        badge: 'STUDIO GRADE'
    },
    // 10. GeoBox Multimodal Resection Studio
    {
        id: 'geobox-resection',
        title: 'GeoBox Multimodal Resection Studio',
        subtitle: 'Zero-GPS Image Localization & Roman Travertine Dusk Relighting',
        category: 'Geospatial & 3D Tiles',
        path: '/geobox_demo.html',
        description: 'Analytical solvePnP camera resection, stone albedo de-lighting, 2850K window portal fixtures, and 50/50 wipe splits.',
        tags: ['solvePnP', 'Colosseum Rome', 'Dusk Atmosphere', 'Window Lights', 'USD Export'],
        badge: 'ANALYTICAL'
    },
    // 11. Multi-District Generative S4D Gallery
    {
        id: 's4d-gallery',
        title: 'Multi-District Generative S4D Gallery',
        subtitle: 'Textured vs Clay Flights & Omni 1.1 Neural Restyle',
        category: 'Geospatial & 3D Tiles',
        path: '/s4d_multi_gallery.html',
        description: 'Multi-district aerial flight inspector with 3 video switcher modes (Blockout, Omni, Side-by-Side) and storyboard keyframe lightbox.',
        tags: ['S4D Multi-Gallery', 'Clay Flight', 'Textured Flight', 'Omni 1.1', 'Storyboard Lightbox'],
        badge: 'MULTI-SCENE'
    },
    // 12. Red Rocks 4D Gaussian Splatting Performer
    {
        id: 'red-rocks-performer',
        title: 'Red Rocks 4D Gaussian Splatting Performer',
        subtitle: 'Real-Time 2D EWA Anisotropic Splats in WebGL',
        category: '3DGS & Splats',
        path: '/red_rocks_performer_demo.html',
        description: '60 FPS in-browser 4D Gaussian Splatting dynamic performer avatar (\'Man in Black\') performing inside Google 3D Tiles.',
        tags: ['Red Rocks', '4DGS Performer', 'Man in Black', '2D EWA Splats', '4-Bone LBS'],
        badge: 'REAL-TIME 3DGS'
    },
    // 13. Universal Architecture & Terrain (UTDRA)
    {
        id: 'universal-architecture-terrain',
        title: 'Universal Architecture & Terrain (UTDRA)',
        subtitle: 'Bridge Void Carving & Sutherland-Hodgman Elevation Slicing',
        category: 'Geospatial & 3D Tiles',
        path: '/universal_architecture_terrain_demo.html',
        description: 'Universal Tile Decomposition & Rectification Algorithm across 9 biomes with >=3.5m bridge void clearance.',
        tags: ['UTDRA / ULDRA', 'Arch of Constantine', 'Bridge Void Carver', 'Elevation Slicing', 'Biome AI'],
        badge: 'UTDRA/ULDRA'
    },
    // 14. Botanical & Forest Procedural 3D Viewer
    {
        id: 'forest-3d-viewer',
        title: 'Botanical & Forest Procedural 3D Viewer',
        subtitle: '70-20-10 Hierarchy, Nurse Logs & Rhytidome Bark PBR',
        category: 'Botany & Nature',
        path: '/forest_3d_viewer.html',
        description: 'Photorealistic procedural coniferous forest with nurse logs, soft foliage normals, and crepuscular god rays.',
        tags: ['Procedural Forest', 'Nurse Logs', 'Rhytidome Bark', 'God Rays', 'Foliage Stratification'],
        badge: 'PHOTOREAL PBR'
    },
    // 15. Video-to-4D Performer Reconstruction Studio
    {
        id: 'video-to-4d-studio',
        title: 'Video-to-4D Performer Reconstruction Studio',
        subtitle: 'GVHMR Kinematics, Visual-Hull Carving & Wan2.2 DiT',
        category: '3DGS & Splats',
        path: '/video_to_4d_performer_studio.html',
        description: 'Full pipeline inspector for converting monocular performer video into 4D animated Gaussians with 2cm voxel visual-hull carving.',
        tags: ['Video to 4D', 'GVHMR', 'Visual Hull', 'Wan2.2 DiT', 'Nerfstudio Export'],
        badge: '4D PIPELINE'
    },
    // 16. Adaptive Matchmove & C² Spline Studio
    {
        id: 'adaptive-matchmove',
        title: 'Adaptive Matchmove & C² Spline Calibration Studio',
        subtitle: 'Huber Loss Bundle Adjustment & Sub-Pixel Metrology',
        category: 'VFX & Matchmove',
        path: '/adaptive_matchmove_studio.html',
        description: 'Camera trajectory smoothing enforcing Mean Reprojection RMS < 0.05 px, Sobel Edge NCC >= 98%, and drone flight dynamics.',
        tags: ['C² Spline', 'Bundle Adjustment', 'Huber Loss', 'Drone Flight', 'Metrology'],
        badge: 'SUB-PIXEL RMS'
    },
    // 17. Person Matchmove & Dynamic Skeleton Aligner
    {
        id: 'person-matchmove',
        title: 'Person Matchmove & Dynamic Skeleton Aligner',
        subtitle: 'Cyan Skeleton Overlay & Kinematic Metrology Diff',
        category: 'VFX & Matchmove',
        path: '/person_matchmove_studio.html',
        description: 'Interactive matchmover for human subjects with MediaPipe kinematics, frame scrubber, and metrology difference viewer.',
        tags: ['Person Matchmove', 'Cyan Skeleton', 'Metrology Diff', 'Frame Scrubber', 'Split Wipe'],
        badge: 'KINEMATICS'
    },
    // 18. Google 360 Panorama Studio & Seam Healer
    {
        id: 'google-360-panorama',
        title: 'Google 360 Panorama Studio & Seam Healer',
        subtitle: 'Spherical Seam Healing & Depth Point Cloud Unprojection',
        category: 'Geospatial & 3D Tiles',
        path: '/google_360_panorama_studio.html',
        description: '360 equirectangular street panorama renderer with automatic seam healing and monocular depth backprojection.',
        tags: ['360 Panorama', 'Seam Healing', 'Equirectangular', 'Depth Unproject', 'Street View'],
        badge: '360 PANORAMA'
    },
    // 19. DepthBox Studio // 2D Image(s) -> 3DGS Engine
    {
        id: 'depthbox-image-to-3dgs',
        title: 'DepthBox Studio // 2D Image(s) -> 3DGS Engine',
        subtitle: 'Multi-View Monocular Depth to 3D Gaussian Splats',
        category: '3DGS & Splats',
        path: '/depthbox_image_to_3dgs.html',
        description: 'Fast 2D image group to 3DGS backprojection and splat synthesis with depth confidence filtering.',
        tags: ['DepthBox', 'Image to 3DGS', 'Dense Point Cloud', 'Depth Backproject', 'Gaussian Splatting'],
        badge: 'IMAGE TO 3DGS'
    },
    // 20. Asset Compositor Demo Studio
    {
        id: 'asset-demo-studio',
        title: 'Asset Compositor Demo Studio',
        subtitle: 'High-Res PBR Models, 4K Video Plates & Trajectories',
        category: 'Texture & PBR',
        path: '/asset_demo_studio.html',
        description: 'Central verification studio loading binary glTF models (Empire State, Humanoid 10331522), 4K plates, and 361-frame camera paths.',
        tags: ['Asset Compositor', 'glTF Binary', '4K Plates', 'Empire State', 'Camera Path'],
        badge: 'ASSET SUITE'
    },
    // 21. Camera Choreography & Trajectory Studio
    {
        id: 'camera-choreography-studio',
        title: 'Camera Choreography & Trajectory Studio',
        subtitle: 'Multi-Angle Orbital Spline Paths & Keyframe Pacing',
        category: 'VFX & Matchmove',
        path: '/camera_choreography_studio.html',
        description: 'Interactive cinematic camera director designing 6-DOF spline paths, focal breathing, and drone flight kinematics.',
        tags: ['Camera Choreography', 'Spline Paths', 'Kinematics', 'Flight Pacing', '6-DoF'],
        badge: 'CHOREOGRAPHY'
    },
    // 22. Pro Color Grade Match Studio
    {
        id: 'pro-color-grade-match-studio',
        title: 'Pro Color Grade Match Studio',
        subtitle: '3D LUT Grading & Planckian Diurnal Kelvin Calibration',
        category: 'Lighting & Atmosphere',
        path: '/pro_color_grade_match_studio.html',
        description: 'Atmospheric color matching suite with 3D LUT cube grading (1000K–40000K), Beer-Lambert aerial extinction, and ACES tonemapping.',
        tags: ['Color Grading', '3D LUT', 'Planckian Kelvin', 'Beer-Lambert', 'ACES'],
        badge: 'COLOR GRADE'
    },
    // 23. Adaptive World Styling Visualizer
    {
        id: 'adaptive-world-styling-visualizer',
        title: 'Adaptive World Styling Visualizer',
        subtitle: 'Multi-Biome Procedural Terrain & Material Transitions',
        category: 'Botany & Nature',
        path: '/adaptive_world_styling_visualizer.html',
        description: 'Real-time procedural biome generator blending multi-layer strata, soil moisture gradients, and procedural vegetation.',
        tags: ['Adaptive World', 'Multi-Biome', 'Terrain Generation', 'Procedural Strata', 'PBR Materials'],
        badge: 'ADAPTIVE BIOMES'
    },
    // 24. The Plaza Hotel · Eloise Shot Matchmove Recreation
    {
        id: 'plaza-matchmove-eloise',
        title: 'The Plaza Hotel · Eloise Shot Matchmove Recreation',
        subtitle: 'Production Shot Recreation with 3D Mesh & Omni Video Sync',
        category: 'VFX & Matchmove',
        path: '/plaza_matchmove_eloise.html',
        description: 'Dedicated cinematic shot reconstruction matching camera solve, live plate, and neural diffusion output for the iconic Eloise sequence.',
        tags: ['Eloise Shot', 'Plaza Hotel', 'Shot Recreation', 'Camera Solve', 'Omni Sync'],
        badge: 'SHOT RECREATION'
    },
    // 25. Generative Video Branching & Decision Tree Studio
    {
        id: 'video-branching-studio',
        title: 'Generative Video Branching & Decision Tree Studio',
        subtitle: 'Non-Linear Storyboard Sequencing & Multi-Route Synthesis',
        category: 'VFX & Matchmove',
        path: '/video_branching_studio.html',
        description: 'Interactive branching narrative studio for connecting conditional video nodes, choice points, and seamless video cross-fades.',
        tags: ['Video Branching', 'Interactive Narrative', 'Decision Tree', 'Storyboards', 'Cross-Fade'],
        badge: 'BRANCHING NLE'
    },
    // 26. GeoBox Precision 6-DOF Camera Resection Report
    {
        id: 'geobox-precision-report',
        title: 'GeoBox Precision 6-DOF Camera Resection Report',
        subtitle: 'Sub-Pixel Optical Alignment & Ground-Truth Metrology Audit',
        category: 'Geospatial & 3D Tiles',
        path: '/geobox_precision_report.html',
        description: 'Analytical metrology report auditing 6-DOF resection residuals (<0.05px RMS) and closed-loop edge cross-correlation.',
        tags: ['Precision Report', 'solvePnP Metrology', 'Sub-Pixel Residuals', 'Edge Alignment', 'Audit'],
        badge: 'PRECISION AUDIT'
    },
    // 27. Visual Proof Alignment & Multimodal Certification
    {
        id: 'visual-proof-alignment',
        title: 'Visual Proof Alignment & Multimodal Certification',
        subtitle: '100% Sub-Pixel Geometric Lock & Photogrammetric Validation',
        category: 'Geospatial & 3D Tiles',
        path: '/visual_proof_alignment.html',
        description: 'Multimodal certification studio comparing live-action photography with 3D tile massings across iconic international landmarks.',
        tags: ['Visual Proof', 'Multimodal Match', 'Geometric Lock', 'Sub-Pixel', '3D Tiles'],
        badge: 'PROOF AUDIT'
    }
];

export const AdminTab: React.FC = () => {
    const { onLaunchDemo, onClose } = useSettingsContext();
    const [selectedCategory, setSelectedCategory] = React.useState<string>('all');
    const [searchQuery, setSearchQuery] = React.useState<string>('');

    const handleLaunchInAppDemo = (demo: ShowcaseDemoItem) => {
        if (onLaunchDemo) {
            onLaunchDemo(demo);
        }
        onClose();
    };

    const handleLaunchStudioSpace = (studio: StandaloneStudioItem) => {
        if (onLaunchDemo) {
            const demoItem: ShowcaseDemoItem = {
                id: `demo-studio-${studio.id}`,
                title: studio.title,
                subtitle: studio.subtitle,
                category: '3d',
                categoryLabel: studio.category,
                description: studio.description,
                tags: studio.tags,
                highlightBadge: studio.badge,
                artifact: {
                    id: `art-studio-${studio.id}`,
                    type: 'interactive-browser',
                    title: studio.title,
                    summary: `${studio.subtitle} — ${studio.description}`,
                    data: {
                        url: studio.path,
                        title: studio.title,
                        viewportMode: 'desktop'
                    },
                    createdAt: new Date().toISOString(),
                    version: 1
                },
                introMessage: `Welcome to the **${studio.title}** interactive studio space. This workspace runs directly inside the Scratchbox IDE canvas stage with full 60 FPS WebGL rendering, camera choreography, and sub-pixel metrology.`
            };
            onLaunchDemo(demoItem);
        }
        onClose();
    };

    const handleOpenExternal = (relPath: string) => {
        const fullUrl = relPath.startsWith('http') ? relPath : `${window.location.origin}${relPath}`;
        window.open(fullUrl, '_blank', 'noopener,noreferrer');
    };

    const filteredInApp = PRELOADED_SHOWCASE_DEMOS.filter(demo => {
        const matchesCategory = selectedCategory === 'all' || selectedCategory === 'canvas';
        if (!matchesCategory) return false;
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase().trim();
        return demo.title.toLowerCase().includes(q) ||
            demo.subtitle.toLowerCase().includes(q) ||
            demo.tags.some(t => t.toLowerCase().includes(q));
    });

    const filteredStandalone = STANDALONE_STUDIOS_CATALOG.filter(studio => {
        const matchesCategory =
            selectedCategory === 'all' ||
            selectedCategory === 'webgl' ||
            (selectedCategory === 'vfx' && studio.category === 'VFX & Matchmove') ||
            (selectedCategory === '3dgs' && studio.category === '3DGS & Splats') ||
            (selectedCategory === 'tiles' && studio.category === 'Geospatial & 3D Tiles') ||
            (selectedCategory === 'pbr' && studio.category === 'Texture & PBR') ||
            (selectedCategory === 'lighting' && (studio.category === 'Lighting & Atmosphere' || studio.category === 'Botany & Nature'));

        if (!matchesCategory) return false;
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase().trim();
        return studio.title.toLowerCase().includes(q) ||
            studio.subtitle.toLowerCase().includes(q) ||
            studio.category.toLowerCase().includes(q) ||
            studio.path.toLowerCase().includes(q) ||
            studio.tags.some(t => t.toLowerCase().includes(q));
    });

    return (
        <div className="sb-cursor-settings-content animate-fadeIn" style={{ gap: '20px', maxWidth: '820px' }}>
            {/* Header Section */}
            <div style={{ textAlign: 'left' }}>
                <h2 className="sb-cursor-content-title">Admin &amp; Showcase Demos</h2>
                <div style={{ fontSize: '12px', color: '#71717a', lineHeight: '1.5', marginTop: '4px' }}>
                    Developer and administrative access to preloaded interactive canvas stages, standalone WebGL VFX studios, and 4D Gaussian Splatting testbeds across the codebase.
                </div>
            </div>

            {/* Filter and Search Bar */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 14px',
                    borderRadius: '10px',
                    background: '#18181b',
                    border: '1px solid rgba(255, 255, 255, 0.08)'
                }}
            >
                <input
                    type="text"
                    style={{
                        flex: 1,
                        background: 'transparent',
                        border: 'none',
                        outline: 'none',
                        fontSize: '12.5px',
                        color: '#f4f4f5',
                        fontFamily: 'inherit'
                    }}
                    placeholder="Filter demos by title, location, technology, or asset..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    {[
                        { id: 'all', label: 'All Demos' },
                        { id: 'canvas', label: 'Canvas Stages' },
                        { id: 'webgl', label: 'All WebGL' },
                        { id: 'vfx', label: 'VFX' },
                        { id: '3dgs', label: '3DGS' },
                        { id: 'tiles', label: '3D Tiles' },
                        { id: 'pbr', label: 'PBR' }
                    ].map(tab => (
                        <button
                            key={tab.id}
                            type="button"
                            className="sb-btn sb-segment-btn"
                            style={{
                                fontSize: '11px',
                                fontWeight: selectedCategory === tab.id ? 600 : 500,
                                padding: '4px 10px',
                                borderRadius: '6px',
                                background: selectedCategory === tab.id ? '#2563eb' : 'rgba(255, 255, 255, 0.06)',
                                border: selectedCategory === tab.id ? '1px solid #3b82f6' : '1px solid rgba(255, 255, 255, 0.08)',
                                color: selectedCategory === tab.id ? '#ffffff' : '#a1a1aa',
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                                outline: 'none'
                            }}
                            onClick={() => setSelectedCategory(tab.id)}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Section 1: In-App Generative Canvas Stages */}
            {(selectedCategory === 'all' || selectedCategory === 'canvas') && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 2px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 600, color: '#f4f4f5' }}>
                            <span style={{ color: '#60a5fa', display: 'inline-flex' }}>
                                <IconSparkles size={15} />
                            </span>
                            <span>In-App Generative Canvas Stages ({filteredInApp.length})</span>
                        </div>
                        <span style={{ fontSize: '11px', color: '#71717a' }}>Mounts directly into current canvas stage</span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {filteredInApp.map(demo => (
                            <div
                                key={demo.id}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '14px 16px',
                                    borderRadius: '10px',
                                    background: '#1c1c1f',
                                    border: '1px solid rgba(255, 255, 255, 0.08)',
                                    gap: '16px',
                                    textAlign: 'left'
                                }}
                            >
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: 1, minWidth: 0, textAlign: 'left' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', textAlign: 'left' }}>
                                        <span style={{ fontSize: '13.5px', fontWeight: 600, color: '#f4f4f5' }}>{demo.title}</span>
                                        <span
                                            style={{
                                                fontSize: '9.5px',
                                                fontWeight: 700,
                                                textTransform: 'uppercase',
                                                letterSpacing: '0.04em',
                                                padding: '2px 8px',
                                                borderRadius: '4px',
                                                background: 'rgba(59, 130, 246, 0.15)',
                                                color: '#60a5fa',
                                                border: '1px solid rgba(59, 130, 246, 0.3)'
                                            }}
                                        >
                                            {demo.highlightBadge}
                                        </span>
                                    </div>
                                    <div style={{ fontSize: '12px', fontWeight: 500, color: '#94a3b8', textAlign: 'left' }}>{demo.subtitle}</div>
                                    <div style={{ fontSize: '11.5px', color: '#71717a', lineHeight: '1.45', textAlign: 'left' }}>{demo.description}</div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', marginTop: '4px', textAlign: 'left' }}>
                                        {demo.tags.slice(0, 5).map(tag => (
                                            <span
                                                key={tag}
                                                style={{
                                                    fontSize: '10px',
                                                    fontFamily: 'ui-monospace, monospace',
                                                    padding: '2px 7px',
                                                    borderRadius: '4px',
                                                    background: 'rgba(255, 255, 255, 0.04)',
                                                    color: '#a1a1aa',
                                                    border: '1px solid rgba(255, 255, 255, 0.07)'
                                                }}
                                            >
                                                #{tag}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-primary"
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            gap: '6px',
                                            height: '32px',
                                            padding: '0 14px',
                                            borderRadius: '6px',
                                            fontSize: '12px',
                                            fontWeight: 600,
                                            cursor: 'pointer',
                                            whiteSpace: 'nowrap',
                                            background: '#2563eb',
                                            color: '#ffffff',
                                            border: '1px solid rgba(59, 130, 246, 0.6)',
                                            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.25)',
                                            outline: 'none'
                                        }}
                                        onClick={() => handleLaunchInAppDemo(demo)}
                                    >
                                        <IconSparkles size={13} />
                                        <span>Launch Stage</span>
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Section 2: Standalone WebGL Studios & VFX Players */}
            {selectedCategory !== 'canvas' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '6px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 2px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 600, color: '#f4f4f5' }}>
                            <span style={{ color: '#34d399', display: 'inline-flex' }}>
                                <IconExternalLink size={15} />
                            </span>
                            <span>Standalone WebGL &amp; VFX Studios ({filteredStandalone.length})</span>
                        </div>
                        <span style={{ fontSize: '11px', color: '#71717a' }}>Launches full interactive WebGL/3DGS studio space in canvas</span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {filteredStandalone.map(studio => (
                            <div
                                key={studio.id}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '14px 16px',
                                    borderRadius: '10px',
                                    background: '#1c1c1f',
                                    border: '1px solid rgba(255, 255, 255, 0.08)',
                                    gap: '16px',
                                    textAlign: 'left'
                                }}
                            >
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: 1, minWidth: 0, textAlign: 'left' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', textAlign: 'left' }}>
                                        <span style={{ fontSize: '13.5px', fontWeight: 600, color: '#f4f4f5' }}>{studio.title}</span>
                                        <span
                                            style={{
                                                fontSize: '10px',
                                                fontFamily: 'ui-monospace, monospace',
                                                padding: '1.5px 6px',
                                                borderRadius: '4px',
                                                background: 'rgba(255, 255, 255, 0.06)',
                                                color: '#d4d4d8',
                                                border: '1px solid rgba(255, 255, 255, 0.08)'
                                            }}
                                        >
                                            {studio.path}
                                        </span>
                                        <span
                                            style={{
                                                fontSize: '9.5px',
                                                fontWeight: 700,
                                                textTransform: 'uppercase',
                                                letterSpacing: '0.04em',
                                                padding: '2px 8px',
                                                borderRadius: '4px',
                                                background: 'rgba(16, 185, 129, 0.15)',
                                                color: '#34d399',
                                                border: '1px solid rgba(16, 185, 129, 0.3)'
                                            }}
                                        >
                                            {studio.badge}
                                        </span>
                                    </div>
                                    <div style={{ fontSize: '12px', fontWeight: 500, color: '#94a3b8', textAlign: 'left' }}>{studio.subtitle}</div>
                                    <div style={{ fontSize: '11.5px', color: '#71717a', lineHeight: '1.45', textAlign: 'left' }}>{studio.description}</div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', marginTop: '4px', textAlign: 'left' }}>
                                        {studio.tags.map(tag => (
                                            <span
                                                key={tag}
                                                style={{
                                                    fontSize: '10px',
                                                    fontFamily: 'ui-monospace, monospace',
                                                    padding: '2px 7px',
                                                    borderRadius: '4px',
                                                    background: 'rgba(255, 255, 255, 0.04)',
                                                    color: '#a1a1aa',
                                                    border: '1px solid rgba(255, 255, 255, 0.07)'
                                                }}
                                            >
                                                #{tag}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-primary"
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            gap: '6px',
                                            height: '32px',
                                            padding: '0 14px',
                                            borderRadius: '6px',
                                            fontSize: '12px',
                                            fontWeight: 600,
                                            cursor: 'pointer',
                                            whiteSpace: 'nowrap',
                                            background: '#047857',
                                            color: '#ffffff',
                                            border: '1px solid rgba(16, 185, 129, 0.5)',
                                            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.25)',
                                            outline: 'none',
                                            transition: 'all 0.15s ease'
                                        }}
                                        onClick={() => handleLaunchStudioSpace(studio)}
                                    >
                                        <span style={{ display: 'inline-flex' }}>
                                            <IconSparkles size={13} />
                                        </span>
                                        <span>Open Studio Space</span>
                                    </button>
                                    <button
                                        type="button"
                                        className="sb-btn sb-icon-button"
                                        title="Open in new window / external browser"
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            width: '32px',
                                            height: '32px',
                                            padding: 0,
                                            borderRadius: '6px',
                                            cursor: 'pointer',
                                            background: 'rgba(255, 255, 255, 0.06)',
                                            color: '#a1a1aa',
                                            border: '1px solid rgba(255, 255, 255, 0.12)',
                                            outline: 'none',
                                            transition: 'all 0.15s ease'
                                        }}
                                        onClick={() => handleOpenExternal(studio.path)}
                                    >
                                        <IconExternalLink size={13} />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};
