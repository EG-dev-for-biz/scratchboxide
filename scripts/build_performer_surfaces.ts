import * as path from 'path';
import * as fs from 'fs';
import { PerformerSurfaceMeshService } from '../packages/core/src/node/spatial/PerformerSurfaceMeshService';

// Rebuilds the studio's "Photoreal Surface" mesh (public/models/humanoid_<id>.glb) for each demo from its
// fitted SMPL-X body and trained splats. Usage: npx vite-node scripts/build_performer_surfaces.ts [ids...]

const demosDir = path.resolve(process.cwd(), 'models/performer_4dgs/demos');
const only = process.argv.slice(2);
const ids = fs.readdirSync(demosDir).filter(id =>
    (only.length === 0 || only.includes(id))
    && fs.existsSync(path.join(demosDir, id, 'gvhmr_body.json'))
    && fs.existsSync(path.join(demosDir, id, 'human_4dgs.ply')));

const service = new PerformerSurfaceMeshService();
for (const id of ids) {
    const t0 = Date.now();
    const out = path.resolve(process.cwd(), 'public/models', `humanoid_${id}.glb`);
    const stats = service.buildForDemo(path.join(demosDir, id), out);
    console.log(`${id}: ${stats.vertices} vertices, ${stats.triangles} triangles -> ${out} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
