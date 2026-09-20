const fs = require('fs');

const ESB_GOOGLE_GEODETIC_ANCHOR = {
  lat: 40.7484405,
  lng: -73.9856644,
  elevation: 18.53,
  placeId: 'ChIJh9828XNZwokR_3A0K2N46j8',
  formattedAddress: 'Empire State Building, 20 W 34th St, New York, NY 10001, USA'
};

const GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE = {
  variant: 'light',
  styles: [
    { id: 'political', label: { visible: false } },
    { id: 'pointOfInterest', label: { visible: false } },
    { id: 'infrastructure', label: { visible: false } },
    { id: 'natural', label: { visible: false } }
  ]
};

const EARTH_RADIUS = 6378137.0;

function projectEnuToWgs84(x, z, anchor = ESB_GOOGLE_GEODETIC_ANCHOR) {
  const originLatRad = (anchor.lat * Math.PI) / 180.0;
  const dLatRad = -z / EARTH_RADIUS;
  const dLngRad = x / (EARTH_RADIUS * Math.cos(originLatRad));

  const lat = anchor.lat + (dLatRad * 180.0) / Math.PI;
  const lng = anchor.lng + (dLngRad * 180.0) / Math.PI;
  return [lng, lat];
}

function manhattanToEnu(uAvenueOffset, vStreetOffset) {
  const theta = (29.0 * Math.PI) / 180.0;
  const x = uAvenueOffset * Math.cos(theta) - vStreetOffset * Math.sin(theta);
  const z = uAvenueOffset * Math.sin(theta) + vStreetOffset * Math.cos(theta);
  return [x, z];
}

function generateCanonicalMidtownMapping() {
  const roads = [];
  const parcels = [];

  const addRoad = (id, name, type, widthMeters, lanes, gridPoints) => {
    const pointsLocalENU = gridPoints.map(([u, v]) => manhattanToEnu(u, v));
    const coordinatesWGS84 = pointsLocalENU.map(([x, z]) => projectEnuToWgs84(x, z));

    roads.push({
      id,
      name,
      type,
      widthMeters,
      lanes,
      pointsLocalENU,
      coordinatesWGS84
    });
  };

  const addParcel = (id, name, blockNumber, lotNumber, heightMeters, levels, isLandmark, gridCorners) => {
    const polygonLocalENU = gridCorners.map(([u, v]) => manhattanToEnu(u, v));
    if (
      polygonLocalENU[0][0] !== polygonLocalENU[polygonLocalENU.length - 1][0] ||
      polygonLocalENU[0][1] !== polygonLocalENU[polygonLocalENU.length - 1][1]
    ) {
      polygonLocalENU.push([...polygonLocalENU[0]]);
    }
    const coordinatesWGS84 = polygonLocalENU.map(([x, z]) => projectEnuToWgs84(x, z));

    parcels.push({
      id,
      name,
      blockNumber,
      lotNumber,
      isLandmark,
      baseElevation: 15.0,
      heightMeters,
      levels,
      polygonLocalENU,
      coordinatesWGS84
    });
  };

  // --- 1. Avenues ---
  addRoad('google_corridor_5th_ave', '5th Avenue', 'avenue', 30.0, 5, [
    [18.0, -420.0],
    [18.0, 420.0]
  ]);
  addRoad('google_corridor_6th_ave', 'Avenue of the Americas (6th Ave)', 'avenue', 32.0, 6, [
    [-240.0, -420.0],
    [-240.0, 420.0]
  ]);
  addRoad('google_corridor_madison_ave', 'Madison Avenue', 'avenue', 28.0, 4, [
    [280.0, -420.0],
    [280.0, 420.0]
  ]);
  addRoad('google_corridor_park_ave', 'Park Avenue', 'avenue', 42.0, 6, [
    [420.0, -420.0],
    [420.0, 420.0]
  ]);
  addRoad('google_corridor_7th_ave', '7th Avenue', 'avenue', 32.0, 5, [
    [-450.0, -420.0],
    [-450.0, 420.0]
  ]);

  // --- 2. Cross Streets ---
  addRoad('google_corridor_w34th_st', 'West 34th Street', 'commercial_corridor', 30.0, 4, [
    [-480.0, -40.0],
    [450.0, -40.0]
  ]);
  addRoad('google_corridor_w33rd_st', 'West 33rd Street', 'cross_street', 18.0, 2, [
    [-480.0, 40.0],
    [450.0, 40.0]
  ]);
  addRoad('google_corridor_w32nd_st', 'West 32nd Street', 'cross_street', 18.0, 2, [
    [-480.0, 120.0],
    [450.0, 120.0]
  ]);
  addRoad('google_corridor_w31st_st', 'West 31st Street', 'cross_street', 18.0, 2, [
    [-480.0, 200.0],
    [450.0, 200.0]
  ]);
  addRoad('google_corridor_w30th_st', 'West 30th Street', 'cross_street', 18.0, 2, [
    [-480.0, 280.0],
    [450.0, 280.0]
  ]);
  addRoad('google_corridor_w35th_st', 'West 35th Street', 'cross_street', 18.0, 2, [
    [-480.0, -120.0],
    [450.0, -120.0]
  ]);
  addRoad('google_corridor_w36th_st', 'West 36th Street', 'cross_street', 18.0, 2, [
    [-480.0, -200.0],
    [450.0, -200.0]
  ]);
  addRoad('google_corridor_w37th_st', 'West 37th Street', 'cross_street', 18.0, 2, [
    [-480.0, -280.0],
    [450.0, -280.0]
  ]);

  // --- 3. Diagonal Corridor: Broadway ---
  addRoad('google_corridor_broadway', 'Broadway (Herald & Greeley Square)', 'diagonal_corridor', 24.0, 3, [
    [-270.0, 320.0],
    [-240.0, 200.0],
    [-210.0, 80.0],
    [-190.0, -40.0],
    [-160.0, -160.0],
    [-130.0, -280.0]
  ]);

  // --- 4. Building Parcels ---
  // ESB Parcel (Block 835, Lot 41)
  addParcel('google_parcel_esb_core', 'Empire State Building (Block 835, Lot 41)', 835, 41, 443.2, 102, true, [
    [-3.0, -31.0],
    [-104.5, -31.0],
    [-104.5, 31.0],
    [-3.0, 31.0]
  ]);

  // Block 835 West: 10-14 W 33rd St & Herald Center
  addParcel('google_parcel_block_835_west', 'Herald Center & 1000 Ave of the Americas (Block 835 West)', 835, 1, 86.0, 24, false, [
    [-115.0, -31.0],
    [-224.0, -31.0],
    [-224.0, 31.0],
    [-115.0, 31.0]
  ]);

  // Block 836: Macy's Herald Square
  addParcel('google_parcel_macys_herald_sq', "Macy's Herald Square (Block 836)", 836, 1, 82.0, 19, false, [
    [-115.0, -111.0],
    [-224.0, -111.0],
    [-224.0, -49.0],
    [-115.0, -49.0]
  ]);

  // Block 836 East: 350 5th Avenue
  addParcel('google_parcel_block_836_east', '350 5th Avenue & Midtown Retail (Block 836 East)', 836, 20, 128.0, 32, false, [
    [-3.0, -111.0],
    [-104.5, -111.0],
    [-104.5, -49.0],
    [-3.0, -49.0]
  ]);

  // Block 864: CUNY Graduate Center / B. Altman Building
  addParcel('google_parcel_cuny_b_altman', 'CUNY Graduate Center / Former B. Altman (Block 864)', 864, 1, 44.0, 9, false, [
    [39.0, -31.0],
    [262.0, -31.0],
    [262.0, 31.0],
    [39.0, 31.0]
  ]);

  // Block 865: 362 5th Avenue Commercial District
  addParcel('google_parcel_block_865', '362 5th Avenue Commercial District (Block 865)', 865, 1, 112.0, 28, false, [
    [39.0, -111.0],
    [262.0, -111.0],
    [262.0, -49.0],
    [39.0, -49.0]
  ]);

  // Block 834: Hotel Martinique & Koreatown Commercial Spine
  addParcel('google_parcel_block_834_martinique', 'Hotel Martinique & Koreatown Commercial Spine (Block 834)', 834, 1, 76.0, 18, false, [
    [-3.0, 49.0],
    [-224.0, 49.0],
    [-224.0, 111.0],
    [-3.0, 111.0]
  ]);

  // Block 863: 320 5th Avenue & Midtown South
  addParcel('google_parcel_block_863', '320 5th Avenue & Midtown South (Block 863)', 863, 1, 95.0, 23, false, [
    [39.0, 49.0],
    [262.0, 49.0],
    [262.0, 111.0],
    [39.0, 111.0]
  ]);

  // Block 837: One Penn / Manhattan Mall Urban Context
  addParcel('google_parcel_block_837_greeley', 'One Penn / Manhattan Mall Urban Context (Block 837)', 837, 1, 142.0, 38, false, [
    [-256.0, -31.0],
    [-434.0, -31.0],
    [-434.0, 31.0],
    [-256.0, 31.0]
  ]);

  // Block 866: 370 5th Avenue & Midtown North
  addParcel('google_parcel_block_866', '370 5th Avenue Commercial District (Block 866)', 866, 1, 88.0, 22, false, [
    [39.0, -191.0],
    [262.0, -191.0],
    [262.0, -129.0],
    [39.0, -129.0]
  ]);

  // Block 838 East: 373 5th Avenue Commercial Block
  addParcel('google_parcel_block_838_east', '373 5th Avenue Commercial Block (Block 838 East)', 838, 1, 94.0, 24, false, [
    [-3.0, -191.0],
    [-104.5, -191.0],
    [-104.5, -129.0],
    [-3.0, -129.0]
  ]);

  // Block 838 West: 1350 Broadway Herald Square North
  addParcel('google_parcel_block_838_west', '1350 Broadway Herald Square North (Block 838 West)', 838, 2, 98.0, 25, false, [
    [-115.0, -191.0],
    [-224.0, -191.0],
    [-224.0, -129.0],
    [-115.0, -129.0]
  ]);

  // Block 833: Midtown South Koreatown Spine
  addParcel('google_parcel_block_833', 'Midtown South Koreatown Spine (Block 833)', 833, 1, 84.0, 20, false, [
    [-3.0, 129.0],
    [-224.0, 129.0],
    [-224.0, 191.0],
    [-3.0, 191.0]
  ]);

  // Block 862: 300 5th Avenue & Madison South
  addParcel('google_parcel_block_862', '300 5th Avenue & Madison South (Block 862)', 862, 1, 72.0, 18, false, [
    [39.0, 129.0],
    [262.0, 129.0],
    [262.0, 191.0],
    [39.0, 191.0]
  ]);

  // Block 783: One Penn Plaza
  addParcel('google_parcel_one_penn_plaza', 'One Penn Plaza (Block 783)', 783, 1, 229.0, 57, false, [
    [-434.0, -111.0],
    [-256.0, -111.0],
    [-256.0, -49.0],
    [-434.0, -49.0]
  ]);

  // Block 784: Nelson Tower / 450 7th Ave
  addParcel('google_parcel_nelson_tower', 'Nelson Tower / 450 7th Ave (Block 784)', 784, 10, 171.0, 46, false, [
    [-434.0, -191.0],
    [-256.0, -191.0],
    [-256.0, -129.0],
    [-434.0, -129.0]
  ]);

  // Block 808: Manhattan Mall & 100 W 33rd St
  addParcel('google_parcel_manhattan_mall', 'Manhattan Mall & 100 W 33rd St (Block 808)', 808, 1, 68.0, 13, false, [
    [-434.0, 49.0],
    [-256.0, 49.0],
    [-256.0, 111.0],
    [-434.0, 111.0]
  ]);

  // Block 864 Lot 30: 10 East 34th Street
  addParcel('google_parcel_10_e_34th', '10 East 34th Street (Block 864 Lot 30)', 864, 30, 88.0, 22, false, [
    [160.0, -31.0],
    [262.0, -31.0],
    [262.0, 31.0],
    [160.0, 31.0]
  ]);

  // Block 865 Lot 40: 200 Madison Avenue
  addParcel('google_parcel_200_madison', '200 Madison Avenue (Block 865 Lot 40)', 865, 40, 100.0, 26, false, [
    [150.0, -111.0],
    [262.0, -111.0],
    [262.0, -49.0],
    [150.0, -49.0]
  ]);

  // Block 834 Lot 25: Koreatown Plaza / 10 W 33rd St
  addParcel('google_parcel_10_w_33rd', 'Koreatown Plaza & 10 W 33rd St (Block 834 Lot 25)', 834, 25, 65.0, 16, false, [
    [-115.0, 49.0],
    [-3.0, 49.0],
    [-3.0, 111.0],
    [-115.0, 111.0]
  ]);

  // Block 863 Lot 45: 180 Madison Avenue
  addParcel('google_parcel_180_madison', '180 Madison Avenue (Block 863 Lot 45)', 863, 45, 91.0, 23, false, [
    [150.0, 49.0],
    [262.0, 49.0],
    [262.0, 111.0],
    [150.0, 111.0]
  ]);

  // Block 866 Lot 50: 225 Madison Avenue
  addParcel('google_parcel_225_madison', '225 Madison Avenue (Block 866 Lot 50)', 866, 50, 136.0, 36, false, [
    [150.0, -191.0],
    [262.0, -191.0],
    [262.0, -129.0],
    [150.0, -129.0]
  ]);

  // Block 862 Lot 35: 160 Madison Avenue
  addParcel('google_parcel_160_madison', '160 Madison Avenue (Block 862 Lot 35)', 862, 35, 118.0, 30, false, [
    [150.0, 129.0],
    [262.0, 129.0],
    [262.0, 191.0],
    [150.0, 191.0]
  ]);

  // Block 781: Two Penn Plaza
  addParcel('google_parcel_two_penn_plaza', 'Two Penn Plaza (Block 781)', 781, 1, 126.0, 31, false, [
    [-434.0, 49.0],
    [-340.0, 49.0],
    [-340.0, 191.0],
    [-434.0, 191.0]
  ]);

  // Block 781: Madison Square Garden Substructure
  addParcel('google_parcel_msg', 'Madison Square Garden (Block 781)', 781, 10, 45.0, 8, false, [
    [-580.0, 49.0],
    [-434.0, 49.0],
    [-434.0, 191.0],
    [-580.0, 191.0]
  ]);

  // Block 810: 11 Penn Plaza / 393 7th Ave
  addParcel('google_parcel_11_penn_plaza', '11 Penn Plaza / 393 7th Ave (Block 810)', 810, 1, 96.0, 24, false, [
    [-434.0, -31.0],
    [-256.0, -31.0],
    [-256.0, 31.0],
    [-434.0, 31.0]
  ]);

  // Block 868: 400 5th Avenue / The Langham
  addParcel('google_parcel_400_5th_ave', '400 5th Avenue / The Langham (Block 868)', 868, 1, 193.0, 57, false, [
    [39.0, -351.0],
    [150.0, -351.0],
    [150.0, -289.0],
    [39.0, -289.0]
  ]);

  // Block 870: 425 5th Avenue
  addParcel('google_parcel_425_5th_ave', '425 5th Avenue (Block 870)', 870, 1, 188.0, 56, false, [
    [39.0, -431.0],
    [150.0, -431.0],
    [150.0, -369.0],
    [39.0, -369.0]
  ]);

  // Block 841: Lord & Taylor Building / Amazon NYC HQ
  addParcel('google_parcel_lord_and_taylor', 'Lord & Taylor / Amazon NYC HQ (Block 841)', 841, 1, 56.0, 11, false, [
    [-104.5, -431.0],
    [-3.0, -431.0],
    [-3.0, -369.0],
    [-104.5, -369.0]
  ]);

  // Block 842: 452 5th Avenue / HSBC Tower
  addParcel('google_parcel_452_5th_ave', '452 5th Avenue / HSBC Tower (Block 842)', 842, 1, 114.0, 30, false, [
    [-104.5, -511.0],
    [-3.0, -511.0],
    [-3.0, -449.0],
    [-104.5, -449.0]
  ]);

  // Block 871: New York Public Library Main Branch (Schwarzman Building)
  addParcel('google_parcel_nypl_schwarzman', 'New York Public Library Main Branch (Block 871)', 871, 1, 32.0, 4, false, [
    [39.0, -530.0],
    [240.0, -530.0],
    [240.0, -449.0],
    [39.0, -449.0]
  ]);

  // Block 842: Bryant Park Studios / 80 W 40th St
  addParcel('google_parcel_bryant_park_studios', 'Bryant Park Studios / 80 W 40th St (Block 842 Lot 10)', 842, 10, 52.0, 11, false, [
    [-224.0, -511.0],
    [-115.0, -511.0],
    [-115.0, -449.0],
    [-224.0, -449.0]
  ]);

  // Block 840: 1065 Avenue of the Americas
  addParcel('google_parcel_1065_6th_ave', '1065 Avenue of the Americas (Block 840)', 840, 1, 140.0, 34, false, [
    [-224.0, -351.0],
    [-115.0, -351.0],
    [-115.0, -289.0],
    [-224.0, -289.0]
  ]);

  // Block 839: 1040 Avenue of the Americas / Millinery Center
  addParcel('google_parcel_1040_6th_ave', '1040 Avenue of the Americas (Block 839)', 839, 1, 96.0, 24, false, [
    [-224.0, -271.0],
    [-115.0, -271.0],
    [-115.0, -209.0],
    [-224.0, -209.0]
  ]);

  // Block 867: 385 5th Avenue / 36th St
  addParcel('google_parcel_385_5th_ave', '385 5th Avenue (Block 867)', 867, 1, 92.0, 23, false, [
    [39.0, -271.0],
    [150.0, -271.0],
    [150.0, -209.0],
    [39.0, -209.0]
  ]);

  // Block 890: 2 Park Avenue (Art Deco Landmark)
  addParcel('google_parcel_2_park_ave', '2 Park Avenue (Block 890)', 890, 1, 109.0, 28, false, [
    [280.0, -31.0],
    [400.0, -31.0],
    [400.0, 31.0],
    [280.0, 31.0]
  ]);

  // Block 891: 10 Park Avenue
  addParcel('google_parcel_10_park_ave', '10 Park Avenue (Block 891)', 891, 1, 92.0, 27, false, [
    [280.0, -111.0],
    [400.0, -111.0],
    [400.0, -49.0],
    [280.0, -49.0]
  ]);

  // Block 832: 295 5th Avenue / Textile Building
  addParcel('google_parcel_295_5th_ave', '295 5th Avenue / Textile Building (Block 832)', 832, 1, 72.0, 17, false, [
    [-104.5, 209.0],
    [-3.0, 209.0],
    [-3.0, 271.0],
    [-104.5, 271.0]
  ]);

  // Block 868: 270 Madison Avenue
  addParcel('google_parcel_270_madison', '270 Madison Avenue (Block 868 Lot 40)', 868, 40, 85.0, 21, false, [
    [150.0, -351.0],
    [262.0, -351.0],
    [262.0, -289.0],
    [150.0, -289.0]
  ]);

  // --- 5. Parks & Plazas ---
  const landscapes = [];
  const addLandscape = (id, name, type, gridCorners, hexColor) => {
    const polygonLocalENU = gridCorners.map(([u, v]) => manhattanToEnu(u, v));
    if (
      polygonLocalENU[0][0] !== polygonLocalENU[polygonLocalENU.length - 1][0] ||
      polygonLocalENU[0][1] !== polygonLocalENU[polygonLocalENU.length - 1][1]
    ) {
      polygonLocalENU.push([...polygonLocalENU[0]]);
    }
    const coordinatesWGS84 = polygonLocalENU.map(([x, z]) => projectEnuToWgs84(x, z));
    landscapes.push({
      id,
      name,
      type,
      polygonLocalENU,
      coordinatesWGS84,
      fillColor: hexColor
    });
  };

  addLandscape('google_landscape_greeley_sq', 'Greeley Square Park', 'park', [
    [-205.0, 52.0],
    [-165.0, 52.0],
    [-185.0, 108.0],
    [-205.0, 108.0]
  ], '#4ade80');

  addLandscape('google_landscape_herald_sq', 'Herald Square Plaza', 'plaza', [
    [-210.0, -108.0],
    [-165.0, -108.0],
    [-180.0, -52.0],
    [-210.0, -52.0]
  ], '#e2e8f0');

  addLandscape('google_landscape_broadway_plaza', 'Broadway Pedestrian Promenade', 'pedestrian_mall', [
    [-200.0, -38.0],
    [-170.0, -38.0],
    [-170.0, 38.0],
    [-200.0, 38.0]
  ], '#cbd5e1');

  addLandscape('google_landscape_bryant_park', 'Bryant Park', 'park', [
    [-220.0, -530.0],
    [15.0, -530.0],
    [15.0, -455.0],
    [-220.0, -455.0]
  ], '#4ade80');

  // --- 6. COLMAP Poses ---
  const colmapCameraPoses = [];
  const rad29 = (29.0 * Math.PI) / 180.0;
  const avenueForward = [Math.sin(rad29), 0.0, -Math.cos(rad29)];
  const streetForward = [Math.cos(rad29), 0.0, Math.sin(rad29)];

  const avenueWaypoints = [120.0, 80.0, 40.0, 0.0, -40.0, -80.0, -120.0];
  avenueWaypoints.forEach((v, idx) => {
    const [x, z] = manhattanToEnu(18.0, v);
    const [lng, lat] = projectEnuToWgs84(x, z);
    colmapCameraPoses.push({
      id: idx + 1,
      name: `COLMAP_CAM_5TH_AVE_${idx + 1}`,
      positionLocalENU: [x, 2.8, z],
      rotationYDegrees: 29.0,
      forwardVector: avenueForward,
      focalLengthMm: 35.0,
      sensorWidthMm: 36.0,
      fovDegrees: 54.4,
      coordinatesWGS84: { lat, lng, elevation: 17.8 }
    });
  });

  const streetWaypoints = [-240.0, -180.0, -115.0, -50.0, 18.0, 100.0, 180.0, 260.0];
  streetWaypoints.forEach((u, idx) => {
    const [x, z] = manhattanToEnu(u, -40.0);
    const [lng, lat] = projectEnuToWgs84(x, z);
    colmapCameraPoses.push({
      id: avenueWaypoints.length + idx + 1,
      name: `COLMAP_CAM_34TH_ST_${idx + 1}`,
      positionLocalENU: [x, 2.8, z],
      rotationYDegrees: 119.0,
      forwardVector: streetForward,
      focalLengthMm: 35.0,
      sensorWidthMm: 36.0,
      fovDegrees: 54.4,
      coordinatesWGS84: { lat, lng, elevation: 17.8 }
    });
  });

  return {
    version: '2.1.0-google-reference',
    source: 'google_maps_platform_reference',
    anchor: ESB_GOOGLE_GEODETIC_ANCHOR,
    styling: GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE,
    gridBearingDegrees: 29.0,
    roads,
    parcels,
    landscapes,
    colmapCameraPoses
  };
}

const mapping = generateCanonicalMidtownMapping();
fs.mkdirSync('public/data', { recursive: true });
fs.writeFileSync('public/data/google_midtown_vector_mapping.json', JSON.stringify(mapping, null, 2));

console.log('Successfully generated canonical Google Midtown mapping:');
console.log(`  Roads: ${mapping.roads.length}`);
console.log(`  Parcels: ${mapping.parcels.length}`);
console.log(`  File size: ${fs.statSync('public/data/google_midtown_vector_mapping.json').size} bytes`);
