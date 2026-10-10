import { createGenAIClient } from '../scripts/google_genai_hub.mjs';

async function main() {
  console.log('🎬 Initiating Google Veo 2 Cinematic Video Generation...');

  const { client } = createGenAIClient();

  // Veo 2 generation request via unified Google GenAI SDK
  const prompt = `Cinematic 24fps shot of an F1 race car drifting smoothly around the Fairmont hairpin in Monaco.
Camera: Low-angle tracking shot moving alongside the car chassis, shallow depth of field, subtle organic camera shake.
Lighting: Late afternoon golden hour Mediterranean sun casting warm specular glints across the carbon fiber bodywork.
Style: 4K film stock, natural physical tire smoke dynamics, single continuous unbroken shot with no scene cuts.`;

  try {
    const operation = await client.models.generateVideos({
      model: 'veo-2.0-generate-001',
      prompt,
      config: {
        fps: 24,
        aspectRatio: '16:9',
        outputMimeType: 'video/mp4'
      }
    });

    console.log('✨ Video generation operation submitted:', operation);
  } catch (err) {
    console.error('Video generation error:', err.message);
  }
}

main().catch(console.error);
