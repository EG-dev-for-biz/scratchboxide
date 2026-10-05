// Astro GVM: Procedural Redwood Forest Ecosystem Generator

// Photorealistic Redwood National Park Ancient Cathedral Ecosystem (100% Real Procedural Discrete Clusters)
        let clusterBoundsData, clusterDescData;
        let clusterVertexData, clusterIndexTemplate;

        // Unified Botanical Terrain Elevation Model (Ensures all flora and trunks sit precisely on the forest floor)
        function getTerrainElevation(x, z) {
            const macro = 1.1 * Math.sin(x * 0.025 + 0.4) * Math.cos(z * 0.020 - 0.3);
            const hummock = 0.42 * Math.sin(x * 0.065 - z * 0.045) + 0.22 * Math.cos(x * 0.10 + z * 0.08);
            return Math.max(-0.25, macro + hummock);
        }

        function buildClusterData(count) {
            numClusters = parseInt(count);
            document.getElementById('total-clusters-val').innerText = numClusters.toLocaleString();
            document.getElementById('total-tris-val').innerText = (numClusters * TRIS_PER_CLUSTER).toLocaleString();

            clusterBoundsData = new Float32Array(numClusters * 8);
            clusterDescData = new Uint32Array(numClusters * 4);
            clusterVertexData = new Float32Array(numClusters * VERTS_PER_CLUSTER * 8);
            clusterIndexTemplate = new Uint32Array(INDICES_PER_CLUSTER);

            // Canonical 8x8 vertex quad grid topology with CCW outward winding
            let idx = 0;
            for (let r = 0; r < 7; r++) {
                for (let c = 0; c < 7; c++) {
                    const p0 = r * 8 + c;
                    const p1 = r * 8 + (c + 1);
                    const p2 = (r + 1) * 8 + c;
                    const p3 = (r + 1) * 8 + (c + 1);
                    if (idx < INDICES_PER_CLUSTER - 6) {
                        clusterIndexTemplate[idx++] = p0;
                        clusterIndexTemplate[idx++] = p2;
                        clusterIndexTemplate[idx++] = p1;
                        clusterIndexTemplate[idx++] = p1;
                        clusterIndexTemplate[idx++] = p2;
                        clusterIndexTemplate[idx++] = p3;
                    }
                }
            }
            while (idx < INDICES_PER_CLUSTER) {
                clusterIndexTemplate[idx] = clusterIndexTemplate[idx - 3];
                idx++;
            }

            let cIdx = 0;
            const tempCoords = new Float32Array(64 * 6);

            function commitCluster(genVertsFn, matId, roughness, disableConeCull = false) {
                if (cIdx >= numClusters) return;
                const bBase = cIdx * 8;
                const vBase = cIdx * VERTS_PER_CLUSTER * 8;

                let cx = 0, cy = 0, cz = 0;
                let avgNx = 0, avgNy = 0, avgNz = 0;

                const coords = genVertsFn();
                for (let v = 0; v < 64; v++) {
                    const px = coords[v * 6 + 0];
                    const py = coords[v * 6 + 1];
                    const pz = coords[v * 6 + 2];
                    const nx = coords[v * 6 + 3];
                    const ny = coords[v * 6 + 4];
                    const nz = coords[v * 6 + 5];

                    cx += px; cy += py; cz += pz;
                    avgNx += nx; avgNy += ny; avgNz += nz;

                    const off = vBase + v * 8;
                    clusterVertexData[off + 0] = px;
                    clusterVertexData[off + 1] = py;
                    clusterVertexData[off + 2] = pz;
                    clusterVertexData[off + 3] = nx;
                    clusterVertexData[off + 4] = ny;
                    clusterVertexData[off + 5] = nz;
                    clusterVertexData[off + 6] = matId;
                    clusterVertexData[off + 7] = roughness;
                }
                cx /= 64; cy /= 64; cz /= 64;

                let maxR2 = 0;
                for (let v = 0; v < 64; v++) {
                    const dx = clusterVertexData[vBase + v * 8 + 0] - cx;
                    const dy = clusterVertexData[vBase + v * 8 + 1] - cy;
                    const dz = clusterVertexData[vBase + v * 8 + 2] - cz;
                    const r2 = dx*dx + dy*dy + dz*dz;
                    if (r2 > maxR2) maxR2 = r2;
                }
                const radius = Math.sqrt(maxR2);

                let cnx = 0, cny = 1, cnz = 0, cutoff = -1.0;
                if (!disableConeCull) {
                    const nLen = Math.hypot(avgNx, avgNy, avgNz);
                    if (nLen > 1e-4) {
                        cnx = avgNx / nLen; cny = avgNy / nLen; cnz = avgNz / nLen;
                        let minCos = 1.0;
                        for (let v = 0; v < 64; v++) {
                            const nx = clusterVertexData[vBase + v * 8 + 3];
                            const ny = clusterVertexData[vBase + v * 8 + 4];
                            const nz = clusterVertexData[vBase + v * 8 + 5];
                            const dot = nx * cnx + ny * cny + nz * cnz;
                            if (dot < minCos) minCos = dot;
                        }
                        const cosAlpha = Math.max(0.0, Math.min(1.0, minCos));
                        const sinAlpha = Math.sqrt(Math.max(0.0, 1.0 - cosAlpha * cosAlpha));
                        cutoff = -sinAlpha;
                    }
                }

                clusterBoundsData[bBase + 0] = cx;
                clusterBoundsData[bBase + 1] = cy;
                clusterBoundsData[bBase + 2] = cz;
                clusterBoundsData[bBase + 3] = radius;
                clusterBoundsData[bBase + 4] = cnx;
                clusterBoundsData[bBase + 5] = cny;
                clusterBoundsData[bBase + 6] = cnz;
                clusterBoundsData[bBase + 7] = cutoff;

                clusterDescData[cIdx * 4 + 0] = cIdx * VERTS_PER_CLUSTER;
                clusterDescData[cIdx * 4 + 1] = VERTS_PER_CLUSTER;
                clusterDescData[cIdx * 4 + 2] = 0;
                clusterDescData[cIdx * 4 + 3] = INDICES_PER_CLUSTER;

                cIdx++;
            }

            // 1. Celestial Sky Hemisphere Dome
            function addSkyDome() {
                const skyRadius = 280.0;
                const numRings = 5;
                const numSlices = 18;
                for (let r = 0; r < numRings; r++) {
                    const phi0 = (r / numRings) * (Math.PI * 0.48);
                    const phi1 = ((r + 1) / numRings) * (Math.PI * 0.48);
                    for (let s = 0; s < numSlices; s++) {
                        const th0 = (s / numSlices) * Math.PI * 2;
                        const th1 = ((s + 1) / numSlices) * Math.PI * 2;
                        commitCluster(() => {
                            let p = 0;
                            for (let row = 0; row < 8; row++) {
                                const phi = phi0 + (row / 7) * (phi1 - phi0);
                                const sinP = Math.sin(phi);
                                const cosP = Math.cos(phi);
                                for (let col = 7; col >= 0; col--) {
                                    const th = th0 + (col / 7) * (th1 - th0);
                                    const px = skyRadius * cosP * Math.cos(th);
                                    const py = skyRadius * sinP;
                                    const pz = skyRadius * cosP * Math.sin(th);

                                    tempCoords[p++] = px;
                                    tempCoords[p++] = py;
                                    tempCoords[p++] = pz;
                                    tempCoords[p++] = -cosP * Math.cos(th);
                                    tempCoords[p++] = -sinP;
                                    tempCoords[p++] = -cosP * Math.sin(th);
                                }
                            }
                            return tempCoords;
                        }, 5, 0.99, true); // Mat 5: Sky (disableConeCull = true)
                    }
                }
            }

            // 2. Smooth Spline Tube for Trunks, Buttress Roots, and Nurse Logs
            function addSplineTube(p0, p1, p2, p3, rStart, rEnd, a0, a1, barkFreq, matId, rough) {
                commitCluster(() => {
                    let p = 0;
                    for (let r = 0; r < 8; r++) {
                        const t = r / 7;
                        const it = 1 - t;
                        const it2 = it * it;
                        const it3 = it2 * it;
                        const t2 = t * t;
                        const t3 = t2 * t;

                        const cx = it3 * p0[0] + 3 * it2 * t * p1[0] + 3 * it * t2 * p2[0] + t3 * p3[0];
                        const cy = it3 * p0[1] + 3 * it2 * t * p1[1] + 3 * it * t2 * p2[1] + t3 * p3[1];
                        const cz = it3 * p0[2] + 3 * it2 * t * p1[2] + 3 * it * t2 * p2[2] + t3 * p3[2];

                        const tx = 3 * it2 * (p1[0] - p0[0]) + 6 * it * t * (p2[0] - p1[0]) + 3 * t2 * (p3[0] - p2[0]);
                        const ty = 3 * it2 * (p1[1] - p0[1]) + 6 * it * t * (p2[1] - p1[1]) + 3 * t2 * (p3[1] - p2[1]);
                        const tz = 3 * it2 * (p1[2] - p0[2]) + 6 * it * t * (p2[2] - p1[2]) + 3 * t2 * (p3[2] - p2[2]);
                        const tLen = Math.hypot(tx, ty, tz) || 1;
                        const tNorm = [tx / tLen, ty / tLen, tz / tLen];

                        let up = [0, 1, 0];
                        if (Math.abs(tNorm[1]) > 0.88) up = [1, 0, 0];
                        let bx = tNorm[1] * up[2] - tNorm[2] * up[1];
                        let by = tNorm[2] * up[0] - tNorm[0] * up[2];
                        let bz = tNorm[0] * up[1] - tNorm[1] * up[0];
                        const bLen = Math.hypot(bx, by, bz) || 1;
                        bx /= bLen; by /= bLen; bz /= bLen;

                        const nx = by * tNorm[2] - bz * tNorm[1];
                        const ny = bz * tNorm[0] - bx * tNorm[2];
                        const nz = bx * tNorm[1] - by * tNorm[0];

                        const baseRad = rStart + t * (rEnd - rStart);

                        for (let c = 0; c < 8; c++) {
                            const u = c / 7;
                            const angle = a0 + u * (a1 - a0);
                            const ca = Math.cos(angle);
                            const sa = Math.sin(angle);

                            const bark = 1.0 + 0.12 * Math.cos(barkFreq * angle) + 0.05 * Math.sin(barkFreq * 2 * angle);
                            const rad = baseRad * bark;

                            const rx = (bx * ca + nx * sa);
                            const ry = (by * ca + ny * sa);
                            const rz = (bz * ca + nz * sa);

                            tempCoords[p++] = cx + rx * rad;
                            tempCoords[p++] = cy + ry * rad;
                            tempCoords[p++] = cz + rz * rad;
                            tempCoords[p++] = rx;
                            tempCoords[p++] = ry;
                            tempCoords[p++] = rz;
                        }
                    }
                    return tempCoords;
                }, matId, rough, false); // Trunks use normal cone culling
            }

            // 3. Luxurious Conifer Bough Spray (Double-sided, disableConeCull = true)
            function addConiferBoughSpray(pStart, pEnd, maxWidth, droop, matId, rough) {
                commitCluster(() => {
                    let p = 0;
                    const dirX = pEnd[0] - pStart[0];
                    const dirY = pEnd[1] - pStart[1];
                    const dirZ = pEnd[2] - pStart[2];
                    const len = Math.hypot(dirX, dirY, dirZ) || 1;
                    const dx = dirX / len, dy = dirY / len, dz = dirZ / len;

                    const lateralX = -dz;
                    const lateralZ = dx;

                    for (let r = 0; r < 8; r++) {
                        const t = r / 7;
                        const spineX = pStart[0] + t * dirX;
                        const spineY = pStart[1] + t * dirY - Math.pow(t, 1.4) * droop;
                        const spineZ = pStart[2] + t * dirZ;

                        const serration = 0.90 + 0.10 * Math.sin(t * Math.PI * 14.0);
                        const curW = maxWidth * Math.pow(Math.sin(t * Math.PI * 0.92), 0.75) * (0.35 + 0.65 * t) * serration;

                        for (let c = 0; c < 8; c++) {
                            const v = (c / 7) * 2.0 - 1.0;
                            const lateralDroop = Math.abs(v) * 0.28 * curW;

                            const px = spineX + lateralX * (v * curW * 0.5);
                            const py = spineY - lateralDroop;
                            const pz = spineZ + lateralZ * (v * curW * 0.5);

                            tempCoords[p++] = px;
                            tempCoords[p++] = py;
                            tempCoords[p++] = pz;

                            const nx = lateralX * (v * 0.4);
                            const ny = 0.88;
                            const nz = lateralZ * (v * 0.4);
                            const nLen = Math.hypot(nx, ny, nz) || 1;
                            tempCoords[p++] = nx / nLen;
                            tempCoords[p++] = ny / nLen;
                            tempCoords[p++] = nz / nLen;
                        }
                    }
                    return tempCoords;
                }, matId, rough, true); // disableConeCull = true! Foliage is visible from all angles!
            }

            // 4. Deciduous Billowy Foliage Lobe (Curved leaf cloud for Maples & Oaks)
            function addDeciduousLeafDome(cx, cy, cz, rx, ry, rz, yaw, matId, rough) {
                commitCluster(() => {
                    let p = 0;
                    for (let r = 0; r < 8; r++) {
                        const phi = (r / 7) * (Math.PI * 0.48);
                        const cosP = Math.cos(phi);
                        const sinP = Math.sin(phi);

                        for (let c = 0; c < 8; c++) {
                            const th = (c / 7) * Math.PI * 2 + yaw;
                            const cosTh = Math.cos(th);
                            const sinTh = Math.sin(th);

                            const puff = 1.0 + 0.18 * Math.sin(th * 3.0) * Math.cos(phi * 2.5) + 0.08 * Math.cos(th * 6.0);

                            const lx = rx * cosP * cosTh * puff;
                            const ly = ry * sinP * puff;
                            const lz = rz * cosP * sinTh * puff;

                            tempCoords[p++] = cx + lx;
                            tempCoords[p++] = cy + ly;
                            tempCoords[p++] = cz + lz;

                            tempCoords[p++] = cosP * cosTh;
                            tempCoords[p++] = sinP;
                            tempCoords[p++] = cosP * sinTh;
                        }
                    }
                    return tempCoords;
                }, matId, rough, true); // disableConeCull = true
            }

            // 5. Giant Western Sword Fern Rosettes (Polystichum munitum)
            // True Botanical Sword Fern Rosettes (Polystichum munitum - 3 Botanical Age Tiers with graceful parabolic droop)
            function addFernRosette(cx, cy, cz, numFronds, maxRadius, maxHeight, matId, rough) {
                for (let f = 0; f < numFronds; f++) {
                    // 3 tiered botanical whorls:
                    // Whorl 0: Senescent outer fronds (heavy droop touching duff)
                    // Whorl 1: Mature mid-crown fronds (graceful parabolic arch)
                    // Whorl 2: Young inner croziers/erect fronds (upright crown center)
                    const tier = f % 3;
                    const fAngle = (f / numFronds) * Math.PI * 2 + (tier * 0.38) + (f * 0.14);
                    const ca = Math.cos(fAngle), sa = Math.sin(fAngle);

                    let fLen = maxRadius;
                    let fH = maxHeight;
                    let droopExp = 2.4;
                    let frondWidth = 0.28;

                    if (tier === 0) {
                        fLen = maxRadius * 1.15;
                        fH = maxHeight * 0.55;
                        droopExp = 1.8;
                        frondWidth = 0.30;
                    } else if (tier === 1) {
                        fLen = maxRadius * 0.95;
                        fH = maxHeight * 0.95;
                        droopExp = 2.5;
                        frondWidth = 0.27;
                    } else {
                        fLen = maxRadius * 0.75;
                        fH = maxHeight * 1.35;
                        droopExp = 3.2;
                        frondWidth = 0.22;
                    }

                    commitCluster(() => {
                        let p = 0;
                        for (let r = 0; r < 8; r++) {
                            const t = r / 7;
                            const rad = fLen * Math.pow(t, 0.88);
                            // Botanical parabolic droop
                            const archY = cy + fH * Math.sin(t * Math.PI * 0.65) - Math.pow(t, droopExp) * (fH * 0.68);

                            const fx = cx + ca * rad;
                            const fz = cz + sa * rad;

                            // Authentic lanceolate pinnae contour: narrow base, wide at 38%, slender tip
                            const taper = Math.sin(t * Math.PI * 0.85) * (1.0 - t * 0.40);
                            const curW = frondWidth * taper;

                            for (let c = 0; c < 8; c++) {
                                const v = (c / 7) - 0.5;
                                // Dihedral V-angle: pinnae leaflets angle upward from central rachis
                                const vFold = Math.abs(v) * 0.12 * (1.0 - t * 0.4);

                                const lx = fx - sa * (v * curW);
                                const lz = fz + ca * (v * curW);
                                const ly = archY + vFold;

                                tempCoords[p++] = lx;
                                tempCoords[p++] = ly;
                                tempCoords[p++] = lz;

                                const nx = -sa * Math.sign(v) * 0.36;
                                const ny = 0.93;
                                const nz = ca * Math.sign(v) * 0.36;
                                const nLen = Math.hypot(nx, ny, nz) || 1;
                                tempCoords[p++] = nx / nLen;
                                tempCoords[p++] = ny / nLen;
                                tempCoords[p++] = nz / nLen;
                            }
                        }
                        return tempCoords;
                    }, matId, rough, true);
                }
            }

            // 6. Weathered Granite Boulders with Lichen & Rocky Facets
            function addGraniteBoulder(bx, by, bz, rx, ry, rz, yaw, matId, rough) {
                for (let s = 0; s < 4; s++) {
                    const a0 = (s / 4) * Math.PI * 2;
                    const a1 = ((s + 1) / 4) * Math.PI * 2;
                    commitCluster(() => {
                        let p = 0;
                        for (let r = 0; r < 8; r++) {
                            const phi = (r / 7) * Math.PI * 0.5;
                            const cosPhi = Math.cos(phi);
                            const sinPhi = Math.sin(phi);

                            for (let c = 0; c < 8; c++) {
                                const theta = a0 + (c / 7) * (a1 - a0) + yaw;
                                const cosTh = Math.cos(theta);
                                const sinTh = Math.sin(theta);

                                const rockNoise = 1.0 + 0.14 * Math.sin(theta * 3.0) * Math.cos(phi * 2.5) + 0.08 * Math.cos(theta * 6.0);

                                const lx = rx * cosPhi * cosTh * rockNoise;
                                const ly = ry * sinPhi * rockNoise;
                                const lz = rz * cosPhi * sinTh * rockNoise;

                                tempCoords[p++] = bx + lx;
                                tempCoords[p++] = by + ly;
                                tempCoords[p++] = bz + lz;
                                tempCoords[p++] = cosPhi * cosTh;
                                tempCoords[p++] = sinPhi;
                                tempCoords[p++] = cosPhi * sinTh;
                            }
                        }
                        return tempCoords;
                    }, matId, rough, false);
                }
            }

            // === ASSEMBLE FULL ECOSYSTEM ===

            // 1. Celestial Sky Dome (90 clusters)
            addSkyDome();

                        // 2. Four Colossal Monarch Redwoods (Towering 65m Ancients with Dense Overlapping Canopies)
            const giantTrees = [
                // Monarch 1: Patriarch in the clearing (Camera focus)
                { x: -12, z: -12, height: 68, baseR: 5.2, topR: 1.1, leanX: 1.6, leanZ: 0.8, numWhorls: 12 },
                // Monarch 2: Right foreground titan
                { x: +26, z: +14, height: 62, baseR: 4.8, topR: 1.0, leanX: -1.4, leanZ: 1.6, numWhorls: 11 },
                // Monarch 3: Towering deep monarch
                { x: +8, z: -40, height: 72, baseR: 5.4, topR: 1.2, leanX: 0.8, leanZ: -1.8, numWhorls: 13 },
                // Monarch 4: Far left guardian
                { x: -40, z: +16, height: 58, baseR: 4.4, topR: 1.0, leanX: 1.4, leanZ: 0.6, numWhorls: 10 }
            ];

            // Continuous Sculpted Monarch Fluted Monoliths (Seamless buttress roots & fluted columns)
            function addSculptedMonarchTrunk(gt, hasGoosepen) {
                const groundBaseY = getTerrainElevation(gt.x, gt.z);
                const numHeightSegs = 8;
                for (let s = 0; s < numHeightSegs; s++) {
                    const t0 = s / numHeightSegs;
                    const t1 = (s + 1) / numHeightSegs;
                    const y0 = groundBaseY + t0 * gt.height;
                    const y1 = groundBaseY + t1 * gt.height;

                    const cx0 = gt.x + gt.leanX * Math.pow(t0, 1.2);
                    const cz0 = gt.z + gt.leanZ * Math.pow(t0, 1.2);
                    const cx1 = gt.x + gt.leanX * Math.pow(t1, 1.2);
                    const cz1 = gt.z + gt.leanZ * Math.pow(t1, 1.2);

                    const baseR0 = gt.baseR * (1.0 - t0 * 0.76);
                    const baseR1 = gt.baseR * (1.0 - t1 * 0.76);

                    // 6 radial cluster wedges per height segment
                    for (let a = 0; a < 6; a++) {
                        const a0 = (a / 6) * Math.PI * 2;
                        const a1 = ((a + 1) / 6) * Math.PI * 2;

                        commitCluster(() => {
                            let p = 0;
                            for (let r = 0; r < 8; r++) {
                                const tr = r / 7;
                                const y = y0 + tr * (y1 - y0);
                                const hAboveGround = y - groundBaseY;
                                const cx = cx0 + tr * (cx1 - cx0);
                                const cz = cz0 + tr * (cz1 - cz0);
                                const bRad = baseR0 + tr * (baseR1 - baseR0);

                                // Massive basal buttress flare that seamlessly flows into ground
                                const flare = 1.0 + 1.55 * Math.exp(-hAboveGround / 4.6);

                                for (let c = 0; c < 8; c++) {
                                    const tc = c / 7;
                                    const angle = a0 + tc * (a1 - a0);

                                    // 5 primary buttress flutes with organic twist
                                    const flute5 = 0.44 * Math.cos(5.0 * angle + hAboveGround * 0.04) * Math.exp(-hAboveGround / 8.5);
                                    // Secondary bark canyons
                                    const flute10 = 0.12 * Math.cos(10.0 * angle);
                                    // Organic swelling burls
                                    const burl = 0.10 * Math.sin(3.0 * angle + hAboveGround * 0.25) * Math.cos(2.0 * angle + hAboveGround * 0.12);

                                    // Goosepen fire hollow (Ancient fire cavity facing viewer on Monarch 1)
                                    let hollow = 0.0;
                                    if (hasGoosepen && hAboveGround < 5.8) {
                                        const dAng = angle - 1.22;
                                        const angGate = Math.exp(-(dAng * dAng) / 0.28);
                                        const yGate = Math.exp(-hAboveGround / 2.8);
                                        hollow = -0.72 * angGate * yGate;
                                    }

                                    const rad = bRad * flare * (1.0 + flute5 + flute10 + burl + hollow);

                                    const ca = Math.cos(angle);
                                    const sa = Math.sin(angle);

                                    const px = cx + ca * rad;
                                    const py = y;
                                    const pz = cz + sa * rad;

                                    tempCoords[p++] = px;
                                    tempCoords[p++] = py;
                                    tempCoords[p++] = pz;

                                    // Cylindrical normal with flute perturbation
                                    const nx = ca + (flute5 + hollow) * sa * 0.5;
                                    const ny = 0.05;
                                    const nz = sa - (flute5 + hollow) * ca * 0.5;
                                    const nLen = Math.hypot(nx, ny, nz) || 1;
                                    tempCoords[p++] = nx / nLen;
                                    tempCoords[p++] = ny / nLen;
                                    tempCoords[p++] = nz / nLen;
                                }
                            }
                            return tempCoords;
                        }, 0, 0.88, false);
                    }
                }
            }

            for (let t = 0; t < giantTrees.length; t++) {
                const gt = giantTrees[t];
                // Build continuous fluted monarch (Tree 0 has authentic goosepen fire hollow)
                addSculptedMonarchTrunk(gt, t === 0);

                // Cathedral Canopy Limbs (Old growth crowns start above 28m)
                for (let w = 0; w < gt.numWhorls; w++) {
                    // Whorls start at 42% height (~28.5m) and rise to 96% height (~65m)
                    const wT = 0.42 + 0.54 * (w / (gt.numWhorls - 1));
                    const wY = gt.height * wT;
                    const trunkPt = [gt.x + gt.leanX * wT, wY, gt.z + gt.leanZ * wT];
                    const numBoughs = 4;
                    const boughLen = (1.0 - (wT - 0.42) * 0.75) * 17.5;

                    for (let b = 0; b < numBoughs; b++) {
                        // Natural organic angular distribution
                        const bAngle = (b / numBoughs) * Math.PI * 2 + w * 1.55 + Math.sin(w + b) * 0.25;
                        const limbDroop = 3.8 + (1.0 - wT) * 4.2;
                        const bEnd = [
                            trunkPt[0] + Math.cos(bAngle) * boughLen,
                            trunkPt[1] - limbDroop,
                            trunkPt[2] + Math.sin(bAngle) * boughLen
                        ];

                        // Heavy arching limb wood
                        const pMidA = [trunkPt[0] * 0.67 + bEnd[0] * 0.33, trunkPt[1] + 1.2, trunkPt[2] * 0.67 + bEnd[2] * 0.33];
                        const pMidB = [trunkPt[0] * 0.33 + bEnd[0] * 0.67, bEnd[1] + 1.5, trunkPt[2] * 0.33 + bEnd[2] * 0.67];
                        for (let a = 0; a < 2; a++) {
                            const a0 = (a / 2) * Math.PI * 2;
                            const a1 = ((a + 1) / 2) * Math.PI * 2;
                            addSplineTube(trunkPt, pMidA, pMidB, bEnd, 0.75 * (1.0 - wT * 0.45), 0.20, a0, a1, 4, 0, 0.70);
                        }

                        // Cascading sub-boughs along the limb
                        const bWidth = 6.8 * (1.0 - (wT - 0.42) * 0.65);
                        // Terminal fan
                        addConiferBoughSpray(pMidB, bEnd, bWidth, 2.8, 1, 0.42);

                        // Mid-limb lateral cascades (left & right)
                        const latAngleL = bAngle + 0.45;
                        const latAngleR = bAngle - 0.45;
                        const subLen = boughLen * 0.58;
                        const subEndL = [pMidA[0] + Math.cos(latAngleL) * subLen, pMidA[1] - 2.4, pMidA[2] + Math.sin(latAngleL) * subLen];
                        const subEndR = [pMidA[0] + Math.cos(latAngleR) * subLen, pMidA[1] - 2.4, pMidA[2] + Math.sin(latAngleR) * subLen];
                        addConiferBoughSpray(pMidA, subEndL, bWidth * 0.85, 2.4, 1, 0.42);
                        addConiferBoughSpray(pMidA, subEndR, bWidth * 0.85, 2.4, 1, 0.42);
                    }
                }
            }

            // 3. Fourteen Secondary Mature Conifers & Pines (Positioned outside the central clearing)
            const secondaryTrees = [
                { x: +20, z: -22, h: 44, r: 2.5 },
                { x: -32, z: -26, h: 40, r: 2.2 },
                { x: +38, z: -14, h: 46, r: 2.6 },
                { x: -24, z: +28, h: 38, r: 2.1 },
                { x: +34, z: +34, h: 42, r: 2.3 },
                { x: -18, z: +32, h: 36, r: 2.0 },
                { x: -38, z: +36, h: 41, r: 2.2 },
                { x: +22, z: -42, h: 45, r: 2.5 },
                { x: -48, z: -14, h: 43, r: 2.4 },
                { x: +46, z: +12, h: 39, r: 2.1 },
                { x: -16, z: -48, h: 47, r: 2.7 },
                { x: +28, z: -30, h: 41, r: 2.3 },
                { x: -34, z: +4, h: 37, r: 2.0 },
                { x: +42, z: -34, h: 44, r: 2.4 }
            ];

            for (let i = 0; i < secondaryTrees.length; i++) {
                const st = secondaryTrees[i];
                const p0 = [st.x, 0, st.z];
                const p1 = [st.x + Math.sin(i * 1.5) * 1.4, st.h * 0.5, st.z + Math.cos(i * 1.5) * 1.4];
                const p2 = [st.x + Math.sin(i * 1.5) * 2.2, st.h, st.z + Math.cos(i * 1.5) * 2.2];
                const pMidA = [p0[0]*0.67 + p2[0]*0.33, st.h * 0.33, p0[2]*0.67 + p2[2]*0.33];
                const pMidB = [p0[0]*0.33 + p2[0]*0.67, st.h * 0.67, p0[2]*0.33 + p2[2]*0.67];

                for (let a = 0; a < 4; a++) {
                    const a0 = (a / 4) * Math.PI * 2;
                    const a1 = ((a + 1) / 4) * Math.PI * 2;
                    addSplineTube(p0, pMidA, pMidB, p2, st.r, st.r * 0.28, a0, a1, 6, 0, 0.74);
                }
                // Conifer foliage boughs
                for (let w = 0; w < 7; w++) {
                    const wY = st.h * (0.32 + 0.64 * (w / 6));
                    const wPt = [st.x, wY, st.z];
                    for (let b = 0; b < 3; b++) {
                        const bAngle = (b / 3) * Math.PI * 2 + w * 1.25;
                        const bEnd = [wPt[0] + Math.cos(bAngle) * (11.0 * (1 - w * 0.12)), wY - 2.8, wPt[2] + Math.sin(bAngle) * (11.0 * (1 - w * 0.12))];
                        addConiferBoughSpray(wPt, bEnd, 7.2 * (1 - w * 0.10), 2.2, 1, 0.32);
                    }
                }
            }

            // 4. Eight Gnarled Pacific Maples (Lush broadleaf canopies)
            const maples = [
                { x: -16, z: +12, h: 22, r: 1.6, yaw: 0.3 },
                { x: +18, z: -10, h: 24, r: 1.8, yaw: 1.1 },
                { x: -26, z: -18, h: 20, r: 1.5, yaw: 2.2 },
                { x: +14, z: +28, h: 25, r: 1.7, yaw: 0.8 },
                { x: -34, z: +22, h: 23, r: 1.6, yaw: 2.9 },
                { x: +30, z: -20, h: 26, r: 1.9, yaw: 1.7 },
                { x: -12, z: -26, h: 21, r: 1.5, yaw: 0.5 },
                { x: +24, z: +22, h: 24, r: 1.7, yaw: 2.4 }
            ];

            for (let m = 0; m < maples.length; m++) {
                const mp = maples[m];
                const p0 = [mp.x, 0, mp.z];
                const p1 = [mp.x + Math.sin(mp.yaw) * 3.2, mp.h * 0.45, mp.z + Math.cos(mp.yaw) * 3.2];
                const p2 = [mp.x + Math.sin(mp.yaw) * 4.8, mp.h * 0.85, mp.z + Math.cos(mp.yaw) * 4.8];
                const pMidA = [p0[0]*0.67 + p1[0]*0.33, mp.h * 0.25, p0[2]*0.67 + p1[2]*0.33];
                const pMidB = [p1[0]*0.33 + p2[0]*0.67, mp.h * 0.65, p1[2]*0.33 + p2[2]*0.67];

                for (let a = 0; a < 3; a++) {
                    const a0 = (a / 3) * Math.PI * 2;
                    const a1 = ((a + 1) / 3) * Math.PI * 2;
                    addSplineTube(p0, pMidA, pMidB, p2, mp.r, mp.r * 0.35, a0, a1, 5, 0, 0.72);
                }

                // Billowy deciduous leaf domes
                const crownCenter = [p2[0], mp.h, p2[2]];
                addDeciduousLeafDome(crownCenter[0], crownCenter[1], crownCenter[2], 7.5, 5.5, 7.5, mp.yaw, 6, 0.28);
                for (let pf = 0; pf < 3; pf++) {
                    const pfAngle = (pf / 3) * Math.PI * 2 + mp.yaw;
                    const puffX = crownCenter[0] + Math.cos(pfAngle) * 4.2;
                    const puffY = crownCenter[1] - 1.8;
                    const puffZ = crownCenter[2] + Math.sin(pfAngle) * 4.2;
                    addDeciduousLeafDome(puffX, puffY, puffZ, 4.8, 3.8, 4.8, pfAngle, 6, 0.28);
                }
            }

            // 5. Twenty Mid-Story Pacific Rhododendrons (Lush understory shrubs)
            const rhodos = [
                { x: -10, z: -6, r: 2.8, h: 3.5 },
                { x: -14, z: +6, r: 3.2, h: 4.0 },
                { x: +8, z: +6, r: 3.0, h: 3.8 },
                { x: +14, z: +12, r: 3.4, h: 4.2 },
                { x: -6, z: +12, r: 2.9, h: 3.6 },
                { x: -20, z: -10, r: 3.3, h: 4.1 },
                { x: +6, z: -10, r: 2.7, h: 3.4 },
                { x: +16, z: -10, r: 3.1, h: 3.9 },
                { x: -4, z: +8, r: 2.6, h: 3.2 },
                { x: +10, z: +16, r: 3.2, h: 4.0 },
                { x: -18, z: +16, r: 3.0, h: 3.7 },
                { x: +20, z: +8, r: 3.3, h: 4.1 },
                { x: -12, z: -14, r: 2.8, h: 3.5 },
                { x: +6, z: -16, r: 3.1, h: 3.9 },
                { x: -24, z: +12, r: 3.0, h: 3.8 },
                { x: +18, z: -14, r: 3.2, h: 4.0 },
                { x: -10, z: +22, r: 2.9, h: 3.6 },
                { x: +14, z: -20, r: 3.4, h: 4.2 },
                { x: -4, z: -22, r: 2.8, h: 3.5 },
                { x: +24, z: +20, r: 3.1, h: 3.9 }
            ];

            for (let rd = 0; rd < rhodos.length; rd++) {
                const ro = rhodos[rd];
                addDeciduousLeafDome(ro.x, ro.h * 0.6, ro.z, ro.r, ro.h * 0.55, ro.r, rd * 0.8, 7, 0.24);
            }

                        // 10. Ancient Shelf Fungi (Bracket fungus Ganoderma applanatum on nurse logs)
            function addShelfFungus(cx, cy, cz, radius, normalX, normalZ, yaw) {
                commitCluster(() => {
                    let p = 0;
                    for (let r = 0; r < 8; r++) {
                        const tR = (r / 7) * radius;
                        for (let c = 0; c < 8; c++) {
                            const th = (c / 7) * Math.PI * 0.85 - (Math.PI * 0.425) + yaw;
                            const px = cx + Math.cos(th) * tR;
                            const pz = cz + Math.sin(th) * tR;
                            const py = cy + 0.12 * Math.sin((r / 7) * Math.PI * 2.0) - Math.pow(r / 7, 2.0) * 0.08;

                            tempCoords[p++] = px;
                            tempCoords[p++] = py;
                            tempCoords[p++] = pz;
                            tempCoords[p++] = 0.0;
                            tempCoords[p++] = 0.95;
                            tempCoords[p++] = 0.0;
                        }
                    }
                    return tempCoords;
                }, 8, 0.65, true); // Mat 8: Shelf Fungus
            }

            // 11. Fallen Redwood Branches & Bark Curls (Fractured wooden snags - tapered solid ends)
            function addGroundDebrisBranch(p0, p1, r) {
                const mid = [
                    (p0[0] + p1[0]) * 0.5 + (Math.sin(p0[0]) * 0.2),
                    (p0[1] + p1[1]) * 0.5 + 0.08,
                    (p0[2] + p1[2]) * 0.5 + (Math.cos(p0[2]) * 0.2)
                ];
                // Taper from root collar down to shattered fractured tip
                for (let a = 0; a < 3; a++) {
                    const a0 = (a / 3) * Math.PI * 2;
                    const a1 = ((a + 1) / 3) * Math.PI * 2;
                    addSplineTube(p0, mid, mid, p1, r * 1.15, 0.04, a0, a1, 5, 0, 0.88);
                }
            }

            // 6. Ancient Moss-Draped Nurse Logs
            const nurseLogs = [
                { p0: [-22, 0, -8], p1: [-12, 0, -5], p2: [-2, 0, -2], p3: [+8, 0, +1], r: 2.2 },
                { p0: [+14, 0, -26], p1: [+20, 0, -23], p2: [+26, 0, -20], p3: [+32, 0, -17], r: 1.8 },
                { p0: [-20, 0, +24], p1: [-12, 0, +27], p2: [-4, 0, +29], p3: [+4, 0, +31], r: 2.0 },
                // Magnificent Foreground Shattered Nurse Log across the viewer's path
                { p0: [-10, 0, +8], p1: [-3, 0, +11], p2: [+4, 0, +13], p3: [+11, 0, +15], r: 1.7 }
            ];
            for (let l = 0; l < nurseLogs.length; l++) {
                const nl = nurseLogs[l];
                // Anchor precisely to terrain elevation with natural sag into duff
                const p0 = [nl.p0[0], getTerrainElevation(nl.p0[0], nl.p0[2]) + nl.r * 0.65, nl.p0[2]];
                const p1 = [nl.p1[0], getTerrainElevation(nl.p1[0], nl.p1[2]) + nl.r * 0.75, nl.p1[2]];
                const p2 = [nl.p2[0], getTerrainElevation(nl.p2[0], nl.p2[2]) + nl.r * 0.72, nl.p2[2]];
                const p3 = [nl.p3[0], getTerrainElevation(nl.p3[0], nl.p3[2]) + nl.r * 0.40, nl.p3[2]];

                // 6 radial cluster wedges for rich, non-faceted cylindrical log
                for (let a = 0; a < 6; a++) {
                    const a0 = (a / 6) * Math.PI * 2;
                    const a1 = ((a + 1) / 6) * Math.PI * 2;
                    // Upper half has Mat 0 (weathered bark/moss), lower half rests in duff
                    addSplineTube(p0, p1, p2, p3, nl.r, nl.r * 0.45, a0, a1, 6, 0, 0.82);
                }
            }

                        // 6b. Shelf Fungi colonies sprouting from decaying nurse logs
            for (let l = 0; l < nurseLogs.length; l++) {
                const nl = nurseLogs[l];
                for (let k = 0; k < 6; k++) {
                    const t = 0.18 + 0.64 * (k / 5);
                    const fx = nl.p0[0] * (1 - t) + nl.p3[0] * t + (Math.sin(k * 2.0) * 0.4);
                    const fz = nl.p0[2] * (1 - t) + nl.p3[2] * t + (Math.cos(k * 2.0) * 0.4);
                    const fy = getTerrainElevation(fx, fz) + nl.r * 0.85 + 0.25;
                    addShelfFungus(fx, fy, fz, 1.2 + Math.sin(k) * 0.4, 0, 1, k * 1.1);
                }
            }

            // 6c. Fallen Branches and Wood Debris along the trail
            const debrisBranches = [
                { p0: [-8, 0, 4], p1: [-3, 0, 9], r: 0.35 },
                { p0: [6, 0, 2], p1: [12, 0, 6], r: 0.28 },
                { p0: [-14, 0, 14], p1: [-8, 0, 18], r: 0.32 },
                { p0: [2, 0, 18], p1: [8, 0, 22], r: 0.26 },
                { p0: [-16, 0, -6], p1: [-10, 0, -2], r: 0.38 },
                { p0: [14, 0, -8], p1: [20, 0, -4], r: 0.30 },
                { p0: [-4, 0, 12], p1: [1, 0, 16], r: 0.24 },
                { p0: [10, 0, 14], p1: [15, 0, 19], r: 0.29 }
            ];
            for (let db = 0; db < debrisBranches.length; db++) {
                const d = debrisBranches[db];
                const ptA = [d.p0[0], getTerrainElevation(d.p0[0], d.p0[2]) + d.r * 0.9, d.p0[2]];
                const ptB = [d.p1[0], getTerrainElevation(d.p1[0], d.p1[2]) + d.r * 0.9, d.p1[2]];
                addGroundDebrisBranch(ptA, ptB, d.r);
            }

            // 7. Weathered Granite Boulders with Lichen & Rocky Facets
            const boulders = [
                { x: -14, z: -8, rx: 3.6, ry: 2.2, rz: 3.2, yaw: 0.5 },
                { x: -6, z: +6, rx: 2.8, ry: 1.8, rz: 2.6, yaw: 1.2 },
                { x: +12, z: +10, rx: 4.4, ry: 2.6, rz: 3.9, yaw: 2.1 },
                { x: +26, z: +16, rx: 3.4, ry: 2.1, rz: 3.0, yaw: 0.8 },
                { x: -28, z: +14, rx: 4.6, ry: 2.8, rz: 4.2, yaw: 3.0 },
                { x: +8, z: -20, rx: 3.2, ry: 1.9, rz: 2.8, yaw: 1.7 },
                { x: -20, z: -24, rx: 4.0, ry: 2.5, rz: 3.5, yaw: 2.6 },
                { x: +30, z: -16, rx: 4.2, ry: 2.6, rz: 3.8, yaw: 0.3 },
                { x: -6, z: +24, rx: 2.8, ry: 1.7, rz: 2.5, yaw: 1.9 },
                { x: +18, z: +32, rx: 3.8, ry: 2.4, rz: 3.4, yaw: 2.8 },
                { x: -32, z: -14, rx: 3.5, ry: 2.2, rz: 3.1, yaw: 1.4 },
                { x: +32, z: +6, rx: 3.0, ry: 1.8, rz: 2.7, yaw: 0.9 },
                { x: -14, z: -32, rx: 4.5, ry: 2.8, rz: 4.0, yaw: 2.2 },
                { x: +18, z: -28, rx: 3.4, ry: 2.1, rz: 3.2, yaw: 1.1 },
                { x: -22, z: +34, rx: 3.8, ry: 2.4, rz: 3.4, yaw: 0.6 },
                { x: +40, z: -8, rx: 3.2, ry: 2.0, rz: 2.9, yaw: 2.4 },
                { x: -4, z: -10, rx: 2.5, ry: 1.5, rz: 2.2, yaw: 0.7 },
                { x: +12, z: +20, rx: 3.1, ry: 1.9, rz: 2.8, yaw: 1.8 }
            ];
            for (let b = 0; b < boulders.length; b++) {
                const bd = boulders[b];
                addGraniteBoulder(bd.x, 0.4, bd.z, bd.rx, bd.ry, bd.rz, bd.yaw, 3, 0.84);
            }

            // 8. Woodland Sword Fern Rosettes (45 colonies nestled around clearing, roots, and logs)
            const fernLocations = [
                // Magnificent Foreground Rosettes nestled along the nurse log and camera trail
                { x: -5, z: +9, n: 20, r: 1.8, h: 1.35 },
                { x: -1, z: +10, n: 22, r: 1.9, h: 1.40 },
                { x: +3, z: +12, n: 20, r: 1.8, h: 1.35 },
                { x: +7, z: +14, n: 18, r: 1.7, h: 1.25 },
                { x: -2, z: +6, n: 24, r: 2.1, h: 1.50 }, // Immediate foreground feature clump!
                { x: +4, z: +8, n: 22, r: 1.9, h: 1.40 },
                // Dense bouquets around Monarch 1 buttress roots & swale
                { x: -14, z: -10, n: 14, r: 1.7, h: 1.2 },
                { x: -10, z: -14, n: 12, r: 1.5, h: 1.1 },
                { x: -15, z: -15, n: 16, r: 1.8, h: 1.3 },
                { x: -8,  z: -10, n: 14, r: 1.6, h: 1.2 },
                { x: -11, z: -8,  n: 15, r: 1.7, h: 1.3 },
                // Foreground understory fronds (immediate camera viewing plane)
                { x: -3.5, z: +2.0, n: 16, r: 1.8, h: 1.3 },
                { x: -1.0, z: +3.0, n: 14, r: 1.6, h: 1.2 },
                { x: +2.5, z: +2.5, n: 15, r: 1.7, h: 1.25 },
                { x: -5.0, z: +4.0, n: 14, r: 1.6, h: 1.15 },
                { x: +0.5, z: +4.5, n: 16, r: 1.8, h: 1.3 },
                { x: -2.0, z: +1.0, n: 12, r: 1.4, h: 1.05 },
                { x: +4.0, z: +3.5, n: 14, r: 1.6, h: 1.2 },
                // Along trail and nurse logs
                { x: -12, z: +6, n: 14, r: 1.7, h: 1.25 },
                { x: -6, z: +8, n: 12, r: 1.5, h: 1.15 },
                { x: +6, z: +6, n: 14, r: 1.6, h: 1.2 },
                { x: +10, z: +10, n: 15, r: 1.7, h: 1.3 },
                { x: -18, z: +12, n: 14, r: 1.6, h: 1.2 },
                { x: +14, z: -6, n: 12, r: 1.5, h: 1.1 },
                { x: -20, z: -8, n: 14, r: 1.6, h: 1.2 },
                { x: +20, z: +14, n: 15, r: 1.7, h: 1.25 },
                { x: -8, z: -4, n: 12, r: 1.4, h: 1.1 },
                { x: +4, z: -8, n: 14, r: 1.6, h: 1.2 },
                { x: -16, z: +18, n: 12, r: 1.5, h: 1.15 },
                { x: +16, z: +20, n: 14, r: 1.6, h: 1.25 },
                { x: -4, z: +14, n: 15, r: 1.7, h: 1.3 },
                { x: +8, z: +16, n: 12, r: 1.5, h: 1.1 },
                { x: -22, z: +4, n: 14, r: 1.6, h: 1.2 },
                { x: +22, z: -2, n: 12, r: 1.5, h: 1.15 },
                { x: -10, z: +22, n: 14, r: 1.6, h: 1.2 },
                { x: +12, z: +24, n: 12, r: 1.4, h: 1.05 }
            ];
            for (let f = 0; f < fernLocations.length; f++) {
                const fl = fernLocations[f];
                const fy = getTerrainElevation(fl.x, fl.z) + 0.08;
                addFernRosette(fl.x, fy, fl.z, fl.n, fl.r, fl.h, 2, 0.24);
            }

                                    // 12. Hanging Old Man's Beard Lichen (Usnea longissima - Cascading lace curtains from boughs)
            function addHangingLichenDrape(pTop, length, width, drapeSeed) {
                commitCluster(() => {
                    let p = 0;
                    for (let r = 0; r < 8; r++) {
                        const tr = r / 7;
                        // Catenary sag and taper
                        const sagY = pTop[1] - tr * length;
                        const taperWidth = width * (1.0 - tr * 0.4);
                        for (let c = 0; c < 8; c++) {
                            const tc = (c / 7) - 0.5;
                            const px = pTop[0] + tc * taperWidth + Math.sin(tr * 4.0 + drapeSeed) * 0.25;
                            const pz = pTop[2] + Math.cos(tr * 3.0 + drapeSeed) * 0.25;
                            const py = sagY;

                            tempCoords[p++] = px;
                            tempCoords[p++] = py;
                            tempCoords[p++] = pz;
                            tempCoords[p++] = 0.0;
                            tempCoords[p++] = 0.0;
                            tempCoords[p++] = 1.0;
                        }
                    }
                    return tempCoords;
                }, 10, 0.42, true); // Mat 10: Usnea Lichen
            }

            // 13. Woodland Bonnet Mushrooms (Mycena - Translucent caps on decaying wood & mossy roots)
            function addMushroomColony(cx, cy, cz, colonyRadius, clusterSeed) {
                commitCluster(() => {
                    let p = 0;
                    for (let r = 0; r < 8; r++) {
                        const tr = (r / 7) * colonyRadius;
                        for (let c = 0; c < 8; c++) {
                            const th = (c / 7) * Math.PI * 2.0 + clusterSeed;
                            const stemH = 0.35 + Math.sin(r * 3.0 + c * 2.0) * 0.15;
                            const px = cx + Math.cos(th) * tr;
                            const pz = cz + Math.sin(th) * tr;
                            // Umbrella cap height
                            const py = cy + stemH * (1.0 - (r % 2) * 0.7);

                            tempCoords[p++] = px;
                            tempCoords[p++] = py;
                            tempCoords[p++] = pz;
                            tempCoords[p++] = 0.0;
                            tempCoords[p++] = 1.0;
                            tempCoords[p++] = 0.0;
                        }
                    }
                    return tempCoords;
                }, 11, 0.28, true); // Mat 11: Mycena Mushrooms
            }

            // 8b. Redwood Sorrel (Oxalis oregana) Carpets & Forest Clover
            function addSorrelCarpet(cx, cy, cz, radius, patchSeed) {
                commitCluster(() => {
                    let p = 0;
                    for (let r = 0; r < 8; r++) {
                        const tr = (r / 7) * radius;
                        for (let c = 0; c < 8; c++) {
                            const th = (c / 7) * Math.PI * 2.0 + patchSeed;
                            const px = cx + Math.cos(th) * tr + Math.sin(r * 2.0) * 0.15;
                            const pz = cz + Math.sin(th) * tr + Math.cos(c * 2.0) * 0.15;
                            const py = cy + 0.14 + Math.sin(px * 1.8 + pz * 1.8) * 0.06;

                            tempCoords[p++] = px;
                            tempCoords[p++] = py;
                            tempCoords[p++] = pz;
                            tempCoords[p++] = 0.0;
                            tempCoords[p++] = 1.0;
                            tempCoords[p++] = 0.0;
                        }
                    }
                    return tempCoords;
                }, 9, 0.35, true); // Mat 9: Redwood Sorrel
            }
            // 8c. Redwood Sorrel patch distribution around monarchs & glades
            const sorrelLocations = [
                { x: -10, z: -10, r: 4.5 },
                { x: +24, z: +12, r: 5.0 },
                { x: -4, z: +4, r: 3.8 },
                { x: +8, z: -2, r: 4.2 },
                { x: -14, z: +10, r: 4.0 },
                { x: +12, z: +18, r: 4.6 },
                { x: -2, z: +20, r: 3.5 },
                { x: +18, z: -8, r: 4.4 },
                { x: -18, z: -4, r: 4.2 },
                { x: +6, z: +8, r: 3.9 }
            ];
            for (let s = 0; s < sorrelLocations.length; s++) {
                const sl = sorrelLocations[s];
                for (let k = 0; k < 6; k++) {
                    const ox = sl.x + (Math.sin(k * 1.5) * sl.r * 0.7);
                    const oz = sl.z + (Math.cos(k * 1.5) * sl.r * 0.7);
                    const oy = getTerrainElevation(ox, oz) + 0.05;
                    addSorrelCarpet(ox, oy, oz, 2.2, k * 1.2);
                }
            }

            // 8d. Colonies of translucent Woodland Mushrooms on nurse logs & damp soil
            const mushroomColonies = [
                { x: -5, y: 0.8, z: 2, r: 0.9 },
                { x: 18, y: 0.9, z: -22, r: 0.8 },
                { x: -8, y: 0.3, z: 7, r: 1.1 },
                { x: 4, y: 0.25, z: 12, r: 0.7 },
                { x: -12, y: 0.35, z: -4, r: 1.0 },
                { x: 14, y: 0.3, z: 16, r: 0.85 }
            ];
            for (let m = 0; m < mushroomColonies.length; m++) {
                const mc = mushroomColonies[m];
                addMushroomColony(mc.x, mc.y, mc.z, mc.r, m * 1.7);
            }

            // 9. Undulating Forest Floor (Damp Loamy Peat, Emerald Moss, Pine Needles, and Puddles)
            const remaining = numClusters - cIdx;
            const gridDim = Math.ceil(Math.sqrt(remaining));
            const tileSize = 240 / Math.max(1, gridDim);
            for (let gx = 0; gx < gridDim && cIdx < numClusters; gx++) {
                for (let gz = 0; gz < gridDim && cIdx < numClusters; gz++) {
                    const x0 = -120 + gx * tileSize;
                    const z0 = -120 + gz * tileSize;
                    commitCluster(() => {
                        let p = 0;
                        for (let r = 0; r < 8; r++) {
                            const pz = z0 + (r / 7) * tileSize;
                            for (let c = 0; c < 8; c++) {
                                const px = x0 + (c / 7) * tileSize;
                                const groundY = getTerrainElevation(px, pz);

                                tempCoords[p++] = px;
                                tempCoords[p++] = groundY;
                                tempCoords[p++] = pz;
                                tempCoords[p++] = -0.06 * Math.cos(px * 0.025);
                                tempCoords[p++] = 1.0;
                                tempCoords[p++] = -0.06 * Math.sin(pz * 0.020);
                            }
                        }
                        return tempCoords;
                    }, 4, 0.65, false); // Mat 4: Forest Floor
                }
            }

            const estVRAM = (clusterBoundsData.byteLength + clusterDescData.byteLength + clusterVertexData.byteLength + clusterIndexTemplate.byteLength) / (1024 * 1024);
            document.getElementById('vram-val').innerText = estVRAM.toFixed(1) + " MB (Fixed)";
        }

        let computeWGSL, renderWGSL;