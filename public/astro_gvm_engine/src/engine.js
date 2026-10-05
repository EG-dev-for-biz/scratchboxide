// Astro GVM: WebGPU Compute & Indirect Draw Pipeline

// Minimal High-Performance Column-Major 4x4 Matrix Math
        const Mat4 = {
            create() {
                return new Float32Array([
                    1, 0, 0, 0,
                    0, 1, 0, 0,
                    0, 0, 1, 0,
                    0, 0, 0, 1
                ]);
            },
            perspective(out, fovRad, aspect, near, far) {
                const f = 1.0 / Math.tan(fovRad / 2);
                const nf = 1 / (near - far);
                out[0] = f / aspect;
                out[1] = 0;
                out[2] = 0;
                out[3] = 0;
                out[4] = 0;
                out[5] = f;
                out[6] = 0;
                out[7] = 0;
                out[8] = 0;
                out[9] = 0;
                out[10] = (far + near) * nf;
                out[11] = -1;
                out[12] = 0;
                out[13] = 0;
                out[14] = 2 * far * near * nf;
                out[15] = 0;
                return out;
            },
            lookAt(out, eye, target, up) {
                let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
                let len = 1 / Math.hypot(zx, zy, zz);
                zx *= len; zy *= len; zz *= len;

                let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
                len = 1 / Math.hypot(xx, xy, xz);
                xx *= len; xy *= len; xz *= len;

                let yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;

                out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
                out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
                out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
                out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
                out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
                out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
                out[15] = 1;
                return out;
            },
            multiply(out, a, b) {
                const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
                const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
                const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
                const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

                for (let i = 0; i < 4; i++) {
                    const b0 = b[i*4], b1 = b[i*4+1], b2 = b[i*4+2], b3 = b[i*4+3];
                    out[i*4]   = a00*b0 + a10*b1 + a20*b2 + a30*b3;
                    out[i*4+1] = a01*b0 + a11*b1 + a21*b2 + a31*b3;
                    out[i*4+2] = a02*b0 + a12*b1 + a22*b2 + a32*b3;
                    out[i*4+3] = a03*b0 + a13*b1 + a23*b2 + a33*b3;
                }
                return out;
            },
            extractFrustumPlanes(m) {
                // Returns 6 planes: vec4(x, y, z, w) where dot(plane.xyz, pos) + plane.w >= 0 is inside
                const planes = new Float32Array(24);
                // Left
                planes[0]  = m[3]  + m[0];
                planes[1]  = m[7]  + m[4];
                planes[2]  = m[11] + m[8];
                planes[3]  = m[15] + m[12];
                // Right
                planes[4]  = m[3]  - m[0];
                planes[5]  = m[7]  - m[4];
                planes[6]  = m[11] - m[8];
                planes[7]  = m[15] - m[12];
                // Bottom
                planes[8]  = m[3]  + m[1];
                planes[9]  = m[7]  + m[5];
                planes[10] = m[11] + m[9];
                planes[11] = m[15] + m[13];
                // Top
                planes[12] = m[3]  - m[1];
                planes[13] = m[7]  - m[5];
                planes[14] = m[11] - m[9];
                planes[15] = m[15] - m[13];
                // Near
                planes[16] = m[2];
                planes[17] = m[6];
                planes[18] = m[10];
                planes[19] = m[14];
                // Far
                planes[20] = m[3]  - m[2];
                planes[21] = m[7]  - m[6];
                planes[22] = m[11] - m[10];
                planes[23] = m[15] - m[14];

                // Normalize planes
                for (let i = 0; i < 6; i++) {
                    const offset = i * 4;
                    const len = Math.hypot(planes[offset], planes[offset+1], planes[offset+2]);
                    if (len > 0) {
                        const inv = 1.0 / len;
                        planes[offset]   *= inv;
                        planes[offset+1] *= inv;
                        planes[offset+2] *= inv;
                        planes[offset+3] *= inv;
                    }
                }
                return planes;
            }
        };
    </script>

    <!-- Main WebGPU Engine Script -->
    <script>
        let device, context, format;
        let computePipeline, renderPipeline;
        let uniformBuffer, clusterBoundsBuffer, clusterDescBuffer;
        let clusterVertexBuffer, clusterIndexBuffer;
        let indirectDrawBuffer, visibleClusterBuffer, readbackBuffer;

        let numClusters = 8192;
        let isCinematic = true;
        const VERTS_PER_CLUSTER = 64;
        const TRIS_PER_CLUSTER = 124;
        const INDICES_PER_CLUSTER = TRIS_PER_CLUSTER * 3; // 372

        let frustumCullingActive = 1;
        let coneCullingActive = 1;
        let viewMode = 1; // Default: Photorealistic Classical PBR

        // Camera Orbit Controls
        let camRadius = 26.0;
        let camTheta = 0.0;
        let camPhi = 1.35;
        let isDragging = false;
        function toggleCinematicOrbit() {
            isCinematic = !isCinematic;
            const btn = document.getElementById('btn-cinematic');
            if (btn) {
                if (isCinematic) btn.classList.add('active');
                else btn.classList.remove('active');
            }
        }
        let lastMouseX = 0, lastMouseY = 0;

        // Uniform Buffer Structure:
        // mat4 viewProj (64)
        // vec4 camPos (16)
        // 6 * vec4 frustumPlanes (96)
        // vec4 cullingParams (16) -> [frustumEnabled, coneEnabled, viewMode, totalClusters]
        // Total = 192 bytes (aligned to 256)
        const uniformData = new Float32Array(64);

        async function init() {
            if (!navigator.gpu) {
                document.getElementById('webgpu-fallback').style.display = 'block';
                return;
            }

            const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
            if (!adapter) {
                document.getElementById('webgpu-fallback').style.display = 'block';
                return;
            }

            device = await adapter.requestDevice();
            const canvas = document.getElementById('gpuCanvas');
            context = canvas.getContext('webgpu');
            format = navigator.gpu.getPreferredCanvasFormat();

            function resize() {
                canvas.width = window.innerWidth * window.devicePixelRatio;
                canvas.height = window.innerHeight * window.devicePixelRatio;
            }
            window.addEventListener('resize', resize);
            resize();

            context.configure({
                device: device,
                format: format,
                alphaMode: 'opaque'
            });

            setupShaders();
            buildClusterData(numClusters);
            setupBuffers();
            setupPipelines();
            setupInput();

            requestAnimationFrame(renderLoop);
        }

let computeWGSL, renderWGSL;

        async function setupShaders() {
            try {
                const [cullRes, pbrRes] = await Promise.all([
                    fetch('./shaders/cull.wgsl'),
                    fetch('./shaders/pbr_forest.wgsl')
                ]);
                if (cullRes.ok && pbrRes.ok) {
                    computeWGSL = await cullRes.text();
                    renderWGSL = await pbrRes.text();
                    return;
                }
            } catch (e) {
                console.warn('Falling back to embedded shaders:', e);
            }
        }


</script>

    <!-- Main WebGPU Engine Script -->
    <script>
        let device, context, format;
        let computePipeline, renderPipeline;
        let uniformBuffer, clusterBoundsBuffer, clusterDescBuffer;
        let clusterVertexBuffer, clusterIndexBuffer;
        let indirectDrawBuffer, visibleClusterBuffer, readbackBuffer;

        let numClusters = 8192;
        let isCinematic = true;
        const VERTS_PER_CLUSTER = 64;
        const TRIS_PER_CLUSTER = 124;
        const INDICES_PER_CLUSTER = TRIS_PER_CLUSTER * 3; // 372

        let frustumCullingActive = 1;
        let coneCullingActive = 1;
        let viewMode = 1; // Default: Photorealistic Classical PBR

        // Camera Orbit Controls
        let camRadius = 26.0;
        let camTheta = 0.0;
        let camPhi = 1.35;
        let isDragging = false;
        function toggleCinematicOrbit() {
            isCinematic = !isCinematic;
            const btn = document.getElementById('btn-cinematic');
            if (btn) {
                if (isCinematic) btn.classList.add('active');
                else btn.classList.remove('active');
            }
        }
        let lastMouseX = 0, lastMouseY = 0;

        // Uniform Buffer Structure:
        // mat4 viewProj (64)
        // vec4 camPos (16)
        // 6 * vec4 frustumPlanes (96)
        // vec4 cullingParams (16) -> [frustumEnabled, coneEnabled, viewMode, totalClusters]
        // Total = 192 bytes (aligned to 256)
        const uniformData = new Float32Array(64);

        async function init() {
            if (!navigator.gpu) {
                document.getElementById('webgpu-fallback').style.display = 'block';
                return;
            }

            const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
            if (!adapter) {
                document.getElementById('webgpu-fallback').style.display = 'block';
                return;
            }

            device = await adapter.requestDevice();
            const canvas = document.getElementById('gpuCanvas');
            context = canvas.getContext('webgpu');
            format = navigator.gpu.getPreferredCanvasFormat();

            function resize() {
                canvas.width = window.innerWidth * window.devicePixelRatio;
                canvas.height = window.innerHeight * window.devicePixelRatio;
            }
            window.addEventListener('resize', resize);
            resize();

            context.configure({
                device: device,
                format: format,
                alphaMode: 'opaque'
            });

            setupShaders();
            buildClusterData(numClusters);
            setupBuffers();
            setupPipelines();
            setupInput();

            requestAnimationFrame(renderLoop);
        }

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

        function setupShaders() {
            // WGSL Compute Culling Shader
            computeWGSL = `
                struct ClusterBounds {
                    sphere: vec4<f32>,
                    cone: vec4<f32>,
                };

                struct CameraUniforms {
                    viewProj: mat4x4<f32>,
                    camPos: vec4<f32>,
                    planes: array<vec4<f32>, 6>,
                    cullingParams: vec4<f32>, // x: frustumOn, y: coneOn, z: viewMode, w: totalCount
                };

                // DrawIndirectArgs (VkDrawIndirectCommand):
                // vertexCount, instanceCount, firstVertex, firstInstance
                struct DrawIndirectArgs {
                    vertexCount: u32,
                    instanceCount: atomic<u32>,
                    firstVertex: u32,
                    firstInstance: u32,
                };

                @group(0) @binding(0) var<uniform> camera: CameraUniforms;
                @group(0) @binding(1) var<storage, read> bounds: array<ClusterBounds>;
                @group(0) @binding(2) var<storage, read_write> drawArgs: DrawIndirectArgs;
                @group(0) @binding(3) var<storage, read_write> visibleClusterIDs: array<u32>;

                @compute @workgroup_size(64, 1, 1)
                fn cs_cull(@builtin(global_invocation_id) id: vec3<u32>) {
                    let clusterIdx = id.x;
                    if (clusterIdx >= u32(camera.cullingParams.w)) {
                        return;
                    }

                    let b = bounds[clusterIdx];

                    // 1. Frustum Culling
                    if (camera.cullingParams.x > 0.5) {
                        for (var p = 0u; p < 6u; p = p + 1u) {
                            let plane = camera.planes[p];
                            let dist = dot(plane.xyz, b.sphere.xyz) + plane.w;
                            if (dist < -b.sphere.w) {
                                return; // Fully outside frustum
                            }
                        }
                    }

                    // 2. Normal Cone Backface Culling
                    if (camera.cullingParams.y > 0.5) {
                        let toCam = normalize(camera.camPos.xyz - b.sphere.xyz);
                        if (dot(b.cone.xyz, toCam) < b.cone.w) {
                            return; // Backfacing cluster
                        }
                    }

                    // Survived: Atomic compaction into visible queue
                    let slot = atomicAdd(&drawArgs.instanceCount, 1u);
                    visibleClusterIDs[slot] = clusterIdx;
                }
            `;

            // WGSL Vertex & Fragment Shaders (Indirect Cluster Rendering)
            renderWGSL = `
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
            `;
        }