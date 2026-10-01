#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const distPath = path.resolve(__dirname, '../dist/index.js');

if (!fs.existsSync(distPath)) {
  try {
    execSync('npm --prefix "' + path.resolve(__dirname, '..') + '" run build', { stdio: 'inherit' });
  } catch (err) {
    console.error('Failed to compile @scratchbox/cli. Please run "npm run build:cli".');
    process.exit(1);
  }
}

const { runCli } = require(distPath);
runCli();
