#!/usr/bin/env node
/**
 * Root convenience entry point for Google GenAI Hub
 */
import { main } from '../.agents/skills/google-genai-models/scripts/google_genai_hub.mjs';

main().catch(err => {
  console.error(err);
  process.exit(1);
});
