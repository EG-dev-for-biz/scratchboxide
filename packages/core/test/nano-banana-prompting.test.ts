import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import {
    NANO_BANANA_STYLES,
    synthesizeContextualNanoBananaPrompt,
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
    // A prompt and its style only: no catalog image or model credit comes with it (the media job makes the image).
    assert.deepStrictEqual(Object.keys(signingResult).sort(), ['prompt', 'styleLabel'], 'Result carries no stock image or attribution');
    console.log('  ✓ Test 1 Passed: Rich contextual prompt generated for Declaration of Independence Signing.');

    // Test 2: Style Transformations on the same historical context
    console.log('\nTest 2: Verifying style transformations preserve document context while altering artistic medium...');
    const oilResult = synthesizeContextualNanoBananaPrompt({ ...signingContext, styleId: 'oil-painting' });
    assert.ok(/oil painting|impasto|chiaroscuro|fine art|canvas/i.test(oilResult.prompt), 'Oil painting style contains painterly texture keywords');
    assert.ok(oilResult.prompt.includes('Declaration') || oilResult.prompt.includes('Congress'), 'Preserves historical subject');

    const engravingResult = synthesizeContextualNanoBananaPrompt({ ...signingContext, styleId: 'vintage-engraving' });
    assert.ok(/engraving|copperplate|cross-hatching|etching|sepia|intaglio/i.test(engravingResult.prompt), 'Engraving style contains printmaking keywords');

    const blueprintResult = synthesizeContextualNanoBananaPrompt({ ...signingContext, styleId: 'architectural' });
    assert.ok(/architectural|blueprint|schematic|drafting|elevation/i.test(blueprintResult.prompt), 'Blueprint style contains drafting keywords');
    console.log('  ✓ Test 2 Passed: Style switching modifies aesthetic directives while retaining deep historical context.');

    // Test 4: Document Synthesis Engine Integration
    console.log('\nTest 4: Verifying Document Synthesis Engine produces contextual Nano Banana metadata...');
    // Media is opt-in (b867569b, Multimedia Policy): a plain request carries no image or video section.
    const plainDoc = synthesizeComprehensiveDocument('write an extensive document about 1776');
    assert.ok(
        !plainDoc.sections.some(s => s.type === 'editorial-image' || s.type === 'video'),
        'No editorial/video section is injected when the prompt did not ask for media'
    );
    const doc1776 = synthesizeComprehensiveDocument('write an extensive document about 1776 with illustrations');
    const editorialSec = doc1776.sections.find(s => s.type === 'editorial-image' || s.type === 'video');
    assert.ok(editorialSec, 'Editorial/video section exists in synthesized 1776 document');
    assert.ok(editorialSec?.visualPrompt, 'Section contains rich visualPrompt');
    assert.ok(editorialSec?.visualPrompt?.includes('1776') || editorialSec?.visualPrompt?.includes('Washington') || editorialSec?.visualPrompt?.includes('Declaration'), 'visualPrompt contains contextual entities');
    assert.strictEqual(editorialSec?.attribution, undefined, 'No model is credited before an image was generated');
    assert.strictEqual(editorialSec?.imageUrl, undefined, 'No stock image stands in for the generation');
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

test('nano-banana-prompting.test', async () => {
    await runNanoBananaPromptingTests();
}, 180_000);
