#!/usr/bin/env node
/**
 * Diagnostic Model Access Checker
 * Tests connectivity and privileges for GA, Preview, Experimental, and Whitelisted models.
 */

import { resolveCredentials, createGenAIClient, getModelRegistry } from './google_genai_hub.mjs';

async function testAccess() {
  console.log('========================================================================');
  console.log('🔍 Google Generative AI Developer Access Diagnostic');
  console.log('========================================================================\n');

  const creds = resolveCredentials();
  console.log('🔑 Credential Status:');
  console.log(`  • AI Studio API Key:      ${creds.apiKey ? '✅ Found (' + creds.apiKey.slice(0, 8) + '...)' : '❌ Not Found'}`);
  console.log(`  • Service Account JSON:   ${creds.serviceAccount ? '✅ Found (' + creds.serviceAccount.client_email + ')' : '❌ Not Found'}`);
  console.log(`  • GCP Project ID:         ${creds.projectId ? '✅ ' + creds.projectId : '❌ Not Set'}`);
  console.log(`  • GCP Location:           ${creds.location}\n`);

  const registry = getModelRegistry();
  const tiers = ['ga', 'preview', 'experimental', 'whitelisted'];

  for (const tier of tiers) {
    const models = registry.models.filter(m => m.lifecycle === tier);
    const tag = tier === 'ga' ? '🟢 GA' : tier === 'preview' ? '🟡 PREVIEW' : tier === 'experimental' ? '🟣 EXPERIMENTAL' : '🔒 WHITELISTED';
    console.log(`\n--- ${tag} Models (${models.length}) ---`);

    for (const m of models) {
      console.log(`  • ${m.id.padEnd(35)} [${m.provider.toUpperCase()}] -> ${m.displayName}`);
    }
  }

  console.log('\n========================================================================');
  console.log('💡 Quick Verification Tip:');
  console.log('  To verify a model live with network access:');
  console.log('  node .agents/skills/google-genai-models/scripts/google_genai_hub.mjs --generate --model gemini-2.5-pro --prompt "Ping"');
  console.log('========================================================================\n');
}

testAccess().catch(console.error);
