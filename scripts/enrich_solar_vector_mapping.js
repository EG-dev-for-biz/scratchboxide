/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * Enrich Google Midtown Vector Mapping with authentic Google Solar API rooftop shapes,
 * setback tier elevations, planar facets, and normal vectors.
 ********************************************************************************/

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VECTOR_MAPPING_FILE = path.join(ROOT, 'public/data/google_midtown_vector_mapping.json');
const SOLAR_CACHE_FILE = path.join(ROOT, 'public/data/solar_cache.json');

const mapping = JSON.parse(fs.readFileSync(VECTOR_MAPPING_FILE, 'utf8'));
const solarCache = JSON.parse(fs.readFileSync(SOLAR_CACHE_FILE, 'utf8'));

// Grid rotation: 29 degrees clockwise relative to True North
const GRID_BEARING_DEG = mapping.gridBearingDegrees || 29.0;
const RAD = (-GRID_BEARING_DEG * Math.PI) / 180.0;
const COS_B = Math.cos(RAD);
const SIN_B = Math.sin(RAD);

const ANCHOR_LAT = mapping.anchor.lat;
const ANCHOR_LNG = mapping.anchor.lng;
const ANCHOR_ELEV = mapping.anchor.elevation || 18.53;

function calculateNormal(pitchDeg, azimuthDeg) {
  const pRad = (pitchDeg * Math.PI) / 180.0;
  const aRad = (azimuthDeg * Math.PI) / 180.0;
  const nx = Math.sin(pRad) * Math.sin(aRad);
  const ny = Math.cos(pRad);
  const nz = -Math.sin(pRad) * Math.cos(aRad);
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
  return {
    nx: Number((nx / len).toFixed(4)),
    ny: Number((ny / len).toFixed(4)),
    nz: Number((nz / len).toFixed(4))
  };
}

function convertSegmentToFacet(seg, idx) {
  const dLat = (seg.center.latitude - ANCHOR_LAT) * 111000.0;
  const dLng = (seg.center.longitude - ANCHOR_LNG) * 84400.0;
  const u = dLng * COS_B - dLat * SIN_B;
  const v = dLng * SIN_B + dLat * COS_B;
  const y = Math.max(0, seg.planeHeightAtCenterMeters - ANCHOR_ELEV);

  const latSpan = Math.abs(seg.boundingBox.ne.latitude - seg.boundingBox.sw.latitude) * 111000.0;
  const lngSpan = Math.abs(seg.boundingBox.ne.longitude - seg.boundingBox.sw.longitude) * 84400.0;
  const halfW = Math.max(1.0, lngSpan / 2.0);
  const halfD = Math.max(1.0, latSpan / 2.0);

  const corners = [
    { x: Number((u - halfW).toFixed(2)), y: Number(y.toFixed(2)), z: Number((-(v - halfD)).toFixed(2)) },
    { x: Number((u + halfW).toFixed(2)), y: Number(y.toFixed(2)), z: Number((-(v - halfD)).toFixed(2)) },
    { x: Number((u + halfW).toFixed(2)), y: Number(y.toFixed(2)), z: Number((-(v + halfD)).toFixed(2)) },
    { x: Number((u - halfW).toFixed(2)), y: Number(y.toFixed(2)), z: Number((-(v + halfD)).toFixed(2)) }
  ];

  return {
    id: `facet_${idx}`,
    centerENU: { x: Number(u.toFixed(2)), y: Number(y.toFixed(2)), z: Number((-v).toFixed(2)) },
    normal: calculateNormal(seg.pitchDegrees, seg.azimuthDegrees),
    pitchDegrees: Number(seg.pitchDegrees.toFixed(1)),
    azimuthDegrees: Number(seg.azimuthDegrees.toFixed(1)),
    planeHeightASL: Number(seg.planeHeightAtCenterMeters.toFixed(2)),
    relativeElevationMeters: Number(y.toFixed(2)),
    areaMeters2: Number(seg.stats.areaMeters2.toFixed(1)),
    dimensionsMeters: { width: Number(lngSpan.toFixed(2)), depth: Number(latSpan.toFixed(2)) },
    cornersENU: corners
  };
}

function clusterTiers(segments, toleranceMeters = 8.0) {
  const sorted = [...segments].sort((a, b) => a.planeHeightAtCenterMeters - b.planeHeightAtCenterMeters);
  const clusters = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i];
    const mean = current.reduce((sum, item) => sum + item.planeHeightAtCenterMeters, 0) / current.length;
    if (Math.abs(s.planeHeightAtCenterMeters - mean) <= toleranceMeters) {
      current.push(s);
    } else {
      clusters.push(current);
      current = [s];
    }
  }
  if (current.length) clusters.push(current);

  return clusters.map((c, idx) => {
    const elevs = c.map(s => s.planeHeightAtCenterMeters);
    const minE = Math.min(...elevs);
    const maxE = Math.max(...elevs);
    const meanE = elevs.reduce((a, b) => a + b, 0) / elevs.length;
    const totalArea = c.reduce((sum, s) => sum + s.stats.areaMeters2, 0);

    return {
      tierIndex: idx,
      name: idx === 0 ? 'Podium / Base Tier' : idx === clusters.length - 1 ? 'Crown / Mooring Spire' : `Setback Tier ${idx}`,
      minElevationASL: Number(minE.toFixed(2)),
      maxElevationASL: Number(maxE.toFixed(2)),
      meanElevationASL: Number(meanE.toFixed(2)),
      relativeElevationMeters: Number((meanE - ANCHOR_ELEV).toFixed(2)),
      totalAreaMeters2: Number(totalArea.toFixed(1)),
      segmentCount: c.length
    };
  });
}

// 1. Process Empire State Building
const esbKey = 'insights:40.748441,-73.985664:qHIGH';
const esbData = solarCache[esbKey]?.data;
let esbEnrichment = null;

if (esbData) {
  const segments = esbData.solarPotential.roofSegmentStats;
  const tiers = clusterTiers(segments, 10.0);
  const facets = segments.map((s, idx) => convertSegmentToFacet(s, idx));

  // Prominent sloped caps (pitch > 4 degrees)
  const slopedCaps = facets.filter(f => f.pitchDegrees >= 4.0);

  esbEnrichment = {
    buildingName: 'Empire State Building',
    resourceName: esbData.name,
    imageryDate: `${esbData.imageryDate.year}-${String(esbData.imageryDate.month).padStart(2, '0')}-${String(esbData.imageryDate.day).padStart(2, '0')}`,
    wholeRoofAreaMeters2: Number(esbData.solarPotential.wholeRoofStats.areaMeters2.toFixed(1)),
    maxArrayPanelsCount: esbData.solarPotential.maxArrayPanelsCount,
    maxSunshineHoursPerYear: Number(esbData.solarPotential.maxSunshineHoursPerYear.toFixed(1)),
    totalSegmentCount: segments.length,
    tierCount: tiers.length,
    tiers: tiers,
    slopedCapsCount: slopedCaps.length,
    sampleFacets: facets.slice(0, 25), // Store representative top 25 facets
    spireLanternCap: facets.find(f => f.planeHeightASL > 400.0)
  };
}

// 2. Process Macy's Herald Square
const macysKey = 'insights:40.750800,-73.989000:qHIGH';
const macysData = solarCache[macysKey]?.data;
let macysEnrichment = null;

if (macysData) {
  const segments = macysData.solarPotential.roofSegmentStats;
  const tiers = clusterTiers(segments, 8.0);
  const facets = segments.map((s, idx) => convertSegmentToFacet(s, idx));
  const slopedCaps = facets.filter(f => f.pitchDegrees >= 4.0);

  macysEnrichment = {
    buildingName: "Macy's Herald Square",
    resourceName: macysData.name,
    imageryDate: `${macysData.imageryDate.year}-${String(macysData.imageryDate.month).padStart(2, '0')}-${String(macysData.imageryDate.day).padStart(2, '0')}`,
    wholeRoofAreaMeters2: Number(macysData.solarPotential.wholeRoofStats.areaMeters2.toFixed(1)),
    maxArrayPanelsCount: macysData.solarPotential.maxArrayPanelsCount,
    maxSunshineHoursPerYear: Number(macysData.solarPotential.maxSunshineHoursPerYear.toFixed(1)),
    totalSegmentCount: segments.length,
    tierCount: tiers.length,
    tiers: tiers,
    slopedCapsCount: slopedCaps.length,
    sampleFacets: facets.slice(0, 20)
  };
}

// Attach to root and parcel objects
mapping.solarRooftops = {
  source: 'google_solar_api_building_insights',
  attribution: 'gmp_git_agentskills_v1',
  timestamp: new Date().toISOString(),
  empireStateBuilding: esbEnrichment,
  macysHeraldSquare: macysEnrichment
};

// Also enrich the specific parcels in mapping.parcels
for (const p of mapping.parcels) {
  if (p.id === 'google_parcel_esb_core' && esbEnrichment) {
    p.solarRooftop = {
      wholeRoofAreaMeters2: esbEnrichment.wholeRoofAreaMeters2,
      tierCount: esbEnrichment.tierCount,
      totalSegmentCount: esbEnrichment.totalSegmentCount,
      spireLanternASL: esbEnrichment.spireLanternCap?.planeHeightASL || 402.75,
      tiers: esbEnrichment.tiers
    };
  }
}

fs.writeFileSync(VECTOR_MAPPING_FILE, JSON.stringify(mapping, null, 2), 'utf8');
console.log('Successfully enriched', VECTOR_MAPPING_FILE, 'with Google Solar API rooftop data:');
console.log(' - ESB Tiers:', esbEnrichment?.tiers.length, 'Segments:', esbEnrichment?.totalSegmentCount, 'Spire Cap:', esbEnrichment?.spireLanternCap?.planeHeightASL, 'm ASL');
console.log(' - Macys Tiers:', macysEnrichment?.tiers.length, 'Segments:', macysEnrichment?.totalSegmentCount, 'Max Elev:', macysEnrichment?.tiers[macysEnrichment.tiers.length - 1]?.maxElevationASL, 'm ASL');
