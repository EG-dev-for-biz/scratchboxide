/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as path from 'path';
import { SbRigService, type SbRigOptions, type SbRigParams, type SbRigPoint3 } from '@scratchbox/core/node';

const USAGE = `Usage: sbox rig <input.glb> [-o output.glb] [--root-hint x,y,z] [--chain-hint "x,y,z;x,y,z;..."]...
                [--rename FROM=TO]... [--param-<name> <value>]... [--tree] [--json]`;

function parsePoint(text: string, label: string): SbRigPoint3 {
  const parts = text.split(',').map(s => Number(s.trim()));
  if (parts.length !== 3 || !parts.every(Number.isFinite)) throw new Error(`${label} expects x,y,z but got '${text}'`);
  return [parts[0], parts[1], parts[2]];
}

export function parseRigArgs(args: string[]): SbRigOptions & { json: boolean } {
  const options: SbRigOptions & { json: boolean } = { json: false };
  const params: Record<string, number | boolean> = {};
  const chainHints: SbRigPoint3[][] = [];
  const rename: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < args.length; i++) {
    let flag = args[i];
    let inline: string | undefined;
    if (flag.startsWith('--') && flag.includes('=')) {
      inline = flag.slice(flag.indexOf('=') + 1);
      flag = flag.slice(0, flag.indexOf('='));
    }
    const value = (): string => {
      if (inline !== undefined) return inline;
      if (i + 1 >= args.length) throw new Error(`${flag} needs a value`);
      return args[++i];
    };
    if (flag === '-o' || flag === '--output') options.outputGlbPath = path.resolve(process.cwd(), value());
    else if (flag === '--root-hint') options.rootHint = parsePoint(value(), '--root-hint');
    else if (flag === '--chain-hint') chainHints.push(value().split(';').filter(Boolean).map(p => parsePoint(p, '--chain-hint')));
    else if (flag === '--rename') {
      const pair = value();
      const eq = pair.indexOf('=');
      if (eq <= 0 || eq === pair.length - 1) throw new Error(`--rename expects FROM=TO, got '${pair}'`);
      rename.push({ from: pair.slice(0, eq), to: pair.slice(eq + 1) });
    } else if (flag.startsWith('--param-')) {
      const raw = value();
      params[flag.slice('--param-'.length)] = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
    } else if (flag === '--tree') options.includeTree = true;
    else if (flag === '--json') options.json = true;
    else if (!flag.startsWith('-') && !options.inputGlbPath) options.inputGlbPath = path.resolve(process.cwd(), flag);
    else throw new Error(`unknown argument '${args[i]}'`);
  }
  if (!options.inputGlbPath) throw new Error(`input .glb required\n${USAGE}`);
  if (Object.keys(params).length) options.params = params as SbRigParams;
  if (chainHints.length) options.chainHints = chainHints;
  if (rename.length) options.rename = rename;
  return options;
}

export async function rigCommand(args: string[]): Promise<void> {
  const { json, ...options } = parseRigArgs(args);
  console.log(`SB-Rig: rigging ${path.basename(options.inputGlbPath!)}...`);
  const result = await new SbRigService().rig(options);
  const { report } = result;
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const fmt = (p?: number[]) => (p ? p.map(v => v.toFixed(3)).join(', ') : '');
  console.log(`  ${report.stats.inputVertices} vertices -> ${report.stats.jointCount} joints, ${report.stats.chainCount} chains ` +
    `(${report.stats.leafChainCount} leaves), root from ${report.stats.rootSource}, ${Number(report.timingsMs.total).toFixed(0)} ms`);
  for (const c of report.chains) {
    console.log(`  ${c.name.padEnd(14)} ${(c.leaf ? 'leaf' : 'inner').padEnd(5)} ${String(c.joints.length).padStart(2)} joints  ` +
      `from ${String(c.parentJoint).padEnd(14)} ends [${fmt(c.endPosition)}]${c.hinted ? '  (hinted)' : ''}`);
  }
  for (const w of report.warnings) console.warn(`  warning: ${w}`);
  console.log(`  skinned GLB: ${result.outputGlbPath}`);
  console.log(`  report:      ${result.reportPath}`);
}
