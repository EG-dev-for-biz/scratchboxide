import { describe, it, expect, afterEach } from 'vitest';
import { calculateNOAASolarPosition } from '../src/browser/generative-canvas/services/atmosphere/solar-position';
import { getSolarPosition } from '../src/common/coordinate/solarPosition';
import { getDiurnalLightingState } from '../src/browser/generative-canvas/services/atmosphere/diurnal-lighting';

// Independent reference: Meeus, Astronomical Algorithms ch. 12/22/25 (apparent place with nutation and aberration,
// apparent sidereal time). It is checked against the NREL SPA worked example below before it is trusted.
const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const norm = (x: number) => ((x % 360) + 360) % 360;
// Meeus, Astronomical Algorithms ch. 22/25/12 (apparent place, nutation, apparent sidereal time). JD in UT; dT seconds.
function refSun(jdUt: number, lat: number, lng: number, dTsec = 69) {
    const jde = jdUt + dTsec / 86400;
    const T = (jde - 2451545) / 36525;
    const L0 = norm(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
    const M = norm(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
    const e = 0.016708634 - 0.000042037 * T;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M * RAD) + (0.019993 - 0.000101 * T) * Math.sin(2 * M * RAD) + 0.000289 * Math.sin(3 * M * RAD);
    const trueLon = L0 + C;
    const nu = M + C;
    const R = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(nu * RAD));
    const omega = 125.04452 - 1934.136261 * T;
    const Lm = 280.4665 + 36000.7698 * T, Lmoon = 218.3165 + 481267.8813 * T;
    const dPsi = (-17.2 * Math.sin(omega * RAD) - 1.32 * Math.sin(2 * Lm * RAD) - 0.23 * Math.sin(2 * Lmoon * RAD) + 0.21 * Math.sin(2 * omega * RAD)) / 3600;
    const dEps = (9.2 * Math.cos(omega * RAD) + 0.57 * Math.cos(2 * Lm * RAD) + 0.1 * Math.cos(2 * Lmoon * RAD) - 0.09 * Math.cos(2 * omega * RAD)) / 3600;
    const lambda = trueLon + dPsi - 20.4898 / 3600 / R;
    const eps0 = 23 + 26 / 60 + 21.448 / 3600 - (46.815 * T + 0.00059 * T * T - 0.001813 * T * T * T) / 3600;
    const eps = eps0 + dEps;
    const ra = norm(Math.atan2(Math.cos(eps * RAD) * Math.sin(lambda * RAD), Math.cos(lambda * RAD)) * DEG);
    const dec = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;
    const Tu = (jdUt - 2451545) / 36525;
    const gmst = norm(280.46061837 + 360.98564736629 * (jdUt - 2451545) + 0.000387933 * Tu * Tu - (Tu * Tu * Tu) / 38710000);
    const gast = gmst + dPsi * Math.cos(eps * RAD);
    const H = norm(gast + lng - ra);
    const phi = lat * RAD;
    const el = Math.asin(Math.sin(phi) * Math.sin(dec * RAD) + Math.cos(phi) * Math.cos(dec * RAD) * Math.cos(H * RAD)) * DEG;
    const az = norm(Math.atan2(Math.sin(H * RAD), Math.cos(H * RAD) * Math.sin(phi) - Math.tan(dec * RAD) * Math.cos(phi)) * DEG + 180);
    return { ra, dec, H: H > 180 ? H - 360 : H, el, az };
}

const jdOf = (d: Date) => d.getTime() / 86400000 + 2440587.5;
const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const DEG_PER_RAD = 180 / Math.PI;

// NREL SPA (Reda & Andreas 2004, Table A4.1): 2003-10-17 12:30:30 local (UTC-7), lat 39.742476, lng -105.1786.
// Topocentric elevation without refraction 39.872046 deg (90 - e0 zenith), topocentric azimuth 194.34024 deg.
const SPA_INSTANT = new Date('2003-10-17T12:30:30-07:00');
const SPA = { lat: 39.742476, lng: -105.1786, elevationDeg: 39.872046, azimuthDeg: 194.34024 };

const CASES: Array<{ iso: string; lat: number; lng: number }> = [
    { iso: '2003-10-17T19:30:30Z', lat: 39.742476, lng: -105.1786 },
    { iso: '2024-06-21T03:00:00Z', lat: 35.6595, lng: 139.7005 }, // Tokyo, noon JST
    { iso: '2024-12-21T15:30:00Z', lat: 51.5007, lng: -0.1246 }, // London, mid-afternoon in winter
    { iso: '2025-03-20T10:15:00Z', lat: -33.8568, lng: 151.2153 }, // Sydney, evening
    { iso: '2026-09-01T06:45:00Z', lat: 64.1466, lng: -21.9426 }, // Reykjavik, morning
    { iso: '2026-01-15T20:00:00Z', lat: -22.9519, lng: -43.2105 }, // Rio, afternoon
    { iso: '2025-07-04T23:59:00Z', lat: 40.7484, lng: -73.9857 } // New York, evening
];

const HOST_ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Chatham', 'Europe/Berlin'];

describe('solar position at a UTC instant (independent of the host time zone)', () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    it('the reference reproduces the NREL SPA worked example', () => {
        const ref = refSun(jdOf(SPA_INSTANT), SPA.lat, SPA.lng, 67);
        // Geocentric vs topocentric differs by the solar parallax (< 0.003 deg).
        expect(Math.abs(ref.el - SPA.elevationDeg)).toBeLessThan(0.01);
        expect(angDiff(ref.az, SPA.azimuthDeg)).toBeLessThan(0.01);
    });

    for (const tz of HOST_ZONES) {
        it(`matches the reference to < 0.05 deg with the host in ${tz}`, () => {
            process.env.TZ = tz;
            for (const c of CASES) {
                const date = new Date(c.iso);
                const ref = refSun(jdOf(date), c.lat, c.lng);
                const noaa = calculateNOAASolarPosition(date, c.lat, c.lng);
                const common = getSolarPosition(date, c.lat, c.lng);
                const label = `${c.iso} @ ${c.lat},${c.lng}`;
                expect(Math.abs(noaa.elevationDeg - ref.el), label).toBeLessThan(0.05);
                expect(angDiff(noaa.azimuthDeg, ref.az), label).toBeLessThan(0.05);
                expect(noaa.julianDay, label).toBeCloseTo(jdOf(date), 9);
                expect(Math.abs(common.altitude * DEG_PER_RAD - ref.el), label).toBeLessThan(0.05);
                expect(angDiff(common.azimuth * DEG_PER_RAD, ref.az), label).toBeLessThan(0.05);
            }
            const spa = calculateNOAASolarPosition(SPA_INSTANT, SPA.lat, SPA.lng);
            expect(Math.abs(spa.elevationDeg - SPA.elevationDeg)).toBeLessThan(0.05);
            expect(angDiff(spa.azimuthDeg, SPA.azimuthDeg)).toBeLessThan(0.05);
        });
    }

    it('a time-of-day hour is local solar time at the destination, whatever the host zone', () => {
        for (const tz of HOST_ZONES) {
            process.env.TZ = tz;
            for (const lng of [139.7, -122.4, 12.5]) {
                // At local solar noon the sun is due south (northern mid-latitudes) and above the morning sun.
                const noon = getDiurnalLightingState(40, lng, 12.0);
                const morning = getDiurnalLightingState(40, lng, 8.0);
                expect(angDiff(noon.sunAzimuth, 180), `${tz} ${lng}`).toBeLessThan(5);
                expect(noon.sunElevation, `${tz} ${lng}`).toBeGreaterThan(morning.sunElevation + 15);
                expect(morning.sunAzimuth, `${tz} ${lng}`).toBeLessThan(180);
            }
        }
    });
});
