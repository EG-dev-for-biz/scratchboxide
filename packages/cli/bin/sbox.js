#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
