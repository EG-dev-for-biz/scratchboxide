import { test } from 'vitest';
import { DEFAULT_ACTIVE_USER_NAME } from '../src/browser/generative-canvas/canvas-types';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { MarkdownDocumentData, MarkdownSection } from '../src/browser/generative-canvas/canvas-types';
import {
    extractDocumentTitleFromPrompt,
    synthesizeComprehensiveDocument
} from '../src/browser/generative-canvas/document-synthesis-engine';

async function run4DMultimodalDocumentTests() {
    console.log('🧪 Running 4D Multi-Modal Document Generation & Adaptive Depth Test Suite...\n');

    // Test 1: Title Extraction
    console.log('Test 1: Document title extraction heuristics...');
    const title1776: string = extractDocumentTitleFromPrompt('write an extensive document on the importance of 1776');
    assert.ok(title1776.includes('1776'), 'Title includes 1776');

    const titleAuth: string = extractDocumentTitleFromPrompt('draft technical architecture for oauth2 zero-trust auth');
    assert.ok(/Authentication|Zero-Trust|Security/i.test(titleAuth), 'Title recognizes Auth/Zero-Trust domain');

    const titleGeneric: string = extractDocumentTitleFromPrompt('write a document about modern quantum computing algorithms');
    assert.ok(titleGeneric.includes('Quantum Computing Algorithms'), 'Clean title derived from generic prompt');
    console.log('  ✓ Test 1 Passed: Accurate title extraction across varied domains.');

    // Test 2: Rich 4D Multi-Modal Synthesis for 1776 Document
    console.log('\nTest 2: Synthesizing 1776 document with rich 4D multi-modal capabilities...');
    const doc1776: MarkdownDocumentData = synthesizeComprehensiveDocument('write an extensive document on the importance of 1776');
    assert.ok(doc1776.title.includes('1776'), '1776 title set');
    assert.strictEqual(doc1776.author, DEFAULT_ACTIVE_USER_NAME, '1776 document author is attributed to the signed-in user');
    assert.ok(doc1776.sections && doc1776.sections.length > 5, 'Comprehensive document has rich section count');

    // Check for Location Imagery Section
    const locSection: MarkdownSection | undefined = doc1776.sections.find(s => s.type === 'location-image');
    assert.ok(locSection, 'Document contains a location-image section');
    assert.ok(locSection?.locationName, 'Location name is populated (e.g. Independence Hall)');
    assert.ok(locSection?.coordinates?.lat && locSection?.coordinates?.lng, 'Coordinates are populated');
    assert.ok(locSection?.caption, 'Location caption exists');

    // Check for Video / Temporal Reconstruction Section
    const videoSection: MarkdownSection | undefined = doc1776.sections.find(s => s.type === 'video');
    assert.ok(videoSection, 'Document contains a video/reconstruction section');
    assert.ok(videoSection?.videoTitle, 'Video title is present');
    assert.ok(videoSection?.duration, 'Video duration is specified');
    assert.ok(videoSection?.timelineEvents && videoSection.timelineEvents.length > 0, 'Timeline events / scrubber keyframes are present');

    // Check for SVG Diagram / Graph Section
    const svgSection: MarkdownSection | undefined = doc1776.sections.find(s => s.type === 'svg-diagram');
    assert.ok(svgSection, 'Document contains an svg-diagram section');
    assert.ok(svgSection?.svgContent?.includes('<svg'), 'Valid inline SVG content is embedded');
    assert.ok(svgSection?.diagramTitle, 'Diagram title is specified');
    assert.ok(svgSection?.diagramType, 'Diagram type is categorized');

    // Check for Grounded Primary Source Citations Section
    const citationSection: MarkdownSection | undefined = doc1776.sections.find(s => s.type === 'citation');
    assert.ok(citationSection, 'Document contains grounded citations');
    assert.ok(citationSection?.citationItems && citationSection.citationItems.length >= 2, 'Multiple grounded citation sources included');
    assert.ok(citationSection?.citationItems?.some(c => c.verified), 'Contains verified source citations');
    assert.ok(citationSection?.citationItems?.some(c => c.url?.startsWith('http')), 'Contains valid external reference URLs');
    console.log('  ✓ Test 2 Passed: 1776 document synthesizes location imagery, video reconstruction, SVG diagram, and grounded citations.');

    // Test 3: Technical Architecture 4D Synthesis
    console.log('\nTest 3: Synthesizing Technical Specification with 4D Multi-Modal Blocks...');
    const docAuth: MarkdownDocumentData = synthesizeComprehensiveDocument('create technical architecture spec for zero-trust identity system');
    assert.strictEqual(docAuth.author, DEFAULT_ACTIVE_USER_NAME, 'Technical architecture author is attributed to the signed-in user');
    const authSvg: MarkdownSection | undefined = docAuth.sections.find(s => s.type === 'svg-diagram');
    assert.ok(authSvg, 'Technical spec contains architecture SVG diagram');
    assert.ok(authSvg?.svgContent?.includes('<svg'), 'Technical diagram contains valid SVG XML markup');

    const authCitations: MarkdownSection | undefined = docAuth.sections.find(s => s.type === 'citation');
    assert.ok(authCitations, 'Technical spec contains standard RFC / NIST citations');
    assert.ok(authCitations?.citationItems?.some(c => c.sourceTitle.includes('RFC') || c.sourceTitle.includes('NIST') || c.sourceTitle.includes('W3C')), 'Contains standard specification citations');
    console.log('  ✓ Test 3 Passed: Technical architecture synthesizes domain-specific SVG diagrams and RFC citations.');

    // Test 4: Adaptive Depth / Pull Back Restraint
    console.log('\nTest 4: Adaptive Depth - Pulling back when concise/text-only is requested...');
    const conciseDoc: MarkdownDocumentData = synthesizeComprehensiveDocument('write a concise, text-only minimal document on the importance of 1776 without images or media');
    assert.strictEqual(conciseDoc.author, DEFAULT_ACTIVE_USER_NAME, 'Concise document author is attributed to the signed-in user');
    const hasMediaInConcise = conciseDoc.sections.some(s => s.type === 'location-image' || s.type === 'video' || s.type === 'svg-diagram');
    assert.strictEqual(hasMediaInConcise, false, 'Concise/text-only request omits heavy media and diagram blocks');
    assert.ok(conciseDoc.sections.some(s => s.type === 'heading'), 'Contains clean headings');
    assert.ok(conciseDoc.sections.some(s => s.type === 'paragraph'), 'Contains clean paragraphs');
    console.log('  ✓ Test 4 Passed: Gracefully pulls back when user prefers clean text or concise notes.');

    // Test 5: Verify CSS rules in unified-ui.css and index.css
    console.log('\nTest 5: Verifying CSS selectors for 4D Multi-Modal blocks in unified-ui.css & index.css...');
    const unifiedCssPath = path.resolve(__dirname, '../src/browser/style/unified-ui.css');
    const unifiedCss = fs.readFileSync(unifiedCssPath, 'utf8');

    assert.ok(unifiedCss.includes('.sb-doc-location-card'), 'unified-ui.css defines .sb-doc-location-card');
    assert.ok(unifiedCss.includes('.sb-doc-video-card'), 'unified-ui.css defines .sb-doc-video-card');
    assert.ok(unifiedCss.includes('.sb-doc-svg-card'), 'unified-ui.css defines .sb-doc-svg-card');
    assert.ok(unifiedCss.includes('.sb-doc-citations-grid'), 'unified-ui.css defines .sb-doc-citations-grid');
    assert.ok(unifiedCss.includes('.sb-citation-badge'), 'unified-ui.css defines .sb-citation-badge');
    console.log('  ✓ Test 5 Passed: CSS stylesheets define styling for location, video, SVG, and citation blocks.');

    // Test 6: Verify Clean Editorial Media Presentation (No Sci-Fi / Gimmicky 4D Badges in UI)
    console.log('\nTest 6: Verifying elimination of gimmicky 4D badges from MarkdownDocumentPrimitive...');
    const primitivePath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive.tsx');
    assert.ok(fs.existsSync(primitivePath), 'MarkdownDocumentPrimitive.tsx exists');
    const primitiveSource = fs.readFileSync(primitivePath, 'utf8');

    assert.ok(!primitiveSource.includes('4D Spatial Anchor'), 'MarkdownDocumentPrimitive must not render "4D Spatial Anchor" badge');
    assert.ok(!primitiveSource.includes('4D Temporal Simulation'), 'MarkdownDocumentPrimitive must not render "4D Temporal Simulation" badge');
    assert.ok(!primitiveSource.includes('+ 4D Diagram'), 'MarkdownDocumentPrimitive must not contain "+ 4D Diagram" button label');
    assert.ok(!primitiveSource.includes('4D Diagram'), 'MarkdownDocumentPrimitive must not contain "4D Diagram" label');
    assert.ok(primitiveSource.includes('+ Diagram'), 'MarkdownDocumentPrimitive uses clean "+ Diagram" quick action');
    assert.ok(primitiveSource.includes('+ Video'), 'MarkdownDocumentPrimitive uses clean "+ Video" quick action');
    assert.ok(primitiveSource.includes('+ Map'), 'MarkdownDocumentPrimitive uses clean "+ Map" quick action');
    assert.ok(primitiveSource.includes('+ Citation'), 'MarkdownDocumentPrimitive uses clean "+ Citation" quick action');
    console.log('  ✓ Test 6 Passed: MarkdownDocumentPrimitive has eliminated all gimmicky 4D labels in favor of clean editorial controls.');

    // Test 7: Verify Clean Editorial Titles & Descriptions in Synthesized Documents
    console.log('\nTest 7: Verifying clean natural titles and descriptions in synthesized documents...');
    const testDoc1776 = synthesizeComprehensiveDocument('write a document about 1776');
    const testVideo1776 = testDoc1776.sections.find(s => s.type === 'video');
    assert.ok(testVideo1776, '1776 video section present');
    assert.ok(!testVideo1776?.description?.includes('4D Temporal reconstruction'), 'Video description has no gimmicky "4D" phrasing');
    assert.ok(!testVideo1776?.videoTitle?.includes('Temporal Simulation:'), 'Video title has clean editorial phrasing');

    const testLoc1776 = testDoc1776.sections.find(s => s.type === 'location-image');
    assert.ok(testLoc1776, '1776 location image present');
    assert.ok(!testLoc1776?.locationName?.includes('Spatial Anchor'), 'Location title has clean real-world naming');
    // Test 8: Verify authentic historical/contextual imagery (no generic modern library placeholders)
    console.log('\nTest 8: Verifying text-motivated authentic imagery for 1776 and architecture...');
    assert.ok(testLoc1776?.imageUrl && !testLoc1776.imageUrl.includes('photo-1569407228235-9a744831a150'), '1776 document does NOT use generic modern library photo');
    assert.strictEqual(testLoc1776?.coordinates?.lat, 39.9489, '1776 location latitude is Philadelphia Independence Hall');
    assert.strictEqual(testLoc1776?.coordinates?.lng, -75.1500, '1776 location longitude is Philadelphia Independence Hall');
    assert.ok(testLoc1776?.visualPrompt?.includes('Independence Hall') || testLoc1776?.visualPrompt?.includes('colonial'), 'Visual prompt is deeply motivated by 1776 colonial setting');
    console.log('  ✓ Test 8 Passed: 1776 imagery is authentically motivated by Independence Hall with exact coordinates.');

    // Test 9: Semantic Theme Detection and Motivated Media Synthesis across Domains
    console.log('\nTest 9: Verifying semantic theme detection and motivated media across domains...');
    const {
        detectDocumentTheme,
        generateMotivatedLocationSection,
        generateMotivatedVideoSection,
        generateMotivatedSvgSection,
        generateMotivatedCitationSection
    } = await import('../src/browser/generative-canvas/document-synthesis-engine');

    assert.strictEqual(detectDocumentTheme('write about the american revolution in 1776'), '1776-revolution');
    assert.strictEqual(detectDocumentTheme('zero-trust identity specification with oauth2 and webauthn passkeys'), 'auth-zerotrust-security');
    assert.strictEqual(detectDocumentTheme('neural attention mechanism and multi-modal transformer llm architecture'), 'ai-machine-learning');
    assert.strictEqual(detectDocumentTheme('quarterly product delivery roadmap and strategic milestones'), 'product-strategy-roadmap');

    const authLoc = generateMotivatedLocationSection('auth-zerotrust-security');
    assert.ok(authLoc.locationName?.includes('Ashburn') || authLoc.locationName?.includes('Edge'), 'Auth location maps to Edge PoP / Datacenter');
    assert.strictEqual(authLoc.coordinates?.lat, 39.0438);

    const aiLoc = generateMotivatedLocationSection('ai-machine-learning');
    assert.ok(aiLoc.locationName?.includes('AI') || aiLoc.locationName?.includes('Cambridge'), 'AI location maps to compute laboratory');
    assert.strictEqual(aiLoc.coordinates?.lat, 42.3619);

    const aiCitations = generateMotivatedCitationSection('ai-machine-learning');
    assert.ok(aiCitations.citationItems?.some((c: any) => c.sourceTitle.includes('Attention Is All You Need')), 'AI citations include Attention Is All You Need');
    console.log('  ✓ Test 9 Passed: Deeply motivated media generation confirmed across historical, security, AI, and roadmap domains.');

    // Test 10: In-place block generation helper binding
    console.log('\nTest 10: Verifying in-place motivated block generation helpers...');
    const histLoc = generateMotivatedLocationSection('1776-revolution');
    assert.ok(histLoc.locationName?.includes('Independence Hall'), 'Motivated block generator produces Independence Hall');
    assert.ok(histLoc.imageUrl && !histLoc.imageUrl.includes('photo-1569407228235-9a744831a150'), 'Motivated block generator uses authentic colonial image');

    const histVid = generateMotivatedVideoSection('1776-revolution');
    assert.ok(histVid.videoTitle?.includes('Delaware') || histVid.videoTitle?.includes('1776'), 'Motivated video generator produces Delaware Crossing');
    assert.ok(histVid.timelineEvents && histVid.timelineEvents.length >= 3, 'Motivated video has timeline scrubber events');

    const histSvg = generateMotivatedSvgSection('1776-revolution');
    assert.ok(histSvg.svgContent?.includes('Common Sense') && histSvg.svgContent?.includes('Declaration Ratified'), 'Motivated SVG contains milestone events');
    console.log('  ✓ Test 10 Passed: In-place motivated block helpers generate theme-bound media.');

    // Test 11: Nano Banana Editorial Image Generation & Art Styles
    console.log('\nTest 11: Verifying Nano Banana Editorial Image Generation & Art Styles...');
    const { generateMotivatedEditorialImageSection } = await import('../src/browser/generative-canvas/document-synthesis-engine');
    const histEditorial = generateMotivatedEditorialImageSection('1776-revolution');
    assert.strictEqual(histEditorial.type, 'editorial-image', 'Editorial image section has type editorial-image');
    assert.ok(histEditorial.imageTitle?.includes('Delaware') || histEditorial.imageTitle?.includes('Washington'), 'Editorial image title reflects historical narrative');
    assert.ok(histEditorial.attribution?.includes('Metropolitan Museum') || histEditorial.attribution?.includes('Historical'), 'Editorial image has authentic source attribution');
    assert.ok(histEditorial.stylePreset?.includes('Oil Painting'), 'Editorial image has style preset');
    assert.ok(histEditorial.visualPrompt?.includes('oil painting') || histEditorial.visualPrompt?.includes('Washington'), 'Visual prompt uses Nano Banana synthesis pattern');
    assert.ok(primitiveSource.includes('handleNanoBananaRegenerate'), 'MarkdownDocumentPrimitive implements handleNanoBananaRegenerate');
    assert.ok(primitiveSource.includes('sb-editorial-image-frame'), 'MarkdownDocumentPrimitive uses clean editorial image frame');
    assert.ok(primitiveSource.includes('sb-editorial-lightbox'), 'MarkdownDocumentPrimitive supports lightbox zoom');
    assert.ok(unifiedCss.includes('.sb-doc-editorial-image-card'), 'unified-ui.css defines .sb-doc-editorial-image-card');
    assert.ok(unifiedCss.includes('.sb-editorial-lightbox-modal'), 'unified-ui.css defines .sb-editorial-lightbox-modal');
    console.log('  ✓ Test 11 Passed: Nano Banana editorial images, styles, attribution, and lightbox zoom verified.');

    // Test 12: Cinematic editorial location cards remain isolated, accessible, and responsive
    console.log('\nTest 12: Verifying cinematic editorial location-card presentation...');
    const locationClassNames = [
        'sb-location-media-frame',
        'sb-location-image-element',
        'sb-location-context-label',
        'sb-location-zoom-action',
        'sb-location-caption-area',
        'sb-location-title-text',
        'sb-location-caption-text',
        'sb-location-footer-row',
        'sb-location-metadata',
        'sb-location-prompt-disclosure'
    ];
    locationClassNames.forEach(className => {
        assert.ok(primitiveSource.includes(className), `Location card uses dedicated ${className} class`);
        assert.ok(unifiedCss.includes(`.${className}`), `unified-ui.css defines dedicated .${className}`);
    });
    assert.ok(
        primitiveSource.includes('aria-label={`Zoom location image: ${displayTitle}`}'),
        'Location Zoom control has a descriptive title-specific aria-label'
    );
    assert.ok(
        primitiveSource.includes('getLocationFallbackSvg(displayTitle, displayDateTag, displayAttribution, doc.title)'),
        'Location image failures use the dedicated location fallback helper'
    );
    assert.ok(primitiveSource.includes('export function getLocationFallbackSvg'), 'Location fallback helper is exported for focused validation');
    assert.ok(primitiveSource.includes('<tspan'), 'Location fallback wraps long locator titles with SVG tspans');
    assert.ok(primitiveSource.includes('slice(0, 2)'), 'Location fallback clamps locator titles to two lines');
    assert.ok(primitiveSource.includes('slice(0, 42)'), 'Location fallback constrains long context labels');
    assert.ok(primitiveSource.includes('slice(0, 74)'), 'Location fallback constrains long location metadata');
    const { getLocationFallbackSvg } = await import('../src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive');
    const longFallbackSvg = decodeURIComponent(getLocationFallbackSvg(
        'Washington Crossing the Delaware at the Historic Pennsylvania River Landing with an Intentionally Long Locator Title',
        'An intentionally long historical context label that must remain compact and constrained',
        'Historical Landmark • 40.2968° N, 74.8682° W • Additional archival provenance that must be restrained',
        'The Pivotal Year: 1776'
    ));
    assert.strictEqual((longFallbackSvg.match(/<tspan/g) || []).length, 2, 'Long locator titles are clamped to two wrapped SVG lines');
    assert.ok(longFallbackSvg.includes('#241b14'), 'Historical location fallback uses the restrained warm historical variant');
    assert.ok(!longFallbackSvg.includes('intentionally long historical context label that must remain compact and constrained'.toUpperCase()), 'Long context labels are clamped');
    assert.ok(!longFallbackSvg.includes('Additional archival provenance that must be restrained'), 'Long location metadata is clamped');
    const infrastructureFallbackSvg = decodeURIComponent(getLocationFallbackSvg('Ashburn Edge PoP', 'Network location', '39.0438° N', 'Zero-trust security'));
    assert.ok(infrastructureFallbackSvg.includes('#101c26'), 'Infrastructure locations use the restrained cool locator variant');

    assert.ok(unifiedCss.includes('.sb-doc-location-card .sb-location-media-frame'), 'Location viewport sizing is scoped to location cards');
    assert.ok(unifiedCss.includes('aspect-ratio: 16 / 9'), 'Location viewport has a stable 16:9 aspect ratio');
    assert.ok(unifiedCss.includes('.sb-location-zoom-action:focus-visible'), 'Location Zoom exposes visible keyboard focus');
    assert.ok(unifiedCss.includes('.sb-location-prompt-disclosure .sb-prompt-summary:focus-visible'), 'Location prompt summary exposes visible keyboard focus');
    assert.ok(unifiedCss.includes('@media (max-width: 560px)'), 'Location card footer has a narrow responsive breakpoint');
    assert.ok(unifiedCss.includes('@media (prefers-reduced-motion: reduce)'), 'Location card honors reduced-motion preferences');
    assert.ok(unifiedCss.includes('body.sb-light .sb-doc-location-card .sb-location-caption-area'), 'Location card has scoped light-theme caption contrast');
    assert.ok(unifiedCss.includes('body.sb-light .sb-location-zoom-action'), 'Location Zoom has a light-theme contrast override');
    assert.ok(!primitiveSource.includes('4D Spatial Anchor'), 'Location restyle does not reintroduce gimmicky 4D labels');
    console.log('  ✓ Test 12 Passed: Location cards are isolated, responsive, accessible, and theme-safe.');

    console.log('\n🎉 ALL 4D MULTI-MODAL DOCUMENT TESTS PASSED!');
}

test('document-4d-multimodal.test', async () => {
    await run4DMultimodalDocumentTests();
}, 180_000);
