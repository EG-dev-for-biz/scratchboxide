/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Cloud Run Spatial Separator Service - Integration Test Suite
 * Validates endpoints, health probes, Gemini 3D bounding box verification,
 * and metric alignment benchmarks without sandbox socket restrictions.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'stream';
import http from 'http';
import { handleRequest } from '../../../deploy/cloud-run/spatial-separator/server.js';

interface SimulatedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  json: () => any;
}

function simulateRequest(method: string, urlPath: string, bodyData?: any): Promise<SimulatedResponse> {
  return new Promise((resolve, reject) => {
    // 1. Mock IncomingMessage
    const req = new Readable({
      read() {
        if (bodyData) {
          this.push(JSON.stringify(bodyData));
        }
        this.push(null);
      }
    }) as any;

    req.method = method;
    req.url = urlPath;
    req.headers = { host: 'localhost:8080' };

    // 2. Mock ServerResponse
    let statusCode = 200;
    const responseHeaders: Record<string, string> = {};
    const chunks: Buffer[] = [];

    const res = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding as any));
        callback();
      }
    }) as any;

    res.writeHead = function (code: number, headers?: any) {
      statusCode = code;
      if (headers) {
        Object.assign(responseHeaders, headers);
      }
      return res;
    };

    res.setHeader = function (name: string, value: string) {
      responseHeaders[name.toLowerCase()] = value;
      return res;
    };

    res.end = function (chunk?: any, encoding?: any) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding as any));
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');
      resolve({
        statusCode,
        headers: responseHeaders,
        body: rawBody,
        json: () => JSON.parse(rawBody)
      });
    };

    handleRequest(req, res).catch(reject);
  });
}

describe('Cloud Run Spatial Separator Microservice', () => {
  it('1. should pass liveness health probe on /health', async () => {
    const res = await simulateRequest('GET', '/health');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('scratchbox-spatial-separator');
  });

  it('2. should execute end-to-end Colosseum separation test on /api/test/run', async () => {
    const res = await simulateRequest('GET', '/api/test/run');
    if (res.statusCode !== 200) {
      throw new Error(`Test 2 failed with ${res.statusCode}: ${res.body}`);
    }
    expect(res.statusCode).toBe(200);
    const data = res.json();

    expect(data.success).toBe(true);
    expect(data.benchmark.objectsCount).toBe(11);
    expect(data.benchmark.avgGemini3DScaleDiscrepancyPercent).toBeLessThanOrEqual(1.5);
    expect(data.scene.objectCounts.monuments).toBe(4);
    expect(data.scene.objectCounts.ruins).toBe(3);
    expect(data.scene.objectCounts.foliage).toBe(3);
    expect(data.scene.objectCounts.terrain).toBe(1);

    // Verify Arch of Constantine has exact Gemini 3D bounding box dimensions
    const arch = data.objects.find((o: any) => o.matchedPlaceId === 'arch-of-constantine' || o.id === 'det-arch-of-constantine');
    expect(arch).toBeDefined();
    expect(arch.geminiBox3d).toBeDefined();
    expect(arch.geminiBox3d.size).toEqual([25.7, 21.0, 7.4]);
    expect(arch.gemini3DScaleDiscrepancyPercent).toBe(0.0);
    expect(arch.residualErrorMeters).toBeLessThan(0.05);

    // Verify Colosseum Facade
    const colosseum = data.objects.find((o: any) => o.id === 'det-colosseum-facade' || o.name?.includes('Colosseum'));
    expect(colosseum).toBeDefined();
    expect(colosseum.geminiBox3d).toBeDefined();
    expect(colosseum.geminiBox3d.size).toEqual([188.0, 48.5, 156.0]);
    expect(colosseum.gemini3DScaleDiscrepancyPercent).toBe(0.0);
  });

  it('3. should serve interactive HTML viewer on /viewer', async () => {
    const res = await simulateRequest('GET', '/viewer');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Colosseum Multi-Modal Object Separation');
    expect(res.body).toContain('Gemini 3D Box');
  });

  it('4. should serve populated Scene3DData on /api/spatial/scene', async () => {
    const res = await simulateRequest('GET', '/api/spatial/scene');
    expect(res.statusCode).toBe(200);
    const scene = res.json();
    expect(scene.title).toContain('Colosseum');
    expect(Array.isArray(scene.objects)).toBe(true);
    expect(scene.objects.length).toBe(11);
  });

  it('5. should support dynamic POST /api/spatial/separate', async () => {
    const res = await simulateRequest('POST', '/api/spatial/separate', {
      stationId: 2,
      maxObjects: 5
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.success).toBe(true);
    expect(data.result.separatedObjects.length).toBeGreaterThan(0);
  });

  it('6. should return botanical species knowledge on /api/spatial/botanical/species', async () => {
    const res = await simulateRequest('GET', '/api/spatial/botanical/species');
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.success).toBe(true);
    expect(data.totalSpecies).toBeGreaterThanOrEqual(10);
    const pine = data.species.find((s: any) => s.id === 'pinus_pinea');
    expect(pine).toBeDefined();
    expect(pine.archetype).toBe('conifer');
    expect(pine.leafMorphology).toBe(2);
  });

  it('7. should synthesize a 1:1 metric replacement tree for an identified tree via GET /api/spatial/botanical/tree/:id', async () => {
    const treesRes = await simulateRequest('GET', '/api/spatial/trees?species=pinus_pinea');
    expect(treesRes.statusCode).toBe(200);
    const sampleTree = treesRes.json().trees[0];
    expect(sampleTree).toBeDefined();

    const synthRes = await simulateRequest('GET', `/api/spatial/botanical/tree/${sampleTree.id}?season=1.0`);
    expect(synthRes.statusCode).toBe(200);
    const synthData = synthRes.json();
    expect(synthData.success).toBe(true);
    expect(synthData.treeId).toBe(sampleTree.id);
    expect(synthData.species).toBe('pinus_pinea');
    expect(synthData.fittedHeightMeters).toBe(sampleTree.canopyHeightMeters);
    expect(synthData.glbDownloadUrl).toContain('.glb');
    expect(synthData.appliedBeta.length).toBe(16);
  });

  it('8. should synthesize an arbitrary tree from any geographic area 3D tile via POST /api/spatial/botanical/synthesize', async () => {
    // Custom tree from Central Park, New York or anywhere globally
    const customTreePayload = {
      treeId: 'tree-central-park-ny-042',
      species: 'quercus_robur',
      nominalDimensions: [14.0, 18.5, 13.5],
      nominalCentroid: [120.5, 25.0, -84.2],
      canopyHeightMeters: 18.5,
      crownDiameterMeters: 13.8,
      season: 0.45 // Autumn golden amber
    };

    const res = await simulateRequest('POST', '/api/spatial/botanical/synthesize', customTreePayload);
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.success).toBe(true);
    expect(data.treeId).toBe('tree-central-park-ny-042');
    expect(data.species).toBe('quercus_robur');
    expect(data.archetype).toBe('decurrent');
    expect(data.fittedHeightMeters).toBe(18.5);
    expect(data.worldPosition[0]).toBeCloseTo(120.5, 0.1);
    expect(data.telemetry.outputVertices).toBeGreaterThan(100);
  });
});
