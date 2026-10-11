const fs = require('fs');
const path = require('path');

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

const cellSize = 3.0;
const grid = new Map();
for (const v of verts) {
    if (v.y < 12.0) continue;
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
    if (v.ny >= 0.70) cell.groundCandidates.push(v.y);
}

console.log(`Total grid cells: ${grid.size}`);

// Bare earth ground anchors
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
console.log(`Raw ground anchors: ${rawAnchors.length}`);

// PMF
const groundAnchors = [];
let pmfRejected = 0;
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
    else pmfRejected++;
}
console.log(`PMF accepted ground anchors: ${groundAnchors.length}, rejected: ${pmfRejected}`);

const getInterpolatedGround = (x, z) => {
    let wSum = 0, ySum = 0;
    for (const ga of groundAnchors) {
        const dx = x - ga.cx, dz = z - ga.cz;
        const d2 = dx * dx + dz * dz;
        if (d2 < 0.25) return ga.dtmY;
        if (d2 < 2500) {
            const w = 1.0 / (d2 + 1.0);
            wSum += w; ySum += w * ga.dtmY;
        }
    }
    return wSum > 0 ? ySum / wSum : 20.0;
};

// Check candidate canopy cells
let outsideBounds = 0;
let insideMonument = 0;
let tooShort = 0;
let tooTall = 0;
let rejectedFlatRoof = 0;
const validCanopyCells = [];

// Monument test ellipse:
const isInsideMonument = (x, z) => {
    const cosY = Math.cos(-18.36 * Math.PI / 180);
    const sinY = Math.sin(-18.36 * Math.PI / 180);
    const dx = x - 16.72;
    const dz = z - (-21.01);
    const rx = dx * cosY - dz * sinY;
    const rz = dx * sinY + dz * cosY;
    return (rx * rx) / ((102.0 + 2.0) ** 2) + (rz * rz) / ((100.0 + 2.0) ** 2) <= 1.0;
};

grid.forEach(cell => {
    if (isInsideMonument(cell.cx, cell.cz)) {
        insideMonument++;
        return;
    }
    const groundY = getInterpolatedGround(cell.cx, cell.cz);
    cell.dtmY = groundY;
    cell.canopyHeight = cell.maxY - groundY;

    if (cell.canopyHeight < 2.5) {
        tooShort++;
        return;
    }
    if (cell.canopyHeight > 32.0) {
        tooTall++;
        return;
    }

    const upperPoints = cell.points.filter(p => p.y >= cell.maxY - 2.5);
    if (upperPoints.length >= 2) {
        const meanNy = upperPoints.reduce((s, p) => s + p.ny, 0) / upperPoints.length;
        if (meanNy < 0.88) {
            validCanopyCells.push(cell);
        } else {
            rejectedFlatRoof++;
        }
    }
});

console.log(`Inside Monument: ${insideMonument}`);
console.log(`Too short (<3.5m): ${tooShort}`);
console.log(`Too tall (>24.0m): ${tooTall}`);
console.log(`Rejected by meanNy >= 0.88 (flat roof check): ${rejectedFlatRoof}`);
console.log(`Valid canopy cells: ${validCanopyCells.length}`);

// Peak detection
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
console.log(`Raw 3x3 peaks: ${rawPeaks.length}`);

// NMS 5.5m vs 3.8m
const testNms = (spacing) => {
    const sorted = [...rawPeaks].sort((a, b) => b.canopyHeight - a.canopyHeight);
    const kept = [];
    const sq = spacing * spacing;
    for (const p of sorted) {
        if (!kept.some(s => (p.cx - s.cx)**2 + (p.cz - s.cz)**2 < sq)) {
            kept.push(p);
        }
    }
    return kept.length;
};

console.log(`NMS 5.5m spacing: ${testNms(5.5)} trees`);
console.log(`NMS 4.0m spacing: ${testNms(4.0)} trees`);
console.log(`NMS 3.2m spacing: ${testNms(3.2)} trees`);
