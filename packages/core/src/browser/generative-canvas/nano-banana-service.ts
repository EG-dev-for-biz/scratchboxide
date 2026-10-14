/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { DocumentTheme, detectDocumentTheme } from './document-synthesis-engine';
import { NanoBananaStyle, NANO_BANANA_STYLES, getNanoBananaStyle } from './services/location-beautify-service';

export type { NanoBananaStyle };
export { NANO_BANANA_STYLES, getNanoBananaStyle };

export interface NanoBananaPromptContext {
    docTitle: string;
    docSubtitle?: string;
    sectionTitle?: string;
    sectionContent?: string;
    adjacentText?: string;
    styleId?: string;
    aspectRatio?: string;
    theme?: DocumentTheme;
}

/**
 * A generation prompt and its style. There is no image here: the image comes from the media job that runs this
 * prompt (never a stock or catalog image credited to a model).
 */
export interface NanoBananaPromptResult {
    prompt: string;
    styleLabel: string;
}

/**
 * Synthesizes a structured, hyper-specific Nano Banana prompt deeply distilled from the document's contextual text.
 */
export function synthesizeContextualNanoBananaPrompt(context: NanoBananaPromptContext): NanoBananaPromptResult {
    const theme = context.theme || detectDocumentTheme(
        context.docTitle,
        `${context.sectionTitle || ''} ${context.sectionContent || ''} ${context.adjacentText || ''}`
    );

    const styleId = context.styleId || 'oil-painting';
    const style = NANO_BANANA_STYLES.find(s => s.id === styleId) || NANO_BANANA_STYLES[0];
    const styleLabel = style.label;

    const combinedText = `${context.docTitle} ${context.docSubtitle || ''} ${context.sectionTitle || ''} ${context.sectionContent || ''} ${context.adjacentText || ''}`.toLowerCase();

    // 1. Build Scene & Subject Core
    let subjectCore = '';
    let authenticSetting = '';
    let periodEntities = '';

    if (theme === '1776-revolution') {
        if (/lexington|concord|minutemen|first shot|buckman|pitcairn|parker|battle|shot heard/i.test(combinedText)) {
            subjectCore = 'Captain John Parker and approximately 77 colonial minutemen assembled in defensive formation on Lexington Green at sunrise on April 19, 1775, facing Major John Pitcairn and ranks of British Regulars in crimson coats as the first shot of the American Revolutionary War rings out';
            authenticSetting = 'the misty Lexington village green under cold pastel dawn skies, historic Buckman Tavern and the timber meetinghouse in the backdrop, with morning fog mingling with white musket smoke and rising sunlight';
            periodEntities = 'colonial minutemen in everyday wool frock coats, tricorne hats, and holding flintlock muskets, ranks of British Light Infantry with polished bayonets, white crossbelts, and mitre caps, officers on horseback with drawn sabers';
        } else if (/declaration|signing|draft|committee of five|jefferson|hancock|congress|july 4|philadelphia|truths/i.test(combinedText)) {
            subjectCore = 'The Second Continental Congress assembled inside the historic Pennsylvania State House Assembly Room in Philadelphia in July 1776, as Thomas Jefferson, Benjamin Franklin, and John Adams formally present the handwritten parchment draft of the Declaration of Independence to President John Hancock';
            authenticSetting = 'the grand Georgian colonial assembly chamber with tall multi-pane white-trimmed sash windows, green baize-covered delegate tables, brass candelabras, and rich dark walnut wainscoting';
            periodEntities = 'colonial delegates in authentic 18th-century tailored woolen frock coats, silk waistcoats, cravats, and powdered wigs, delicate goose quill pens in pewter inkwells, scattered folio sheets of manuscript draft, and embossed sealing wax';
        } else if (/crossing|delaware|trenton|ice|boat|river|december|night|blizzard|glover/i.test(combinedText)) {
            subjectCore = 'General George Washington standing resolute in a wooden Durham boat crossing the ice-choked Delaware River during a fierce winter blizzard on Christmas night, December 25-26, 1776, leading 2,400 Continental Army soldiers in a surprise counterattack on the Hessian garrison at Trenton';
            authenticSetting = 'treacherous freezing river waters filled with jagged floating ice floes, dramatic snow squalls whipping through dark atmospheric winter night skies, distant torches flickering on the snowy shoreline';
            periodEntities = 'Continental soldiers and Marblehead mariners in tricorne hats and heavy wool greatcoats desperately rowing wooden oars, horses and heavy iron cannons secured in transport barges, lantern glow reflecting off icy waves';
        } else if (/independence hall|assembly|building|state house|colonial/i.test(combinedText)) {
            subjectCore = 'The historic Georgian architecture of Independence Hall (Pennsylvania State House) in Philadelphia during the summer of 1776, with citizens and colonial delegates gathered outside the red-brick facade';
            authenticSetting = 'Chestnut Street with cobblestone roads, Georgian symmetry, iconic white clock tower steeple rising into summer afternoon clouds, horse-drawn carriages, and colonial elm trees';
            periodEntities = 'authentic 18th-century architectural moldings, dentiled cornices, wrought-iron railings, brick masonry, and townspeople in colonial attire';
        } else if (/paine|common sense|parchment|quill|book|pamphlet|treatise/i.test(combinedText)) {
            subjectCore = 'A dramatic 1776 colonial author desk illuminated by candlelight, featuring Thomas Paine\'s original printed pamphlet "Common Sense", alongside handwritten manuscript pages of the Declaration of Independence';
            authenticSetting = 'an authentic 18th-century colonial study with aged pine bookshelves, leather-bound Enlightenment treatises by John Locke and Montesquieu, and a paned window overlooking colonial Philadelphia';
            periodEntities = 'antiqued rag parchment documents with authentic calligraphic ink script, brass pocket watch, horn spectacles, iron quill nibs, sealing wax stamp, and a pewter candleholder with molten wax drips';
        } else {
            subjectCore = 'Continental soldiers in colonial uniforms gathered around winter campfire lights in the December 1776 encampment, forging the resolve of the American Revolution';
            authenticSetting = 'a snow-covered woodland clearing under deep twilight skies with flickering golden firelight and heavy snow falling on canvas tents';
            periodEntities = 'flintlock muskets, iron kettles over embers, tricorne hats, wool blankets, and wooden supply wagons';
        }
    } else if (theme === 'auth-zerotrust-security') {
        subjectCore = `Zero-Trust cryptography schematic illustrating ${context.sectionTitle || 'OAuth 2.1 & FIDO2 Passkey Handshake'}, highlighting asymmetric Ed25519 token signatures, secure enclaves, and low-latency Envoy edge proxies`;
        authenticSetting = 'a high-tech dark architectural perspective with glowing cyan cryptographic routing pathways, isolation boundaries, and cryptographic verification rings';
        periodEntities = 'biometric hardware security keys, SHA-256 challenge flow lines, JWT payload structures, and TLS termination barriers';
    } else if (theme === 'ai-machine-learning') {
        subjectCore = `Multi-modal generative AI architectural topology illustrating ${context.sectionTitle || 'Neural Attention & Subagent DAG Execution'}, showing real-time token embedding streams and collaborative agent orchestration`;
        authenticSetting = 'a high-dimensional abstract tensor space with multi-layered neural manifolds, glowing attention head routes, and dynamic semantic vector clusters';
        periodEntities = 'luminescent tensor nodes, synaptic connection vectors, subagent orchestration DAG nodes, and multi-modal embedding trajectories';
    } else {
        subjectCore = `Editorial concept visualization for "${context.sectionTitle || context.docTitle}", capturing the core themes, systemic components, and executive vision of the document`;
        authenticSetting = 'a refined architectural studio setting with clean structural geometry, volumetric depth, and balanced negative space';
        periodEntities = 'precise diagrams, tactile materials, and contemporary high-resolution focal elements';
    }

    // 2. Synthesize Complete Structured Prompt
    const structuredPrompt = [
        `${style.mediumDirective} depicting ${subjectCore}.`,
        `Environment & Setting: ${authenticSetting}.`,
        `Specific Detail & Texture: ${periodEntities}.`,
        `Lighting & Atmosphere: ${style.lightingDirective}.`,
        `Optics & Camera: ${style.opticsDirective}.`,
        `Color Palette: ${style.colorGrading}.`,
        `Masterpiece execution, hyper-detailed, period authenticity, 8k resolution, flawless composition.`
    ].join(' ');

    return { prompt: structuredPrompt, styleLabel };
}
