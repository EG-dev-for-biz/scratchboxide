import { fetchGcapFeatureTile, decodeGcapDeltaOffsets } from '../scripts/google_genai_hub.mjs';

async function main() {
  console.log('🗺️ Querying Google Map Tiles API (GCAP Vector Tiles)...');

  // Tile coordinates for Zoom 17 (e.g., Manhattan / Columbus Circle)
  const zoom = 17;
  const x = 38600;
  const y = 49265;

  try {
    const result = await fetchGcapFeatureTile({
      zoom,
      x,
      y,
      enableModeledVolumes: true,
      alwaysIncludeBuildingFootprints: true
    });

    console.log(`✅ Retrieved Tile with ${result.featureCount} features (ETag: ${result.eTag || 'none'})`);

    let modeledVolumeCount = 0;
    let extrudedAreaCount = 0;
    let roadCount = 0;
    let detailedMarkingCount = 0;

    for (const f of result.tile.features || []) {
      const types = f.types || [];
      if (types.includes('FEATURE_TYPE_ROAD')) roadCount++;
      if (types.includes('FEATURE_TYPE_DETAILED_ROAD_MARKINGS')) detailedMarkingCount++;

      if (f.geometry?.modeledVolumes?.length > 0) {
        modeledVolumeCount += f.geometry.modeledVolumes.length;
        // Decode first 3D building volume
        const vol = f.geometry.modeledVolumes[0];
        const points = decodeGcapDeltaOffsets(vol.vertexOffsets);
        console.log(`  🏢 Modeled Volume decoded: ${points.length} 3D vertices, ${vol.strips?.length || 0} triangle strips`);
      }

      if (f.geometry?.extrudedAreas?.length > 0) {
        extrudedAreaCount += f.geometry.extrudedAreas.length;
      }
    }

    console.log('\nSummary:');
    console.log(`  • 3D Modeled Volumes (Buildings): ${modeledVolumeCount}`);
    console.log(`  • 2.5D Extruded Building Areas:  ${extrudedAreaCount}`);
    console.log(`  • Road Segments:                 ${roadCount}`);
    console.log(`  • Detailed Road Markings:        ${detailedMarkingCount}`);
  } catch (err) {
    console.log(`ℹ️ GCAP Vector Tile fetch: ${err.message}`);
  }
}

main().catch(console.error);
