/**
 * Plans the ownership vote's facade reuse between two cached tile_refine entries of the same structure (the first isolate's
 * and the voted one's) and prints which facades it keeps and why the others changed (pipeline-k/facade-reuse.ts).
 *
 *   npx vite-node scripts/dev/facade-reuse-plan.ts <first tile_refine entry> <voted tile_refine entry>
 */
import * as path from 'path';
import { ownershipChange } from '../../packages/core/src/node/3d-engine/staged-location/ownership-change';
import { planFacadeReuse } from '../../packages/core/src/node/3d-engine/staged-location/pipeline-k/facade-reuse';

const [first, voted] = process.argv.slice(2);
if (!first || !voted) { console.error('usage: facade-reuse-plan.ts <first entry> <voted entry>'); process.exit(2); }
const t0 = Date.now();
const change = ownershipChange(path.join(first, 'raw_clay.glb'), path.join(voted, 'raw_clay.glb'));
const t1 = Date.now();
const plan = planFacadeReuse(path.join(first, 'relief_orthos'), path.join(voted, 'relief_orthos'), change.moved, change.movedAreas);
console.log(JSON.stringify({ change: { share: change.share, onlyFirstM2: change.onlyFirstM2, onlySecondM2: change.onlySecondM2, movedTriangles: change.moved.length / 3, ms: t1 - t0 }, planMs: Date.now() - t1, kept: plan.kept.length, changed: plan.changed.length, keptAreaM2: plan.keptAreaM2, changedAreaM2: plan.changedAreaM2 }));
for (const k of plan.kept) console.log(`kept    voted ${k.votedId} = first ${k.firstId}  ${k.areaM2} m²  ${JSON.stringify(k.metrics)}`);
for (const c of plan.changed) console.log(`changed voted ${c.votedId} -> id ${c.id}  ${c.areaM2} m²  ${c.reason}`);
