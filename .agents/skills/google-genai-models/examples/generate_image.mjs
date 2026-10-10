import { generateImages } from '../scripts/google_genai_hub.mjs';
import path from 'path';

async function main() {
  console.log('🎨 Invoking Imagen 3 for Photographic Surface Texture Synthesis...');

  const outputPath = path.resolve(process.cwd(), 'public/renders/travertine_pbr_albedo.png');

  const result = await generateImages({
    model: 'imagen-3.0-generate-002',
    prompt: 'Macro photographic flat lay of Roman travertine stone, orthogonal top-down texture map, perfectly flat diffuse lighting without harsh shadows, micro-cavitation pores, natural mineral grain, 8k photographic resolution, razor-sharp edge focus, tactile surface relief, physically accurate albedo.',
    aspectRatio: '1:1',
    outputPath
  });

  console.log(`✨ Generated ${result.count} texture image saved to: ${result.savedPaths[0]}`);
}

main().catch(console.error);
