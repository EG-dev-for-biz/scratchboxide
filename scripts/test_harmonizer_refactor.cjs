const fs = require('fs');
const path = require('path');

async function test() {
    console.log('[Test Refactor] Testing enhanced PhotogrammetricTerrainHarmonizer logic...');
    const glbBuffer = fs.readFileSync('public/models/colosseum_rome_pristine_leaf_raw.glb');
    const jsonLen = glbBuffer.readUInt32LE(12);
    const gltf = JSON.parse(glbBuffer.toString('utf8', 20, 20 + jsonLen));
    const binOffset = 20 + jsonLen + 8;

    const verts = [];
    for (const mesh of gltf.meshes) {
        for (const prim of mesh.primitives) {
            if (prim.attributes && prim.attributes.POSITION !== undefined) {
                const pAcc = gltf.accessors[prim.attributes.POSITION];
                const pBv = gltf.bufferViews[pAcc.bufferView];
                const pArr = new Float32Array(glbBuffer.buffer, glbBuffer.byteOffset + binOffset + (pBv.byteOffset || 0) + (pAcc.byteOffset || 0), pAcc.count * 3);
                let nArr = null;
                if (prim.attributes.NORMAL !== undefined) {
                    const nAcc = gltf.accessors[prim.attributes.NORMAL];
                    const nBv = gltf.bufferViews[nAcc.bufferView];
                    nArr = new Float32Array(glbBuffer.buffer, glbBuffer.byteOffset + binOffset + (nBv.byteOffset || 0) + (nAcc.byteOffset || 0), nAcc.count * 3);
                }
                for (let i = 0; i < pAcc.count; i++) {
                    const i3 = i * 3;
                    verts.push({
                        x: pArr[i3], y: pArr[i3 + 1], z: pArr[i3 + 2],
                        nx: nArr ? nArr[i3] : 0, ny: nArr ? nArr[i3 + 1] : 1, nz: nArr ? nArr[i3 + 2] : 0
                    });
                }
            }
        }
    }
    console.log(`[Test Refactor] Extracted ${verts.length.toLocaleString()} vertices.`);

    // Elliptical monument polygon
    const isInsideMonument = (x, z) => {
        const cosY = Math.cos(-18.36 * Math.PI / 180);
        const sinY = Math.sin(-18.36 * Math.PI / 180);
        const dx = x - 16.72;
        const dz = z - (-21.01);
        const rx = dx * cosY - dz * sinY;
        const rz = dx * sinY + dz * cosY;
        return (rx * rx) / ((102.0 + 2.0) ** 2) + (rz * rz) / ((100.0 + 2.0) ** 2) <= 1.0;
    };

    const cellSize = 3.0;
    const datumCutoff = 12.0;
    const grid = new Map();

    for (const v of verts) {
        if (v.y < datumCutoff) continue;
        const gx = Math.floor(v.x / cellSize);
        const gz = Math.floor(v.z / cellSize);
        const key = `${gx}_${gz}`;
        let cell = grid.get(key);
        if (!cell) {
            cell = {
                gx, gz, cx: (gx + 0.5) * cellSize, cz: (gz + 0.5) * cellSize,
                minY: v.y, maxY: v.y, points: [], groundCandidates: []
            };
            grid.set(key, cell);
        }
        if (v.y < cell.minY) cell.minY = v.y;
        if (v.y > cell.maxY) cell.maxY = v.y;
        cell.points.push(v);
        if (v.ny >= 0.70 && !isInsideMonument(v.x, v.z)) {
            cell.groundCandidates.push(v.y);
        }
    }

    // Bare-Earth Ground Anchors
    const rawAnchors = [];
    grid.forEach(cell => {
        if (cell.groundCandidates.length >= 3) {
            cell.groundCandidates.sort((a, b) => a - b);
            const spread = cell.groundCandidates[cell.groundCandidates.length - 1] - cell.groundCandidates[0];
            if (spread <= 1.5) {
                rawAnchors.push({ cx: cell.cx, cz: cell.cz, dtmY: cell.groundCandidates[Math.floor(cell.groundCandidates.length * 0.15)] });
            }
        }
    });

    // PMF
    const groundAnchors = [];
    for (const a of rawAnchors) {
        let isElevatedStructure = false;
        for (const other of rawAnchors) {
            const d = Math.hypot(a.cx - other.cx, a.cz - other.cz);
            if (d > 0.1 && d <= 32.0) {
                const maxPlausibleRise = 5.0 + 0.35 * d;
                if (a.dtmY - other.dtmY > maxPlausibleRise) {
                    isElevatedStructure = true;
                    break;
                }
            }
        }
        if (!isElevatedStructure) groundAnchors.push(a);
    }
    console.log(`[Test Refactor] Built DTM with ${groundAnchors.length} PMF ground anchors.`);

    // k-NN IDW Ground Interpolator
    const getInterpolatedGround = (x, z) => {
        const candidates = [];
        for (const ga of groundAnchors) {
            const dx = x - ga.cx;
            const dz = z - ga.cz;
            const d2 = dx * dx + dz * dz;
            if (d2 < 0.25) return ga.dtmY;
            if (d2 < 2025) candidates.push({ d2, dtmY: ga.dtmY });
        }
        if (candidates.length === 0) {
            for (const ga of groundAnchors) {
                const dx = x - ga.cx;
                const dz = z - ga.cz;
                candidates.push({ d2: dx * dx + dz * dz, dtmY: ga.dtmY });
            }
        }
        candidates.sort((a, b) => a.d2 - b.d2);
        const k = Math.min(8, candidates.length);
        let wSum = 0, ySum = 0;
        for (let i = 0; i < k; i++) {
            const w = 1.0 / (Math.sqrt(candidates[i].d2) + 0.1);
            wSum += w;
            ySum += w * candidates[i].dtmY;
        }
        return wSum > 0 ? ySum / wSum : 20.0;
    };

    const minHeight = 2.2;
    const maxHeight = 34.0;
    const validCanopyCells = [];

    grid.forEach(cell => {
        if (isInsideMonument(cell.cx, cell.cz)) return;
        const groundY = getInterpolatedGround(cell.cx, cell.cz);
        cell.dtmY = groundY;
        cell.canopyHeight = cell.maxY - groundY;

        if (cell.canopyHeight >= minHeight && cell.canopyHeight <= maxHeight) {
            const upperPoints = cell.points.filter(p => p.y >= cell.maxY - 2.5);
            if (upperPoints.length >= 2) {
                const meanNy = upperPoints.reduce((s, p) => s + p.ny, 0) / upperPoints.length;
                // Compute standard deviation of Ny to distinguish flat roofs from organic crowns
                const varNy = upperPoints.reduce((s, p) => s + (p.ny - meanNy) ** 2, 0) / upperPoints.length;
                const stdNy = Math.sqrt(varNy);
                // Reject only if surface is exceptionally flat and planar
                if (meanNy < 0.88 || stdNy >= 0.07) {
                    validCanopyCells.push(cell);
                }
            }
        }
    });

    console.log(`[Test Refactor] Valid canopy cells: ${validCanopyCells.length}`);

    // Peak Detection
    const rawPeaks = [];
    for (const cell of validCanopyCells) {
        let isPeak = true;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                if (dx === 0 && dz === 0) continue;
                const neighbor = grid.get(`${cell.gx + dx}_${cell.gz + dz}`);
                if (neighbor && neighbor.maxY > cell.maxY) {
                    isPeak = false;
                    break;
                }
            }
            if (!isPeak) break;
        }
        if (isPeak) rawPeaks.push(cell);
    }

    rawPeaks.sort((a, b) => (b.canopyHeight || 0) - (a.canopyHeight || 0));
    const minSpacing = 3.8;
    const minSpacingSq = minSpacing * minSpacing;
    const suppressedPeaks = [];

    for (const p of rawPeaks) {
        let tooClose = false;
        for (const s of suppressedPeaks) {
            const dx = p.cx - s.cx;
            const dz = p.cz - s.cz;
            if (dx * dx + dz * dz < minSpacingSq) {
                tooClose = true;
                break;
            }
        }
        if (!tooClose) suppressedPeaks.push(p);
    }

    console.log(`[Test Refactor] Resected Trees: ${suppressedPeaks.length}`);
    const species = { pine: 0, cypress: 0, oak: 0 };
    for (const p of suppressedPeaks) {
        const h = p.canopyHeight;
        const r = Math.min(10.0, Math.max(2.8, h * 0.40));
        const diam = r * 2;
        const aspect = h / diam;
        
        if (aspect > 1.5 || (diam <= 5.2 && h >= 7.5)) species.cypress++;
        else if (diam >= 6.0 && aspect <= 1.5) species.pine++;
        else species.oak++;

    }
    console.log(`[Test Refactor] Species breakdown:`, species);

    // Test vertex depression
    let depressedCount = 0;
    let lockedCount = 0;
    const fadeMultiplier = 1.35;

    for (const v of verts) {
        if (isInsideMonument(v.x, v.z)) {
            lockedCount++;
            continue;
        }
        if (Math.abs(v.ny) <= 0.30) continue; // protect vertical curbs/walls

        for (const p of suppressedPeaks) {
            const h = p.canopyHeight;
            const rBase = Math.min(10.0, Math.max(2.8, h * 0.40));
            const rFade = rBase * fadeMultiplier;
            const dx = v.x - p.cx;
            const dz = v.z - p.cz;
            const distSq = dx * dx + dz * dz;
            if (distSq < rFade * rFade) {
                const dist = Math.sqrt(distSq);
                const u = dist / rFade;
                const targetGy = getInterpolatedGround(v.x, v.z);
                const deltaY = v.y - targetGy;
                if (deltaY > 0.0 && deltaY <= 34.0) {
                    depressedCount++;
                    break;
                }
            }
        }
    }
    console.log('[Test Refactor] Depressed vertices:', depressedCount.toLocaleString());
    console.log('[Test Refactor] Locked monument vertices:', lockedCount.toLocaleString());

}
test();
