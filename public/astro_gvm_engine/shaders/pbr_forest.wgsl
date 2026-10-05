struct CameraUniforms {
                    viewProj: mat4x4<f32>,
                    camPos: vec4<f32>, // xyz: camera pos, w: elapsed time in seconds
                    planes: array<vec4<f32>, 6>,
                    cullingParams: vec4<f32>, // x: frustumOn, y: coneOn, z: viewMode, w: totalCount
                };

                @group(0) @binding(0) var<uniform> camera: CameraUniforms;
                @group(0) @binding(1) var<storage, read> visibleClusterIDs: array<u32>;
                @group(0) @binding(2) var<storage, read> vertexPool: array<f32>;
                @group(0) @binding(3) var<storage, read> indexTemplate: array<u32>;

                struct VertexOutput {
                    @builtin(position) position: vec4<f32>,
                    @location(0) worldPos: vec3<f32>,
                    @location(1) normal: vec3<f32>,
                    @location(2) clusterColor: vec3<f32>,
                    @location(3) @interpolate(flat) matId: u32,
                    @location(4) roughness: f32,
                };

                fn hashColor(seed: u32) -> vec3<f32> {
                    var s = seed * 747796405u + 2891336453u;
                    var word = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
                    let h = f32((word >> 22u) ^ word) / 4294967295.0;
                    return vec3<f32>(
                        abs(sin(h * 6.28318 + 0.0)),
                        abs(sin(h * 6.28318 + 2.094)),
                        abs(sin(h * 6.28318 + 4.188))
                    );
                }

                const PI: f32 = 3.14159265359;

                fn distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
                    let a = roughness * roughness;
                    let a2 = a * a;
                    let NdotH = max(dot(N, H), 0.0);
                    let NdotH2 = NdotH * NdotH;
                    let num = a2;
                    var denom = (NdotH2 * (a2 - 1.0) + 1.0);
                    denom = PI * denom * denom;
                    return num / max(denom, 0.0001);
                }

                fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
                    let r = (roughness + 1.0);
                    let k = (r * r) / 8.0;
                    return NdotV / (NdotV * (1.0 - k) + k);
                }

                fn geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
                    let NdotV = max(dot(N, V), 0.0);
                    let NdotL = max(dot(N, L), 0.0);
                    let ggx2 = geometrySchlickGGX(NdotV, roughness);
                    let ggx1 = geometrySchlickGGX(NdotL, roughness);
                    return ggx1 * ggx2;
                }

                fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
                    return F0 + (vec3<f32>(1.0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
                }

                fn acesToneMap(color: vec3<f32>) -> vec3<f32> {
                    let a = 2.51;
                    let b = 0.03;
                    let c = 2.43;
                    let d = 0.59;
                    let e = 0.14;
                    return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
                }

                // Procedural 3D Voronoi Cellular Noise (Bioluminescent Micro-Cells & Photophores)
                fn cellularBioNoise(p: vec3<f32>) -> vec2<f32> {
                    let Pi = floor(p);
                    let Pf = fract(p);
                    var minD = 1.0;
                    var minD2 = 1.0;

                    for (var z: i32 = -1; z <= 1; z = z + 1) {
                        for (var y: i32 = -1; y <= 1; y = y + 1) {
                            for (var x: i32 = -1; x <= 1; x = x + 1) {
                                let g = vec3<f32>(f32(x), f32(y), f32(z));
                                let randSeed = Pi + g;
                                // Simple deterministic hash for cell center
                                let hx = sin(dot(randSeed, vec3<f32>(12.9898, 78.233, 45.164))) * 43758.5453;
                                let hy = sin(dot(randSeed, vec3<f32>(39.346, 11.135, 83.155))) * 43758.5453;
                                let hz = sin(dot(randSeed, vec3<f32>(73.156, 52.235, 9.151))) * 43758.5453;
                                let jitter = vec3<f32>(fract(hx), fract(hy), fract(hz)) * 0.7;
                                let d = length(g + jitter - Pf);
                                if (d < minD) {
                                    minD2 = minD;
                                    minD = d;
                                } else if (d < minD2) {
                                    minD2 = d;
                                }
                            }
                        }
                    }
                    return vec2<f32>(minD, minD2);
                }

                                                // Analytical Canopy Shadow & Sunbeam Gap Function (High-contrast cinematic beams)
                fn getCanopyShadow(P: vec3<f32>, sunDir: vec3<f32>) -> f32 {
                    let tCanopy = (36.0 - P.y) / max(sunDir.y, 0.08);
                    if (tCanopy < 0.0) { return 1.0; }
                    let hitPt = P + sunDir * tCanopy;

                    let d1 = length(hitPt.xz - vec2<f32>(-12.0, -12.0));
                    let d2 = length(hitPt.xz - vec2<f32>(26.0, 14.0));
                    let d3 = length(hitPt.xz - vec2<f32>(8.0, -40.0));
                    let d4 = length(hitPt.xz - vec2<f32>(-40.0, 16.0));
                    let dMin = min(min(d1, d2), min(d3, d4));

                    // High-frequency gaps between conifer branches
                    let gap1 = sin(hitPt.x * 0.45) * cos(hitPt.z * 0.45);
                    let gap2 = sin(hitPt.x * 1.65 + hitPt.z * 1.45);
                    let gaps = gap1 * 0.65 + gap2 * 0.35;

                    let crownShadow = smoothstep(22.0, 6.0, dMin);
                    let gapTransmission = smoothstep(-0.15, 0.60, gaps);

                    return clamp(1.0 - crownShadow * (1.0 - gapTransmission * 0.95), 0.04, 1.0);
                }

                                @vertex
                fn vs_main(
                    @builtin(vertex_index) vertexIdx: u32,
                    @builtin(instance_index) instanceIdx: u32
                ) -> VertexOutput {
                    var out: VertexOutput;

                    let clusterId = visibleClusterIDs[instanceIdx];
                    let localVertIdx = indexTemplate[vertexIdx];
                    let vertFloatOffset = (clusterId * 64u + localVertIdx) * 8u;

                    let px = vertexPool[vertFloatOffset + 0u];
                    let py = vertexPool[vertFloatOffset + 1u];
                    let pz = vertexPool[vertFloatOffset + 2u];
                    let nx = vertexPool[vertFloatOffset + 3u];
                    let ny = vertexPool[vertFloatOffset + 4u];
                    let nz = vertexPool[vertFloatOffset + 5u];
                    let matIdFloat = vertexPool[vertFloatOffset + 6u];
                    let rough = vertexPool[vertFloatOffset + 7u];

                    let matId = u32(matIdFloat);
                    var worldPos = vec3<f32>(px, py, pz);

                    // Harmonic Botanical Wind Turbulence (Zero-CPU GPU Vertex Oscillation)
                    let windTime = camera.camPos.w;
                    let windDir = vec2<f32>(-0.707, 0.707);
                    let windPhase = dot(worldPos.xz, windDir) * 0.12 + windTime * 1.6;

                    // Conifer boughs sway smoothly in the high canopy
                    if (matId == 1u) {
                        let heightFlex = clamp(worldPos.y / 60.0, 0.0, 1.0);
                        let sway = sin(windPhase * 0.8) * 0.32 * heightFlex + sin(windPhase * 2.0 + worldPos.y * 0.4) * 0.07 * heightFlex;
                        worldPos.x = worldPos.x + windDir.x * sway;
                        worldPos.z = worldPos.z + windDir.y * sway;
                        worldPos.y = worldPos.y - abs(sway) * 0.12;
                    }
                    // Sword ferns flutter gracefully
                    else if (matId == 2u) {
                        let frondFlutter = sin(windPhase * 2.4 + worldPos.x * 2.2) * 0.09;
                        worldPos.y = worldPos.y + frondFlutter;
                        worldPos.x = worldPos.x + windDir.x * frondFlutter * 0.4;
                    }
                    // Hanging Usnea lichen sways like gossamer drapes
                    else if (matId == 10u) {
                        let lichenSway = sin(windPhase * 1.1 + worldPos.z * 1.5) * 0.22 + sin(windTime * 2.8) * 0.06;
                        worldPos.x = worldPos.x + windDir.x * lichenSway;
                        worldPos.z = worldPos.z + windDir.y * lichenSway;
                    }
                    // Understory Maples & Rhododendrons
                    else if (matId == 6u || matId == 7u) {
                        let shrubSway = sin(windPhase * 1.4 + worldPos.z) * 0.12;
                        worldPos.x = worldPos.x + windDir.x * shrubSway;
                        worldPos.z = worldPos.z + windDir.y * shrubSway;
                    }

                    out.worldPos = worldPos;
                    out.normal = normalize(vec3<f32>(nx, ny, nz));
                    out.position = camera.viewProj * vec4<f32>(worldPos, 1.0);
                    out.clusterColor = hashColor(clusterId);
                    out.matId = matId;
                    out.roughness = rough;

                    return out;
                }

                                                                                                                                                @fragment
                fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
                    let mode = u32(camera.cullingParams.z);
                    let time = camera.camPos.w;

                    // Mode 0: Discrete Cluster IDs (Partitioning Visualization)
                    if (mode == 0u) {
                        let light = max(dot(in.normal, normalize(vec3<f32>(0.5, 0.8, 0.3))), 0.25);
                        return vec4<f32>(in.clusterColor * light, 1.0);
                    }

                    // Mode 3: Surface Normal Vectors
                    if (mode == 3u) {
                        return vec4<f32>(in.normal * 0.5 + 0.5, 1.0);
                    }

                    let V = normalize(camera.camPos.xyz - in.worldPos);
                    var N = normalize(in.normal);
                    // Two-sided normal orientation for foliage cards & double-sided geometry
                    if (dot(N, V) < 0.0) {
                        N = -N;
                    }

                    // Sunlight Configuration
                    // Warm golden morning sun streaming through the cathedral canopy
                    var sunDir = normalize(vec3<f32>(-0.55, 0.62, -0.42));
                    var sunRadiance = vec3<f32>(1.0, 0.88, 0.68) * 6.5;

                    // Overcast Soft Daylight mode
                    if (mode == 2u) {
                        sunDir = normalize(vec3<f32>(0.15, 0.95, 0.25));
                        sunRadiance = vec3<f32>(0.92, 0.95, 1.0) * 3.4;
                    }

                                        // MAT 5: Celestial Sky Hemisphere (Crisp Azure Windows & Morning Corona)
                    if (in.matId == 5u) {
                        let viewDir = normalize(in.worldPos - camera.camPos.xyz);
                        let sunDot = max(dot(viewDir, sunDir), 0.0);

                        // Atmospheric Rayleigh gradient (Deep sapphire zenith to warm horizon)
                        let horizonWarm = vec3<f32>(0.92, 0.78, 0.58);
                        let azureZenith = vec3<f32>(0.12, 0.38, 0.84);  // Pure Pacific coastal azure
                        let skyGrad = mix(horizonWarm, azureZenith, clamp(viewDir.y * 1.6, 0.0, 1.0));

                        // Intense morning solar flare & corona
                        let sunDisk = pow(sunDot, 512.0) * 55.0;
                        let sunCorona = pow(sunDot, 22.0) * 3.2;
                        let skyFinal = skyGrad + (sunDisk + sunCorona) * vec3<f32>(1.0, 0.92, 0.72);

                        let mappedSky = acesToneMap(skyFinal);
                        return vec4<f32>(pow(mappedSky, vec3<f32>(1.0 / 2.2)), 1.0);
                    }

                    let NdotV = max(dot(N, V), 0.001);
                    let NdotL = max(dot(N, sunDir), 0.0);
                    let H = normalize(V + sunDir);
                    let NdotH = max(dot(N, H), 0.0);

                    // Natural sky ambient light: deep blue from above, warm earth bounce from below
                    var skyAmbient = mix(vec3<f32>(0.06, 0.08, 0.05), vec3<f32>(0.22, 0.38, 0.68), N.y * 0.5 + 0.5) * 0.95;
                    if (mode == 2u) {
                        skyAmbient = vec3<f32>(0.32, 0.40, 0.48) * 1.35;
                    }

                                        // Physical Foliage Subsurface Scattering (Gentle, realistic chlorophyll transmission)
                    let backSun = max(dot(-V, sunDir), 0.0);
                    let foliageSSS = pow(backSun, 4.0) * 0.35;

                    // Canopy Ambient Occlusion (Deeper inner boughs receive less sky ambient)
                    var canopyAO = clamp((in.worldPos.y - 4.0) / 45.0, 0.45, 1.0);

                    var albedo = vec3<f32>(0.1);
                    var roughness = clamp(in.roughness, 0.04, 0.92);
                    var metallic = 0.02;
                    var sssEmission = vec3<f32>(0.0);

                                                            // MAT 0: Ancient Redwood Monarch Bark (Deep Voronoi Fissure Canyons & Fibrous Cinnamon Peels)
                    if (in.matId == 0u) {
                        let dM1 = length(in.worldPos.xz - vec2<f32>(-12.0, -12.0));
                        let dM2 = length(in.worldPos.xz - vec2<f32>(26.0, 14.0));
                        let dM3 = length(in.worldPos.xz - vec2<f32>(8.0, -40.0));
                        let dM4 = length(in.worldPos.xz - vec2<f32>(-40.0, 16.0));
                        
                        var treeCenter = vec2<f32>(-12.0, -12.0);
                        var isMonarch1 = 1.0;
                        if (dM2 < dM1 && dM2 < dM3 && dM2 < dM4) { treeCenter = vec2<f32>(26.0, 14.0); isMonarch1 = 0.0; }
                        else if (dM3 < dM1 && dM3 < dM2 && dM3 < dM4) { treeCenter = vec2<f32>(8.0, -40.0); isMonarch1 = 0.0; }
                        else if (dM4 < dM1 && dM4 < dM2 && dM4 < dM3) { treeCenter = vec2<f32>(-40.0, 16.0); isMonarch1 = 0.0; }

                        let relPos = in.worldPos.xz - treeCenter;
                        let barkAngle = atan2(relPos.y, relPos.x);
                        let barkY = in.worldPos.y;

                        // Continuous cylindrical normal blending (Eliminates faceting while respecting fluting)
                        let radialNorm = normalize(vec3<f32>(relPos.x, 0.0, relPos.y));
                        N = normalize(mix(in.normal, radialNorm, 0.50));

                        // 1. Broad rounded structural plates (cinnamon bark ridges, ~0.8m width)
                        let plateFreq = 8.0;
                        let platePhase = barkAngle * plateFreq + sin(barkY * 0.22) * 0.70;
                        let plateDist = abs(fract(platePhase) - 0.5) * 2.0;

                        // 2. Secondary Voronoi fissure wandering with horizontal stress micro-crevices
                        let crackWander = sin(barkY * 2.4 + barkAngle * 14.0) * 0.16;
                        let deepFissure = smoothstep(0.28, 0.05, plateDist + crackWander);
                        let horizCrack = smoothstep(0.04, 0.0, abs(fract(barkY * 3.5 + sin(barkAngle * 6.0) * 0.25) - 0.5));

                        // 3. High-frequency vertical peeling fibers
                        let fiberNoise = sin(barkAngle * 55.0 + sin(barkY * 0.8) * 1.8) * 0.6 + cos(barkAngle * 110.0 + barkY * 3.2) * 0.4;
                        let fibrousPeels = smoothstep(0.22, 0.82, fiberNoise);

                        // Old-Growth Redwood Bark Palette:
                        // Deep canyon shadow umber
                        let fissureUmber = vec3<f32>(0.018, 0.010, 0.006);
                        // Core fibrous cinnamon
                        let richCinnamon = vec3<f32>(0.440, 0.185, 0.075);
                        // Weathered outer rhytidome ridge
                        let weatheredGrey = vec3<f32>(0.230, 0.140, 0.100);
                        // Fresh peeling stringy bark
                        let freshPeel = vec3<f32>(0.510, 0.225, 0.090);

                        albedo = mix(fissureUmber, richCinnamon, smoothstep(0.12, 0.58, plateDist));
                        albedo = mix(albedo, weatheredGrey, smoothstep(0.58, 0.94, plateDist));
                        albedo = mix(albedo, freshPeel, fibrousPeels * 0.38);
                        albedo = mix(albedo, fissureUmber, horizCrack * 0.65);

                        // Goosepen Fire Hollow Charcoal (Facing camera on Monarch 1 at angle 1.22 rad)
                        let dAngFire = barkAngle - 1.22;
                        let isCharcoalZone = isMonarch1 * smoothstep(5.8, 0.2, barkY) * exp(-(dAngFire * dAngFire) / 0.24);
                        let charcoalAlbedo = vec3<f32>(0.010, 0.008, 0.007);
                        albedo = mix(albedo, charcoalAlbedo, isCharcoalZone * 0.98);

                        // Deep fissure cavity ambient occlusion
                        canopyAO = canopyAO * mix(1.0, 0.14, deepFissure * (1.0 - isCharcoalZone * 0.6));

                        // Damp velvet moss patches in lower sheltered bark hollows
                        let trunkMoisture = smoothstep(6.5, 0.4, barkY) * deepFissure * (1.0 - isCharcoalZone);
                        let mossColor = vec3<f32>(0.070, 0.190, 0.040);
                        albedo = mix(albedo, mossColor, trunkMoisture * 0.72);

                        // Nurse Log Moss Draping: Upper surface of horizontal fallen logs gets lush emerald moss
                        let isNurseLog = step(abs(in.normal.y), 0.99) * smoothstep(2.5, 0.2, in.worldPos.y) * (1.0 - isMonarch1);
                        let logTopMoss = smoothstep(0.20, 0.75, in.normal.y) * isNurseLog;
                        let logMossGreen = vec3<f32>(0.045, 0.150, 0.030);
                        albedo = mix(albedo, logMossGreen, logTopMoss * 0.88);

                        roughness = mix(0.88, 0.98, isCharcoalZone);
                    }
                    // MAT 1: Authentic Dense Distichous Redwood Needle Sprays (Sequoia sempervirens)
                    else if (in.matId == 1u) {
                        let sprigScale = 5.5;
                        let rotShoot = in.worldPos.x * 0.707 + in.worldPos.z * 0.707;
                        let rotLat = in.worldPos.x * 0.707 - in.worldPos.z * 0.707 + in.worldPos.y * 0.35;

                        // Periodic sprig cells tiled across foliage boughs
                        let cellU = fract(rotShoot * sprigScale);
                        let cellV = fract(rotLat * sprigScale);
                        let vLateral = (cellV - 0.5) * 2.0;
                        let lateralDist = abs(vLateral);

                        // Central woody shoot axis (slender red-brown branchlet)
                        let isTwig = lateralDist < 0.14;

                        // Bilateral comb needles spreading at alternating angles along the shoot
                        let lateralShift = select(0.5, 0.0, vLateral > 0.0);
                        let needleStep = fract(cellU * 5.0 + lateralShift);
                        let needleProfile = abs(needleStep - 0.5) * 2.0;

                        // Natural needle length taper along the branchlet shoot
                        let sprigTaper = sin(cellU * 3.14159265);
                        let maxNeedleLen = 0.85 * sprigTaper + 0.18;

                        let isNeedleBlade = (lateralDist < maxNeedleLen) && (needleProfile > 0.18);

                        if (!isTwig && !isNeedleBlade) {
                            discard;
                        }

                        let twigWood = vec3<f32>(0.18, 0.08, 0.04);
                        let darkNeedleShade = vec3<f32>(0.012, 0.040, 0.014);
                        let richEvergreen = vec3<f32>(0.026, 0.082, 0.028);
                        let sunlitEdge = vec3<f32>(0.055, 0.135, 0.042);

                        if (isTwig) {
                            albedo = twigWood;
                            roughness = 0.75;
                            sssEmission = vec3<f32>(0.0);
                        } else {
                            let midRib = smoothstep(0.04, 0.0, abs(lateralDist - 0.45 * maxNeedleLen));
                            let needleAge = smoothstep(0.14, maxNeedleLen, lateralDist);

                            albedo = mix(darkNeedleShade, richEvergreen, needleProfile);
                            albedo = mix(albedo, sunlitEdge, needleAge * 0.65);
                            albedo = mix(albedo, vec3<f32>(0.04, 0.10, 0.03), midRib * 0.35);

                            let edgeGlow = smoothstep(0.65, 1.0, needleProfile);
                            sssEmission = sunlitEdge * sunRadiance * foliageSSS * edgeGlow * 1.6;
                            roughness = 0.44;
                        }
                    }
                    // MAT 2: Woodland Western Sword Fern Fronds (Polystichum munitum - Individual Serrated Pinnae Leaflets)
                    else if (in.matId == 2u) {
                        // High-frequency alternating pinnae leaflets along the frond
                        let frondCoord = in.worldPos.xz * 6.5;
                        let pinnaeStria = sin(frondCoord.x * 24.0 + frondCoord.y * 18.0);
                        let gap = smoothstep(0.08, 0.22, abs(pinnaeStria));

                        if (gap < 0.15) {
                            discard;
                        }

                        let deepCuticle = vec3<f32>(0.014, 0.062, 0.018);   // Dark waxy adaxial surface
                        let brightSunlit = vec3<f32>(0.13, 0.30, 0.048);   // Translucent serrated margin
                        let rachisStem = vec3<f32>(0.075, 0.052, 0.022);   // Central woody rachis

                        let isMargin = smoothstep(0.3, 0.9, pinnaeStria);
                        albedo = mix(deepCuticle, brightSunlit, isMargin);
                        sssEmission = albedo * sunRadiance * foliageSSS * 1.25;
                        roughness = 0.24;
                    }
                    // MAT 3: Weathered Granite Boulders with Moss & Lichen
                    else if (in.matId == 3u) {
                        let slateGranite = vec3<f32>(0.15, 0.16, 0.17);
                        let darkRock = vec3<f32>(0.08, 0.09, 0.10);

                        let rockGrain = sin(in.worldPos.x * 4.5) * sin(in.worldPos.y * 4.5) * sin(in.worldPos.z * 4.5);
                        albedo = mix(slateGranite, darkRock, rockGrain * 0.5 + 0.5);

                        let lichenNoise = sin(in.worldPos.x * 1.2 + in.worldPos.z * 0.9) * cos(in.worldPos.y * 1.5);
                        let goldenLichen = vec3<f32>(0.28, 0.22, 0.08);
                        let sageLichen = vec3<f32>(0.14, 0.20, 0.11);

                        let hasLichen = smoothstep(0.35, 0.75, abs(lichenNoise));
                        let lichenColor = mix(goldenLichen, sageLichen, sin(in.worldPos.x * 1.5) * 0.5 + 0.5);
                        albedo = mix(albedo, lichenColor, hasLichen * 0.7);

                        roughness = 0.88;
                    }
                    // MAT 4: Forest Floor (Rich Humus Peat, Cinnamon Needle Carpet, Velvet Moss & Mud Hollows - NO MOIRÉ)
                    else if (in.matId == 4u) {
                        let darkHumus = vec3<f32>(0.048, 0.028, 0.016);     // Rich California coastal humus
                        let cinnamonDuff = vec3<f32>(0.138, 0.065, 0.026);  // Dense fallen redwood needle bed
                        let velvetMoss = vec3<f32>(0.035, 0.110, 0.022);    // Deep emerald moss in moist swales
                        let wetMud = vec3<f32>(0.022, 0.014, 0.009);        // Saturated peat mud

                        // Multi-scale organic octaves (Smooth, natural variation without pixel-grid moiré)
                        let pF = in.worldPos.xz;
                        let n1 = sin(pF.x * 0.25 + sin(pF.y * 0.32));
                        let n2 = cos(pF.x * 0.65 - pF.y * 0.55);
                        let n3 = sin(pF.x * 1.8 + pF.y * 1.4);
                        let n4 = cos(pF.x * 4.2 - pF.y * 3.8);
                        let macroNoise = n1 * 0.40 + n2 * 0.30 + n3 * 0.20 + n4 * 0.10;

                        // Needle duff blending based on organic macro clusters
                        let needleBlend = smoothstep(-0.35, 0.45, macroNoise);

                        // Velvet moss flourishing in shaded, moist hollows
                        let valleyMoisture = smoothstep(2.0, 0.0, in.worldPos.y);
                        let mossPatch = smoothstep(0.25, 0.75, n1 * 0.6 + n3 * 0.4) * valleyMoisture * 0.85;

                        albedo = mix(darkHumus, cinnamonDuff, needleBlend * 0.80);
                        albedo = mix(albedo, velvetMoss, mossPatch);

                        // Water puddles in ground hollows with wet mirror gloss
                        let isPuddle = smoothstep(0.15, -0.10, in.worldPos.y);
                        let puddleColor = vec3<f32>(0.018, 0.028, 0.035);

                        albedo = mix(albedo, puddleColor, isPuddle * 0.94);
                        albedo = mix(albedo, wetMud, (1.0 - isPuddle) * valleyMoisture * 0.50);
                        roughness = mix(0.84, 0.04, isPuddle);
                    }
                    // MAT 6: Deciduous Pacific Vine Maple (Acer circinatum - Palmate leaf alpha cutout)
                    else if (in.matId == 6u) {
                        let leafScale = 24.0;
                        let uL = fract(in.worldPos.x * leafScale);
                        let vL = fract(in.worldPos.z * leafScale);
                        let dCenter = length(vec2<f32>(uL - 0.5, vL - 0.5));

                        let angle = atan2(vL - 0.5, uL - 0.5);
                        let lobes = abs(sin(angle * 3.5)) * 0.24 + 0.16;

                        // Palmate leaf cutout
                        if (dCenter > lobes) {
                            discard;
                        }

                        let freshSpringGreen = vec3<f32>(0.07, 0.22, 0.035);
                        let deepLobedGreen = vec3<f32>(0.025, 0.11, 0.018);
                        let veinColor = vec3<f32>(0.12, 0.26, 0.04);

                        let vein = smoothstep(0.03, 0.0, abs(sin(angle * 3.5) * dCenter));
                        albedo = mix(deepLobedGreen, freshSpringGreen, smoothstep(0.04, 0.32, dCenter));
                        albedo = mix(albedo, veinColor, vein * 0.5);
                        sssEmission = albedo * sunRadiance * foliageSSS * 1.35;
                        roughness = 0.42;
                    }
                    // MAT 7: Mid-Story Pacific Rhododendron (Leathery whorled leaves + delicate floral trusses)
                    else if (in.matId == 7u) {
                        let leafScale = 18.0;
                        let uR = fract(in.worldPos.x * leafScale);
                        let vR = fract(in.worldPos.z * leafScale);
                        let dR = length(vec2<f32>((uR - 0.5) * 1.5, vR - 0.5));

                        if (dR > 0.36) {
                            discard;
                        }

                        let darkWaxyLeaf = vec3<f32>(0.014, 0.060, 0.018);
                        let floralPink = vec3<f32>(0.74, 0.42, 0.54);

                        let isFlowerZone = smoothstep(2.6, 4.2, in.worldPos.y) * sin(in.worldPos.x * 2.8 + in.worldPos.z * 2.8);
                        let isPetal = smoothstep(0.40, 0.75, isFlowerZone);

                        albedo = mix(darkWaxyLeaf, floralPink, isPetal * 0.92);
                        sssEmission = albedo * sunRadiance * foliageSSS * (0.8 + isPetal * 0.5);
                        roughness = mix(0.32, 0.52, isPetal);
                    }
                                        // MAT 8: Bracket Shelf Fungus (Ganoderma applanatum - Concentric annual growth rings & ivory pore margin)
                    else if (in.matId == 8u) {
                        // Local growth rings from bracket attachment base
                        let localRad = length(vec2<f32>(fract(in.worldPos.x * 0.8) - 0.5, fract(in.worldPos.z * 0.8) - 0.5)) * 12.0;
                        let ringStria = sin(localRad * 6.28318);

                        let woodyUmber = vec3<f32>(0.18, 0.09, 0.04);
                        let richChestnut = vec3<f32>(0.38, 0.18, 0.07);
                        let ivoryLip = vec3<f32>(0.88, 0.86, 0.78);

                        let ringPattern = smoothstep(-0.35, 0.65, ringStria);
                        albedo = mix(woodyUmber, richChestnut, ringPattern);

                        let isMargin = smoothstep(0.42, 0.92, fract(localRad * 0.25));
                        albedo = mix(albedo, ivoryLip, isMargin * 0.55);
                        roughness = 0.68;
                    }
                                        // MAT 9: Redwood Sorrel (Oxalis oregana - Botanical 12cm shamrocks with pale chevrons & blooming flowers)
                    else if (in.matId == 9u) {
                        let dCam = length(in.worldPos - camera.camPos.xyz);
                        let sorrelScale = 8.5; // Natural 12cm shamrock scale (eliminates high-frequency subpixel moiré)
                        let uS = fract(in.worldPos.x * sorrelScale);
                        let vS = fract(in.worldPos.z * sorrelScale);
                        let dS = length(vec2<f32>(uS - 0.5, vS - 0.5));
                        let sAngle = atan2(vS - 0.5, uS - 0.5);

                        let leafletShape = abs(sin(sAngle * 1.5)) * 0.26 + 0.12;

                        // Smooth distance-adaptive antialiasing: no harsh single-pixel checkerboard at distance
                        let cutoff = smoothstep(24.0, 7.0, dCam);
                        if (cutoff > 0.05 && dS > leafletShape) {
                            discard;
                        }

                        let tenderShamrock = vec3<f32>(0.072, 0.220, 0.038);
                        let deepCrease = vec3<f32>(0.026, 0.110, 0.018);
                        let paleChevron = vec3<f32>(0.135, 0.265, 0.075);
                        let oxalisBlossom = vec3<f32>(0.86, 0.82, 0.88); // Delicate white/pink woodland flower

                        let isChevron = smoothstep(0.04, 0.0, abs(dS - 0.16));
                        albedo = mix(deepCrease, tenderShamrock, smoothstep(0.03, 0.26, dS));
                        albedo = mix(albedo, paleChevron, isChevron * 0.42);

                        // Scattered blooming woodland oxalis blossoms (1 in every 8 clover clumps)
                        let flowerSeed = sin(floor(in.worldPos.x * sorrelScale) * 12.3 + floor(in.worldPos.z * sorrelScale) * 7.7);
                        let isFlower = step(0.76, flowerSeed) * smoothstep(0.18, 0.04, dS);
                        albedo = mix(albedo, oxalisBlossom, isFlower * 0.95);

                        sssEmission = albedo * sunRadiance * foliageSSS * (1.3 + isFlower * 0.5);
                        roughness = mix(0.36, 0.55, isFlower);
                    }
                                        // MAT 10: Hanging Old Man's Beard Lichen (Usnea longissima - Wispy pale-sage gossamer streamers)
                    else if (in.matId == 10u) {
                        let lichenFreq = 48.0;
                        let strandX = sin(in.worldPos.x * lichenFreq + in.worldPos.y * 18.0);
                        let strandZ = cos(in.worldPos.z * lichenFreq);
                        let lacePattern = abs(strandX) * 0.7 + abs(strandZ) * 0.3;

                        // High perforation: discard airy voids between delicate strands
                        if (lacePattern < 0.48) {
                            discard;
                        }

                        let paleSageLichen = vec3<f32>(0.14, 0.22, 0.11);
                        let sunlitMoss = vec3<f32>(0.26, 0.36, 0.16);

                        albedo = mix(paleSageLichen, sunlitMoss, smoothstep(0.5, 0.9, lacePattern));
                        // Soft backlit gossamer translucency
                        sssEmission = albedo * sunRadiance * foliageSSS * 1.2;
                        roughness = 0.75;
                    }
                    // MAT 11: Woodland Bonnet Mushrooms (Mycena - Translucent caps with slender stalks)
                    else {
                        let capDist = length(vec2<f32>(fract(in.worldPos.x * 6.0) - 0.5, fract(in.worldPos.z * 6.0) - 0.5));
                        if (capDist > 0.45) {
                            discard;
                        }

                        let pearlyCap = vec3<f32>(0.65, 0.58, 0.48);
                        let amberCore = vec3<f32>(0.85, 0.62, 0.32);

                        let radialStria = sin(atan2(fract(in.worldPos.z * 6.0) - 0.5, fract(in.worldPos.x * 6.0) - 0.5) * 16.0);
                        albedo = mix(pearlyCap, amberCore, smoothstep(0.1, 0.4, capDist));
                        albedo = albedo + vec3<f32>(radialStria * 0.05);

                        // High translucency
                        sssEmission = albedo * sunRadiance * foliageSSS * 1.8;
                        roughness = 0.25;
                    }

                                        // Physically-Based Rendering (Cook-Torrance GGX)
                    var F0 = vec3<f32>(0.04);
                    F0 = mix(F0, albedo, metallic);

                    let NDF = distributionGGX(N, H, roughness);
                    let G = geometrySmith(N, V, sunDir, roughness);
                    let F = fresnelSchlick(max(dot(H, V), 0.0), F0);

                    let kS = F;
                    let kD = (vec3<f32>(1.0) - kS) * (1.0 - metallic);

                    let numerator = NDF * G * F;
                    let denominator = 4.0 * NdotV * NdotL + 0.0001;
                    var specular = numerator / denominator;

                    // Direct sunbeam occlusion from canopy gaps
                    let sunOcclusion = getCanopyShadow(in.worldPos, sunDir);

                    // --- BREAKTHROUGH 1: Dual-Lobe GGX Anisotropic Wet Rain Rivulets on Bark ---
                    if (in.matId == 0u) {
                        let barkY = in.worldPos.y;
                        let barkAngle = atan2(in.worldPos.z, in.worldPos.x);
                        let plateA = fract(barkAngle * 3.82);
                        let plateDist = abs(plateA - 0.5) * 2.0;
                        let crackWander = sin(barkY * 0.35 + barkAngle * 2.0) * 0.12;
                        let deepFissure = smoothstep(0.24, 0.05, plateDist + crackWander);

                        let rivuletNoise = sin(barkY * 24.0 + sin(barkAngle * 28.0)) * 0.5 + 0.5;
                        let isWetTrack = smoothstep(0.38, 0.72, deepFissure * rivuletNoise);

                        let wetRough = 0.048;
                        let wetNDF = distributionGGX(N, H, wetRough);
                        let wetG = geometrySmith(N, V, sunDir, wetRough);
                        let wetF = fresnelSchlick(max(dot(H, V), 0.0), vec3<f32>(0.02));
                        let wetSpecular = (wetNDF * wetG * wetF) / (4.0 * NdotV * NdotL + 0.0001);

                        albedo = mix(albedo, albedo * 0.50, isWetTrack);
                        specular = mix(specular, wetSpecular * 3.4, isWetTrack);
                    }

                    // --- BREAKTHROUGH 2: Botanical Epicuticular Wax Clearcoat & Phase-Directed Chlorophyll BSSRDF ---
                    let isFoliage = (in.matId == 1u || in.matId == 2u || in.matId == 6u || in.matId == 7u || in.matId == 9u);
                    if (isFoliage) {
                        // 1. Epicuticular Adaxial Wax Clearcoat (Glossy dielectric layer on upper leaf surfaces)
                        let clearRough = 0.13;
                        let clearNDF = distributionGGX(N, H, clearRough);
                        let clearG = geometrySmith(N, V, sunDir, clearRough);
                        let clearF = fresnelSchlick(max(dot(H, V), 0.0), vec3<f32>(0.038));
                        let clearSpec = (clearNDF * clearG * clearF) / (4.0 * NdotV * NdotL + 0.0001);
                        let upwardFacing = clamp(N.y, 0.0, 1.0);
                        specular = specular + clearSpec * upwardFacing * 0.78;

                        // 2. Physical Phase-Directed Chlorophyll BSSRDF (Selective forward transmission)
                        let forwardScatter = max(dot(-V, sunDir), 0.0);
                        let gLeaf = 0.74;
                        let hgPhase = (1.0 - gLeaf * gLeaf) / (4.0 * 3.14159265 * pow(1.0 + gLeaf * gLeaf - 2.0 * gLeaf * forwardScatter, 1.5));
                        // Deep rich emerald base with delicate golden-amber translucency strictly when backlit
                        let chlorophyllGlow = vec3<f32>(0.12, 0.28, 0.05) * sunRadiance * hgPhase * 1.15 * sunOcclusion;
                        sssEmission = chlorophyllGlow * 0.90;
                    }

                    var directLight = (kD * albedo / 3.14159265 + specular) * sunRadiance * NdotL * sunOcclusion;
                    var ambientLight = albedo * skyAmbient * canopyAO;
                    var surfaceColor = directLight + ambientLight + sssEmission;

                    // Micro-Condensation Dewdrops (Glistening droplets on upward foliage catching morning sun)
                    if (N.y > 0.35 && (in.matId == 1u || in.matId == 2u || in.matId == 6u || in.matId == 7u || in.matId == 9u)) {
                        let dewPos = in.worldPos * 68.0;
                        let dewNoise = sin(dewPos.x) * sin(dewPos.z) * cos(dewPos.y);
                        let isDroplet = smoothstep(0.88, 0.98, dewNoise);
                        let dewSpec = pow(max(dot(H, N), 0.0), 96.0) * isDroplet * 7.5 * sunOcclusion;
                        surfaceColor = surfaceColor + sunRadiance * dewSpec * vec3<f32>(1.0, 0.98, 0.92);
                    }

                                        // Deep Ground Contact Cavity Ambient Occlusion (anchors trees, logs, boulders into soil)
                    let groundDist = max(in.worldPos.y + 0.15, 0.0);
                    let contactAO = smoothstep(0.0, 0.85, groundDist);
                    let deepGroundShade = mix(0.15, 1.0, contactAO);

                    // Rotting duff & damp peat accumulation around base
                    let duffRing = (1.0 - smoothstep(0.0, 0.75, groundDist));
                    let darkPeatMud = vec3<f32>(0.022, 0.014, 0.009);
                    albedo = mix(albedo, darkPeatMud, duffRing * 0.70);

                    surfaceColor = surfaceColor * deepGroundShade;

                    // Raymarched Volumetric Crepuscular God Rays (Delicate golden shafts against rich deep shadows)
                    let rayVec = in.worldPos - camera.camPos.xyz;
                    let totalDist = length(rayVec);
                    let rayDir = normalize(rayVec);
                    let marchDist = min(totalDist, 45.0);
                    let numMarchSteps = 14u;
                    let stepLen = marchDist / f32(numMarchSteps);

                    // Forward Mie scattering phase function (Tight forward focus)
                    let cosAngle = dot(rayDir, sunDir);
                    let mieG = 0.78;
                    let miePhase = (1.0 - mieG * mieG) / (4.0 * 3.14159265 * pow(1.0 + mieG * mieG - 2.0 * mieG * cosAngle, 1.5));

                    var volumetricLight = vec3<f32>(0.0);
                    for (var s = 0u; s < numMarchSteps; s = s + 1u) {
                        let sDist = (f32(s) + 0.5) * stepLen;
                        let sPos = camera.camPos.xyz + rayDir * sDist;
                        let sMist = exp(-sPos.y * 0.038) * 0.011;
                        let sSun = getCanopyShadow(sPos, sunDir);
                        volumetricLight = volumetricLight + sunRadiance * sSun * sMist * miePhase * stepLen;
                    }
                    let goldenRayColor = vec3<f32>(1.0, 0.88, 0.60);
                    surfaceColor = surfaceColor + volumetricLight * goldenRayColor * 0.80;

                    // High-Contrast Atmospheric Cathedral Depth (Preserves deep dark tree silhouettes)
                    let fogFactor = 1.0 - exp(-totalDist * 0.0013);
                    let mistCool = vec3<f32>(0.32, 0.44, 0.62); // Coastal marine coolness
                    let mistWarm = vec3<f32>(0.94, 0.82, 0.56); // Forward sunbeam warmth
                    let sunInscatter = pow(max(dot(rayDir, sunDir), 0.0), 6.0);
                    let mistFinal = mix(mistCool, mistWarm, sunInscatter * 0.82);

                    surfaceColor = mix(surfaceColor, mistFinal, clamp(fogFactor, 0.0, 0.36));

                                        // ACES Filmic Tone Mapping + Contrast Curve
                    let mapped = acesToneMap(surfaceColor);
                    var finalColor = pow(mapped, vec3<f32>(1.0 / 2.2));

                    // Subtle optical lens vignette (cinematic camera border falloff)
                    let screenUV = in.position.xy / vec2<f32>(1920.0, 1080.0) - vec2<f32>(0.5);
                    let vignette = 1.0 - dot(screenUV, screenUV) * 0.38;
                    finalColor = finalColor * clamp(vignette, 0.76, 1.0);

                    return vec4<f32>(finalColor, 1.0);
                }