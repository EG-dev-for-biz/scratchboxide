#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Audit Tool: Anti-Architectural Simulation Trap Linter
 * Part of the Antigravity 'prevent-architectural-simulation-trap' Skill.
 *
 * Scans codebases, PRs, and generative pipelines for architectural simulation
 * anti-patterns:
 *   1. Hollow interface scaffolds & empty stub methods
 *   2. Banned client-side toy primitives (BoxGeometry, etc.)
 *   3. Closed domain taxonomies / enum presets
 *   4. Mock-only tests that assert zero real state
 *   5. Static throwaway scene generators violating ephemeral compilation
 ********************************************************************************/

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '../../..');

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
};

const VIOLATION_RULES = [
  {
    id: 'HOLLOW_STUB_METHOD',
    category: 'Archetype 1: Hollow Scaffold',
    regex: /(?:public\s+|private\s+|async\s+)?(?:function\s+\w+|\w+\s*\([^)]*\))\s*:\s*[^{]+\{\s*(?:\/\/.*?\s*)*(?:return\s*(?:null|undefined|Promise\.resolve\(\s*\)|Promise\.resolve\(\{\}\s*\)|\[\]|\{\})\s*;|throw\s+new\s+Error\s*\(\s*['"](?:Not implemented|TODO|stub)['"]\s*\)\s*;)\s*\}/gi,
    severity: 'error',
    message: 'Hollow stub method detected without computational substance. Replace with concrete logic or remove abstraction.'
  },
  {
    id: 'BANNED_TOY_PRIMITIVE',
    category: 'Archetype 4: Toy Script Emulation',
    regex: /new\s+(?:THREE\.)?(?:BoxGeometry|CylinderGeometry|ConeGeometry|SphereGeometry|DodecahedronGeometry)\s*\(/g,
    severity: 'error',
    message: 'Client-side toy 3D primitive instantiated in generative code. Geometry must be synthesized via C++20 engine and streamed as binary glTF 2.0.'
  },
  {
    id: 'CLOSED_DOMAIN_TAXONOMY',
    category: 'Archetype 5: Closed Taxonomy Trap',
    regex: /(?:enum\s+(?:Domain|Biome|SceneType|EnvironmentType|LocationCategory)\b|type\s+(?:Domain|Biome|SceneType)\s*=\s*['"][^'"]+['"]\s*\|)/g,
    severity: 'warning',
    message: 'Closed domain taxonomy detected. The LLM is the domain engine; replace discrete string enums with continuous dimensional schemas.'
  },
  {
    id: 'MOCK_ONLY_ASSERTION',
    category: 'Archetype 2: Synthetic Verification',
    regex: /expect\(\w+(?:Mock)?\.(?:toHaveBeenCalled|toHaveBeenCalledTimes|toHaveBeenCalledWith)\)\s*\.toBe\(true\)/g,
    severity: 'warning',
    message: 'Test only verifies that a mock was invoked. Assert real transformed state, buffer invariants, or return values.'
  },
  {
    id: 'LOOSE_MATH_TOLERANCE',
    category: 'Archetype 7: Mathematical Simulation Trap',
    regex: /expect\([^)]+\)\.toBeCloseTo\([^,]+,\s*(?:-[1-9]|0)\)/g,
    severity: 'warning',
    message: 'Loose numerical tolerance detected in test assertion (<= 0 decimal digits). Mathematical proofs require machine precision (>= 4 decimal digits).'
  }
];

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.gemini',
  '.system_generated'
]);

const EXEMPT_FILENAMES = new Set([
  'transform-gizmo-engine.ts',
  'syncCustomMeshes.ts',
  'audit_simulation_trap.js',
  'BoundingBoxComparisonService.ts', // Bounding box collision calculation / wireframe
  'GeometricComplexityGate.ts'       // Defines the gate constants
]);

// Directories actively enforced for zero-primitive generative 3D
const DEFAULT_TARGET_PATHS = [
  'packages/core/src/common/spatial',
  'packages/core/src/browser/generative-canvas/primitives',
  'public/test_reports'
];

function parseArgs() {
  const args = process.argv.slice(2);
  let targetPath = null;
  let strict = false;
  let diffOnly = false;
  let verifyMath = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--strict') {
      strict = true;
    } else if (args[i] === '--diff') {
      diffOnly = true;
    } else if (args[i] === '--math') {
      verifyMath = true;
    } else if (!args[i].startsWith('--') && !targetPath) {
      targetPath = args[i];
    }
  }

  return { targetPath, strict, diffOnly, verifyMath };
}

function getChangedFiles() {
  try {
    const gitOutput = execSync('git diff --name-only HEAD', { encoding: 'utf8', cwd: ROOT_DIR });
    return gitOutput
      .split('\n')
      .map(f => f.trim())
      .filter(f => f.length > 0 && fs.existsSync(path.join(ROOT_DIR, f)));
  } catch {
    return [];
  }
}

function scanFilesRecursively(dir, result = []) {
  if (!fs.existsSync(dir)) return result;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      scanFilesRecursively(fullPath, result);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.ts', '.tsx', '.js', '.jsx', '.cpp', '.hpp', '.h'].includes(ext)) {
        result.push(fullPath);
      }
    }
  }

  return result;
}

function runAudit() {
  const { targetPath, strict, diffOnly, verifyMath } = parseArgs();

  console.log(`${COLORS.bold}${COLORS.cyan}🛡️  [Anti-Architectural Simulation Trap Audit]${COLORS.reset}`);
  console.log(`${COLORS.dim}Enforcing mechanical reality grounding & anti-astronaut invariants...${COLORS.reset}\n`);

  let filesToScan = [];

  if (diffOnly) {
    const changed = getChangedFiles();
    filesToScan = changed.map(f => path.join(ROOT_DIR, f));
    console.log(`Auditing ${filesToScan.length} git modified file(s)...\n`);
  } else if (targetPath) {
    const resolved = path.resolve(process.cwd(), targetPath);
    if (fs.existsSync(resolved)) {
      if (fs.statSync(resolved).isDirectory()) {
        filesToScan = scanFilesRecursively(resolved);
      } else {
        filesToScan = [resolved];
      }
    } else {
      console.error(`${COLORS.red}Target path does not exist: ${targetPath}${COLORS.reset}`);
      process.exit(1);
    }
  } else {
    // Default: scan designated generative paths
    filesToScan = DEFAULT_TARGET_PATHS.flatMap(rel => scanFilesRecursively(path.join(ROOT_DIR, rel)));
  }

  let errorCount = 0;
  let warningCount = 0;

  for (const filePath of filesToScan) {
    const fileName = path.basename(filePath);
    if (EXEMPT_FILENAMES.has(fileName)) continue;

    const content = fs.readFileSync(filePath, 'utf8');
    const relativePath = path.relative(ROOT_DIR, filePath);

    // Check for static throwaway scene files
    if (filePath.includes('/scripts/') && /^(?:arctic|desert|forest|alien|cyberpunk|canyon)_.*\.cpp$/i.test(fileName)) {
      console.log(`${COLORS.red}❌ [STATIC_SCENE_PROLIFERATION]${COLORS.reset} ${relativePath}`);
      console.log(`   ${COLORS.yellow}Archetype 6: Static Code Proliferation detected.${COLORS.reset}`);
      console.log(`   Static scene generator file '${fileName}' committed to scripts/.`);
      console.log(`   Remedy: Synthesize C++20 on the fly via Adaptive3DSceneSynthesizer and compile ephemerally.\n`);
      errorCount++;
    }

    const lines = content.split('\n');

    for (const rule of VIOLATION_RULES) {
      // Regex testing per line or block
      lines.forEach((line, lineIndex) => {
        // Skip comment lines
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || line.includes('ALLOW_SIMULATION_EXCEPTION')) {
          return;
        }

        rule.regex.lastIndex = 0;
        if (rule.regex.test(line)) {
          const isError = rule.severity === 'error';
          const icon = isError ? `${COLORS.red}❌` : `${COLORS.yellow}⚠️ `;
          const label = isError ? 'ERROR' : 'WARNING';

          if (isError) errorCount++;
          else warningCount++;

          console.log(`${icon} [${label}: ${rule.id}] ${COLORS.bold}${relativePath}:${lineIndex + 1}${COLORS.reset}`);
          console.log(`   ${COLORS.dim}Category: ${rule.category}${COLORS.reset}`);
          console.log(`   ${COLORS.bold}Code:${COLORS.reset} ${trimmed}`);
          console.log(`   ${COLORS.cyan}Directives:${COLORS.reset} ${rule.message}\n`);
        }
      });
    }
  }

  console.log('------------------------------------------------------------');
  
  if (verifyMath) {
    console.log(`\n${COLORS.bold}${COLORS.cyan}Executing 3D Mathematical Invariants Proofs...${COLORS.reset}`);
    try {
      const mathScriptPath = path.join(__dirname, 'verify_3d_math_invariants.js');
      execSync(`node "${mathScriptPath}"`, { stdio: 'inherit', cwd: ROOT_DIR });
    } catch (err) {
      errorCount++;
      console.error(`${COLORS.red}❌ 3D Mathematical Invariants Proof failed!${COLORS.reset}`);
    }
    console.log('------------------------------------------------------------');
  }

  if (errorCount === 0 && warningCount === 0) {
    console.log(`${COLORS.green}${COLORS.bold}✅ [PASS] Zero Architectural & Mathematical Simulation Trap violations!${COLORS.reset}`);
    console.log(`${COLORS.dim}Codebase exhibits mechanical reality grounding and concrete substance.${COLORS.reset}\n`);
    process.exit(0);
  } else if (errorCount === 0 && !strict) {
    console.log(`${COLORS.yellow}${COLORS.bold}⚠️  [PASS WITH WARNINGS] Audit completed with ${warningCount} warning(s).${COLORS.reset}\n`);
    process.exit(0);
  } else {
    console.error(`${COLORS.red}${COLORS.bold}❌ [FAIL] Audit failed with ${errorCount} error(s) and ${warningCount} warning(s).${COLORS.reset}`);
    console.error(`   Please address the mechanical/mathematical violations above before committing.\n`);
    process.exit(1);
  }
}

runAudit();
