import { generateContent } from '../scripts/google_genai_hub.mjs';

async function main() {
  console.log('🤖 Invoking Gemini 2.5 Pro for Structured Procedural Code Generation...');

  const result = await generateContent({
    model: 'gemini-2.5-pro',
    systemInstruction: 'You are an expert computational geometer for Scratchbox IDE C++20 engine.',
    prompt: `Generate a JSON object defining the continuous physical parameters for an alien crystal spire:
- heightMeters: continuous float
- twistTurns: continuous float
- radialHarmonicLobes: integer
- surfaceCavitationDepth: continuous float
- materialAlbedoRgb: [r, g, b] normalized floats`,
    json: true
  });

  console.log('✨ Response:\n', result.text);
}

main().catch(console.error);
