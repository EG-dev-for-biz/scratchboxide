import { generateContent } from '../scripts/google_genai_hub.mjs';
import path from 'path';

async function main() {
  console.log('👁️ Invoking Gemini Multimodal Visual Inspection...');

  const imagePath = path.resolve(process.cwd(), 'public/images/start_frame_01_omni.png');

  const result = await generateContent({
    model: 'gemini-2.5-pro',
    systemInstruction: 'You are an elite VFX Art Director and 3D visual critic.',
    images: [imagePath],
    prompt: `Analyze the lighting and material composition of this reference frame:
1. Identify the key light color temperature and ambient fill balance.
2. Note the surface roughness and architectural fenestration detailing.
3. Suggest 3 specific PBR metallic-roughness adjustments for 3D model synchronization.`
  });

  console.log('✨ Analysis:\n', result.text);
}

main().catch(console.error);
