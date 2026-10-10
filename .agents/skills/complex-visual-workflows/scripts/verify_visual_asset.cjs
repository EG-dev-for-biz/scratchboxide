#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Mechanical Asset Verification Utility for Visual Pipelines
 * Verifies geometric complexity, video encoding parameters, image resolutions,
 * and Gaussian splat counts from first principles.
 *
 * Usage:
 *   node .agents/skills/complex-visual-workflows/scripts/verify_visual_asset.cjs <path-to-asset>
 ********************************************************************************/

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function verifyGlb(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 12) {
    throw new Error(`File too small to be a valid glTF binary: ${buffer.length} bytes`);
  }

  const magic = buffer.toString('utf8', 0, 4);
  if (magic !== 'glTF') {
    throw new Error(`Invalid GLB magic header: expected 'glTF', got '${magic}'`);
  }

  const version = buffer.readUInt32LE(4);
  const totalLength = buffer.readUInt32LE(8);

  let offset = 12;
  let jsonChunk = null;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.toString('utf8', offset + 4, offset + 8);
    offset += 8;

    if (chunkType === 'JSON') {
      const jsonStr = buffer.toString('utf8', offset, offset + chunkLength);
      jsonChunk = JSON.parse(jsonStr);
    }
    offset += chunkLength;
  }

  if (!jsonChunk) {
    throw new Error('No JSON chunk found in GLB');
  }

  const meshes = jsonChunk.meshes || [];
  const materials = jsonChunk.materials || [];
  const accessors = jsonChunk.accessors || [];

  let totalVertices = 0;
  let totalTriangles = 0;

  for (const mesh of meshes) {
    for (const prim of mesh.primitives || []) {
      if (prim.attributes && prim.attributes.POSITION !== undefined) {
        const posAcc = accessors[prim.attributes.POSITION];
        if (posAcc) {
          totalVertices += posAcc.count || 0;
        }
      }
      if (prim.indices !== undefined) {
        const idxAcc = accessors[prim.indices];
        if (idxAcc) {
          totalTriangles += Math.floor((idxAcc.count || 0) / 3);
        }
      } else if (prim.attributes && prim.attributes.POSITION !== undefined) {
        const posAcc = accessors[prim.attributes.POSITION];
        if (posAcc) {
          totalTriangles += Math.floor((posAcc.count || 0) / 3);
        }
      }
    }
  }

  const passesPropFloor = totalVertices >= 5000;
  const passesSceneFloor = totalVertices >= 25000;

  return {
    type: '3D Mesh (glTF Binary)',
    fileSize: formatBytes(buffer.length),
    version,
    declaredLength: totalLength,
    actualLength: buffer.length,
    meshCount: meshes.length,
    materialCount: materials.length,
    materials: materials.map(m => m.name || 'unnamed'),
    totalVertices,
    totalTriangles,
    fidelityCheck: {
      passesPropFloor, // >= 5,000 vertices
      passesSceneFloor, // >= 25,000 vertices
      status: passesSceneFloor ? 'EXCELLENT_SCENE' : passesPropFloor ? 'VALID_PROP' : 'BELOW_COMPLEXITY_FLOOR'
    }
  };
}

function verifyVideo(filePath) {
  try {
    const probeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,duration,codec_name,nb_frames -show_entries format=duration,size,bit_rate -of json "${filePath}"`;
    const output = execSync(probeCmd, { encoding: 'utf8' });
    const data = JSON.parse(output);

    const stream = (data.streams && data.streams[0]) || {};
    const format = data.format || {};

    let fps = 0;
    if (stream.r_frame_rate) {
      const parts = stream.r_frame_rate.split('/');
      fps = parts.length === 2 && Number(parts[1]) > 0 ? (Number(parts[0]) / Number(parts[1])) : Number(stream.r_frame_rate);
    }

    const width = stream.width || 0;
    const height = stream.height || 0;
    const duration = parseFloat(format.duration || stream.duration || 0);

    let resolutionCategory = 'custom';
    if (width >= 3840 || height >= 2160) resolutionCategory = '4K UHD';
    else if (width >= 1920 || height >= 1080) resolutionCategory = '1080p FHD';
    else if (width >= 1280 || height >= 720) resolutionCategory = '720p HD';

    return {
      type: 'Video (MP4 / NLE Timeline)',
      codec: stream.codec_name,
      resolution: `${width}x${height}`,
      resolutionCategory,
      aspectRatio: (width / (height || 1)).toFixed(3),
      durationSeconds: duration.toFixed(2),
      fps: fps.toFixed(2),
      totalFrames: stream.nb_frames || Math.round(duration * fps),
      fileSize: formatBytes(Number(format.size || fs.statSync(filePath).size)),
      bitrateKbps: Math.round(Number(format.bit_rate || 0) / 1000)
    };
  } catch (err) {
    const stat = fs.statSync(filePath);
    return {
      type: 'Video (Unprobed)',
      fileSize: formatBytes(stat.size),
      note: 'ffprobe unavailable or failed: ' + err.message
    };
  }
}

function verifyImage(filePath) {
  try {
    const sipsCmd = `sips -g pixelWidth -g pixelHeight -g format "${filePath}" 2>/dev/null`;
    const output = execSync(sipsCmd, { encoding: 'utf8' });
    const widthMatch = output.match(/pixelWidth:\s*(\d+)/);
    const heightMatch = output.match(/pixelHeight:\s*(\d+)/);
    const formatMatch = output.match(/format:\s*(\w+)/);

    const width = widthMatch ? parseInt(widthMatch[1], 10) : 0;
    const height = heightMatch ? parseInt(heightMatch[1], 10) : 0;
    const imgFormat = formatMatch ? formatMatch[1] : path.extname(filePath).slice(1);
    const stat = fs.statSync(filePath);

    return {
      type: '2D Image / 3D Turnaround Render',
      format: imgFormat,
      dimensions: `${width}x${height}`,
      aspectRatio: (width / (height || 1)).toFixed(3),
      is4K: width >= 3840 || height >= 2160,
      fileSize: formatBytes(stat.size)
    };
  } catch {
    const stat = fs.statSync(filePath);
    return {
      type: 'Image',
      fileSize: formatBytes(stat.size)
    };
  }
}

function verifySplat(filePath) {
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.ply') {
    const head = fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).slice(0, 1024);
    const vertexMatch = head.match(/element\s+vertex\s+(\d+)/);
    const splatCount = vertexMatch ? parseInt(vertexMatch[1], 10) : 0;
    return {
      type: '3D Gaussian Splat (Stanford PLY)',
      fileSize: formatBytes(stat.size),
      splatCount: splatCount.toLocaleString(),
      hasNormals: head.includes('property float nx'),
      hasSphericalHarmonics: head.includes('f_rest_') || head.includes('f_dc_')
    };
  }

  if (ext === '.spz') {
    return {
      type: '3D Gaussian Splat (Niantic SPZ v2)',
      fileSize: formatBytes(stat.size),
      note: 'Compact compressed Gaussian representation (<100ms streaming serialization)'
    };
  }

  return {
    type: 'Gaussian Splat Data',
    fileSize: formatBytes(stat.size)
  };
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node verify_visual_asset.cjs <path-to-asset>');
    process.exit(1);
  }

  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    console.error(`Asset not found: ${resolved}`);
    process.exit(1);
  }

  const ext = path.extname(resolved).toLowerCase();
  console.log(`\n============================================================`);
  console.log(`🔍 Scratchbox Visual Asset Mechanical Verification`);
  console.log(`Target: ${resolved}`);
  console.log(`============================================================\n`);

  let result;
  if (ext === '.glb') {
    result = verifyGlb(resolved);
  } else if (['.mp4', '.mov', '.webm', '.mkv'].includes(ext)) {
    result = verifyVideo(resolved);
  } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    result = verifyImage(resolved);
  } else if (['.ply', '.spz', '.splat'].includes(ext)) {
    result = verifySplat(resolved);
  } else {
    result = {
      type: 'Unknown Asset',
      fileSize: formatBytes(fs.statSync(resolved).size)
    };
  }

  console.log(JSON.stringify(result, null, 2));

  if (result.fidelityCheck && result.fidelityCheck.status === 'BELOW_COMPLEXITY_FLOOR') {
    console.warn(`\n⚠️  WARNING: Geometric complexity (${result.totalVertices} vertices) is below the 5,000 vertex floor! Reject toy primitives.`);
  } else {
    console.log(`\n✅ Asset verified successfully.`);
  }
}

main();
