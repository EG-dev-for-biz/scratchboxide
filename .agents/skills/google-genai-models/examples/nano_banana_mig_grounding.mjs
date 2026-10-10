import { createGenAIClient } from '../scripts/google_genai_hub.mjs';

async function main() {
  console.log('🍌 Invoking Nano Banana 2.1 with Maps Imagery Grounding (MIG)...');

  const { client, mode, creds } = createGenAIClient({ vertex: true });
  console.log(`📡 Connected to Vertex AI [Project: ${creds.projectId}, Location: ${creds.location}]`);

  const prompt = `Synthesize an ultra-high-resolution architectural photograph of the Colosseum in Rome:
Vantage Point: Southern exterior facade at eye level looking up at the travertine arches.
Lighting: Late afternoon golden hour with long soft shadows and warm limestone specular bounce.
Grounding: Street View panorama reference looking north from Via Celio Vibenna.
Fidelity: Razor-sharp masonry relief, micro-cavitation pores, natural weathering stains, and clean sky backdrop.`;

  try {
    // Model query with Vertex AI Maps Imagery Grounding tool definition
    const response = await client.models.generateContent({
      model: 'nano-banana-2.1-mig',
      contents: prompt,
      config: {
        tools: [
          {
            googleMaps: {
              groundingTypes: {
                streetviewImagery: {}
              }
            }
          }
        ],
        temperature: 0.2
      }
    });

    console.log('✨ Model Response:', response.text || '(Image generation completed)');
    const candidate = response.candidates?.[0];
    const groundingChunks = candidate?.groundingMetadata?.groundingChunks;
    if (groundingChunks) {
      console.log('🗺️ Grounding Chunks:', JSON.stringify(groundingChunks, null, 2));
    }
  } catch (err) {
    console.log(`ℹ️ Nano Banana MIG note: ${err.message}`);
  }
}

main().catch(console.error);
