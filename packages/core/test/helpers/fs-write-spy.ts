/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Records every write the code under test makes through node's fs (writeFileSync, appendFileSync, writeSync,
 * promises.writeFile, createWriteStream), whichever way it imported fs: the CommonJS module object is patched and the
 * ESM named exports are re-synced, so `import * as fs`, `import fs` and `import { writeFileSync }` all see the spy.
 * The real write still happens.
 */

import { createRequire, syncBuiltinESMExports } from 'module';

export interface FsWrite {
    api: string;
    target: string;
    /** The bytes written, when they are in hand (a stream's are not). */
    data?: Buffer;
}

const asBuffer = (d: unknown): Buffer | undefined => (Buffer.isBuffer(d) ? d : d instanceof Uint8Array ? Buffer.from(d) : typeof d === 'string' ? Buffer.from(d) : undefined);

export function spyOnFsWrites(): { writes: FsWrite[]; restore(): void } {
    const cjs: any = createRequire(__filename)('fs');
    const writes: FsWrite[] = [];
    const restores: Array<() => void> = [];
    const patch = (owner: any, name: string, api: string, targetOf: (args: any[]) => string, dataOf?: (args: any[]) => unknown) => {
        const real = owner[name];
        owner[name] = function (...args: any[]) {
            writes.push({ api, target: targetOf(args), ...(dataOf ? { data: asBuffer(dataOf(args)) } : {}) });
            return real.apply(this, args);
        };
        restores.push(() => { owner[name] = real; });
    };
    patch(cjs, 'writeFileSync', 'writeFileSync', a => String(a[0]), a => a[1]);
    patch(cjs, 'appendFileSync', 'appendFileSync', a => String(a[0]), a => a[1]);
    patch(cjs, 'writeSync', 'writeSync', a => `fd ${a[0]}`, a => a[1]);
    patch(cjs.promises, 'writeFile', 'promises.writeFile', a => String(a[0]), a => a[1]);
    patch(cjs.promises, 'appendFile', 'promises.appendFile', a => String(a[0]), a => a[1]);
    patch(cjs, 'createWriteStream', 'createWriteStream', a => String(a[0]));
    syncBuiltinESMExports();
    return {
        writes,
        restore() {
            for (const r of restores.splice(0)) r();
            syncBuiltinESMExports();
        }
    };
}
