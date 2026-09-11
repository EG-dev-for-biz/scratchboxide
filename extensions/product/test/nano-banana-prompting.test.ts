/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import {
    NANO_BANANA_STYLES,
    synthesizeContextualNanoBananaPrompt,
    lookupCuratedNanoBananaImage,
    NanoBananaPromptContext
} from '../src/browser/generative-canvas/nano-banana-service';
import { synthesizeComprehensiveDocument } from '../src/browser/generative-canvas/document-synthesis-engine';

async function runNanoBananaPromptingTests() {
    console.log('🍌 Running Nano Banana Contextual Prompting & Image Engine Test Suite...\n');

    // Test 1: Declaration of Independence Signing contextual prompt synthesis
    console.log('Test 1: Synthesizing contextual prompt for Declaration of Independence Signing...');
    const signingContext: NanoBananaPromptContext = {
        docTitle: 'The Pivotal Year: 1776 and the Birth of a Nation',
        docSubtitle: 'Examining the Birth of a Nation, Enlightenment Philosophy, and the Crucible of Liberty',
        sectionTitle: 'Reenactment of the Declaration of Independence Signing',
        sectionContent: 'A conceptual video simulating the atmosphere and key moments of the Second Continental Congress as delegates debate and ultimately sign the Declaration of Independence. Keyframes would highlight the presentation of the draft, the vote, and the ceremonial signing.',
        adjacentText: 'Drafted by Thomas Jefferson and refined by the Committee of Five (John Adams, Benjamin Franklin, Roger Sherman, Robert Livingston).',
        styleId: 'cinematic-film'
    };

    const signingResult = synthesizeContextualNanoBananaPrompt(signingContext);
    assert.ok(signingResult.prompt, 'Generated prompt exists');
    assert.ok(signingResult.prompt.includes('Declaration of Independence') || signingResult.prompt.includes('Second Continental Congress'), 'Prompt includes core subject');
    assert.ok(signingResult.prompt.includes('Philadelphia') || signingResult.prompt.includes('Pennsylvania State House') || signingResult.prompt.includes('Assembly Room'), 'Prompt includes historical location setting');
    assert.ok(/parchment|quill|colonial|frock|Georgian/i.test(signingResult.prompt), 'Prompt includes authentic period entities (parchment/quill/Georgian)');
    assert.ok(/35mm|cinematic|anamorphic|film|lighting|lens/i.test(signingResult.prompt), 'Prompt includes cinematic film optics and lighting');
    assert.ok(signingResult.attribution.includes('Nano Banana'), 'Attribution specifies Nano Banana');
    assert.ok(signingResult.curatedImageUrl.startsWith('http') || signingResult.curatedImageUrl.startsWith('data:image/svg+xml') || signingResult.curatedImageUrl.includes('<svg'), 'Curated image URL or vector is provided');
    // Ensure it does NOT use the generic stamp/railway collage
    assert.ok(!signingResult.curatedImageUrl.includes('photo-1582555172866'), 'Does not use generic postcard collage');
    console.log('  ✓ Test 1 Passed: Rich contextual prompt generated for Declaration of Independence Signing.');

    // Test 2: Style Transformations on the same historical context
    console.log('\nTest 2: Verifying style transformations preserve document context while altering artistic medium...');
    const oilResult = synthesizeContextualNanoBananaPrompt({ ...signingContext, styleId: 'oil-painting' });
    assert.ok(/oil painting|impasto|chiaroscuro|fine art|canvas/i.test(oilResult.prompt), 'Oil painting style contains painterly texture keywords');
    assert.ok(oilResult.prompt.includes('Declaration') || oilResult.prompt.includes('Congress'), 'Preserves historical subject');

    const engravingResult = synthesizeContextualNanoBananaPrompt({ ...signingContext, styleId: 'vintage-engraving' });
    assert.ok(/engraving|copperplate|cross-hatching|etching|sepia|intaglio/i.test(engravingResult.prompt), 'Engraving style contains printmaking keywords');
    assert.ok(engravingResult.curatedImageUrl.startsWith('http') || engravingResult.curatedImageUrl.startsWith('data:image/svg+xml') || engravingResult.curatedImageUrl.includes('<svg'), 'Engraving image URL exists');

    const blueprintResult = synthesizeContextualNanoBananaPrompt({ ...signingContext, styleId: 'architectural' });
    assert.ok(/architectural|blueprint|schematic|drafting|elevation/i.test(blueprintResult.prompt), 'Blueprint style contains drafting keywords');
    console.log('  ✓ Test 2 Passed: Style switching modifies aesthetic directives while retaining deep historical context.');

    // Test 3: Curated high-relevance image catalog lookup
    console.log('\nTest 3: Curated image catalog precision...');
    const declImage = lookupCuratedNanoBananaImage('1776-revolution', 'Reenactment of the Declaration of Independence Signing', 'oil-painting');
    assert.ok(declImage.url, 'Declaration image exists');
    assert.ok(declImage.title.includes('Declaration') || declImage.title.includes('Congress'), 'Image title matches Declaration theme');

    const delawareImage = lookupCuratedNanoBananaImage('1776-revolution', "Washington's Crossing of the Delaware", 'oil-painting');
    assert.ok(delawareImage.url, 'Delaware crossing image exists');
    assert.ok(delawareImage.title.includes('Delaware') || delawareImage.title.includes('Washington'), 'Image title matches Washington Crossing Delaware');

    const zeroTrustImage = lookupCuratedNanoBananaImage('auth-zerotrust-security', 'PKCE Handshake and Passkey Verification', 'architectural');
    assert.ok(zeroTrustImage.url, 'Zero trust image exists');
    console.log('  ✓ Test 3 Passed: Curated catalog delivers distinct, high-relevance imagery for each scene.');

    // Test 4: Document Synthesis Engine Integration
    console.log('\nTest 4: Verifying Document Synthesis Engine produces contextual Nano Banana metadata...');
    const doc1776 = synthesizeComprehensiveDocument('write an extensive document about 1776');
    const editorialSec = doc1776.sections.find(s => s.type === 'editorial-image' || s.type === 'video');
    assert.ok(editorialSec, 'Editorial/video section exists in synthesized 1776 document');
    assert.ok(editorialSec?.visualPrompt, 'Section contains rich visualPrompt');
    assert.ok(editorialSec?.visualPrompt?.includes('1776') || editorialSec?.visualPrompt?.includes('Washington') || editorialSec?.visualPrompt?.includes('Declaration'), 'visualPrompt contains contextual entities');
    assert.ok(editorialSec?.attribution?.includes('Nano Banana'), 'Attribution reflects Nano Banana generation');
    assert.ok(!editorialSec?.imageUrl?.includes('photo-1582555172866'), 'Section does not use generic postage stamp photo');
    console.log('  ✓ Test 4 Passed: Document synthesis engine seamlessly creates contextually enriched Nano Banana sections.');

    // Test 5: Verify all style presets in NANO_BANANA_STYLES have complete metadata
    console.log('\nTest 5: Verifying NANO_BANANA_STYLES catalog completeness...');
    assert.ok(NANO_BANANA_STYLES.length >= 6, 'Contains at least 6 core styles');
    for (const style of NANO_BANANA_STYLES) {
        assert.ok(style.id, 'Style has id');
        assert.ok(style.label, 'Style has label');
        assert.ok(style.hint, 'Style has hint');
    }
    console.log('  ✓ Test 5 Passed: All Nano Banana styles are well-formed and documented.');

    console.log('\n🎉 ALL NANO BANANA CONTEXTUAL PROMPTING TESTS PASSED!');
}

runNanoBananaPromptingTests().catch(err => {
    console.error('❌ Nano Banana Prompting test failure:', err);
    process.exit(1);
});
