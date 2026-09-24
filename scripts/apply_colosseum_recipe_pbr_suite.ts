/**
 * Colosseum Recipe PBR Suite
 *
 * Alternative to scripts/apply_colosseum_1k_pbr_suite.cjs. Instead of unpacking every UV atlas
 * and re-baking albedo/normal/ORM per mesh, this keeps the original photogrammetry textures
 * byte-for-byte and moves the derived data into vertex attributes plus three shared detail maps.
 * The runtime shader (public/js/scratchbox-recipe-pbr.js) evaluates de-lighting, bevel, AO and
 * micro-detail per fragment.
 *
 * Run: [RECIPE_KTX2=etc1s|uastc|off] npx vite-node scripts/run_colosseum_recipe_pbr_cli.ts
 * The KTX2 variant needs `basisu` (brew install basis_universal) and ffmpeg on PATH.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  buildRecipeSubmeshGeometry,
  buildGroundHeightField,
  computeVoxelAmbientOcclusion,
  packRecipeMask,
  generateTileableDetailMap,
  encodeCompactRecipeAttributes,
  type DetailMapKind,
  type RecipeSubmeshGeometry
} from '../packages/core/src/node/3d-engine/recipe-pbr-geometry-kernel';

const REPO_ROOT = path.resolve(__dirname, '..');
const INPUT_GLB = path.join(REPO_ROOT, 'public/models/colosseum_rome_textured.glb');
const OUTPUT_GLB = path.join(REPO_ROOT, 'public/models/colosseum_rome_recipe_pbr.glb');
const OUTPUT_KTX2_GLB = path.join(REPO_ROOT, 'public/models/colosseum_rome_recipe_pbr_ktx2.glb');
const KTX2_CACHE_DIR = path.join(REPO_ROOT, 'node_modules/.cache/recipe-pbr-ktx2');
const execFileAsync = promisify(execFile);
const OUTPUT_REPORT = path.join(REPO_ROOT, 'public/models/colosseum_rome_recipe_pbr.report.json');
const DETAIL_DIR = path.join(REPO_ROOT, 'public/models/recipe');
const DETAIL_SIZE = 512;

interface Gltf {
  [key: string]: any;
  accessors: any[];
  bufferViews: any[];
  buffers: any[];
  meshes: any[];
  materials: any[];
  images: any[];
}

function readGlb(file: string): { gltf: Gltf; bin: Buffer } {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const binStart = 20 + jsonLen;
  const binLen = buf.readUInt32LE(binStart);
  return { gltf, bin: buf.subarray(binStart + 8, binStart + 8 + binLen) };
}

function readAccessor(gltf: Gltf, bin: Buffer, index: number): Float32Array | Uint8Array | Uint16Array | Uint32Array {
  const acc = gltf.accessors[index];
  const bv = gltf.bufferViews[acc.bufferView];
  const comps = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[acc.type];
  const Ctor = ({ 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array } as Record<number, any>)[acc.componentType];
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const bytes = bin.subarray(start, start + acc.count * comps * Ctor.BYTES_PER_ELEMENT);
  return new Ctor(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function encodePng(rgba: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

export interface RecipePipelineOptions {
  /** Basis Universal mode for the KTX2 variant; 'off' writes only the original-JPEG GLB. */
  ktx2?: 'etc1s' | 'uastc' | 'off';
}

export async function runColosseumRecipePbrPipeline(userOptions: RecipePipelineOptions = {}) {
  const options = { ktx2: userOptions.ktx2 ?? 'etc1s' };
  const t0 = Date.now();
  if (!fs.existsSync(INPUT_GLB)) throw new Error(`Input GLB not found at ${INPUT_GLB}`);
  const { gltf, bin } = readGlb(INPUT_GLB);
  console.log(`=== Colosseum Recipe PBR: ${gltf.meshes.length} submeshes ===`);

  // 1. Geometry layer: split normals + sharp-edge distance + neighbour normals
  const geos: RecipeSubmeshGeometry[] = gltf.meshes.map((mesh: any) => {
    const prim = mesh.primitives[0];
    return buildRecipeSubmeshGeometry({
      positions: readAccessor(gltf, bin, prim.attributes.POSITION) as Float32Array,
      uvs: readAccessor(gltf, bin, prim.attributes.TEXCOORD_0) as Float32Array,
      indices: prim.indices !== undefined ? Uint32Array.from(readAccessor(gltf, bin, prim.indices)) : null
    });
  });
  const tGeo = Date.now();
  console.log(`[geometry] split normals + edge distances in ${tGeo - t0} ms`);

  // 2. Ground field + voxel AO across the whole scene so neighbouring submeshes occlude each other
  const ground = buildGroundHeightField(geos, 6);
  const aoPerMesh = computeVoxelAmbientOcclusion(geos, { cellSize: 0.5, maxDistance: 12, rayCount: 16 });
  const compacts = geos.map(encodeCompactRecipeAttributes);
  const masks = geos.map((g, mi) => {
    const hag = new Float32Array(g.positions.length / 3);
    for (let v = 0; v < hag.length; v++) {
      hag[v] = Math.max(0, g.positions[v * 3 + 1] - ground.sample(g.positions[v * 3], g.positions[v * 3 + 2]));
    }
    return packRecipeMask(aoPerMesh[mi], hag, 8, compacts[mi].edgeFlags);
  });
  const tAo = Date.now();
  console.log(`[ao] voxel hemisphere AO + ground height in ${tAo - tGeo} ms`);

  // 3. Shared metric detail maps
  fs.mkdirSync(DETAIL_DIR, { recursive: true });
  const detailKinds: DetailMapKind[] = ['stone', 'asphalt', 'foliage'];
  const detailMaps: Record<string, { uri: string; tileMeters: number; bytes: number }> = {};
  for (const kind of detailKinds) {
    const map = generateTileableDetailMap(kind, DETAIL_SIZE);
    const png = encodePng(map.rgba, map.size, map.size);
    const file = `${kind}_detail_${DETAIL_SIZE}.png`;
    fs.writeFileSync(path.join(DETAIL_DIR, file), png);
    detailMaps[kind] = { uri: `recipe/${file}`, tileMeters: map.tileMeters, bytes: png.length };
  }
  console.log(`[detail] ${detailKinds.length} shared ${DETAIL_SIZE}² detail maps`);

  // 4. Texture payloads: original JPEGs byte-for-byte, plus Basis Universal KTX2 re-encodes
  const sourceImages: Buffer[] = gltf.images.map((img: any) => {
    const bv = gltf.bufferViews[img.bufferView];
    return Buffer.from(bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
  });
  const jpegImages: TexturePayload[] = sourceImages.map((data, i) => {
    const { width, height } = jpegDimensions(data);
    return { data, mimeType: gltf.images[i].mimeType, vramBytes: (width * height * 4 * 4) / 3 };
  });

  const common = { gltf, geos, compacts, masks, detailMaps };
  const jpegResult = writeRecipeGlb({ ...common, textureFormat: 'jpeg', images: jpegImages, outputPath: OUTPUT_GLB });
  console.log(`[glb] JPEG variant ${(jpegResult.bytes / 1048576).toFixed(2)} MB`);

  const variants: Record<string, VariantReport> = { jpeg: variantReport(jpegResult, OUTPUT_GLB) };
  let ktx2Skipped: string | undefined;
  if (options.ktx2 !== 'off') {
    try {
      await execFileAsync('basisu', ['-version']);
    } catch {
      ktx2Skipped = 'basisu not found on PATH (brew install basis_universal); KTX2 variant not rebuilt';
      console.warn(`[ktx2] ${ktx2Skipped}`);
    }
  }
  if (options.ktx2 !== 'off' && !ktx2Skipped) {
    const tK = Date.now();
    const ktx2Images = await encodeKtx2Images(sourceImages, options.ktx2);
    const ktx2Result = writeRecipeGlb({ ...common, textureFormat: `ktx2-${options.ktx2}`, images: ktx2Images, outputPath: OUTPUT_KTX2_GLB });
    variants.ktx2 = variantReport(ktx2Result, OUTPUT_KTX2_GLB);
    console.log(`[ktx2] ${options.ktx2.toUpperCase()} variant ${(ktx2Result.bytes / 1048576).toFixed(2)} MB in ${Date.now() - tK} ms`);
  }

  const report = {
    success: true,
    outputGlbPath: OUTPUT_GLB,
    glbUrl: '/models/colosseum_rome_recipe_pbr.glb',
    fileSizeBytes: jpegResult.bytes,
    fileSizeMb: (jpegResult.bytes / 1048576).toFixed(2),
    durationSeconds: +((Date.now() - t0) / 1000).toFixed(1),
    stats: jpegResult.stats,
    variants,
    ...(ktx2Skipped ? { ktx2Skipped } : {}),
    detailMaps,
    timestamp: new Date().toISOString()
  };
  fs.writeFileSync(OUTPUT_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  return report;
}

interface TexturePayload {
  data: Buffer;
  mimeType: string;
  vramBytes: number;
}

interface WriteGlbInput {
  gltf: Gltf;
  geos: RecipeSubmeshGeometry[];
  compacts: ReturnType<typeof encodeCompactRecipeAttributes>[];
  masks: Uint8Array[];
  detailMaps: Record<string, { uri: string; tileMeters: number; bytes: number }>;
  textureFormat: string;
  images: TexturePayload[];
  outputPath: string;
}

interface VariantReport {
  glbUrl: string;
  textureFormat: string;
  fileSizeMb: string;
  imageMb: number;
  estimatedTextureVramMb: number;
}

function variantReport(r: ReturnType<typeof writeRecipeGlb>, outputPath: string): VariantReport {
  return {
    glbUrl: `/models/${path.basename(outputPath)}`,
    textureFormat: r.textureFormat,
    fileSizeMb: (r.bytes / 1048576).toFixed(2),
    imageMb: r.stats.imageMb,
    estimatedTextureVramMb: r.stats.estimatedTextureVramMb
  };
}

function jpegDimensions(data: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < data.length) {
    if (data[i] !== 0xff) { i++; continue; }
    const marker = data[i + 1];
    if (marker >= 0xc0 && marker <= 0xc2) return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
    i += 2 + data.readUInt16BE(i + 2);
  }
  throw new Error('JPEG without SOF marker');
}

async function encodeKtx2Images(sources: Buffer[], mode: 'etc1s' | 'uastc'): Promise<TexturePayload[]> {
  fs.mkdirSync(KTX2_CACHE_DIR, { recursive: true });
  const modeArgs = mode === 'uastc'
    ? ['-uastc', '-uastc_level', '2', '-uastc_rdo_l', '1.0', '-ktx2_zstandard_level', '18']
    : ['-q', '192', '-comp_level', '2'];
  // Basis transcodes ETC1S to BC1/ETC1 (0.5 B/px) and UASTC to BC7/ASTC (1 B/px).
  const gpuBytesPerPixel = mode === 'uastc' ? 1 : 0.5;
  const results: TexturePayload[] = new Array(sources.length);
  let next = 0, cached = 0;

  const worker = async () => {
    while (next < sources.length) {
      const i = next++;
      const hash = createHash('sha1').update(sources[i]).update(modeArgs.join(' ')).digest('hex');
      const cachePath = path.join(KTX2_CACHE_DIR, `${hash}_${mode}.ktx2`);
      if (fs.existsSync(cachePath)) {
        cached++;
      } else {
        const tmpBase = path.join(os.tmpdir(), `recipe_ktx2_${process.pid}_${i}`);
        fs.writeFileSync(`${tmpBase}.jpg`, sources[i]);
        // basisu cannot read progressive JPEGs, so decode to lossless PNG first.
        await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-i', `${tmpBase}.jpg`, `${tmpBase}.png`]);
        await execFileAsync('basisu', ['-quiet', '-ktx2', '-mipmap', '-srgb', ...modeArgs, '-file', `${tmpBase}.png`, '-output_file', `${tmpBase}.ktx2`], { maxBuffer: 16 * 1024 * 1024 });
        fs.renameSync(`${tmpBase}.ktx2`, cachePath);
        fs.rmSync(`${tmpBase}.jpg`, { force: true });
        fs.rmSync(`${tmpBase}.png`, { force: true });
      }
      const data = fs.readFileSync(cachePath);
      const width = data.readUInt32LE(20), height = data.readUInt32LE(24);
      results[i] = { data, mimeType: 'image/ktx2', vramBytes: (width * height * gpuBytesPerPixel * 4) / 3 };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, os.cpus().length - 1)) }, worker));
  console.log(`[ktx2] ${sources.length} textures (${cached} from cache)`);
  return results;
}

function writeRecipeGlb(input: WriteGlbInput) {
  const { geos, compacts, masks, detailMaps, textureFormat, images, outputPath } = input;
  const gltf: Gltf = structuredClone(input.gltf);
  const chunks: Buffer[] = [];
  const bufferViews: any[] = [];
  const accessors: any[] = [];
  let offset = 0;
  const addView = (data: Buffer, target?: number, byteStride?: number) => {
    const pad = (4 - (data.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, ...(target ? { target } : {}), ...(byteStride ? { byteStride } : {}) });
    chunks.push(pad ? Buffer.concat([data, Buffer.alloc(pad)]) : data);
    offset += data.length + pad;
    return bufferViews.length - 1;
  };
  const addAccessor = (arr: ArrayBufferView, componentType: number, type: string, count: number, extra: object = {}, target = 34962, byteStride?: number) => {
    const bv = addView(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength), target, byteStride);
    accessors.push({ bufferView: bv, componentType, type, count, ...extra });
    return accessors.length - 1;
  };

  let vertexCount = 0, triangleCount = 0, sharpEdges = 0, smoothEdges = 0, sharpTris = 0, geometryBytes = 0, floatUvMeshes = 0;
  gltf.meshes.forEach((mesh: any, mi: number) => {
    const g = geos[mi];
    const c = compacts[mi];
    const n = g.positions.length / 3;
    vertexCount += n; triangleCount += g.indices.length / 3;
    sharpEdges += g.sharpEdgeCount; smoothEdges += g.smoothEdgeCount; sharpTris += g.sharpTriangleCount;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
      const v = g.positions[i * 3 + c];
      if (v < min[c]) min[c] = v; if (v > max[c]) max[c] = v;
    }
    const before = offset;
    if (!c.uvs) floatUvMeshes++;
    // Positions stay float32 so the geometry lock and inter-submesh seams are exact.
    const attributes: Record<string, number> = {
      POSITION: addAccessor(g.positions, 5126, 'VEC3', n, { min, max }),
      NORMAL: addAccessor(c.normals, 5120, 'VEC3', n, { normalized: true }, 34962, 4),
      TEXCOORD_0: c.uvs ? addAccessor(c.uvs, 5123, 'VEC2', n, { normalized: true }) : addAccessor(g.uvs, 5126, 'VEC2', n),
      _SBEDGEH: addAccessor(c.edgeAltitude, 5126, 'SCALAR', n),
      _SBNBRA: addAccessor(c.neighborOctA, 5120, 'VEC4', n, { normalized: true }),
      _SBNBRB: addAccessor(c.neighborOctB, 5120, 'VEC4', n, { normalized: true }),
      _SBMASK: addAccessor(masks[mi], 5121, 'VEC4', n, { normalized: true })
    };
    const small = n <= 65535;
    const indexArr = small ? Uint16Array.from(g.indices) : g.indices;
    const indices = addAccessor(indexArr, small ? 5123 : 5125, 'SCALAR', g.indices.length, {}, 34963);
    geometryBytes += offset - before;
    const prim = mesh.primitives[0];
    mesh.primitives = [{ attributes, indices, material: prim.material, mode: 4 }];
  });

  const isKtx2 = textureFormat.startsWith('ktx2');
  let imageBytes = 0, vramBytes = 0;
  gltf.images = images.map(img => {
    imageBytes += img.data.length;
    vramBytes += img.vramBytes;
    return { mimeType: img.mimeType, bufferView: addView(img.data) };
  });
  if (isKtx2) {
    gltf.textures = gltf.textures.map((tex: any) => ({
      ...(tex.sampler !== undefined ? { sampler: tex.sampler } : {}),
      extensions: { KHR_texture_basisu: { source: tex.source } }
    }));
  }

  gltf.materials = gltf.materials.map((mat: any, i: number) => ({
    name: `Colosseum_Recipe_PBR_${i}`,
    pbrMetallicRoughness: {
      baseColorTexture: mat.pbrMetallicRoughness?.baseColorTexture,
      metallicFactor: 0,
      roughnessFactor: 0.85
    },
    doubleSided: true
  }));

  gltf.accessors = accessors;
  gltf.bufferViews = bufferViews;
  gltf.buffers = [{ byteLength: offset }];
  const required = ['KHR_mesh_quantization', ...(isKtx2 ? ['KHR_texture_basisu'] : [])];
  gltf.extensionsUsed = [...(gltf.extensionsUsed || []).filter((e: string) => e !== 'KHR_materials_unlit'), ...required];
  gltf.extensionsRequired = required;
  gltf.asset = { version: '2.0', generator: 'Scratchbox Recipe PBR Suite' };

  const stats = {
    submeshes: gltf.meshes.length,
    vertexCount,
    triangleCount,
    sharpEdges,
    smoothEdges,
    sharpTriangles: sharpTris,
    floatUvMeshes,
    geometryMb: +(geometryBytes / 1048576).toFixed(2),
    imageMb: +(imageBytes / 1048576).toFixed(2),
    detailMapKb: +(Object.values(detailMaps).reduce((s, d) => s + d.bytes, 0) / 1024).toFixed(1),
    textureCount: gltf.images.length,
    estimatedTextureVramMb: +(vramBytes / 1048576).toFixed(0)
  };
  gltf.scenes[gltf.scene ?? 0].extras = {
    scratchboxRecipe: {
      version: 2,
      textureFormat,
      detailMaps,
      bevel: { radiusMeters: 0.02, minPixels: 0.75, sharpAngleDeg: 45 },
      mask: { r: 'ambientOcclusion', g: 'heightAboveGround/8m', a: 'edgeFlags: bits0-1 corner, bits2-4 sharp edges' },
      stats
    }
  };

  const json = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = (4 - (json.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);
  const binChunk = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonChunk.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binChunk.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  const glb = Buffer.concat([header, jh, jsonChunk, bh, binChunk]);
  fs.writeFileSync(outputPath, glb);
  return { bytes: glb.length, stats, textureFormat };
}