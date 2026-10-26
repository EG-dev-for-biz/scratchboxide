/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The "everything in a tile" object catalog (object-catalog.ts, asset-db.ts's objects table): a discovered object is
 * recorded with its bounding box and discovery time; re-discovering the same object (a rebuild, an overlapping
 * district) refreshes it instead of duplicating it.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resetDefaultDurableAssetStore } from '../src/node/asset-store/durable-asset-store';
import { recordDiscoveredObject, recordDiscoveredObjects } from '../src/node/asset-store/object-catalog';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-object-catalog-')));
const prevHome = process.env.SCRATCHBOX_HOME;
process.env.SCRATCHBOX_HOME = HOME;
afterAll(() => {
    resetDefaultDurableAssetStore();
    fs.rmSync(HOME, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.SCRATCHBOX_HOME; else process.env.SCRATCHBOX_HOME = prevHome;
});
beforeEach(() => resetDefaultDurableAssetStore());

/** A plausible tree-sized bounding box (6 m across, 8 m tall) centred on (lat, lng). */
const treeBox = (lat: number, lng: number) => ({
    type: 'SB_FEATURE_TYPE_TREE', label: 'measured crown, 8 m tall', lat, lng,
    bboxLo: { lat: lat - 0.00003, lng: lng - 0.00003, alt: 0 }, bboxHi: { lat: lat + 0.00003, lng: lng + 0.00003, alt: 8 },
    source: 'tree-crown'
});

describe('object catalog', () => {
    it('records a newly discovered object with its bounding box and a discovery time', () => {
        const r = recordDiscoveredObject(treeBox(40.7411, -73.9897));
        expect(r.isNew).toBe(true);
        expect(r.id).not.toMatch(/^unrecorded:/);
    });

    it('a repeat discovery at the same place refreshes the existing row instead of duplicating it', () => {
        const a = recordDiscoveredObject(treeBox(40.7411, -73.9897));
        const b = recordDiscoveredObject(treeBox(40.74110002, -73.98970002)); // ~0.3 m away: the same tree, remeasured
        expect(b.isNew).toBe(false);
        expect(b.id).toBe(a.id);
    });

    it('a different place (past the dedup radius) is a new object, even of the same type', () => {
        const a = recordDiscoveredObject(treeBox(40.7411, -73.9897));
        const b = recordDiscoveredObject(treeBox(40.7415, -73.9897)); // ~45 m north
        expect(b.isNew).toBe(true);
        expect(b.id).not.toBe(a.id);
    });

    it('a different type at the same place is also a new object (dedup is per type)', () => {
        const a = recordDiscoveredObject(treeBox(40.7411, -73.9897));
        const b = recordDiscoveredObject({ ...treeBox(40.7411, -73.9897), type: 'SB_FEATURE_TYPE_STREET_FURNITURE' });
        expect(b.isNew).toBe(true);
        expect(b.id).not.toBe(a.id);
    });

    it('recordDiscoveredObjects records a batch and counts how many were genuinely new', () => {
        const { recorded, new: isNew } = recordDiscoveredObjects([treeBox(40.75, -73.98), treeBox(40.76, -73.97), treeBox(40.75000001, -73.98000001)]);
        expect(recorded).toBe(3);
        expect(isNew).toBe(2); // the third is the first one, remeasured
    });
});
