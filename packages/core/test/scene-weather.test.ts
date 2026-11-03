/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A scene's weather (scene-weather.ts): the sun from time, date and place (or the plain sun path with no place), the sky
 * config written from it, clearing it restoring the scene's own sky, and the graph's Weather node writing the same.
 */

import { describe, expect, it } from 'vitest';
import type { GraphNode, Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import {
    LOCATION_SCENE_WEATHER, afternoonTimeForSunElevation, applySceneWeather, clearSceneWeather, formatTimeOfDay, normalizeWeather, readSceneWeather, weatherPhase, weatherSun,
    withLocationSceneWeather
} from '../src/browser/generative-canvas/services/atmosphere/scene-weather';
import { applySceneNodeParam, sceneNodeFields } from '../src/browser/generative-canvas/scene-node-params';
import { sceneOptsIntoAtmosphere } from '../src/common/scene-atmosphere-opt-in';
import { morphScene3DToNodeGraph } from '../src/browser/generative-canvas/primitive-transformer-engine';

const studio = (): Scene3DData => ({ title: 'box', environment: { skybox: 'studio' } } as Scene3DData);
const weatherNode = { id: 'n-weather', label: 'Weather' } as GraphNode;

describe('scene weather', () => {
    it('follows the plain sun path with no place: up at noon, set at night, rising in the east', () => {
        expect(weatherSun(normalizeWeather({ timeOfDay: 12 })).elevationDeg).toBeCloseTo(60, 6);
        expect(weatherSun(normalizeWeather({ timeOfDay: 12 })).azimuthDeg).toBeCloseTo(180, 6);
        expect(weatherSun(normalizeWeather({ timeOfDay: 6 })).azimuthDeg).toBeCloseTo(90, 6);
        const night = weatherSun(normalizeWeather({ timeOfDay: 0 }));
        expect(night.elevationDeg).toBeLessThan(-6);
        expect(weatherPhase(night.elevationDeg)).toBe('night');
        expect(night.source).toBe('sun-path');
    });

    it('reads the real sun at a place and date: New York at solar noon on the June solstice stands about 73 degrees up', () => {
        const sun = weatherSun(normalizeWeather({ timeOfDay: 12, date: '2026-06-21' }), { lat: 40.7484, lng: -73.9857 });
        expect(sun.source).toBe('ephemeris');
        expect(sun.elevationDeg).toBeGreaterThan(71);
        expect(sun.elevationDeg).toBeLessThan(74);
        const winter = weatherSun(normalizeWeather({ timeOfDay: 12, date: '2026-12-21' }), { lat: 40.7484, lng: -73.9857 });
        expect(winter.elevationDeg).toBeGreaterThan(24);
        expect(winter.elevationDeg).toBeLessThan(27);
    });

    it('writes the sky config the viewport draws, and clearing it restores the scene\'s own sky', () => {
        const before = studio();
        expect(sceneOptsIntoAtmosphere(before)).toBe(false);
        const s = applySceneWeather(before, { timeOfDay: 20, cloudCover: 0.6, haze: 0.5, fog: 0.5 });
        const a = s.features!.atmosphericScattering as Record<string, number | boolean>;
        expect(sceneOptsIntoAtmosphere(s)).toBe(true);
        expect(s.environment!.skybox).toBe('sky');
        expect(a.cloudCoverage).toBe(0.6);
        expect(a.cloudShadowsEnabled).toBe(true);
        expect(a.turbidity).toBeCloseTo(6, 6);
        expect(a.fogDensity).toBeCloseTo(0.02, 6);
        expect(a.sunElevation).toBeCloseTo(weatherSun(normalizeWeather({ timeOfDay: 20 })).elevationDeg, 6);
        expect(readSceneWeather(s)!.timeOfDay).toBe(20);
        // a second change keeps the rest, and the prior sky stays the scene's own
        const s2 = applySceneWeather(s, { timeOfDay: 9 });
        expect(readSceneWeather(s2)!.cloudCover).toBe(0.6);
        const back = clearSceneWeather(s2);
        expect(back.weather).toBeUndefined();
        expect(back.features?.atmosphericScattering).toBeUndefined();
        expect(back.environment!.skybox).toBe('studio');
        expect(sceneOptsIntoAtmosphere(back)).toBe(false);
    });

    it('puts haze into the air around the scene, not only into the sky: the aerial perspective thickens with it', () => {
        const thin = applySceneWeather(studio(), { haze: 0.1 }).features!.atmosphericScattering as Record<string, number | boolean>;
        const thick = applySceneWeather(studio(), { haze: 0.9 }).features!.atmosphericScattering as Record<string, number | boolean>;
        expect(thin.aerialPerspectiveEnabled).toBe(true);
        expect(thick.aerialPerspectiveRange as number).toBeLessThan(thin.aerialPerspectiveRange as number);
        expect(thick.mie as number).toBeGreaterThan(thin.mie as number);
        const none = applySceneWeather(studio(), { haze: 0 }).features!.atmosphericScattering as Record<string, number | boolean>;
        // on with the sky even in the clearest air, over its longest range
        expect(none.aerialPerspectiveEnabled).toBe(true);
        expect(none.aerialPerspectiveRange as number).toBeGreaterThan(thin.aerialPerspectiveRange as number);
        // a district hazes over hundreds of metres, a studio scene over tens
        const district = applySceneWeather({ ...studio(), geoAnchor: { lat: 52.37, lng: 4.89 } } as Scene3DData, { haze: 0.5 }).features!.atmosphericScattering as Record<string, number>;
        expect(district.aerialPerspectiveRange).toBeCloseTo(400, 0);
        expect(clearSceneWeather(applySceneWeather(studio(), { haze: 0.5 })).features?.atmosphericScattering).toBeUndefined();
    });

    it('keeps the sky config fields the weather does not own', () => {
        const s0 = { ...studio(), features: { atmosphericScattering: { enabled: true, godRaysIntensity: 0.4, kelvinTemperature: 5000 } } } as unknown as Scene3DData;
        const s = applySceneWeather(s0, { cloudCover: 0.2 });
        const a = s.features!.atmosphericScattering as Record<string, unknown>;
        expect(a.godRaysIntensity).toBe(0.4);
        expect(a.kelvinTemperature).toBe(5000);
        expect((clearSceneWeather(s).features!.atmosphericScattering as Record<string, unknown>).godRaysIntensity).toBe(0.4);
    });

    it('the graph\'s Weather node shows and writes the same weather', () => {
        let s = studio();
        const off = sceneNodeFields(weatherNode, s)!;
        expect(off.find(f => f.key === 'enabled')!.value).toBe(false);
        s = applySceneNodeParam(s, weatherNode, 'enabled', true);
        expect(readSceneWeather(s)).toBeDefined();
        s = applySceneNodeParam(s, weatherNode, 'timeOfDay', 6.5);
        s = applySceneNodeParam(s, weatherNode, 'cloudCover', 0.8);
        const fields = sceneNodeFields(weatherNode, s)!;
        expect(fields.find(f => f.key === 'timeOfDay')!.value).toBe(6.5);
        expect(fields.find(f => f.key === 'cloudCover')!.value).toBe(0.8);
        s = applySceneNodeParam(s, weatherNode, 'enabled', false);
        expect(s.weather).toBeUndefined();
    });

    it('the scene graph draws a Weather node feeding the Environment, its subtitle the weather set', () => {
        const g0 = morphScene3DToNodeGraph(studio());
        const n0 = g0.nodes.find(n => n.id === 'n-weather')!;
        expect(n0).toBeDefined();
        expect(n0.subtitle).toMatch(/Not set/);
        expect(g0.edges.some(e => e.source === 'n-weather' && e.target === 'n-env')).toBe(true);
        const g1 = morphScene3DToNodeGraph(applySceneWeather(studio(), { timeOfDay: 18.25, cloudCover: 0.4 }));
        expect(g1.nodes.find(n => n.id === 'n-weather')!.subtitle).toBe('18:15 · 40% cloud');
    });

    it('wraps and clamps what it is given', () => {
        const w = normalizeWeather({ timeOfDay: 25.5, cloudCover: 2, haze: -1, date: 'tomorrow' });
        expect(w.timeOfDay).toBeCloseTo(1.5, 6);
        expect(w.cloudCover).toBe(1);
        expect(w.haze).toBe(0);
        expect(w.date).toBeUndefined();
        expect(formatTimeOfDay(14.5)).toBe('14:30');
        expect(formatTimeOfDay(23.999)).toBe('00:00');
    });
});

describe('a real place\'s opening sky (user decision 2026-11-02)', () => {
    const nyc = { lat: 40.7484, lng: -73.9857 };
    const place = (): Scene3DData => ({ title: 'Empire State Building', environment: { skybox: 'studio', lighting: 'studio' }, geoAnchor: { ...nyc } } as unknown as Scene3DData);

    it('finds the afternoon time the sun stands at a given height, from the place\'s ephemeris', () => {
        for (const date of ['2026-06-21', '2026-11-02', '2026-12-21']) {
            const t = afternoonTimeForSunElevation(20, nyc, date);
            expect(t).toBeGreaterThan(12);
            expect(weatherSun(normalizeWeather({ timeOfDay: t, date }), nyc).elevationDeg).toBeCloseTo(20, 2);
        }
        // a later sunset in June: the sun reaches 20 degrees later in the day than in December
        expect(afternoonTimeForSunElevation(20, nyc, '2026-06-21')).toBeGreaterThan(afternoonTimeForSunElevation(20, nyc, '2026-12-21') + 2);
        // the plain sun path with no place: 20 degrees up after noon
        expect(weatherSun(normalizeWeather({ timeOfDay: afternoonTimeForSunElevation(20) })).elevationDeg).toBeCloseTo(20, 2);
    });

    it('gives the time of the highest sun when the sun never climbs that high (London at midwinter peaks near 15 degrees)', () => {
        const london = { lat: 51.508, lng: -0.128 };
        const t = afternoonTimeForSunElevation(20, london, '2026-12-21');
        const at = weatherSun(normalizeWeather({ timeOfDay: t, date: '2026-12-21' }), london).elevationDeg;
        expect(at).toBeLessThan(20);
        expect(at).toBeGreaterThan(weatherSun(normalizeWeather({ timeOfDay: t + 1, date: '2026-12-21' }), london).elevationDeg);
        expect(Math.abs(t - 12)).toBeLessThan(1);
    });

    it('opens a place partly cloudy under a low sun, over a studio the Weather tool\'s Off returns to', () => {
        const s = withLocationSceneWeather(place(), '2026-11-02') as Scene3DData & { weather: any; weatherCleared?: boolean };
        expect(readSceneWeather(s)).toMatchObject({ cloudCover: LOCATION_SCENE_WEATHER.cloudCover, haze: LOCATION_SCENE_WEATHER.haze, fog: 0, date: '2026-11-02' });
        expect(weatherSun(readSceneWeather(s)!, nyc).elevationDeg).toBeCloseTo(LOCATION_SCENE_WEATHER.sunElevationDeg, 2);
        expect(s.environment?.skybox).toBe('sky');
        expect((s.features as any).atmosphericScattering).toMatchObject({ enabled: true, cloudCoverage: 0.4, cloudShadowsEnabled: true, latitude: nyc.lat, longitude: nyc.lng });
        expect((s.features as any).atmosphericScattering.aerialPerspectiveEnabled).toBe(true);
        // a splat world gets the sky without the haze pass, which would tone-map its depthless splats a second time
        const world = withLocationSceneWeather({ ...place(), splatUrl: '/tilesets/w/fused.spz' } as Scene3DData, '2026-11-02');
        expect((world.features as any).atmosphericScattering).toMatchObject({ enabled: true, cloudCoverage: 0.4, aerialPerspectiveEnabled: false });
        const off = clearSceneWeather(s) as Scene3DData & { weatherCleared?: boolean };
        expect(off.environment?.skybox).toBe('studio');
        expect((off.features as any).atmosphericScattering).toBeUndefined();
        expect(off.weatherCleared).toBe(true);
    });

    it('never overrides a weather the scene has, nor puts one back once it was cleared', () => {
        const own = applySceneWeather(place(), { timeOfDay: 9, cloudCover: 0.9 });
        expect(withLocationSceneWeather(own, '2026-11-02')).toBe(own);
        const cleared = clearSceneWeather(withLocationSceneWeather(place(), '2026-11-02'));
        expect(withLocationSceneWeather(cleared, '2026-11-03')).toBe(cleared);
        // setting a weather again lifts the mark
        expect((applySceneWeather(cleared, { cloudCover: 0.2 }) as { weatherCleared?: boolean }).weatherCleared).toBeUndefined();
    });
});
