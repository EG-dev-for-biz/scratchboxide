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
    /** Separate structures (groups of touching parts), the main one included; 0 when the check was skipped or empty. */
    structureCount: number;
    toleranceMeters: number;
    floatingParts: FloatingPart[];
    skippedReason?: string;
    /** With `withGraph`: the welded piece each triangle belongs to, and which pieces touch or are embedded in which. */
    graph?: ContactGraph;
}

export interface ContactGraph {
    /** Piece index of each triangle (a piece is a set of triangles joined by shared, welded vertices). */
    trianglePiece: Int32Array;
    /** For each piece, the pieces it touches (within the tolerance) or is embedded in, or that are embedded in it. */
    touching: number[][];
}

const MAX_TRIANGLES = 600_000;
/** Floating groups reported (and measured), largest first. */
const REPORTED_GROUPS = 12;
/** Upper bound on triangle entries in the embedding test's 2D grid (memory), reached by coarsening the grid. */
const MAX_RAY_GRID_ENTRIES = 12_000_000;

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

/**
 * Values read, or vertices transformed, between yield points inside one accessor or primitive of the GLB reader; it
 * also yields after every primitive, since a tile can hold hundreds of small ones.
 */
const READ_PER_YIELD = 1 << 13;

/** An accessor's values as numbers, read through a DataView (sparse accessors and normalisation are not applied). */
function* readAccessor(gltf: any, bin: DataView, index: number): Generator<void, { values: Float64Array; components: number }, void> {
    const acc = gltf.accessors[index];
    const view = gltf.bufferViews[acc.bufferView];
    const components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[acc.type] || 1;
    const bytes = COMPONENT_BYTES[acc.componentType];
    const stride = view.byteStride || components * bytes;
    const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
    const get: (offset: number) => number =
        acc.componentType === 5126 ? o => bin.getFloat32(o, true)
            : acc.componentType === 5125 ? o => bin.getUint32(o, true)
                : acc.componentType === 5123 ? o => bin.getUint16(o, true)
                    : acc.componentType === 5121 ? o => bin.getUint8(o)
                        : acc.componentType === 5122 ? o => bin.getInt16(o, true)
                            : o => bin.getInt8(o);
    const values = new Float64Array(acc.count * components);
    for (let i = 0; i < acc.count; i++) {
        const o = base + i * stride;
        for (let c = 0; c < components; c++) values[i * components + c] = get(o + c * bytes);
        if (i % READ_PER_YIELD === READ_PER_YIELD - 1) yield;
    }
    return { values, components };
}

/** One soup being assembled: each primitive's arrays, joined once at the end. */
interface SoupSink {
    positions: Float32Array[];
    indices: Uint32Array[];
    /** Left out when only geometry is wanted. */
    colors?: Float32Array[];
    vertexCount: number;
}

const newSink = (colors: boolean): SoupSink => ({ positions: [], indices: [], ...(colors ? { colors: [] } : {}), vertexCount: 0 });

/**
 * Walks the GLB's default scene and appends each mesh primitive, in world space, to the sink `sinkFor` picks
 * for its node (named by the node, else its mesh). Returns false when the buffer is not a GLB. Yields about every
 * READ_PER_YIELD values, so a large model can be read in slices.
 */
function* walkGlbTriangles(glb: Buffer, sinkFor: (name: string) => SoupSink): Generator<void, boolean, void> {
    if (glb.length < 28 || glb.toString('utf8', 0, 4) !== 'glTF') return false;
    const jsonLength = glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
    const binStart = 20 + jsonLength + 8;
    const bin = new DataView(glb.buffer, glb.byteOffset + binStart, Math.max(0, glb.length - binStart));

    function* emitMesh(meshIndex: number, world: Mat4, sink: SoupSink): Generator<void, void, void> {
        for (const prim of gltf.meshes[meshIndex]?.primitives || []) {
            if (prim.mode !== undefined && prim.mode !== 4) continue; // triangles only
            if (typeof prim.attributes?.POSITION !== 'number') continue;
            const pos = (yield* readAccessor(gltf, bin, prim.attributes.POSITION)).values;
            const vertexCount = pos.length / 3;
            const offset = sink.vertexCount;
            if (sink.colors) {
                const base: number[] = gltf.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorFactor || [0.8, 0.8, 0.8, 1];
                const colorAcc = typeof prim.attributes?.COLOR_0 === 'number' ? prim.attributes.COLOR_0 : undefined;
                const vc = colorAcc !== undefined ? yield* readAccessor(gltf, bin, colorAcc) : undefined;
                const vcScale = colorAcc !== undefined ? ({ 5121: 255, 5123: 65535 } as Record<number, number>)[gltf.accessors[colorAcc].componentType] || 1 : 1;
                const colors = new Float32Array(vertexCount * 3);
                for (let v = 0; v < vertexCount; v++) {
                    for (let c = 0; c < 3; c++) colors[v * 3 + c] = base[c] * (vc ? vc.values[v * vc.components + c] / vcScale : 1);
                    if (v % READ_PER_YIELD === READ_PER_YIELD - 1) yield;
                }
                sink.colors.push(colors);
            }
            const positions = new Float32Array(vertexCount * 3);
            for (let i = 0; i < pos.length; i += 3) {
                const x = pos[i], y = pos[i + 1], z = pos[i + 2];
                positions[i] = world[0] * x + world[4] * y + world[8] * z + world[12];
                positions[i + 1] = world[1] * x + world[5] * y + world[9] * z + world[13];
                positions[i + 2] = world[2] * x + world[6] * y + world[10] * z + world[14];
                if (i % (READ_PER_YIELD * 3) === READ_PER_YIELD * 3 - 3) yield;
            }
            sink.positions.push(positions);
            let indices: Uint32Array;
            if (typeof prim.indices === 'number') {
                const idx = (yield* readAccessor(gltf, bin, prim.indices)).values;
                indices = new Uint32Array(idx.length);
                for (let i = 0; i < idx.length; i++) {
                    indices[i] = idx[i] + offset;
                    if (i % READ_PER_YIELD === READ_PER_YIELD - 1) yield;
                }
            } else {
                indices = new Uint32Array(vertexCount);
                for (let i = 0; i < vertexCount; i++) indices[i] = i + offset;
            }
            sink.indices.push(indices);
            sink.vertexCount += vertexCount;
            yield;
        }
    }
    const meshName = (meshIndex: number) => String(gltf.meshes?.[meshIndex]?.name ?? `mesh_${meshIndex}`);
    function* visit(nodeIndex: number, parent: Mat4): Generator<void, void, void> {
        const node = gltf.nodes?.[nodeIndex];
        if (!node) return;
        const world = multiply(parent, nodeMatrix(node));
        if (typeof node.mesh === 'number') yield* emitMesh(node.mesh, world, sinkFor(typeof node.name === 'string' && node.name ? node.name : meshName(node.mesh)));
        for (const child of node.children || []) yield* visit(child, world);
    }

    const sceneIndex = typeof gltf.scene === 'number' ? gltf.scene : 0;
    const roots: number[] = gltf.scenes?.[sceneIndex]?.nodes
        ?? (gltf.nodes ? gltf.nodes.map((_: any, i: number) => i) : []);
    if (roots.length) {
        for (const r of roots) yield* visit(r, IDENTITY);
    } else {
        for (let i = 0; i < (gltf.meshes || []).length; i++) yield* emitMesh(i, IDENTITY, sinkFor(meshName(i)));
    }
    return true;
}

function concat<T extends Float32Array | Uint32Array>(chunks: T[], make: (length: number) => T): T {
    const out = make(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
}

function toSoup(sink: SoupSink): TriangleSoup {
    const soup: TriangleSoup = { positions: concat(sink.positions, n => new Float32Array(n)), indices: concat(sink.indices, n => new Uint32Array(n)) };
    if (sink.colors) soup.colors = concat(sink.colors, n => new Float32Array(n));
    return soup;
}

/** Runs a sliced computation straight through. */
export function runToEnd<T>(steps: Generator<void, T, void>): T {
    for (;;) {
        const step = steps.next();
        if (step.done) return step.value;
    }
}

/**
 * Runs a sliced computation, giving the event loop back every `sliceMs` (about 20 ms) so a server stays responsive,
 * and stopping with `abortError()` as soon as `signal` is aborted.
 */
export async function runInSlices<T>(
    steps: Generator<void, T, void>,
    options: { signal?: AbortSignal; sliceMs?: number; abortError?: () => Error } = {}
): Promise<T> {
    const sliceMs = options.sliceMs ?? 20;
    let sliceStart = Date.now();
    for (;;) {
        if (options.signal?.aborted) throw options.abortError?.() ?? new Error('Stopped.');
        const step = steps.next();
        if (step.done) return step.value;
        if (Date.now() - sliceStart >= sliceMs) {
            await new Promise<void>(resolve => setImmediate(resolve));
            sliceStart = Date.now();
        }
    }
}

function* soupSteps(glb: Buffer, colors: boolean): Generator<void, TriangleSoup | null, void> {
    const sink = newSink(colors);
    return (yield* walkGlbTriangles(glb, () => sink)) ? toSoup(sink) : null;
}

/** The GLB as one world-space soup; `colors: false` skips reading vertex colours when only geometry is needed. */
export function glbToTriangleSoup(glb: Buffer, options: { colors?: boolean } = {}): TriangleSoup | null {
    return runToEnd(soupSteps(glb, options.colors !== false));
}

/** The same, read in slices of about `sliceMs` so a large model does not hold up the event loop. */
export function glbToTriangleSoupAsync(
    glb: Buffer,
    options: { colors?: boolean; signal?: AbortSignal; sliceMs?: number; abortError?: () => Error } = {}
): Promise<TriangleSoup | null> {
    return runInSlices(soupSteps(glb, options.colors !== false), options);
}

/**
 * One world-space soup per node name (the node's name, else its mesh's), in the order first seen; nodes that share
 * a name are merged. Null when the buffer is not a GLB.
 */
export function glbToNamedTriangleSoups(glb: Buffer): Map<string, TriangleSoup> | null {
    return runToEnd(namedSoupSteps(glb));
}

/** The same, read in slices of about `sliceMs`. */
export function glbToNamedTriangleSoupsAsync(
    glb: Buffer,
    options: { signal?: AbortSignal; sliceMs?: number; abortError?: () => Error } = {}
): Promise<Map<string, TriangleSoup> | null> {
    return runInSlices(namedSoupSteps(glb), options);
}

function* namedSoupSteps(glb: Buffer): Generator<void, Map<string, TriangleSoup> | null, void> {
    const sinks = new Map<string, SoupSink>();
    const ok = yield* walkGlbTriangles(glb, name => {
        let sink = sinks.get(name);
        if (!sink) sinks.set(name, sink = newSink(true));
        return sink;
    });
    if (!ok) return null;
    return new Map([...sinks].map(([name, sink]) => [name, toSoup(sink)]));
}

/** Several soups as one (indices offset, colors kept when every soup has them). */
export function mergeTriangleSoups(soups: TriangleSoup[]): TriangleSoup {
    const vertexTotal = soups.reduce((n, s) => n + s.positions.length / 3, 0);
    const positions = new Float32Array(vertexTotal * 3);
    const indices = new Uint32Array(soups.reduce((n, s) => n + s.indices.length, 0));
    const withColors = soups.every(s => s.colors && s.colors.length === s.positions.length);
    const colors = withColors ? new Float32Array(vertexTotal * 3) : undefined;
    let v = 0, t = 0;
    for (const s of soups) {
        positions.set(s.positions, v * 3);
        if (colors && s.colors) colors.set(s.colors, v * 3);
        for (let i = 0; i < s.indices.length; i++) indices[t + i] = s.indices[i] + v;
        v += s.positions.length / 3;
        t += s.indices.length;
    }
    return colors ? { positions, indices, colors } : { positions, indices };
}

// ---------------------------------------------------------------------------
// Geometry helpers (scalar, reading the soup in place: the analysis calls them millions of times)
// ---------------------------------------------------------------------------

/** Squared distance from (px, py, pz) to triangle t of the soup (Ericson, Real-Time Collision Detection 5.1.5). */
function closestDistSq(P: Float32Array, I: Uint32Array, t: number, px: number, py: number, pz: number): number {
    const ia = I[t * 3] * 3, ib = I[t * 3 + 1] * 3, ic = I[t * 3 + 2] * 3;
    const ax = P[ia], ay = P[ia + 1], az = P[ia + 2];
    const abx = P[ib] - ax, aby = P[ib + 1] - ay, abz = P[ib + 2] - az;
    const acx = P[ic] - ax, acy = P[ic + 1] - ay, acz = P[ic + 2] - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
    const bpx = px - P[ib], bpy = py - P[ib + 1], bpz = pz - P[ib + 2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return lengthSq(apx - v * abx, apy - v * aby, apz - v * abz);
    }
    const cpx = px - P[ic], cpy = py - P[ic + 1], cpz = pz - P[ic + 2];
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return lengthSq(apx - w * acx, apy - w * acy, apz - w * acz);
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return lengthSq(bpx - w * (P[ic] - P[ib]), bpy - w * (P[ic + 1] - P[ib + 1]), bpz - w * (P[ic + 2] - P[ib + 2]));
    }
    const denom = 1 / (va + vb + vc);
    const v = vb * denom, w = vc * denom;
    return lengthSq(apx - v * abx - w * acx, apy - v * aby - w * acy, apz - v * abz - w * acz);
}

/** Möller–Trumbore along a fixed skewed direction; true for a hit at t > 0. */
const RAY_DIR: Vec3 = normalize([1, 0.1234, 0.0567]);
function rayHitsTriangle(P: Float32Array, I: Uint32Array, t: number, ox: number, oy: number, oz: number): boolean {
    const [rx, ry, rz] = RAY_DIR;
    const ia = I[t * 3] * 3, ib = I[t * 3 + 1] * 3, ic = I[t * 3 + 2] * 3;
    const ax = P[ia], ay = P[ia + 1], az = P[ia + 2];
    const e1x = P[ib] - ax, e1y = P[ib + 1] - ay, e1z = P[ib + 2] - az;
    const e2x = P[ic] - ax, e2y = P[ic + 1] - ay, e2z = P[ic + 2] - az;
    const hx = ry * e2z - rz * e2y, hy = rz * e2x - rx * e2z, hz = rx * e2y - ry * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-12) return false;
    const f = 1 / det;
    const sx = ox - ax, sy = oy - ay, sz = oz - az;
    const u = f * (sx * hx + sy * hy + sz * hz);
    if (u < 0 || u > 1) return false;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = f * (rx * qx + ry * qy + rz * qz);
    if (v < 0 || u + v > 1) return false;
    return f * (e2x * qx + e2y * qy + e2z * qz) > 1e-9;
}

function lengthSq(x: number, y: number, z: number): number { return x * x + y * y + z * z; }
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize(a: Vec3): Vec3 { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; }

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Cells of size `step` over the box [min, max] with one spare cell on every side, keyed by integers (string keys
 * made the analysis several times slower). Cell indices are clamped to the padded box.
 */
function cellGrid(min: Vec3, max: Vec3, step: number): { cell: (value: number, axis: number) => number; key: (x: number, y: number, z: number) => number } {
    const n = [0, 1, 2].map(k => Math.floor((max[k] - min[k]) / step) + 3);
    return {
        cell: (value, axis) => Math.min(n[axis] - 1, Math.max(0, Math.floor((value - min[axis]) / step) + 1)),
        key: (x, y, z) => x + n[0] * (y + n[1] * z)
    };
}

/**
 * Triangle lists per cell in one flat array (cell c holds triangles[start[c]..start[c + 1]]). The triangles are given
 * piece by piece, so each cell lists a piece's triangles together and `runEnd[j]` jumps past every triangle of the
 * piece at j: a piece the query point belongs to, or is already joined to, is skipped in one step however many of its
 * triangles share the cell.
 */
interface PieceSortedCells {
    start: Int32Array;
    triangles: Int32Array;
    runEnd: Int32Array;
}

/** Undefined when the lists would hold more than `maxEntries` entries. */
function* pieceSortedCells(
    byPiece: Int32Array,
    cellsOf: (t: number, visit: (cell: number) => void) => void,
    triPart: Int32Array,
    spend: (cost: number) => boolean,
    /** The number of cells when known; otherwise cellsOf numbers cells from 0 as it meets them. */
    knownCellCount?: number,
    maxEntries = Infinity
): Generator<void, PieceSortedCells | undefined, void> {
    const counts: number[] | Int32Array = knownCellCount !== undefined ? new Int32Array(knownCellCount) : [];
    let entries = 0;
    for (let i = 0; i < byPiece.length; i++) {
        const before = entries;
        cellsOf(byPiece[i], c => { counts[c] = (counts[c] ?? 0) + 1; entries++; });
        if (entries > maxEntries) return undefined;
        if (spend(1 + entries - before)) yield;
    }
    const cellCount = knownCellCount ?? counts.length;
    const start = new Int32Array(cellCount + 1);
    for (let c = 0; c < cellCount; c++) start[c + 1] = start[c] + (counts[c] ?? 0);
    const triangles = new Int32Array(start[cellCount]);
    const fill = start.slice(0, cellCount);
    for (let i = 0; i < byPiece.length; i++) {
        const t = byPiece[i];
        let visits = 1;
        cellsOf(t, c => { triangles[fill[c]++] = t; visits++; });
        if (spend(visits)) yield;
    }
    const runEnd = new Int32Array(triangles.length);
    for (let c = 0; c < cellCount; c++) {
        const from = start[c], to = start[c + 1];
        if (spend((to - from) >> 3)) yield;
        for (let j = to - 1; j >= from; j--) {
            runEnd[j] = j + 1 < to && triPart[triangles[j + 1]] === triPart[triangles[j]] ? runEnd[j + 1] : j + 1;
        }
    }
    return { start, triangles, runEnd };
}

interface Part {
    triangles: number[];
    vertices: number[];
    min: Vec3;
    max: Vec3;
}

export interface PartConnectivityOptions {
    toleranceMeters?: number;
    withGraph?: boolean;
}

/** Thrown by analyzePartConnectivityAsync when its signal is aborted. */
export class ConnectivityAnalysisAbortedError extends Error {
    constructor() {
        super('The part connectivity analysis was stopped.');
        this.name = 'ConnectivityAnalysisAbortedError';
    }
}

/** Units of work (about one triangle or vertex test each) between the analysis's yield points. */
const WORK_PER_YIELD = 20_000;

/** Synchronous analysis (scripts' structural check, tests). Large models are better measured with the async form. */
export function analyzePartConnectivity(soup: TriangleSoup, options: PartConnectivityOptions = {}): PartConnectivityReport {
    return runToEnd(analysisSteps(soup, options));
}

/**
 * The same analysis, giving the event loop back every `sliceMs` (about 20 ms) so a server stays responsive while a
 * large model is measured, and stopping with ConnectivityAnalysisAbortedError as soon as `signal` is aborted.
 */
export function analyzePartConnectivityAsync(
    soup: TriangleSoup,
    options: PartConnectivityOptions & { signal?: AbortSignal; sliceMs?: number } = {}
): Promise<PartConnectivityReport> {
    return runInSlices(analysisSteps(soup, options), { ...options, abortError: () => new ConnectivityAnalysisAbortedError() });
}

/**
 * The analysis as a generator that yields about every WORK_PER_YIELD units of work, so callers decide whether to run
 * it straight through or in slices. Proximity uses a 3D grid and embedding casts one ray per sample against a 2D grid
 * of triangles seen along the ray; both grids keep each cell's triangles grouped by piece, so pieces that need no
 * test are skipped whole. Only the reported floating groups are measured.
 */
function* analysisSteps(soup: TriangleSoup, options: PartConnectivityOptions): Generator<void, PartConnectivityReport, void> {
    const P = soup.positions, I = soup.indices;
    const triCount = I.length / 3;
    const vertexCount = P.length / 3;
    if (triCount === 0) {
        return { passed: true, partCount: 0, attachedPartCount: 0, structureCount: 0, toleranceMeters: 0, floatingParts: [] };
    }
    let work = 0;
    /** Adds `cost` units of work; true when a yield point is due. */
    const spend = (cost: number): boolean => {
        work += cost;
        if (work < WORK_PER_YIELD) return false;
        work = 0;
        return true;
    };

    const gMin: Vec3 = [Infinity, Infinity, Infinity], gMax: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertexCount * 3; i += 3) {
        for (let k = 0; k < 3; k++) { gMin[k] = Math.min(gMin[k], P[i + k]); gMax[k] = Math.max(gMax[k], P[i + k]); }
    }
    const diagonal = Math.hypot(gMax[0] - gMin[0], gMax[1] - gMin[1], gMax[2] - gMin[2]);
    const tolerance = options.toleranceMeters ?? Math.max(0.002, diagonal * 0.002);
    if (triCount > MAX_TRIANGLES) {
        return { passed: true, partCount: 0, attachedPartCount: 0, structureCount: 0, toleranceMeters: tolerance, floatingParts: [], skippedReason: `model has ${triCount} triangles (limit ${MAX_TRIANGLES})` };
    }

    // 1. Weld coincident vertices, then union triangles into parts. Neighbouring cells are searched too:
    // rounding alone splits coincident points that straddle a cell boundary (e.g. box faces).
    // At most 1e5 weld cells along any axis keeps the integer cell keys exact.
    const weldStep = Math.max(1e-6, tolerance * 0.05, Math.max(gMax[0] - gMin[0], gMax[1] - gMin[1], gMax[2] - gMin[2]) / 1e5);
    const weldStepSq = weldStep * weldStep;
    // Cells twice the weld distance across: a point's weld sphere then reaches at most one neighbour per axis.
    const weldCell = weldStep * 2;
    const weldGrid = cellGrid(gMin, gMax, weldCell);
    const weldCells = new Map<number, number[]>();
    const weldPositions = new Float64Array(vertexCount * 3);
    let weldCount = 0;
    const welded = new Int32Array(vertexCount);
    const weldIn = (key: number, x: number, y: number, z: number): number => {
        const list = weldCells.get(key);
        if (!list) return -1;
        for (const c of list) {
            if (lengthSq(weldPositions[c * 3] - x, weldPositions[c * 3 + 1] - y, weldPositions[c * 3 + 2] - z) <= weldStepSq) return c;
        }
        return -1;
    };
    // The point's own cell first (where a coincident vertex almost always is), then the neighbour on the near side of
    // each axis.
    const nearSide = (value: number, axis: number) => (((value - gMin[axis]) / weldCell) % 1 < 0.5 ? -1 : 1);
    for (let i = 0; i < vertexCount; i++) {
        if (spend(4)) yield;
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        const cx = weldGrid.cell(x, 0), cy = weldGrid.cell(y, 1), cz = weldGrid.cell(z, 2);
        const own = weldGrid.key(cx, cy, cz);
        const sx = nearSide(x, 0), sy = nearSide(y, 1), sz = nearSide(z, 2);
        let id = weldIn(own, x, y, z);
        for (let n = 1; n < 8 && id < 0; n++) {
            id = weldIn(weldGrid.key(cx + (n & 1 ? sx : 0), cy + (n & 2 ? sy : 0), cz + (n & 4 ? sz : 0)), x, y, z);
        }
        if (id < 0) {
            id = weldCount++;
            weldPositions[id * 3] = x; weldPositions[id * 3 + 1] = y; weldPositions[id * 3 + 2] = z;
            const list = weldCells.get(own);
            if (list) list.push(id); else weldCells.set(own, [id]);
        }
        welded[i] = id;
    }
    const parent = new Int32Array(weldCount).map((_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let t = 0; t < triCount; t++) {
        if (spend(2)) yield;
        union(welded[I[t * 3]], welded[I[t * 3 + 1]]);
        union(welded[I[t * 3]], welded[I[t * 3 + 2]]);
    }

    // A vertex index belongs to exactly one part (every triangle using it is joined through it), so each part's
    // vertices are listed once, in the order first met.
    const partOfRoot = new Int32Array(weldCount).fill(-1);
    const parts: Part[] = [];
    const triPart = new Int32Array(triCount);
    const listed = new Uint8Array(vertexCount);
    for (let t = 0; t < triCount; t++) {
        if (spend(3)) yield;
        const root = find(welded[I[t * 3]]);
        let pi = partOfRoot[root];
        if (pi < 0) {
            pi = partOfRoot[root] = parts.length;
            parts.push({ triangles: [], vertices: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
        }
        triPart[t] = pi;
        const part = parts[pi];
        part.triangles.push(t);
        for (let k = 0; k < 3; k++) {
            const v = I[t * 3 + k];
            if (listed[v]) continue;
            listed[v] = 1;
            part.vertices.push(v);
            for (let a = 0; a < 3; a++) { part.min[a] = Math.min(part.min[a], P[v * 3 + a]); part.max[a] = Math.max(part.max[a], P[v * 3 + a]); }
        }
    }

    // 2. Spatial grid of triangles for proximity queries.
    const cell = Math.max(tolerance * 4, diagonal / 96);
    const triGrid = cellGrid(gMin, gMax, cell);
    const cellIndex = new Map<number, number>();
    const triCells = (t: number, visit: (cell: number) => void) => {
        const ia = I[t * 3] * 3, ib = I[t * 3 + 1] * 3, ic = I[t * 3 + 2] * 3;
        const lo = [0, 1, 2].map(k => triGrid.cell(Math.min(P[ia + k], P[ib + k], P[ic + k]) - tolerance, k));
        const hi = [0, 1, 2].map(k => triGrid.cell(Math.max(P[ia + k], P[ib + k], P[ic + k]) + tolerance, k));
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
            const key = triGrid.key(x, y, z);
            let c = cellIndex.get(key);
            if (c === undefined) cellIndex.set(key, c = cellIndex.size);
            visit(c);
        }
    };
    const allByPiece = new Int32Array(triCount);
    let filled = 0;
    for (const part of parts) for (const t of part.triangles) allByPiece[filled++] = t;
    const grid = (yield* pieceSortedCells(allByPiece, triCells, triPart, spend))!;

    // 3. Contact graph between parts (surface proximity).
    const adjacency: Set<number>[] = parts.map(() => new Set<number>());
    const link = (a: number, b: number) => { adjacency[a].add(b); adjacency[b].add(a); };
    const tolSq = tolerance * tolerance;
    for (let pi = 0; pi < parts.length; pi++) {
        const near = adjacency[pi];
        for (const v of parts[pi].vertices) {
            const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
            const c = cellIndex.get(triGrid.key(triGrid.cell(x, 0), triGrid.cell(y, 1), triGrid.cell(z, 2)));
            let cost = 1;
            if (c !== undefined) {
                for (let j = grid.start[c]; j < grid.start[c + 1];) {
                    const qi = triPart[grid.triangles[j]];
                    const end = grid.runEnd[j];
                    cost++;
                    if (qi !== pi && !near.has(qi)) {
                        for (let k = j; k < end; k++) {
                            cost++;
                            if (closestDistSq(P, I, grid.triangles[k], x, y, z) <= tolSq) { link(pi, qi); break; }
                        }
                    }
                    j = end;
                }
            }
            if (spend(cost)) yield;
        }
    }

    // 4. Embedding: a part with a vertex inside another (closed) part counts as attached. Only parts whose boxes
    // overlap a part they are not yet joined to can gain a link here, so only they take part (a sweep along x finds
    // them). Each of their sample vertices casts one ray along RAY_DIR and counts its crossings with each such part (an
    // odd count means inside it). Only triangles whose projection along the ray covers the sample's projection can be
    // crossed, so those triangles are binned on a 2D grid in the plane across the ray.
    const candidate = new Uint8Array(parts.length);
    let candidateTriangles = 0;
    const byMinX = parts.map((_, i) => i).sort((a, b) => parts[a].min[0] - parts[b].min[0]);
    for (let i = 0; i < byMinX.length; i++) {
        const pa = byMinX[i], a = parts[pa];
        for (let j = i + 1; j < byMinX.length; j++) {
            const pb = byMinX[j], b = parts[pb];
            if (b.min[0] > a.max[0] + tolerance) break;
            if (spend(1)) yield;
            if (b.min[1] > a.max[1] + tolerance || a.min[1] > b.max[1] + tolerance || b.min[2] > a.max[2] + tolerance || a.min[2] > b.max[2] + tolerance) continue;
            if (adjacency[pa].has(pb)) continue;
            for (const pc of [pa, pb]) {
                if (!candidate[pc]) { candidate[pc] = 1; candidateTriangles += parts[pc].triangles.length; }
            }
        }
    }
    if (candidateTriangles > 0) {
        const tested = new Int32Array(candidateTriangles);
        let n = 0;
        for (let pi = 0; pi < parts.length; pi++) if (candidate[pi]) for (const t of parts[pi].triangles) tested[n++] = t;
        const axisU = normalize(cross(RAY_DIR, [0, 1, 0]));
        const axisV = cross(RAY_DIR, axisU);
        const pu = new Float64Array(vertexCount), pv = new Float64Array(vertexCount);
        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (let i = 0; i < vertexCount; i++) {
            if (spend(1)) yield;
            const p: Vec3 = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
            pu[i] = dot(p, axisU); pv[i] = dot(p, axisV);
            uMin = Math.min(uMin, pu[i]); uMax = Math.max(uMax, pu[i]); vMin = Math.min(vMin, pv[i]); vMax = Math.max(vMax, pv[i]);
        }
        const span = Math.max(uMax - uMin, vMax - vMin, 1e-9);
        // About one triangle per cell, coarser when large triangles would put too many entries in the grid.
        let side = Math.min(1024, Math.max(8, Math.ceil(Math.sqrt(candidateTriangles))));
        let binSize = span / side;
        const bin = (value: number, min: number) => Math.min(side - 1, Math.max(0, Math.floor((value - min) / binSize)));
        const triBins = (t: number, visit: (cell: number) => void) => {
            const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
            const u0 = bin(Math.min(pu[a], pu[b], pu[c]), uMin), u1 = bin(Math.max(pu[a], pu[b], pu[c]), uMin);
            const v0 = bin(Math.min(pv[a], pv[b], pv[c]), vMin), v1 = bin(Math.max(pv[a], pv[b], pv[c]), vMin);
            for (let u = u0; u <= u1; u++) for (let v = v0; v <= v1; v++) visit(u * side + v);
        };
        let bins: PieceSortedCells | undefined;
        while (!(bins = yield* pieceSortedCells(tested, triBins, triPart, spend, side * side, side > 8 ? MAX_RAY_GRID_ENTRIES : Infinity))) {
            side = Math.max(8, Math.floor(side / 2));
            binSize = span / side;
        }

        for (let pi = 0; pi < parts.length; pi++) {
            if (!candidate[pi]) continue;
            const part = parts[pi];
            const near = adjacency[pi];
            const step = Math.max(1, Math.floor(part.vertices.length / 48));
            for (let i = 0; i < part.vertices.length; i += step) {
                const vi = part.vertices[i];
                const x = P[vi * 3], y = P[vi * 3 + 1], z = P[vi * 3 + 2];
                const k = bin(pu[vi], uMin) * side + bin(pv[vi], vMin);
                let cost = 1;
                for (let j = bins.start[k]; j < bins.start[k + 1];) {
                    const qi = triPart[bins.triangles[j]];
                    const end = bins.runEnd[j];
                    cost++;
                    const q = parts[qi];
                    // A point outside a part's box cannot be inside the part.
                    const inBox = x > q.min[0] && x < q.max[0] && y > q.min[1] && y < q.max[1] && z > q.min[2] && z < q.max[2];
                    if (inBox && qi !== pi && !near.has(qi)) {
                        let inside = false;
                        for (let m = j; m < end; m++) {
                            if (rayHitsTriangle(P, I, bins.triangles[m], x, y, z)) inside = !inside;
                        }
                        cost += end - j;
                        if (inside) link(pi, qi);
                    }
                    j = end;
                }
                if (spend(cost)) yield;
            }
        }
    }

    // 5. Structures are groups of parts joined by contact. The ground does not join them: a leg that
    // stands on the floor but never reaches the seat is a separate structure, not an attached part.
    const groundY = gMin[1];
    const structureOf = new Int32Array(parts.length).fill(-1);
    const structures: number[][] = [];
    for (let pi = 0; pi < parts.length; pi++) {
        if (structureOf[pi] >= 0) continue;
        const members: number[] = [];
        const stack = [pi];
        structureOf[pi] = structures.length;
        while (stack.length) {
            const cur = stack.pop()!;
            members.push(cur);
            for (const qi of adjacency[cur]) if (structureOf[qi] < 0) { structureOf[qi] = structures.length; stack.push(qi); }
        }
        structures.push(members);
    }
    const trianglesIn = (members: number[]) => members.reduce((n, pi) => n + parts[pi].triangles.length, 0);
    const mainIndex = structures.reduce((best, members, i) => (trianglesIn(members) > trianglesIn(structures[best]) ? i : best), 0);
    const attached = new Set<number>(structures[mainIndex]);
    const mainTriangles = structures[mainIndex].flatMap(pi => parts[pi].triangles);
    // Only the largest groups are reported, so only they are measured.
    const groups = structures.filter((_, i) => i !== mainIndex)
        .map(members => ({ members, triangleCount: trianglesIn(members) }))
        .sort((a, b) => b.triangleCount - a.triangleCount)
        .slice(0, REPORTED_GROUPS);

    // 6. Report the largest other structures with their real gap to the main structure.
    const SEARCH_RADIUS = 0.5;
    const floatingParts: FloatingPart[] = [];
    for (const { members, triangleCount } of groups) {
        const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
        const samples: number[] = [];
        for (const pi of members) {
            const part = parts[pi];
            for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], part.min[k]); max[k] = Math.max(max[k], part.max[k]); }
            const step = Math.max(1, Math.floor(part.vertices.length / 64));
            for (let i = 0; i < part.vertices.length; i += step) samples.push(part.vertices[i]);
        }
        let best = Infinity;
        const sampleStep = Math.max(1, Math.ceil((samples.length * mainTriangles.length) / 4_000_000));
        for (let s = 0; s < samples.length; s += sampleStep) {
            const v = samples[s];
            const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
            for (const t of mainTriangles) {
                const d = closestDistSq(P, I, t, x, y, z);
                if (d < best) best = d; // degenerate triangles yield NaN; skip them
            }
            if (spend(mainTriangles.length)) yield;
        }
        const gap = Math.sqrt(best);
        floatingParts.push({
            part: members[0],
            partCount: members.length,
            triangleCount,
            touchesGround: min[1] <= groundY + tolerance,
            center: [0, 1, 2].map(k => +((min[k] + max[k]) / 2).toFixed(3)) as Vec3,
            size: [0, 1, 2].map(k => +(max[k] - min[k]).toFixed(3)) as Vec3,
            gapMeters: Number.isFinite(gap) ? +Math.min(gap, SEARCH_RADIUS).toFixed(3) : SEARCH_RADIUS
        });
    }

    return {
        passed: structures.length === 1,
        partCount: parts.length,
        attachedPartCount: attached.size,
        structureCount: structures.length,
        toleranceMeters: +tolerance.toFixed(4),
        floatingParts,
        ...(options.withGraph ? { graph: { trianglePiece: triPart, touching: adjacency.map(s => [...s]) } } : {})
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
