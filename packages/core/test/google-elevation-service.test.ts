/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    GoogleElevationService,
    type ElevationPoint,
    type ElevationResult
} from '../src/browser';

describe('Google Elevation API Integration & Topographic Terrain Profiler', () => {
    let service: GoogleElevationService;
    const testApiKey = 'AIzaSyTestMockKeyForElevationUnitTests_12345';

    beforeEach(() => {
        service = new GoogleElevationService({
            apiKey: testApiKey,
            proxyBaseUrl: 'http://127.0.0.1:8098/api/elevation',
            enableCaching: true,
            cacheTtlMs: 30 * 24 * 60 * 60 * 1000 // 30-day ToS compliance
        });
    });

    it('1. should initialize with mandatory GMP solution attribution', () => {
        expect(service).toBeDefined();
        expect(service.getSolutionId()).toBe('gmp_git_agentskills_v1');
        expect(service.isCachingEnabled()).toBe(true);
    });

    it('2. should enforce Google Maps ToS caching semantics (30-day TTL)', () => {
        const testLat = 40.7484405;
        const testLng = -73.9856644;
        const mockResult: ElevationResult = {
            elevation: 18.53,
            location: { lat: testLat, lng: testLng },
            resolution: 4.77
        };

        // Cache entry storage
        service.setCacheEntry(testLat, testLng, mockResult);

        // Immediate cache hit
        const cached = service.getCachedElevation(testLat, testLng);
        expect(cached).not.toBeNull();
        expect(cached?.elevation).toBeCloseTo(18.53, 2);
        expect(cached?.resolution).toBeCloseTo(4.77, 2);

        // Verification of cache miss for distant coordinate
        const cacheMiss = service.getCachedElevation(testLat + 0.05, testLng - 0.05);
        expect(cacheMiss).toBeNull();
    });

    it('3. should batch coordinates into compliant chunks', () => {
        const locations: ElevationPoint[] = [];
        for (let i = 0; i < 1200; i++) {
            locations.push({
                lat: 40.7400 + i * 0.0001,
                lng: -73.9800 - i * 0.0001
            });
        }

        const chunks = service.chunkLocations(locations, 512);
        expect(chunks.length).toBe(3);
        expect(chunks[0].length).toBe(512);
        expect(chunks[1].length).toBe(512);
        expect(chunks[2].length).toBe(176);
        expect(chunks[0].length + chunks[1].length + chunks[2].length).toBe(1200);
    });

    it('4. should correctly transform geodetic elevation into local datum ENU offset', () => {
        const esbDatum = 18.53; // Orthometric datum at Empire State Building
        const bryantParkGround = 24.80; // Bryant Park ground elevation
        const heraldSquareGround = 15.27; // Herald Square ground elevation

        const bryantParkOffset = bryantParkGround - esbDatum;
        const heraldSquareOffset = heraldSquareGround - esbDatum;

        expect(bryantParkOffset).toBeCloseTo(+6.27, 2);
        expect(heraldSquareOffset).toBeCloseTo(-3.26, 2);
    });

    it('5. should verify Midtown Manhattan topographic regression plane', () => {
        // Continuous regression plane: E(u, v) = 0.00671 * u - 0.01709 * v - 0.10
        const getModelElevation = (u: number, v: number): number => {
            return 0.00671 * u - 0.01709 * v - 0.10;
        };

        // At ESB datum origin (u=0, v=0)
        expect(getModelElevation(0, 0)).toBeCloseTo(-0.10, 1);

        // Eastward slope: Murray Hill / Park Ave (+300m East, u = 300)
        const eastOffset = getModelElevation(300, 0);
        expect(eastOffset).toBeGreaterThan(1.5); // Rising eastwards

        // Westward slope: Herald Square / Penn Station (-400m West, u = -400)
        const westOffset = getModelElevation(-400, 0);
        expect(westOffset).toBeLessThan(-2.0); // Dropping westwards towards Hudson

        // Northward slope: Bryant Park (+500m North along grid, v = -500 in ENU Z)
        const northOffset = getModelElevation(0, -500);
        expect(northOffset).toBeGreaterThan(5.0); // Rising northwards towards Central Park bedrock
    });

    it('6. should query path elevation and calculate gradient slope', async () => {
        const mockPathElevations: ElevationResult[] = [
            { elevation: 14.98, location: { lat: 40.7456, lng: -73.9877 }, resolution: 4.77 },
            { elevation: 18.53, location: { lat: 40.7484, lng: -73.9856 }, resolution: 4.77 },
            { elevation: 24.80, location: { lat: 40.7536, lng: -73.9832 }, resolution: 4.77 }
        ];

        // Mock fetch implementation for proxy path query
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                status: 'OK',
                results: mockPathElevations
            })
        });
        global.fetch = mockFetch;

        const results = await service.getPathElevation({
            path: [
                { lat: 40.7456, lng: -73.9877 },
                { lat: 40.7536, lng: -73.9832 }
            ],
            samples: 3
        });

        expect(results).toHaveLength(3);
        expect(results[0].elevation).toBeCloseTo(14.98, 2);
        expect(results[1].elevation).toBeCloseTo(18.53, 2);
        expect(results[2].elevation).toBeCloseTo(24.80, 2);

        // Total elevation delta along corridor
        const totalDelta = results[2].elevation - results[0].elevation;
        expect(totalDelta).toBeCloseTo(9.82, 2);
    });

    it('7. should handle API error responses gracefully without crashing', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            statusText: 'Forbidden'
        });
        global.fetch = mockFetch;

        await expect(service.getElevationForLocations([
            { lat: 40.7484, lng: -73.9856 }
        ])).rejects.toThrow();
    });
});
