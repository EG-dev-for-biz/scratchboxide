/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Fits a window-site decision on the window check's labels and scores it against the array's current rule
 * (pipeline-k/window-label-fit.ts). Reads every labels.jsonl in the default label store (window_labels under
 * .scratchbox/cache, or SCRATCHBOX_WINDOW_LABELS_DIR) and in the paths given; writes window_label_fit.json; prints the
 * summary. Nothing is written into the label store and nothing changes the array.
 *
 *   npm run window-labels:fit                                      the default store only
 *   npm run window-labels:fit -- --labels <file-or-dir>... [--out <dir>]
 *   npm run window-labels:fit -- --no-default --labels <file>       the paths given only
 *
 * --out defaults to .scratchbox/cache/window_label_fit under the repository.
 */

import * as path from 'path';
import { windowLabelsDir } from '../packages/core/src/node/3d-engine/staged-location/pipeline-k/window-check';
import { findLabelFiles, fitWindowLabels, writeWindowLabelFitReport } from '../packages/core/src/node/3d-engine/staged-location/pipeline-k/window-label-fit';

function main(): void {
    const repoRoot = path.resolve(__dirname, '..');
    const args = process.argv.slice(2), labels: string[] = [];
    let out = path.join(repoRoot, '.scratchbox', 'cache', 'window_label_fit'), useDefault = true;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--labels') { while (i + 1 < args.length && !args[i + 1].startsWith('--')) labels.push(path.resolve(args[++i])); }
        else if (a === '--out') out = path.resolve(args[++i]);
        else if (a === '--no-default') useDefault = false;
        else if (!a.startsWith('--')) labels.push(path.resolve(a));
        else throw new Error(`unknown argument ${a}`);
    }
    if (useDefault) labels.unshift(windowLabelsDir(path.join(repoRoot, '.scratchbox', 'cache')));
    const files = findLabelFiles(labels);
    if (!files.length) {
        console.log(`[window-labels:fit] no labels.jsonl found under: ${labels.join(', ')}`);
        process.exitCode = 1;
        return;
    }
    const report = fitWindowLabels(files);
    const written = writeWindowLabelFitReport(report, out);
    for (const f of report.counts.files) console.log(`[window-labels:fit] ${f.rows} rows  ${f.file}`);
    console.log(`[window-labels:fit] report: ${written}`);
    console.log(report.summary);
}

main();
