#!/usr/bin/env node
/**
 * Automated Model Catalog Updater
 * Fetches the latest live model list from Google Developer API (AI Studio) and Vertex AI,
 * detects new models, and writes an updated model_registry.json.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listModels } from './google_genai_hub.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REGISTRY_PATH = path.resolve(__dirname, '../references/model_registry.json');

async function updateCatalog() {
  console.log('🔄 Checking Google Generative AI endpoints for newly released models...');
  
  const res = await listModels({ live: true });
  
  const catalog = {
    version: `${new Date().getFullYear()}.${String(new Date().getMonth() + 1).padStart(2, '0')}`,
    updatedAt: new Date().toISOString(),
    liveDiscovered: res.liveSource,
    defaultModel: 'gemini-2.5-pro',
    fastModel: 'gemini-2.5-flash',
    experimentalModel: 'gemini-2.0-flash-thinking-exp-01-21',
    models: res.models
  };

  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(catalog, null, 2), 'utf8');
  console.log(`✅ Successfully updated model registry at: ${REGISTRY_PATH}`);
  console.log(`📊 Total Registered Models: ${res.models.length}`);
  console.log(`📡 Live Discovery Status:   ${res.liveSource ? 'CONNECTED (Live)' : 'OFFLINE (Cached fallback)'}`);
}

updateCatalog().catch(console.error);
