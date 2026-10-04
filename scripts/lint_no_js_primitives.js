#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Linting Guard: Prohibition on JavaScript Generative Primitives
 * 
 * Enforces the core repository directive:
 * "Lean on C/C++ First for 3D (C++20 as Geometry Generator, Three.js as Pure Viewport)"
 * 
 * Any generative scene builder or interactive studio that instantiates
 * Three.js primitives (BoxGeometry, CylinderGeometry, ConeGeometry)
 * instead of native C++20 / GLTF streaming fails this audit immediately.
 ********************************************************************************/

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

// Directories actively enforced for zero-primitive generative 3D
const TARGET_SCAN_PATHS = [
    path.join(ROOT_DIR, 'public/test_reports'),
    path.join(ROOT_DIR, 'packages/core/src/common/spatial'),
    path.join(ROOT_DIR, 'packages/core/src/browser/generative-canvas/primitives')
];

// Patterns that indicate client-side toy primitives in scene generation
const BANNED_PATTERNS = [
    { regex: /new\s+(?:THREE\.)?BoxGeometry\s*\(/g, name: 'BoxGeometry' },
    { regex: /new\s+(?:THREE\.)?CylinderGeometry\s*\(/g, name: 'CylinderGeometry' },
    { regex: /new\s+(?:THREE\.)?ConeGeometry\s*\(/g, name: 'ConeGeometry' },
    { regex: /new\s+(?:THREE\.)?DodecahedronGeometry\s*\(/g, name: 'DodecahedronGeometry' }
];

// Explicit exemptions (e.g. bounding box helper or viewport transform gizmos)
const EXEMPTIONS = [
    'transform-gizmo-engine.ts',
    'syncCustomMeshes.ts' // fallback placeholder for custom mesh protocol
];

function scanDirectory(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '.git') {
                scanDirectory(fullPath, fileList);
            }
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.html'))) {
            fileList.push(fullPath);
        }
    }
    return fileList;
}

let violationCount = 0;
console.log('🔍 [Anti-JS-Primitive Linter] Scanning generative viewports and canvas primitives...\n');

const allFiles = TARGET_SCAN_PATHS.flatMap(dir => scanDirectory(dir));

for (const filePath of allFiles) {
    const fileName = path.basename(filePath);
    if (EXEMPTIONS.includes(fileName)) {
        continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, index) => {
        // Skip comment lines or lines with explicit bypass
        if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.includes('ALLOW_PRIMITIVE_EXCEPTION')) {
            return;
        }

        for (const pattern of BANNED_PATTERNS) {
            pattern.regex.lastIndex = 0;
            if (pattern.regex.test(line)) {
                console.error(`❌ VIOLATION in ${path.relative(ROOT_DIR, filePath)}:${index + 1}`);
                console.error(`   Found banned primitive constructor: "${pattern.name}"`);
                console.error(`   Code: ${line.trim()}`);
                console.error(`   Directives mandate: Procedural geometry must be synthesized via Native C++20 engine and streamed as binary .glb.\n`);
                violationCount++;
            }
        }
    });
}

if (violationCount > 0) {
    console.error(`❌ Anti-JS-Primitive Audit Failed with ${violationCount} violation(s).`);
    console.error(`   Please refactor scene generators to use Native C++20 Engine (scratchbox_native / Adaptive3DSceneSynthesizer).\n`);
    process.exit(1);
} else {
    console.log(`✅ Anti-JS-Primitive Audit Passed! Zero prohibited JavaScript primitives detected in active generative viewports.\n`);
    process.exit(0);
}
