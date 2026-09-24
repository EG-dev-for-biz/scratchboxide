import * as fs from 'fs';
import * as path from 'path';
import { UniversalArchiBridgeService } from '../packages/core/src/node/spatial/UniversalArchiBridgeService';

async function main() {
    const bridge = new UniversalArchiBridgeService();
    const macroEntitiesPath = path.resolve(__dirname, '../public/models/macro_entities.json');
    const macroEntities = JSON.parse(fs.readFileSync(macroEntitiesPath, 'utf8'));

    const targets = [
        { id: 'det-temple-venus-roma', file: 'temple_venus_roma_sb_archi.glb' },
        { id: 'det-meta-sudans', file: 'meta_sudans_sb_archi.glb' },
        { id: 'det-velian-ruins', file: 'velian_ruins_sb_archi.glb' },
        { id: 'det-campanile-tower', file: 'campanile_tower_sb_archi.glb' },
        { id: 'det-travertine-blocks', file: 'travertine_blocks_sb_archi.glb' }
    ];

    console.log(`Starting district batch architectural synthesis for ${targets.length} structures...`);

    for (const t of targets) {
        const entity = macroEntities.find((e: any) => e.id === t.id);
        if (!entity) {
            console.warn(`Entity ${t.id} not found in macro_entities.json!`);
            continue;
        }

        const publicOutPath = path.resolve(__dirname, '../public', t.file);
        const cloudRunOutPath = path.resolve(__dirname, '../deploy/cloud-run/spatial-separator/assets', t.file);

        console.log(`\nSynthesizing ${entity.name} (${t.id})...`);
        const result = await bridge.synthesizeStructureFromEntity(entity, {
            outputGlbPath: publicOutPath
        });

        console.log(`✓ Synthesized: ${t.file}`);
        console.log(`  Typology: ${result.typology}`);
        console.log(`  Order: ${result.order}`);
        console.log(`  Vertices: ${result.telemetry.outputVertices}`);
        console.log(`  Triangles: ${result.telemetry.outputTriangles}`);
        console.log(`  File Size: ${fs.statSync(publicOutPath).size} bytes`);
        console.log(`  World Position: ${JSON.stringify(result.worldPosition)}`);

        // Copy to cloud run assets
        fs.copyFileSync(publicOutPath, cloudRunOutPath);
        console.log(`  Copied to Cloud Run assets: ${cloudRunOutPath}`);
    }

    console.log('\nDistrict batch synthesis complete!');
}

main().catch(err => {
    console.error('Error during district batch synthesis:', err);
    process.exit(1);
});
