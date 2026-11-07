/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * npm run notices:native [-- --check]
 *
 * Rewrites the "Native third-party code" section of the root NOTICE.md from every
 * packages/core/src/native/3d-engine/third_party/<name>/VENDORED.md and its licence file, after running the licence
 * gate. With --check it writes nothing and exits 1 when NOTICE.md is out of date or the gate fails.
 */

import * as fs from 'fs';
import * as path from 'path';
import { applyNativeNotices, checkThirdPartyLicences, renderNativeNotices } from '../packages/core/src/node/3d-engine/native-third-party';

const repo = path.resolve(__dirname, '..');
const root = path.join(repo, 'packages/core/src/native/3d-engine/third_party');
const noticeFile = path.join(repo, 'NOTICE.md');
const check = process.argv.includes('--check');

const problems = checkThirdPartyLicences(root);
if (problems.length) {
    console.error(`Licence gate failed for ${root}:\n${problems.map(p => `  - ${p}`).join('\n')}`);
    process.exit(1);
}
const current = fs.readFileSync(noticeFile, 'utf8');
const next = applyNativeNotices(current, renderNativeNotices(root));
if (check) {
    if (next !== current) {
        console.error('NOTICE.md is out of date with third_party/*/VENDORED.md: run `npm run notices:native` and commit NOTICE.md.');
        process.exit(1);
    }
    console.log('NOTICE.md native third-party section is up to date.');
} else if (next !== current) {
    fs.writeFileSync(noticeFile, next);
    console.log('NOTICE.md: native third-party section rewritten.');
} else {
    console.log('NOTICE.md: already up to date.');
}
