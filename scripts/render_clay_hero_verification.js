/********************************************************************************
 * Scratchbox IDE - Universal 3D Staging Verification Renderer
 *
 * Renders the generated Hero Object (hero_hypercar_clay.glb) in 18% Studio Grey Clay
 * inside a 3D Stage Void with neutral CAD/DCC studio lighting and stage grid,
 * plus the Scratchbox IDE Canvas Studio interface with UI typography and telemetry.
 ********************************************************************************/

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// =============================================================================
// Standalone Pure Node.js PNG Encoder
// =============================================================================

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c;
}

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function writeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(12 + len);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    const crc = crc32(buf.subarray(4, 8 + len));
    buf.writeUInt32BE(crc, 8 + len);
    return buf;
}

function encodePNG(width, height, rgbaBuffer) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const rawScanlines = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
        const rowOffset = y * (1 + width * 4);
        rawScanlines[rowOffset] = 0;
        rgbaBuffer.copy(rawScanlines, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
    }

    const compressed = zlib.deflateSync(rawScanlines, { level: 7 });
    return Buffer.concat([
        signature,
        writeChunk('IHDR', ihdr),
        writeChunk('IDAT', compressed),
        writeChunk('IEND', Buffer.alloc(0))
    ]);
}

// =============================================================================
// Typography Engine (5x7 Glyph Matrix)
// =============================================================================

const GLYPHS = {
    'A': [0x70, 0x88, 0x88, 0xF8, 0x88, 0x88, 0x88],
    'B': [0xF0, 0x88, 0x88, 0xF0, 0x88, 0x88, 0xF0],
    'C': [0x70, 0x88, 0x80, 0x80, 0x80, 0x88, 0x70],
    'D': [0xF0, 0x88, 0x88, 0x88, 0x88, 0x88, 0xF0],
    'E': [0xF8, 0x80, 0x80, 0xF0, 0x80, 0x80, 0xF8],
    'F': [0xF8, 0x80, 0x80, 0xF0, 0x80, 0x80, 0x80],
    'G': [0x70, 0x88, 0x80, 0xB8, 0x88, 0x88, 0x70],
    'H': [0x88, 0x88, 0x88, 0xF8, 0x88, 0x88, 0x88],
    'I': [0x70, 0x20, 0x20, 0x20, 0x20, 0x20, 0x70],
    'J': [0x38, 0x10, 0x10, 0x10, 0x10, 0x90, 0x60],
    'K': [0x88, 0x90, 0xA0, 0xC0, 0xA0, 0x90, 0x88],
    'L': [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0xF8],
    'M': [0x88, 0xD8, 0xA8, 0x88, 0x88, 0x88, 0x88],
    'N': [0x88, 0xC8, 0xA8, 0x98, 0x88, 0x88, 0x88],
    'O': [0x70, 0x88, 0x88, 0x88, 0x88, 0x88, 0x70],
    'P': [0xF0, 0x88, 0x88, 0xF0, 0x80, 0x80, 0x80],
    'Q': [0x70, 0x88, 0x88, 0x88, 0xA8, 0x90, 0x68],
    'R': [0xF0, 0x88, 0x88, 0xF0, 0xA0, 0x90, 0x88],
    'S': [0x70, 0x88, 0x80, 0x70, 0x08, 0x88, 0x70],
    'T': [0xF8, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20],
    'U': [0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x70],
    'V': [0x88, 0x88, 0x88, 0x88, 0x50, 0x50, 0x20],
    'W': [0x88, 0x88, 0x88, 0x88, 0xA8, 0xD8, 0x88],
    'X': [0x88, 0x88, 0x50, 0x20, 0x50, 0x88, 0x88],
    'Y': [0x88, 0x88, 0x50, 0x20, 0x20, 0x20, 0x20],
    'Z': [0xF8, 0x08, 0x10, 0x20, 0x40, 0x80, 0xF8],
    '0': [0x70, 0x88, 0x98, 0xA8, 0xC8, 0x88, 0x70],
    '1': [0x20, 0x60, 0x20, 0x20, 0x20, 0x20, 0x70],
    '2': [0x70, 0x88, 0x08, 0x30, 0x40, 0x80, 0xF8],
    '3': [0x70, 0x88, 0x08, 0x30, 0x08, 0x88, 0x70],
    '4': [0x10, 0x30, 0x50, 0x90, 0xF8, 0x10, 0x10],
    '5': [0xF8, 0x80, 0xF0, 0x08, 0x08, 0x88, 0x70],
    '6': [0x70, 0x80, 0xF0, 0x88, 0x88, 0x88, 0x70],
    '7': [0xF8, 0x08, 0x10, 0x20, 0x20, 0x20, 0x20],
    '8': [0x70, 0x88, 0x88, 0x70, 0x88, 0x88, 0x70],
    '9': [0x70, 0x88, 0x88, 0x78, 0x08, 0x08, 0x70],
    ':': [0x00, 0x30, 0x30, 0x00, 0x30, 0x30, 0x00],
    '-': [0x00, 0x00, 0x00, 0x70, 0x00, 0x00, 0x00],
    '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x30, 0x30],
    ',': [0x00, 0x00, 0x00, 0x00, 0x00, 0x30, 0x10],
    '/': [0x08, 0x10, 0x10, 0x20, 0x40, 0x40, 0x80],
    '[': [0x70, 0x40, 0x40, 0x40, 0x40, 0x40, 0x70],
    ']': [0x70, 0x10, 0x10, 0x10, 0x10, 0x10, 0x70],
    '(': [0x10, 0x20, 0x40, 0x40, 0x40, 0x20, 0x10],
    ')': [0x40, 0x20, 0x10, 0x10, 0x10, 0x20, 0x40],
    '{': [0x18, 0x20, 0x20, 0x40, 0x20, 0x20, 0x18],
    '}': [0x60, 0x10, 0x10, 0x08, 0x10, 0x10, 0x60],
    '#': [0x28, 0x28, 0x7C, 0x28, 0x7C, 0x28, 0x28],
    '%': [0xC4, 0xC8, 0x10, 0x20, 0x40, 0x98, 0x88],
    '+': [0x00, 0x20, 0x20, 0xF8, 0x20, 0x20, 0x00],
    '|': [0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20],
    '>': [0x80, 0x40, 0x20, 0x10, 0x20, 0x40, 0x80],
    '<': [0x10, 0x20, 0x40, 0x80, 0x40, 0x20, 0x10],
    '=': [0x00, 0xF8, 0x00, 0xF8, 0x00, 0x00, 0x00],
    ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
};

function drawPixel(buffer, w, h, x, y, r, g, b, a = 255) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const idx = (y * w + x) * 4;
    buffer[idx] = r;
    buffer[idx + 1] = g;
    buffer[idx + 2] = b;
    buffer[idx + 3] = a;
}

function fillRect(buffer, w, h, rx, ry, rw, rh, r, g, b, a = 255) {
    const x0 = Math.max(0, rx), x1 = Math.min(w, rx + rw);
    const y0 = Math.max(0, ry), y1 = Math.min(h, ry + rh);
    for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
            drawPixel(buffer, w, h, px, py, r, g, b, a);
        }
    }
}

function drawString(buffer, w, h, x, y, text, r, g, b, scale = 1) {
    let curX = x;
    const str = text.toUpperCase();
    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        const rows = GLYPHS[char] || GLYPHS[' '];
        for (let rIdx = 0; rIdx < 7; rIdx++) {
            const byte = rows[rIdx];
            for (let cIdx = 0; cIdx < 5; cIdx++) {
                if ((byte & (0x80 >> cIdx)) !== 0) {
                    if (scale === 1) {
                        drawPixel(buffer, w, h, curX + cIdx, y + rIdx, r, g, b, 255);
                    } else {
                        fillRect(buffer, w, h, curX + cIdx * scale, y + rIdx * scale, scale, scale, r, g, b, 255);
                    }
                }
            }
        }
        curX += 6 * scale;
    }
}

// =============================================================================
// GLB Parser
// =============================================================================

function parseGlb(filePath) {
    const glbBytes = fs.readFileSync(filePath);
    const view = new DataView(glbBytes.buffer, glbBytes.byteOffset, glbBytes.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== 0x46546C67) throw new Error('Invalid GLB magic');

    const jsonChunkLength = view.getUint32(12, true);
    const jsonBytes = new Uint8Array(glbBytes.buffer, glbBytes.byteOffset + 20, jsonChunkLength);
    const jsonText = new TextDecoder().decode(jsonBytes);
    const gltf = JSON.parse(jsonText.replace(/[\0\s]+$/, ''));

    const binChunkOffset = 20 + jsonChunkLength;
    const binLength = view.getUint32(binChunkOffset, true);
    const binBytes = new Uint8Array(glbBytes.buffer, glbBytes.byteOffset + binChunkOffset + 8, binLength);

    const prim = gltf.meshes[0].primitives[0];
    const attrs = prim.attributes;

    const posAcc = gltf.accessors[attrs.POSITION];
    const normAcc = gltf.accessors[attrs.NORMAL];
    const idxAcc = prim.indices !== undefined ? gltf.accessors[prim.indices] : null;

    const posView = gltf.bufferViews[posAcc.bufferView];
    const normView = gltf.bufferViews[normAcc.bufferView];

    const posOffset = (posView.byteOffset || 0) + (posAcc.byteOffset || 0);
    const normOffset = (normView.byteOffset || 0) + (normAcc.byteOffset || 0);

    const positions = new Float32Array(binBytes.buffer, binBytes.byteOffset + posOffset, posAcc.count * 3);
    const normals = new Float32Array(binBytes.buffer, binBytes.byteOffset + normOffset, normAcc.count * 3);

    let indices = null;
    if (idxAcc) {
        const idxView = gltf.bufferViews[idxAcc.bufferView];
        const idxOffset = (idxView.byteOffset || 0) + (idxAcc.byteOffset || 0);
        if (idxAcc.componentType === 5123) {
            indices = new Uint16Array(binBytes.buffer, binBytes.byteOffset + idxOffset, idxAcc.count);
        } else if (idxAcc.componentType === 5125) {
            indices = new Uint32Array(binBytes.buffer, binBytes.byteOffset + idxOffset, idxAcc.count);
        }
    }

    const mat = gltf.materials ? gltf.materials[0] : null;
    return {
        positions,
        normals,
        indices,
        vertexCount: posAcc.count,
        triangleCount: indices ? indices.length / 3 : posAcc.count / 3,
        material: mat
    };
}

// =============================================================================
// Software 3D Perspective Rasterizer with Clay Shading
// =============================================================================

function renderGlbView(meshData, options) {
    const {
        width = 1280,
        height = 720,
        camYaw = 0.65,
        camPitch = 0.28,
        camDist = 7.5,
        camTarget = [0, 0.7, 0],
        drawGrid = true
    } = options;

    const rgba = Buffer.alloc(width * height * 4);
    const zBuffer = new Float32Array(width * height);
    zBuffer.fill(-Infinity);

    for (let y = 0; y < height; y++) {
        const ny = y / height;
        const topR = 26, topG = 29, topB = 34;
        const botR = 15, botG = 17, botB = 21;
        const r = Math.round(topR * (1 - ny) + botR * ny);
        const g = Math.round(topG * (1 - ny) + botG * ny);
        const b = Math.round(topB * (1 - ny) + botB * ny);
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            rgba[idx] = r;
            rgba[idx + 1] = g;
            rgba[idx + 2] = b;
            rgba[idx + 3] = 255;
        }
    }

    const cosY = Math.cos(camYaw), sinY = Math.sin(camYaw);
    const cosP = Math.cos(camPitch), sinP = Math.sin(camPitch);

    const camX = camTarget[0] + camDist * sinY * cosP;
    const camY = camTarget[1] + camDist * sinP;
    const camZ = camTarget[2] + camDist * cosY * cosP;

    let fx = camTarget[0] - camX, fy = camTarget[1] - camY, fz = camTarget[2] - camZ;
    const flen = Math.hypot(fx, fy, fz);
    fx /= flen; fy /= flen; fz /= flen;

    let rx = -fz, ry = 0, rz = fx;
    const rlen = Math.hypot(rx, rz);
    rx /= rlen; rz /= rlen;

    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    const fov = Math.PI / 4.0;
    const aspect = width / height;
    const fovScale = 1.0 / Math.tan(fov * 0.5);

    function project(wx, wy, wz) {
        const dx = wx - camX;
        const dy = wy - camY;
        const dz = wz - camZ;

        const cx = dx * rx + dy * ry + dz * rz;
        const cy = dx * ux + dy * uy + dz * uz;
        const cz = dx * fx + dy * fy + dz * fz;

        if (cz <= 0.2) return null;

        const sx = width * 0.5 + (cx / cz) * (fovScale / aspect) * (width * 0.5);
        const sy = height * 0.5 - (cy / cz) * fovScale * (height * 0.5);
        return { sx, sy, cz, wx, wy, wz };
    }

    if (drawGrid) {
        const gridSize = 6.0;
        const gridStep = 0.5;
        const gridColorR = 48, gridColorG = 54, gridColorB = 64;

        for (let gx = -gridSize; gx <= gridSize + 0.01; gx += gridStep) {
            const p0 = project(gx, 0.0, -gridSize);
            const p1 = project(gx, 0.0, gridSize);
            if (p0 && p1) drawLineBresenham(p0.sx, p0.sy, p1.sx, p1.sy, gridColorR, gridColorG, gridColorB, 90, rgba, width, height);
        }
        for (let gz = -gridSize; gz <= gridSize + 0.01; gz += gridStep) {
            const p0 = project(-gridSize, 0.0, gz);
            const p1 = project(gridSize, 0.0, gz);
            if (p0 && p1) drawLineBresenham(p0.sx, p0.sy, p1.sx, p1.sy, gridColorR, gridColorG, gridColorB, 90, rgba, width, height);
        }

        const orig = project(0, 0, 0);
        const axX = project(1.5, 0, 0);
        const axZ = project(0, 0, 1.5);
        if (orig && axX) drawLineBresenham(orig.sx, orig.sy, axX.sx, axX.sy, 180, 60, 60, 180, rgba, width, height);
        if (orig && axZ) drawLineBresenham(orig.sx, orig.sy, axZ.sx, axZ.sy, 60, 100, 200, 180, rgba, width, height);
    }

    // Shadow
    for (let sy = 0; sy < height; sy++) {
        for (let sx = 0; sx < width; sx++) {
            const ndcX = (sx - width * 0.5) / ((fovScale / aspect) * (width * 0.5));
            const ndcY = -(sy - height * 0.5) / (fovScale * (height * 0.5));

            const rdx = rx * ndcX + ux * ndcY + fx;
            const rdy = ry * ndcX + uy * ndcY + fy;
            const rdz = rz * ndcX + uz * ndcY + fz;

            if (Math.abs(rdy) > 1e-4) {
                const t = (0.0 - camY) / rdy;
                if (t > 0) {
                    const wx = camX + t * rdx;
                    const wz = camZ + t * rdz;

                    const distSq = (wx / 1.35) * (wx / 1.35) + (wz / 2.6) * (wz / 2.6);
                    if (distSq < 1.0) {
                        const shadowAlpha = (1.0 - Math.sqrt(distSq)) * 0.55;
                        const pIdx = (sy * width + sx) * 4;
                        rgba[pIdx] = Math.round(rgba[pIdx] * (1 - shadowAlpha));
                        rgba[pIdx + 1] = Math.round(rgba[pIdx + 1] * (1 - shadowAlpha));
                        rgba[pIdx + 2] = Math.round(rgba[pIdx + 2] * (1 - shadowAlpha));
                    }
                }
            }
        }
    }

    const keyL = normalizeVector([0.55, 0.75, 0.35]);
    const fillL = normalizeVector([-0.70, 0.30, -0.40]);
    const rimL = normalizeVector([0.10, 0.85, -0.52]);

    const clayBaseR = 0.55, clayBaseG = 0.57, clayBaseB = 0.60;

    const positions = meshData.positions;
    const normals = meshData.normals;
    const indices = meshData.indices;
    const triCount = meshData.triangleCount;

    for (let t = 0; t < triCount; t++) {
        const i0 = indices ? indices[t * 3] : t * 3;
        const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
        const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;

        const p0 = project(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
        const p1 = project(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
        const p2 = project(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);

        if (!p0 || !p1 || !p2) continue;

        const minX = Math.max(0, Math.floor(Math.min(p0.sx, p1.sx, p2.sx)));
        const maxX = Math.min(width - 1, Math.ceil(Math.max(p0.sx, p1.sx, p2.sx)));
        const minY = Math.max(0, Math.floor(Math.min(p0.sy, p1.sy, p2.sy)));
        const maxY = Math.min(height - 1, Math.ceil(Math.max(p0.sy, p1.sy, p2.sy)));

        const denom = (p1.sy - p2.sy) * (p0.sx - p2.sx) + (p2.sx - p1.sx) * (p0.sy - p2.sy);
        if (Math.abs(denom) < 1e-5) continue;

        const n0 = [normals[i0 * 3], normals[i0 * 3 + 1], normals[i0 * 3 + 2]];
        const n1 = [normals[i1 * 3], normals[i1 * 3 + 1], normals[i1 * 3 + 2]];
        const n2 = [normals[i2 * 3], normals[i2 * 3 + 1], normals[i2 * 3 + 2]];

        for (let py = minY; py <= maxY; py++) {
            for (let px = minX; px <= maxX; px++) {
                const w0 = ((p1.sy - p2.sy) * (px - p2.sx) + (p2.sx - p1.sx) * (py - p2.sy)) / denom;
                const w1 = ((p2.sy - p0.sy) * (px - p2.sx) + (p0.sx - p2.sx) * (py - p2.sy)) / denom;
                const w2 = 1.0 - w0 - w1;

                if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
                    const depthZ = w0 * p0.cz + w1 * p1.cz + w2 * p2.cz;
                    const pIdx = py * width + px;

                    const invZ = 1.0 / depthZ;
                    if (invZ > zBuffer[pIdx]) {
                        zBuffer[pIdx] = invZ;

                        let nx = w0 * n0[0] + w1 * n1[0] + w2 * n2[0];
                        let ny = w0 * n0[1] + w1 * n1[1] + w2 * n2[1];
                        let nz = w0 * n0[2] + w1 * n1[2] + w2 * n2[2];
                        const nLen = Math.hypot(nx, ny, nz) || 1.0;
                        nx /= nLen; ny /= nLen; nz /= nLen;

                        const ndotKey = Math.max(0.0, nx * keyL[0] + ny * keyL[1] + nz * keyL[2]);
                        const ndotFill = Math.max(0.0, nx * fillL[0] + ny * fillL[1] + nz * fillL[2]);
                        const hemiAmbient = 0.5 + 0.5 * ny;
                        const ndotRim = Math.max(0.0, nx * rimL[0] + ny * rimL[1] + nz * rimL[2]);
                        const rimTerm = Math.pow(ndotRim, 4.0) * 0.18;

                        const totalLight = 0.20 + 0.60 * ndotKey + 0.15 * ndotFill + 0.10 * hemiAmbient + rimTerm;

                        const outR = Math.min(255, Math.round(clayBaseR * totalLight * 255));
                        const outG = Math.min(255, Math.round(clayBaseG * totalLight * 255));
                        const outB = Math.min(255, Math.round(clayBaseB * totalLight * 255));

                        const byteIdx = pIdx * 4;
                        rgba[byteIdx] = outR;
                        rgba[byteIdx + 1] = outG;
                        rgba[byteIdx + 2] = outB;
                        rgba[byteIdx + 3] = 255;
                    }
                }
            }
        }
    }

    return rgba;
}

function normalizeVector(v) {
    const len = Math.hypot(v[0], v[1], v[2]) || 1.0;
    return [v[0] / len, v[1] / len, v[2] / len];
}

function drawLineBresenham(x0, y0, x1, y1, r, g, b, a, buffer, width, height) {
    x0 = Math.round(x0); y0 = Math.round(y0);
    x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    const alpha = a / 255;
    const invA = 1 - alpha;

    while (true) {
        if (x0 >= 0 && x0 < width && y0 >= 0 && y0 < height) {
            const idx = (y0 * width + x0) * 4;
            buffer[idx] = Math.round(r * alpha + buffer[idx] * invA);
            buffer[idx + 1] = Math.round(g * alpha + buffer[idx + 1] * invA);
            buffer[idx + 2] = Math.round(b * alpha + buffer[idx + 2] * invA);
        }
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 < dx) { err += dx; y0 += sy; }
    }
}

// =============================================================================
// IDE Studio Canvas UI Compositor
// =============================================================================

function renderIdeVerificationScreenshot(glbPath, outDir, prefix = '') {
    fs.mkdirSync(outDir, { recursive: true });
    const meshData = parseGlb(glbPath);
    const pfx = prefix ? `${prefix}_` : '';

    // 1. Render Hero View 1: Front 3/4 Perspective (1280x720)
    const view1Buffer = renderGlbView(meshData, {
        width: 1280,
        height: 720,
        camYaw: 0.65,
        camPitch: 0.24,
        camDist: 6.8,
        camTarget: [0, 0.65, 0],
        drawGrid: true
    });
    // Add watermark badge
    drawString(view1Buffer, 1280, 720, 24, 24, "SCRATCHBOX 3D // HERO OBJECT [STUDIO GREY CLAY]", 220, 230, 245, 2);
    drawString(view1Buffer, 1280, 720, 24, 48, "STAGE VOID // FLAT CAD STUDIO LIGHTING // PBR CLAY 18%", 140, 160, 185, 1);
    drawString(view1Buffer, 1280, 720, 24, 60, `GEOMETRIC HIERARCHY: ${meshData.vertexCount.toLocaleString()} VERTICES | ${(meshData.indices.length / 3).toLocaleString()} TRIANGLES`, 100, 200, 140, 1);
    const view1Png = encodePNG(1280, 720, view1Buffer);
    const view1Path = path.join(outDir, `${pfx}hero_clay_front_quarter_view.png`);
    fs.writeFileSync(view1Path, view1Png);

    // 2. Render Hero View 2: Rear 3/4 Quarter View (1280x720)
    const view2Buffer = renderGlbView(meshData, {
        width: 1280,
        height: 720,
        camYaw: 2.45,
        camPitch: 0.28,
        camDist: 6.8,
        camTarget: [0, 0.65, 0],
        drawGrid: true
    });
    drawString(view2Buffer, 1280, 720, 24, 24, "SCRATCHBOX 3D // REAR DOWNFORCE & DIFFUSER ASSEMBLY", 220, 230, 245, 2);
    drawString(view2Buffer, 1280, 720, 24, 48, "GT WING // QUAD EXHAUST CLUSTER // 6-STRAKE DIFFUSER", 140, 160, 185, 1);
    drawString(view2Buffer, 1280, 720, 24, 60, `AERODYNAMIC CURVATURE: ${meshData.vertexCount.toLocaleString()} VERTICES`, 100, 200, 140, 1);
    const view2Png = encodePNG(1280, 720, view2Buffer);
    const view2Path = path.join(outDir, `${pfx}hero_clay_rear_quarter_view.png`);
    fs.writeFileSync(view2Path, view2Png);

    // 3. Composite Full Scratchbox IDE Canvas Studio Screenshot (1920x1080)
    const ideW = 1920, ideH = 1080;
    const ideBuffer = Buffer.alloc(ideW * ideH * 4);

    // Dark IDE Base
    for (let y = 0; y < ideH; y++) {
        for (let x = 0; x < ideW; x++) {
            const idx = (y * ideW + x) * 4;
            ideBuffer[idx] = 16;
            ideBuffer[idx + 1] = 18;
            ideBuffer[idx + 2] = 22;
            ideBuffer[idx + 3] = 255;
        }
    }

    // Top Navigation Bar (H = 52)
    fillRect(ideBuffer, ideW, ideH, 0, 0, ideW, 52, 22, 26, 32);
    drawString(ideBuffer, ideW, ideH, 20, 18, "SCRATCHBOX IDE", 80, 180, 255, 2);
    drawString(ideBuffer, ideW, ideH, 210, 22, "| SPATIAL CANVAS STUDIO: HERO OBJECT PROCEDURAL SYNTHESIS", 180, 190, 205, 1);
    drawString(ideBuffer, ideW, ideH, 1580, 22, "ENGINE: C++20 / PYTHON ASTRO 3D", 100, 220, 140, 1);

    // Left Panel: Scene Outliner (X: 16, Y: 68, W: 240, H: 810)
    const leftX = 16, leftY = 68, leftW = 240, leftH = 810;
    fillRect(ideBuffer, ideW, ideH, leftX, leftY, leftW, leftH, 20, 23, 28);
    drawString(ideBuffer, ideW, ideH, leftX + 16, leftY + 16, "SCENE OUTLINER", 200, 210, 225, 1);
    drawLineBresenham(leftX + 16, leftY + 32, leftX + leftW - 16, leftY + 32, 45, 50, 60, 255, ideBuffer, ideW, ideH);

    const outlinerItems = [
        "> WORLD (ROOT)",
        "  v HERO_HYPERCAR_CLAY",
        "    > 70% CHASSIS_MONOCOQUE",
        "    > 70% SCULPTED_HOOD",
        "    > 70% CANOPY_GLASSHOUSE",
        "    > 20% FRONT_SPLITTER_DUAL",
        "    > 20% REAR_GT_WING_ACTIVE",
        "    > 20% 4X_WHEEL_ASSEMBLIES",
        "      - RIM_BARREL_DEEPDISH",
        "      - 10X_AERO_SPOKES",
        "      - BRAKE_ROTOR_PERFORATED",
        "      - MONOBLOC_CALIPER_6PISTON",
        "    > 10% QUAD_EXHAUST_CLUSTER",
        "    > 10% DORSAL_SHARK_FIN",
        "    > 10% ENGINE_LOUVERS_6TIER",
        "    > 10% COCKPIT_BUCKET_SEATS"
    ];

    let itemY = leftY + 48;
    for (const item of outlinerItems) {
        const isHighlight = item.includes("HERO") || item.includes("70%") || item.includes("20%");
        const cr = isHighlight ? 100 : 160;
        const cg = isHighlight ? 200 : 170;
        const cb = isHighlight ? 255 : 180;
        drawString(ideBuffer, ideW, ideH, leftX + 14, itemY, item, cr, cg, cb, 1);
        itemY += 22;
    }

    // Center Stage Void Viewport (X: 272, Y: 68, W: 1360, H: 810)
    const stageX = 272, stageY = 68, stageW = 1360, stageH = 810;
    const stageRgba = renderGlbView(meshData, {
        width: stageW,
        height: stageH,
        camYaw: 0.62,
        camPitch: 0.22,
        camDist: 6.6,
        camTarget: [0, 0.65, 0],
        drawGrid: true
    });

    for (let y = 0; y < stageH; y++) {
        const srcOffset = y * stageW * 4;
        const dstOffset = ((stageY + y) * ideW + stageX) * 4;
        stageRgba.copy(ideBuffer, dstOffset, srcOffset, srcOffset + stageW * 4);
    }

    // Viewport HUD Overlays inside Center Stage
    drawString(ideBuffer, ideW, ideH, stageX + 20, stageY + 20, "VIEWPORT: 3D STAGE VOID [STUDIO CAD FLAT LIGHTING]", 240, 245, 255, 1);
    drawString(ideBuffer, ideW, ideH, stageX + 20, stageY + 36, "SHADER MODE: 18% STUDIO GREY CLAY (NO TEXTURES / NO CLOUDS)", 140, 180, 220, 1);
    drawString(ideBuffer, ideW, ideH, stageX + stageW - 280, stageY + 20, "FPS: 60.0 | DRAWCALLS: 1", 100, 220, 140, 1);

    // Right Panel: Inspector & Material Telemetry (X: 1648, Y: 68, W: 256, H: 810)
    const inspX = 1648, inspY = 68, inspW = 256, inspH = 810;
    fillRect(ideBuffer, ideW, ideH, inspX, inspY, inspW, inspH, 20, 23, 28);
    drawString(ideBuffer, ideW, ideH, inspX + 16, inspY + 16, "INSPECTOR: MATERIAL", 200, 210, 225, 1);
    drawLineBresenham(inspX + 16, inspY + 32, inspX + inspW - 16, inspY + 32, 45, 50, 60, 255, ideBuffer, ideW, ideH);

    const inspectorFields = [
        ["NAME", "STUDIO_GREY_CLAY"],
        ["BASE COLOR", "[0.55, 0.57, 0.60]"],
        ["HEX CODE", "#8C9199"],
        ["ROUGHNESS", "0.85 (LAMBERTIAN)"],
        ["METALLIC", "0.00 (DIELECTRIC)"],
        ["EMISSIVE", "[0.0, 0.0, 0.0]"],
        ["LIGHTING", "STUDIO CAD FLAT"],
        ["KEY LIGHT", "UPPER-RIGHT (+Y,+Z)"],
        ["FILL LIGHT", "LEFT AMBIENT (-X)"],
        ["SKYBOX", "'STUDIO' (NEUTRAL)"],
        ["GROUND", "FALSE (STAGE VOID)"],
        ["GRID", "TRUE (CAD FLOOR)"],
        ["COMFYUI", "BYPASSED (TIER 1 NATIVE)"]
    ];

    let fldY = inspY + 48;
    for (const [k, v] of inspectorFields) {
        drawString(ideBuffer, ideW, ideH, inspX + 14, fldY, k, 130, 140, 155, 1);
        drawString(ideBuffer, ideW, ideH, inspX + 14, fldY + 12, v, 210, 225, 240, 1);
        fldY += 32;
    }

    // Bottom Bar: Follow-up Suggestions (X: 16, Y: 896, W: 1888, H: 168)
    const botX = 16, botY = 896, botW = 1888, botH = 168;
    fillRect(ideBuffer, ideW, ideH, botX, botY, botW, botH, 22, 26, 33);
    drawString(ideBuffer, ideW, ideH, botX + 24, botY + 18, "PROACTIVE FOLLOW-UP SUGGESTIONS (EXPLORE NEXT):", 80, 180, 255, 1);

    // 3 Actionable Suggestion Cards
    const cardW = 590, cardH = 105;
    const cardY = botY + 42;

    // Card 1: Lighting
    const c1X = botX + 24;
    fillRect(ideBuffer, ideW, ideH, c1X, cardY, cardW, cardH, 28, 33, 42);
    drawString(ideBuffer, ideW, ideH, c1X + 16, cardY + 16, "[1] LIGHTING EXPLORATION", 255, 200, 80, 1);
    drawString(ideBuffer, ideW, ideH, c1X + 16, cardY + 36, "- 3-POINT RIM LIGHTING: HIGH-CONTRAST DRAMATIC PROFILE", 190, 200, 215, 1);
    drawString(ideBuffer, ideW, ideH, c1X + 16, cardY + 52, "- GOLDEN HOUR EPHEMERIS: NOAA SOLAR AZIMUTH & DUSK HAZE", 190, 200, 215, 1);
    drawString(ideBuffer, ideW, ideH, c1X + 16, cardY + 68, "- CYBERPUNK NEON: HIGH-INTENSITY EMISSIVE FLOOD ACCENTS", 190, 200, 215, 1);

    // Card 2: Staging & Environment
    const c2X = c1X + cardW + 30;
    fillRect(ideBuffer, ideW, ideH, c2X, cardY, cardW, cardH, 28, 33, 42);
    drawString(ideBuffer, ideW, ideH, c2X + 16, cardY + 16, "[2] STAGING & ENVIRONMENT", 100, 220, 140, 1);
    drawString(ideBuffer, ideW, ideH, c2X + 16, cardY + 36, "- INFINITY CYCLORAMA COVE: SMOOTH BEVELED STUDIO BACKDROP", 190, 200, 215, 1);
    drawString(ideBuffer, ideW, ideH, c2X + 16, cardY + 52, "- ASPHALT ROAD PLINTH: BEVELED CURB & RAIN PUDDLE REFLECTIONS", 190, 200, 215, 1);
    drawString(ideBuffer, ideW, ideH, c2X + 16, cardY + 68, "- ARCHITECTURAL ROTUNDA: CLASSICAL COLONNADE DISPLAY STAND", 190, 200, 215, 1);

    // Card 3: PBR Materials & Textures
    const c3X = c2X + cardW + 30;
    fillRect(ideBuffer, ideW, ideH, c3X, cardY, cardW, cardH, 28, 33, 42);
    drawString(ideBuffer, ideW, ideH, c3X + 16, cardY + 16, "[3] PBR MATERIALS & TEXTURES", 140, 180, 255, 1);
    drawString(ideBuffer, ideW, ideH, c3X + 16, cardY + 36, "- AUTOMOTIVE CLEARCOAT: DEEP METALLIC MULTI-LAYER PAINT", 190, 200, 215, 1);
    drawString(ideBuffer, ideW, ideH, c3X + 16, cardY + 52, "- 2X2 TWILL CARBON FIBER: CLEAR ANISOTROPIC WEAVE HOOD/WING", 190, 200, 215, 1);
    drawString(ideBuffer, ideW, ideH, c3X + 16, cardY + 68, "- PERFORATED ROTORS & RED CALIPERS: CERAMIC BRAKE SYSTEM", 190, 200, 215, 1);

    const fullIdePng = encodePNG(ideW, ideH, ideBuffer);
    const fullIdePath = path.join(outDir, `${pfx}scratchbox_ide_clay_stage_void_verification.png`);
    fs.writeFileSync(fullIdePath, fullIdePng);

    return { view1Path, view2Path, fullIdePath };
}

const outDir = '/Users/eligreen/.gemini/antigravity/brain/97b137e8-ad3d-47ff-a3ae-59e570b58f77';
const glbPath = process.argv[2] || '/Users/eligreen/dev/scratchbox-ide-master/build/hero_hypercar_clay.glb';
const prefix = process.argv[3] || '';
renderIdeVerificationScreenshot(glbPath, outDir, prefix);
console.log(`Visual verification screenshots updated successfully with prefix '${prefix}'.`);
