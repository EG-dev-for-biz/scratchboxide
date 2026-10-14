/**
 * Structural check for generated models: every part must touch another part or the ground.
 *
 * Scripts usually merge all parts into one mesh, so parts are recovered as connected pieces of the
 * triangle mesh (after welding coincident vertices). Two parts are attached when one's surface comes
 * within `tolerance` of the other's, or when one is embedded in the other (e.g. a rung end inside a leg).
 */

type Vec3 = [number, number, number];
type Mat4 = number[];

export interface TriangleSoup {
    /** World-space positions, xyz per vertex. */
    positions: Float32Array;
    /** Vertex indices, three per triangle. */
    indices: Uint32Array;
    /** Linear RGB per vertex in 0..1: material base color times COLOR_0 when present. */
    colors?: Float32Array;
}

/** A group of parts joined to each other but not to the model's main structure. */
export interface FloatingPart {
    /** Index of the group's first part. */
    part: number;
    partCount: number;
    triangleCount: number;
    /** True when the group stands on the ground by itself (e.g. a leg that never reaches the seat). */
    touchesGround: boolean;
    center: Vec3;
    size: Vec3;
    /** Distance from the group's surface to the main structure's surface (capped at 0.5 m). */
    gapMeters: number;
}

export interface PartConnectivityReport {
    passed: boolean;
    partCount: number;
    attachedPartCount: number;
    toleranceMeters: number;
    floatingParts: FloatingPart[];
    skippedReason?: string;
}

const MAX_TRIANGLES = 600_000;

// ---------------------------------------------------------------------------
// GLB -> world-space triangle soup
// ---------------------------------------------------------------------------

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Mat4, b: Mat4): Mat4 {
    const out = new Array(16).fill(0);
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
            out[col * 4 + row] = sum;
        }
    }
    return out;
}

function nodeMatrix(node: any): Mat4 {
    if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
    const [tx, ty, tz] = node.translation || [0, 0, 0];
    const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale || [1, 1, 1];
    // Column-major T * R * S, as glTF specifies.
    return [
        (1 - 2 * (qy * qy + qz * qz)) * sx, (2 * (qx * qy + qz * qw)) * sx, (2 * (qx * qz - qy * qw)) * sx, 0,
        (2 * (qx * qy - qz * qw)) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, (2 * (qy * qz + qx * qw)) * sy, 0,
        (2 * (qx * qz + qy * qw)) * sz, (2 * (qy * qz - qx * qw)) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
        tx, ty, tz, 1
    ];
}

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function readAccessor(gltf: any, bin: Buffer, index: number): { values: number[]; components: number } {
    const acc = gltf.accessors[index];
    const view = gltf.bufferViews[acc.bufferView];
    const components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[acc.type] || 1;
    const bytes = COMPONENT_BYTES[acc.componentType];
    const stride = view.byteStride || components * bytes;
    const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
    const values: number[] = new Array(acc.count * components);
    for (let i = 0; i < acc.count; i++) {
        for (let c = 0; c < components; c++) {
            const o = base + i * stride + c * bytes;
            switch (acc.componentType) {
                case 5126: values[i * components + c] = bin.readFloatLE(o); break;
                case 5125: values[i * components + c] = bin.readUInt32LE(o); break;
                case 5123: values[i * components + c] = bin.readUInt16LE(o); break;
                case 5121: values[i * components + c] = bin.readUInt8(o); break;
                case 5122: values[i * components + c] = bin.readInt16LE(o); break;
                default: values[i * components + c] = bin.readInt8(o);
            }
        }
    }
    return { values, components };
}

export function glbToTriangleSoup(glb: Buffer): TriangleSoup | null {
    if (glb.length < 28 || glb.toString('utf8', 0, 4) !== 'glTF') return null;
    const jsonLength = glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
    const binStart = 20 + jsonLength + 8;
    const bin = glb.subarray(binStart);
    const positions: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];

    const emitMesh = (meshIndex: number, world: Mat4) => {
        for (const prim of gltf.meshes[meshIndex]?.primitives || []) {
            if (prim.mode !== undefined && prim.mode !== 4) continue; // triangles only
            if (typeof prim.attributes?.POSITION !== 'number') continue;
            const pos = readAccessor(gltf, bin, prim.attributes.POSITION).values;
            const offset = positions.length / 3;
            const base: number[] = gltf.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorFactor || [0.8, 0.8, 0.8, 1];
            const colorAcc = typeof prim.attributes?.COLOR_0 === 'number' ? prim.attributes.COLOR_0 : undefined;
            const vc = colorAcc !== undefined ? readAccessor(gltf, bin, colorAcc) : undefined;
            const vcScale = colorAcc !== undefined ? ({ 5121: 255, 5123: 65535 } as Record<number, number>)[gltf.accessors[colorAcc].componentType] || 1 : 1;
            for (let v = 0; v < pos.length / 3; v++) {
                for (let c = 0; c < 3; c++) {
                    colors.push(base[c] * (vc ? vc.values[v * vc.components + c] / vcScale : 1));
                }
            }
            for (let i = 0; i < pos.length; i += 3) {
                const [x, y, z] = [pos[i], pos[i + 1], pos[i + 2]];
                positions.push(
                    world[0] * x + world[4] * y + world[8] * z + world[12],
                    world[1] * x + world[5] * y + world[9] * z + world[13],
                    world[2] * x + world[6] * y + world[10] * z + world[14]
                );
            }
            const idx = typeof prim.indices === 'number'
                ? readAccessor(gltf, bin, prim.indices).values
                : Array.from({ length: pos.length / 3 }, (_, i) => i);
            for (const v of idx) indices.push(v + offset);
        }
    };
    const visit = (nodeIndex: number, parent: Mat4) => {
        const node = gltf.nodes?.[nodeIndex];
        if (!node) return;
        const world = multiply(parent, nodeMatrix(node));
        if (typeof node.mesh === 'number') emitMesh(node.mesh, world);
        for (const child of node.children || []) visit(child, world);
    };

    const sceneIndex = typeof gltf.scene === 'number' ? gltf.scene : 0;
    const roots: number[] = gltf.scenes?.[sceneIndex]?.nodes
        ?? (gltf.nodes ? gltf.nodes.map((_: any, i: number) => i) : []);
    if (roots.length) {
        roots.forEach(r => visit(r, IDENTITY));
    } else {
        (gltf.meshes || []).forEach((_: any, i: number) => emitMesh(i, IDENTITY));
    }
    return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), colors: Float32Array.from(colors) };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function closestPointDistanceSq(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
    // Ericson, Real-Time Collision Detection 5.1.5
    const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return distSq(p, a);
    const bp = sub(p, b);
    const d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return distSq(p, b);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return distSq(p, add(a, scale(ab, v)));
    }
    const cp = sub(p, c);
    const d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return distSq(p, c);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return distSq(p, add(a, scale(ac, w)));
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return distSq(p, add(b, scale(sub(c, b), w)));
    }
    const denom = 1 / (va + vb + vc);
    const v = vb * denom, w = vc * denom;
    return distSq(p, add(a, add(scale(ab, v), scale(ac, w))));
}

/** Möller–Trumbore along a fixed skewed direction; returns true for a hit at t > 0. */
const RAY_DIR: Vec3 = normalize([1, 0.1234, 0.0567]);
function rayHitsTriangle(o: Vec3, a: Vec3, b: Vec3, c: Vec3): boolean {
    const e1 = sub(b, a), e2 = sub(c, a);
    const h = cross(RAY_DIR, e2);
    const det = dot(e1, h);
    if (Math.abs(det) < 1e-12) return false;
    const f = 1 / det;
    const s = sub(o, a);
    const u = f * dot(s, h);
    if (u < 0 || u > 1) return false;
    const q = cross(s, e1);
    const v = f * dot(RAY_DIR, q);
    if (v < 0 || u + v > 1) return false;
    return f * dot(e2, q) > 1e-9;
}

function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a: Vec3, s: number): Vec3 { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function distSq(a: Vec3, b: Vec3): number { const d = sub(a, b); return dot(d, d); }
function normalize(a: Vec3): Vec3 { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; }

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface Part {
    triangles: number[];
    vertices: number[];
    min: Vec3;
    max: Vec3;
}

export function analyzePartConnectivity(soup: TriangleSoup, options: { toleranceMeters?: number } = {}): PartConnectivityReport {
    const triCount = soup.indices.length / 3;
    const vertexCount = soup.positions.length / 3;
    if (triCount === 0) {
        return { passed: true, partCount: 0, attachedPartCount: 0, toleranceMeters: 0, floatingParts: [] };
    }

    const point = (i: number): Vec3 => [soup.positions[i * 3], soup.positions[i * 3 + 1], soup.positions[i * 3 + 2]];
    let gMin: Vec3 = [Infinity, Infinity, Infinity], gMax: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertexCount; i++) {
        const p = point(i);
        for (let k = 0; k < 3; k++) { gMin[k] = Math.min(gMin[k], p[k]); gMax[k] = Math.max(gMax[k], p[k]); }
    }
    const diagonal = Math.hypot(gMax[0] - gMin[0], gMax[1] - gMin[1], gMax[2] - gMin[2]);
    const tolerance = options.toleranceMeters ?? Math.max(0.002, diagonal * 0.002);
    if (triCount > MAX_TRIANGLES) {
        return { passed: true, partCount: 0, attachedPartCount: 0, toleranceMeters: tolerance, floatingParts: [], skippedReason: `model has ${triCount} triangles (limit ${MAX_TRIANGLES})` };
    }

    // 1. Weld coincident vertices, then union triangles into parts. Neighbouring cells are searched too:
    // rounding alone splits coincident points that straddle a cell boundary (e.g. box faces).
    const weldStep = Math.max(1e-6, tolerance * 0.05);
    const weldCells = new Map<string, number[]>();
    const weldPositions: Vec3[] = [];
    const welded = new Int32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
        const p = point(i);
        const c = [0, 1, 2].map(k => Math.floor(p[k] / weldStep));
        let id = -1;
        for (let dx = -1; dx <= 1 && id < 0; dx++) for (let dy = -1; dy <= 1 && id < 0; dy++) for (let dz = -1; dz <= 1 && id < 0; dz++) {
            for (const candidate of weldCells.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) || []) {
                if (distSq(weldPositions[candidate], p) <= weldStep * weldStep) { id = candidate; break; }
            }
        }
        if (id < 0) {
            id = weldPositions.length;
            weldPositions.push(p);
            const key = `${c[0]},${c[1]},${c[2]}`;
            const list = weldCells.get(key);
            if (list) list.push(id); else weldCells.set(key, [id]);
        }
        welded[i] = id;
    }
    const parent = new Int32Array(weldPositions.length).map((_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let t = 0; t < triCount; t++) {
        union(welded[soup.indices[t * 3]], welded[soup.indices[t * 3 + 1]]);
        union(welded[soup.indices[t * 3]], welded[soup.indices[t * 3 + 2]]);
    }

    const partOfRoot = new Map<number, number>();
    const parts: Part[] = [];
    const triPart = new Int32Array(triCount);
    for (let t = 0; t < triCount; t++) {
        const root = find(welded[soup.indices[t * 3]]);
        let pi = partOfRoot.get(root);
        if (pi === undefined) {
            pi = parts.length;
            partOfRoot.set(root, pi);
            parts.push({ triangles: [], vertices: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
        }
        triPart[t] = pi;
        const part = parts[pi];
        part.triangles.push(t);
        for (let k = 0; k < 3; k++) {
            const v = soup.indices[t * 3 + k];
            part.vertices.push(v);
            const p = point(v);
            for (let a = 0; a < 3; a++) { part.min[a] = Math.min(part.min[a], p[a]); part.max[a] = Math.max(part.max[a], p[a]); }
        }
    }
    for (const part of parts) part.vertices = Array.from(new Set(part.vertices));

    // 2. Spatial grid of triangles for proximity queries.
    const cell = Math.max(tolerance * 4, diagonal / 96);
    const grid = new Map<string, number[]>();
    const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`;
    for (let t = 0; t < triCount; t++) {
        const [a, b, c] = [point(soup.indices[t * 3]), point(soup.indices[t * 3 + 1]), point(soup.indices[t * 3 + 2])];
        const lo = [0, 1, 2].map(k => Math.floor((Math.min(a[k], b[k], c[k]) - tolerance) / cell));
        const hi = [0, 1, 2].map(k => Math.floor((Math.max(a[k], b[k], c[k]) + tolerance) / cell));
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
            const key = cellKey(x, y, z);
            const list = grid.get(key);
            if (list) list.push(t); else grid.set(key, [t]);
        }
    }
    const triangle = (t: number): [Vec3, Vec3, Vec3] => [point(soup.indices[t * 3]), point(soup.indices[t * 3 + 1]), point(soup.indices[t * 3 + 2])];

    // 3. Contact graph between parts (surface proximity), plus ground contact.
    const adjacency: Set<number>[] = parts.map(() => new Set<number>());
    const link = (a: number, b: number) => { adjacency[a].add(b); adjacency[b].add(a); };
    const tolSq = tolerance * tolerance;
    parts.forEach((part, pi) => {
        for (const v of part.vertices) {
            const p = point(v);
            const list = grid.get(cellKey(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)));
            if (!list) continue;
            for (const t of list) {
                const qi = triPart[t];
                if (qi === pi || adjacency[pi].has(qi)) continue;
                const [a, b, c] = triangle(t);
                if (closestPointDistanceSq(p, a, b, c) <= tolSq) link(pi, qi);
            }
        }
    });

    // 4. Embedding: a part with a vertex inside another (closed) part counts as attached.
    const boxesOverlap = (a: Part, b: Part) => [0, 1, 2].every(k => a.min[k] <= b.max[k] + tolerance && b.min[k] <= a.max[k] + tolerance);
    const isInside = (p: Vec3, part: Part) => {
        let hits = 0;
        for (const t of part.triangles) { const [a, b, c] = triangle(t); if (rayHitsTriangle(p, a, b, c)) hits++; }
        return hits % 2 === 1;
    };
    parts.forEach((part, pi) => {
        parts.forEach((other, qi) => {
            if (qi === pi || adjacency[pi].has(qi) || !boxesOverlap(part, other)) return;
            const step = Math.max(1, Math.floor(part.vertices.length / 48));
            for (let i = 0; i < part.vertices.length; i += step) {
                if (isInside(point(part.vertices[i]), other)) { link(pi, qi); return; }
            }
        });
    });

    // 5. Structures are groups of parts joined by contact. The ground does not join them: a leg that
    // stands on the floor but never reaches the seat is a separate structure, not an attached part.
    const groundY = gMin[1];
    const structureOf = new Int32Array(parts.length).fill(-1);
    const structures: number[][] = [];
    parts.forEach((_, pi) => {
        if (structureOf[pi] >= 0) return;
        const members: number[] = [];
        const stack = [pi];
        structureOf[pi] = structures.length;
        while (stack.length) {
            const cur = stack.pop()!;
            members.push(cur);
            for (const qi of adjacency[cur]) if (structureOf[qi] < 0) { structureOf[qi] = structures.length; stack.push(qi); }
        }
        structures.push(members);
    });
    const trianglesIn = (members: number[]) => members.reduce((n, pi) => n + parts[pi].triangles.length, 0);
    const mainIndex = structures.reduce((best, members, i) => (trianglesIn(members) > trianglesIn(structures[best]) ? i : best), 0);
    const attached = new Set<number>(structures[mainIndex]);
    const mainTriangles = structures[mainIndex].flatMap(pi => parts[pi].triangles);
    const groups = structures.filter((_, i) => i !== mainIndex);

    // 6. Report every other structure with its real gap to the main structure.
    const SEARCH_RADIUS = 0.5;
    const floatingParts: FloatingPart[] = groups.map(members => {
        const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
        let triangleCount = 0;
        const samples: Vec3[] = [];
        for (const pi of members) {
            const part = parts[pi];
            triangleCount += part.triangles.length;
            for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], part.min[k]); max[k] = Math.max(max[k], part.max[k]); }
            const step = Math.max(1, Math.floor(part.vertices.length / 64));
            for (let i = 0; i < part.vertices.length; i += step) samples.push(point(part.vertices[i]));
        }
        let best = Infinity;
        const sampleStep = Math.max(1, Math.ceil((samples.length * mainTriangles.length) / 4_000_000));
        for (let s = 0; s < samples.length; s += sampleStep) {
            for (const t of mainTriangles) {
                const [a, b, c] = triangle(t);
                const d = closestPointDistanceSq(samples[s], a, b, c);
                if (d < best) best = d; // degenerate triangles yield NaN; skip them
            }
        }
        const gap = Math.sqrt(best);
        return {
            part: members[0],
            partCount: members.length,
            triangleCount,
            touchesGround: min[1] <= groundY + tolerance,
            center: [0, 1, 2].map(k => +((min[k] + max[k]) / 2).toFixed(3)) as Vec3,
            size: [0, 1, 2].map(k => +(max[k] - min[k]).toFixed(3)) as Vec3,
            gapMeters: Number.isFinite(gap) ? +Math.min(gap, SEARCH_RADIUS).toFixed(3) : SEARCH_RADIUS
        };
    }).sort((a, b) => b.triangleCount - a.triangleCount);

    return {
        passed: floatingParts.length === 0,
        partCount: parts.length,
        attachedPartCount: attached.size,
        toleranceMeters: +tolerance.toFixed(4),
        floatingParts: floatingParts.slice(0, 12)
    };
}

/** One-paragraph instruction for the model when parts float; undefined when the model is connected. */
export function describeFloatingParts(report: PartConnectivityReport): string | undefined {
    if (report.passed || report.skippedReason) return undefined;
    const list = report.floatingParts.slice(0, 6)
        .map(f => `a ${f.partCount > 1 ? `group of ${f.partCount} pieces` : 'piece'} centred at [${f.center.join(', ')}] sized [${f.size.join(', ')}] m ` +
            (f.touchesGround ? 'stands on the ground by itself, ' : 'floats, ') +
            (f.gapMeters >= 0.5 ? 'more than 50 cm from the main structure' : `${(f.gapMeters * 100).toFixed(1)} cm from the main structure`))
        .join('; ');
    const groupCount = report.floatingParts.length;
    return `Structural check failed: the model is ${groupCount + 1} separate structures instead of one; ${groupCount === 1 ? 'this group is' : 'these groups are'} not joined to the main structure: ${list}. ` +
        'Unless these parts are meant to be separate objects, fix the script so every member meets what it should attach to: ' +
        'compute joint points once and build members between them (sb.sweep_curve_profile(path=[start, end])), instead of rotating parts about the origin.';
}
