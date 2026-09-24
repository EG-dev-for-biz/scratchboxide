import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  Google3DTileBlockoutPipelineService
} from '../src/node/spatial/Google3DTileBlockoutPipelineService';
import { GOOGLE_3D_TILES_TOOL_DECLARATIONS, google3DTilesHandlers } from '../src/node/gemini/tools/spatial-tools';

describe('Zero Building Clipping & Atomic Building Integrity', () => {
  const service = new Google3DTileBlockoutPipelineService();

  describe('1. Directives & Agent Skills Codification', () => {
    it('should have Rule: Zero Building Clipping codified in AGENTS.md', () => {
      const agentsMdPath = path.resolve(__dirname, '../../../AGENTS.md');
      const content = fs.readFileSync(agentsMdPath, 'utf8');

      expect(content).toContain('### Rule: Zero Building Clipping During Tile Extraction & Ingestion (Atomic Building Integrity)');
      expect(content).toContain('Atomic Architectural Entity Invariant (Zero-Cut Extraction)');
      expect(content).toContain('Unbounded Vertical Skyward Extent');
      expect(content).toContain('Boundary Dilation & Connected Component Expansion');
      expect(content).toContain('Multi-Tier Zenith & Horizon Frustum Encompassment');
      expect(content).toContain('Unified Multi-District Contiguous Tile Streaming');
      expect(content).toContain('Automated Verification & Rejection Gate');
    });

    it('should have Ingestion Quality Standards codified in google-3d-tiles-ingestion SKILL.md', () => {
      const skillPath = path.resolve(__dirname, '../../../.agents/skills/google-3d-tiles-ingestion/SKILL.md');
      const content = fs.readFileSync(skillPath, 'utf8');

      expect(content).toContain('Ingestion Quality Standards & Zero-Building-Clipping Invariant');
      expect(content).toContain('Atomic Building Integrity (Zero Building Clipping)');
      expect(content).toContain('Unbounded Vertical Skyward Extent');
      expect(content).toContain('Multi-Tier Zenith Frustum Encompassment');
      expect(content).toContain('Boundary Dilation to Street Corridors');
    });

    it('should have Atomic Integrity codified in universal-tile-decomposition SKILL.md', () => {
      const skillPath = path.resolve(__dirname, '../../../.agents/skills/universal-tile-decomposition/SKILL.md');
      const content = fs.readFileSync(skillPath, 'utf8');

      expect(content).toContain('Non-Negotiable Directives: Atomic Building Integrity & Zero Roof Slicing');
      expect(content).toContain('Atomic Structural Integrity');
      expect(content).toContain('Zero Roof Shearing');
      expect(content).toContain('Crown & Spire Preservation');
    });

    it('should have Bisected Building Envelope codified as Red Line in visual-critic SKILL.md', () => {
      const skillPath = path.resolve(__dirname, '../../../.agents/skills/visual-critic/SKILL.md');
      const content = fs.readFileSync(skillPath, 'utf8');

      expect(content).toContain('Bisected or Sliced Building Envelope');
      expect(content).toContain('open-shell dollhouse geometry');
    });
  });

  describe('2. Headless Tile Runner HTML Zenith Rig', () => {
    it('should inject multi-tier zenith and cardinal skyline cameras into runner HTML', () => {
      const runnerHtml = (service as any).generateRunnerHtml(
        {
          mode: 'clay',
          atomicBuildingIntegrity: true,
          zenithAltitudeMeters: 2000.0,
          geoAnchor: {
            lat: 40.7484,
            lng: -73.9857,
            elevation: 10,
            landmarkName: 'Midtown Manhattan'
          }
        },
        {
          origin: {
            lat: 40.7484,
            lng: -73.9857,
            elevation: 10,
            landmarkName: 'Midtown Manhattan'
          },
          frames: [
            {
              index: 0,
              timeSec: 0,
              position: [0, 65, 200],
              target: [0, 20, 0],
              up: [0, 1, 0],
              fov: 52
            },
            {
              index: 1,
              timeSec: 1,
              position: [200, 65, 0],
              target: [0, 20, 0],
              up: [0, 1, 0],
              fov: 52
            }
          ]
        }
      );

      // Verify atomic building integrity settle HUD notice
      expect(runnerHtml).toContain('Enforcing atomic building integrity & multi-tier zenith settle...');

      // Verify High-Altitude Zenith Context Camera (>= 1800m)
      expect(runnerHtml).toContain('const zenithAlt = Math.max(2000, 1800.0);');
      expect(runnerHtml).toContain('const topCamHigh = new THREE.PerspectiveCamera(75, 1.0, 0.5, 35000);');
      expect(runnerHtml).toContain('topCamHigh.position.set(0, zenithAlt, 0.01);');

      // Verify Mid-Altitude Zenith Fill Camera
      expect(runnerHtml).toContain('const topCamMid = new THREE.PerspectiveCamera(70, 1.0, 0.5, 25000);');
      expect(runnerHtml).toContain('topCamMid.position.set(0, 650.0, 0.01);');

      // Verify Oblique Cardinal Skyline Elevators
      expect(runnerHtml).toContain('const cardinalDist = 650.0;');
      expect(runnerHtml).toContain('const cardinalAlt = 280.0;');
      expect(runnerHtml).toContain('cardinalCam.lookAt(0, 120.0, 0);');

      // Verify exportGroup bounding box computation
      expect(runnerHtml).toContain('const bbox = new THREE.Box3().setFromObject(exportGroup);');
      expect(runnerHtml).toContain('boundingBox: calculatedBBox');
    });

    it('should clamp zenith altitude to at least 1800m if a lower altitude is requested', () => {
      const runnerHtml = (service as any).generateRunnerHtml(
        {
          mode: 'full-texture',
          atomicBuildingIntegrity: true,
          zenithAltitudeMeters: 500.0, // Lower altitude requested
          geoAnchor: {
            lat: 40.7484,
            lng: -73.9857,
            elevation: 10,
            landmarkName: 'Midtown Manhattan'
          }
        },
        {
          origin: {
            lat: 40.7484,
            lng: -73.9857,
            elevation: 10,
            landmarkName: 'Midtown Manhattan'
          },
          frames: [
            {
              index: 0,
              timeSec: 0,
              position: [0, 65, 200],
              target: [0, 20, 0],
              up: [0, 1, 0],
              fov: 52
            }
          ]
        }
      );

      // Verify clamped expression
      expect(runnerHtml).toContain('const zenithAlt = Math.max(500, 1800.0);');
      expect(runnerHtml).toContain('topCamHigh.position.set(0, zenithAlt, 0.01);');
    });
  });

  describe('3. In-App Spatial Tool Declarations & Handlers', () => {
    it('should expose atomicBuildingIntegrity in tool declarations', () => {
      const fullTextureTool = GOOGLE_3D_TILES_TOOL_DECLARATIONS.find(t => t.name === 'google_3d_tiles_get_full_texture');
      const clayTool = GOOGLE_3D_TILES_TOOL_DECLARATIONS.find(t => t.name === 'google_3d_tiles_get_clay');
      const runnerTool = GOOGLE_3D_TILES_TOOL_DECLARATIONS.find(t => t.name === 'google_3d_tiles_clay_blockout_runner');

      expect(fullTextureTool).toBeDefined();
      expect(fullTextureTool?.parameters.properties.atomicBuildingIntegrity).toBeDefined();
      expect(fullTextureTool?.parameters.properties.zenithAltitudeMeters).toBeDefined();

      expect(clayTool).toBeDefined();
      expect(clayTool?.parameters.properties.atomicBuildingIntegrity).toBeDefined();
      expect(clayTool?.parameters.properties.zenithAltitudeMeters).toBeDefined();

      expect(runnerTool).toBeDefined();
      expect(runnerTool?.parameters.properties.atomicBuildingIntegrity).toBeDefined();
      expect(runnerTool?.parameters.properties.zenithAltitudeMeters).toBeDefined();
    });

    it('should execute offline mock with atomic building integrity flags enabled', async () => {
      const result = await google3DTilesHandlers.google_3d_tiles_get_clay({
        query: 'Midtown Manhattan, coordinates: 40.748400, -73.985700',
        mockExecution: true,
        atomicBuildingIntegrity: true,
        zenithAltitudeMeters: 2000
      }, {} as any);

      expect(result.resultPayload.success).toBe(true);
      expect(result.resultPayload.mode).toBe('clay');
      expect(result.resultPayload.mesh.vertexCount).toBeGreaterThan(0);
      expect(result.summaryResult).toContain('Google 3D Tiles ingested in studio grey clay');
    });
  });
});
