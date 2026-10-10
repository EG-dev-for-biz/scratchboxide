#!/usr/bin/env node

/**
 * md_to_slides_compiler.mjs
 *
 * Markdown to Google Slides & Interactive Web Presentation Compiler
 * Powered by Scratchbox Studio layout geometry, responsive typography,
 * card-container architecture, and brand-anchored color system extraction.
 *
 * Usage:
 *   node scripts/md_to_slides_compiler.mjs <input.md> [options]
 *
 * Options:
 *   --out <path>         Output .pptx file path (default: <input>.pptx)
 *   --html               Also generate self-contained 1920x1080 HTML web presentation
 *   --brand <name>       Brand name (e.g., Chase, Knicks, Apple, Nike, Patagonia)
 *   --theme <dark|light> Force dark or light brand variant (default: dark)
 *   --ratio <16:9|4:3>   Slide aspect ratio (default: 16:9 widescreen LAYOUT_WIDE)
 *   --upload-drive       Directly upload and convert to live Google Slides deck with public write access
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { generateHtmlDeck } from './html_slides_engine.mjs';

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const rootDir = path.resolve(scriptDir, '..');
const requireModule = createRequire(path.join(rootDir, 'package.json'));
const PptxGenJS = requireModule('pptxgenjs');
let sizeOf;
try {
  sizeOf = requireModule('image-size');
} catch (e) {
  // fallback
}

export function getImageDimensions(imagePath) {
  if (sizeOf && fs.existsSync(imagePath)) {
    try {
      const dim = sizeOf(imagePath);
      if (dim && dim.width && dim.height) {
        return { width: dim.width, height: dim.height, aspect: dim.width / dim.height };
      }
    } catch (e) {}
  }
  return { width: 16, height: 9, aspect: 16 / 9 };
}

export function fitDimensions(aspect, maxW, maxH) {
  const areaAspect = maxW / maxH;
  if (aspect > areaAspect) {
    return { w: maxW, h: maxW / aspect };
  } else {
    return { w: maxH * aspect, h: maxH };
  }
}

export const SPELLED_NUMBERS = [
  'ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
  'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN', 'TWENTY',
  'TWENTY-ONE', 'TWENTY-TWO', 'TWENTY-THREE', 'TWENTY-FOUR', 'TWENTY-FIVE', 'TWENTY-SIX', 'TWENTY-SEVEN', 'TWENTY-EIGHT', 'TWENTY-NINE', 'THIRTY',
  'THIRTY-ONE', 'THIRTY-TWO', 'THIRTY-THREE', 'THIRTY-FOUR', 'THIRTY-FIVE', 'THIRTY-SIX', 'THIRTY-SEVEN', 'THIRTY-EIGHT', 'THIRTY-NINE', 'FORTY',
  'FORTY-ONE', 'FORTY-TWO', 'FORTY-THREE', 'FORTY-FOUR', 'FORTY-FIVE', 'FORTY-SIX', 'FORTY-SEVEN', 'FORTY-EIGHT', 'FORTY-NINE', 'FIFTY',
  'FIFTY-ONE', 'FIFTY-TWO', 'FIFTY-THREE', 'FIFTY-FOUR', 'FIFTY-FIVE', 'FIFTY-SIX', 'FIFTY-SEVEN', 'FIFTY-EIGHT', 'FIFTY-NINE', 'SIXTY'
];

export const EDITORIAL_FONT_PAIRINGS = {
  'high-fashion': {
    name: 'High-Fashion & Culture',
    displayFont: 'Bodoni Moda',
    bodyFont: 'Plus Jakarta Sans',
    monoFont: 'JetBrains Mono',
    italicDisplay: true,
    displayTracking: -1.0,
    kickerTracking: 3.5,
  },
  'brutalist-scale': {
    name: 'Brutalist Scale-Contrast',
    displayFont: 'Syne',
    bodyFont: 'Source Serif 4',
    monoFont: 'Space Mono',
    italicDisplay: false,
    displayTracking: -2.0,
    kickerTracking: 4.0,
  },
  'intellectual-editorial': {
    name: 'Intellectual / Editorial Warmth',
    displayFont: 'Newsreader',
    bodyFont: 'Plus Jakarta Sans',
    monoFont: 'JetBrains Mono',
    italicDisplay: true,
    displayTracking: -1.0,
    kickerTracking: 3.0,
  },
  'technical-vanguard': {
    name: 'Technical Vanguard',
    displayFont: 'Instrument Sans',
    bodyFont: 'Instrument Sans',
    monoFont: 'JetBrains Mono',
    italicDisplay: false,
    displayTracking: -1.0,
    kickerTracking: 3.0,
  },
  'modern-grotesk': {
    name: 'Modern Neo-Grotesk',
    displayFont: 'Plus Jakarta Sans',
    bodyFont: 'Plus Jakarta Sans',
    monoFont: 'JetBrains Mono',
    italicDisplay: false,
    displayTracking: -1.0,
    kickerTracking: 2.5,
  },
};

// ============================================================================
// 0. SCRATCHBOX MCP IMAGE ENGINE (scratchbox.ai)
// ============================================================================

export function formatLayoutImagePrompt(rawPrompt, aspectRatio = '16:9', layoutPlacement = 'split-left') {
  let prompt = (rawPrompt || '').trim();
  // Strip accidental requests for words, titles, typography, text
  prompt = prompt
    .replace(/\bwith (the )?(title|headline|text|words?|caption|logo|typography)\b[^\.,;]*/gi, '')
    .replace(/\b(saying|titled|written|spelling)\b[^\.,;]*/gi, '')
    .trim();

  const resTag = (aspectRatio === '21:9' || aspectRatio === '2.37:1') 
    ? '4K Ultrawide resolution (3840x1620)' 
    : '4K UHD resolution (3840x2160)';

  // Directional negative space staging for layout-text coordination
  let stagingClause = '';
  if (layoutPlacement === 'split-left' || layoutPlacement === 'left-text') {
    stagingClause = 'Compositional staging: primary focal subject anchored in the rightmost 35% of the frame, leaving an expansive, tranquil low-frequency negative space void across the left flank for editorial typographic breathing room, with subject gaze and leading lines directed inward toward the text.';
  } else if (layoutPlacement === 'split-right' || layoutPlacement === 'right-text') {
    stagingClause = 'Compositional staging: primary focal subject anchored in the leftmost 35% of the frame, leaving an expansive, tranquil low-frequency negative space void across the right flank for editorial typographic breathing room, with subject gaze and leading lines directed inward toward the text.';
  }

  // Micro-motion blur taking digital edge off
  const shutterClause = '1/48s cinema shutter speed with subtle motivated micro-motion blur on camera drift and peripheral subject movement to soften artificial digital edge sharpness and ground the frame in physical optical physics.';

  return `${prompt}. ${stagingClause} ${resTag}, razor-sharp optical clarity with physical film response, ${shutterClause} Pure visual imagery, absolutely zero text, no words, no letters, no alphabet, no fonts, no numbers, no subtitles, no watermark, no logo, clean visual frame.`;
}

export async function generateScratchboxImage(prompt, aspectRatio = '16:9', workspaceId = '126', layoutPlacement = 'split-left') {
  const sanitizedPrompt = formatLayoutImagePrompt(prompt, aspectRatio, layoutPlacement);
  const baseUrl = process.env.SCRATCHBOX_BASE_URL || 'https://scratchbox.ai/api/mcp/canvas';
  let secret = process.env.SCRATCHBOX_INTERNAL_SECRET;
  if (!secret) {
    const candidatePaths = [
      '/Users/eligreen/dev/scratchbox-ide-master/secrets.json',
      '/dev/secrets.json',
      `${process.env.HOME}/dev/secrets.json`
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          const d = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (d.SESSION_SECRET) {
            secret = d.SESSION_SECRET;
            break;
          }
        } catch (_) {}
      }
    }
  }
  if (!secret) {
    secret = 'LeMzrOSJU35Y3itLva3+kIJz/udHkKYGePE1rw6SzmEVYPg0qTnu1YEJmLlZeM0oOWAEoYNsEQ7ReVPVU+865A==';
  }

  const idempotencyKey = `sb-slides-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'x-internal-secret': secret,
    'x-internal-user-id': '1',
    'x-scratchbox-workspace-id': String(workspaceId)
  };

  const queueRes = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: 'ai.generate_images',
        arguments: {
          prompt: sanitizedPrompt,
          aspectRatio,
          idempotencyKey,
          quality: '4k',
          resolution: '4k',
          shutter_angle: 180,
          motion_blur: 0.06,
          model: 'google/nano-banana-pro'
        }
      }
    })
  });

  if (!queueRes.ok) {
    throw new Error(`Scratchbox MCP queue error (${queueRes.status}): ${await queueRes.text()}`);
  }

  const rawQueue = await queueRes.text();
  const dataLine = rawQueue.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) throw new Error(`Invalid SSE response from Scratchbox MCP: ${rawQueue.slice(0, 200)}`);
  const qData = JSON.parse(dataLine.slice(6));
  const structured = qData?.result?.structuredContent;
  const operationId = structured?.operationId || structured?.jobs?.[0]?.jobId;
  if (!operationId) throw new Error(`No operationId returned from Scratchbox MCP: ${dataLine}`);

  // Poll operation.get
  const startTime = Date.now();
  const maxWaitMs = 120_000;
  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, 2500));
    const pollRes = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: 'operation.get',
          arguments: { operationId }
        }
      })
    });
    const pollRaw = await pollRes.text();
    const pollLine = pollRaw.split('\n').find(l => l.startsWith('data: '));
    if (!pollLine) continue;
    const pData = JSON.parse(pollLine.slice(6));
    const op = pData?.result?.structuredContent;

    if (op?.status === 'completed' && op?.terminal) {
      const relUrl = op?.result?.url || '';
      const fullUrl = relUrl.startsWith('http') ? relUrl : `https://scratchbox.ai${relUrl}`;
      return {
        url: fullUrl,
        operationId,
        provider: op?.result?.provider || 'google',
        modelId: op?.result?.modelId || 'google/nano-banana-pro',
        storagePath: op?.result?.storagePath
      };
    }
    if (op?.status === 'failed') {
      throw new Error(`Scratchbox MCP image generation failed: ${op?.error || 'Unknown'}`);
    }
  }
  throw new Error(`Scratchbox MCP image generation timed out after ${maxWaitMs / 1000}s`);
}

// ============================================================================
// 0.5 CONTEXTUAL EXEMPLIFICATION PROMPT SYNTHESIS
// ============================================================================

export function synthesizeContextualExemplificationPrompt(s, brandContext = '', defaultRatio = '16:9', layoutPlacement = 'split-left') {
  const title = s.title || '';
  const subtitle = s.subtitle || '';
  const kicker = s.kicker || '';
  const prose = [
    ...(s.bodyParagraphs || []),
    ...(s.bullets || []),
    ...(s.blockquote ? [s.blockquote] : []),
    ...(s.speakerNotes ? [s.speakerNotes] : [])
  ].join(' ');

  const fullText = `${brandContext} ${kicker} ${title} ${subtitle} ${prose}`.toLowerCase();

  // If user provided a descriptive prompt (>12 words), honor its core subject
  if (s.rawAltPrompt && s.rawAltPrompt.split(/\s+/).length > 12) {
    return s.rawAltPrompt;
  }

  // Domain extraction & physical proof formulation (anti-generic, concept-driven)
  let physicalScene = '';

  if (/(thermal|cooling|heatsink|heatpipe|battery|energy|power|watt|voltage)/.test(fullText)) {
    physicalScene = 'Extreme macro photograph of an extruded matte-black aluminum heatsink with sintered copper heatpipes undergoing thermal stress testing; micro-convective heat shimmer in the air; 5000K overhead technical work lamp casting sharp raking shadows across precision CNC milling lines';
  } else if (/(code|software|engine|compiler|latency|pipeline|shader|gpu|compute|algorithm|mesh|3d|runtime)/.test(fullText)) {
    physicalScene = 'Technical studio photograph: an engineer\'s dark matte workstation with a color-calibrated monitor displaying wireframe mesh density; hands resting at an anodized mechanical keyboard with soft 3200K tungsten desk lamp grazing aluminum edges and dark slate desk surface';
  } else if (/(concrete|brutalist|architecture|facade|cantilever|monolith|pavilion|building|spatial)/.test(fullText)) {
    physicalScene = 'Medium-wide architectural exterior at dusk: monolithic board-formed concrete mass cantilevered over calm dark reflecting water; 2800K warm interior light glowing through recessed slit apertures into cool evening twilight with textured shadows';
  } else if (/(leather|craft|artisan|tailor|bespoke|stitch|textile|linen|wool|material|fabric)/.test(fullText)) {
    physicalScene = 'Tactile macro close-up of an artisan\'s hands pulling waxed linen thread tight through double saddle stitching on vegetable-tanned bridle leather; showing subtle brass awl marks, weathered oak workbench with bone folders';
  } else if (/(warehouse|logistics|fulfillment|robot|agv|supply|shipping|transit|fleet)/.test(fullText)) {
    physicalScene = 'Low-angle dynamic photograph inside a high-bay automated logistics facility at 3:15 AM; an automated guided vehicle (AGV) with worn scuff bumpers navigating floor tracking lines under cool industrial 4500K ceiling fixtures';
  } else if (/(medical|bio|pharma|clinic|cellular|dna|lab|surgeon|surgical|microscop)/.test(fullText)) {
    physicalScene = 'Clinical extreme macro photograph of a microfluidic test chip with delicate fluid meniscus advancing through sub-millimeter channels; cold 6000K shadowless illumination reflecting off sterile stainless steel instrument trays';
  } else if (/(camera|lens|film|cinematograph|director|shutter|anamorphic|optics|sensor)/.test(fullText)) {
    physicalScene = 'Close-up observational photograph of a 35mm cinema prime lens mounted on a studio camera rig on a soundstage; warm practical tungsten lanterns in the soft background, optical glass coatings catching subtle amber flares';
  } else if (/(strategy|vision|executive|leadership|market|horizon|venture|growth)/.test(fullText)) {
    physicalScene = 'Observational architectural interior at dawn: an executive conference room with floor-to-ceiling glass overlooking a misty coastal city skyline; minimalist oiled walnut table catching the first raking morning light (4000K)';
  } else {
    // Grounded physical proof derived from section title and subtitle
    physicalScene = `Observational editorial documentary still exemplifying "${title}": authentic physical environment, lived-in details, and natural material textures directly relevant to ${subtitle || title}`;
  }

  return `${physicalScene}. Shot on 35mm Panavision Primo prime lens at T2.8, Kodak Vision3 500T organic film grain, high dynamic range.`;
}

export async function resolveScratchboxImages(slides, workspaceId = '126', autoGenerateForVisualSlides = false, brandContext = '', defaultRatio = '16:9') {
  for (let sIdx = 0; sIdx < slides.length; sIdx++) {
    const s = slides[sIdx];
    const is21x9 = defaultRatio === '21:9' || defaultRatio === '2.37:1';
    
    // Check existing image tags
    for (let imgIdx = 0; imgIdx < s.images.length; imgIdx++) {
      const img = s.images[imgIdx];
      const isGenerate = !img.url || img.url === 'generate' || img.url.startsWith('generate:') || 
                         img.url === 'scratchbox' || img.url.startsWith('scratchbox:');
      if (isGenerate) {
        let aspect = is21x9 ? '21:9' : '16:9';
        if (img.url && img.url.includes(':')) {
          aspect = img.url.replace(/^[^:]+:/, '').trim() || aspect;
        } else if (s.archetype === 'art-card' || s.archetype === 'anamorphic-letterbox') {
          aspect = '21:9';
        }

        s.rawAltPrompt = img.alt;
        const prompt = synthesizeContextualExemplificationPrompt(s, brandContext, aspect, 'split-left');
        console.log(`[SCRATCHBOX-MCP] Generating grounded visual proof for slide ${sIdx + 1} ("${s.title}") via scratchbox.ai (${aspect}):\n  -> "${prompt}"...`);
        const genRes = await generateScratchboxImage(prompt, aspect, workspaceId, 'split-left');
        img.url = genRes.url;
        img.generatedBy = 'scratchbox-mcp';
        img.provider = genRes.provider;
        img.modelId = genRes.modelId;
        console.log(`[SCRATCHBOX-MCP] Successfully injected live CDN visual: ${img.url}`);
      }
    }

    // Auto-synthesize image if requested and slide is an image-centric archetype
    if (autoGenerateForVisualSlides && s.images.length === 0) {
      const visualArchetypes = ['art-card', 'hero-opener', 'anamorphic-letterbox', 'image-forward'];
      if (visualArchetypes.includes(s.archetype)) {
        let aspect = (s.archetype === 'art-card' || s.archetype === 'anamorphic-letterbox' || is21x9) ? '21:9' : '16:9';
        const prompt = synthesizeContextualExemplificationPrompt(s, brandContext, aspect, 'split-left');
        console.log(`[SCRATCHBOX-MCP] Auto-synthesizing visual proof for slide ${sIdx + 1} ("${s.title}") (${aspect}):\n  -> "${prompt}"...`);
        const genRes = await generateScratchboxImage(prompt, aspect, workspaceId, 'split-left');
        s.images.push({
          alt: prompt,
          url: genRes.url,
          generatedBy: 'scratchbox-mcp',
          provider: genRes.provider,
          modelId: genRes.modelId
        });
        console.log(`[SCRATCHBOX-MCP] Injected auto-synthesized visual: ${genRes.url}`);
      }
    }
  }
}

// ============================================================================
// 1. TEXT SANITIZATION & REFINEMENT ENGINE
// ============================================================================

export function cleanSlideText(str) {
  if (!str) return '';
  return str
    .replace(/\\text\{([^}]+)\}/g, '$1')
    .replace(/\\times/g, '×')
    .replace(/\\circ/g, '°')
    .replace(/\$([^\$]+)\$/g, '$1')
    .replace(/v_\{max\}/g, 'v_max')
    .replace(/\\/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripMarkdownFormatting(str) {
  if (!str) return '';
  return cleanSlideText(str).replace(/[*_~`]/g, '').trim();
}

export function sanitizeSlideText(str) {
  return stripMarkdownFormatting(str);
}

/**
 * Parses markdown bold and bullet lead-in prefixes into PptxGenJS text runs
 */
export function parseTextRuns(rawText, palette, baseOptions = {}) {
  if (!rawText) return [];
  const text = cleanSlideText(rawText);
  const runs = [];
  const baseSize = baseOptions.fontSize || 11.5;
  const baseColor = baseOptions.color || palette.textColor;
  const accentColor = baseOptions.accentColor || palette.accentColor;
  const boldColor = baseOptions.boldColor || palette.titleColor;
  const lineSpacing = baseOptions.lineSpacingMultiple || 1.35;
  const fontFace = baseOptions.fontFace;
  const bulletPrefix = baseOptions.bullet ? '• ' : '';

  // Check for lead-in bold pattern: **Lead In**: rest or Lead In: rest
  const leadMatch = text.match(/^(\*\*[^*]+\*\*|[^:]{2,32}):\s+(.*)$/);
  if (leadMatch) {
    const rawLead = leadMatch[1].replace(/\*\*/g, '').trim();
    const rest = leadMatch[2].trim();

    runs.push({
      text: bulletPrefix + rawLead + ': ',
      options: {
        bold: true,
        fontSize: baseSize,
        fontFace,
        color: boldColor,
        lineSpacingMultiple: lineSpacing,
      },
    });

    const subRuns = parseInlineRuns(rest, baseSize, baseColor, accentColor, lineSpacing, '', fontFace);
    runs.push(...subRuns);
    return runs;
  }

  return parseInlineRuns(text, baseSize, baseColor, accentColor, lineSpacing, bulletPrefix, fontFace);
}

function parseInlineRuns(text, baseSize, baseColor, accentColor, lineSpacing, prefix = '', fontFace = undefined) {
  const runs = [];
  const regex = /(\*\*[^*]+\*\*)/g;
  const parts = text.split(regex);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const curPrefix = i === 0 ? prefix : '';
    if (part.startsWith('**') && part.endsWith('**')) {
      runs.push({
        text: curPrefix + part.slice(2, -2),
        options: {
          bold: true,
          fontSize: baseSize,
          fontFace,
          color: accentColor,
          lineSpacingMultiple: lineSpacing,
        },
      });
    } else {
      runs.push({
        text: curPrefix + part,
        options: {
          bold: false,
          fontSize: baseSize,
          fontFace,
          color: baseColor,
          lineSpacingMultiple: lineSpacing,
        },
      });
    }
  }
  return runs;
}

// ============================================================================
// 2. COLOR THEORY & HARMONY ENGINE (Adobe Color & Coolors Mathematics)
// ============================================================================

export function hexToRgb(hex) {
  const clean = hex.replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

export function rgbToHex(r, g, b) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(r), clamp(g), clamp(b)].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  s /= 100; l /= 100;
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(hue2rgb(h + 1 / 3) * 255),
    g: Math.round(hue2rgb(h) * 255),
    b: Math.round(hue2rgb(h - 1 / 3) * 255),
  };
}

export function computeSplitComplementary(hex) {
  const rgb = hexToRgb(hex);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const h1 = (hsl.h + 150) % 360;
  const h2 = (hsl.h + 210) % 360;
  const c1 = hslToRgb(h1, hsl.s, hsl.l);
  const c2 = hslToRgb(h2, hsl.s, hsl.l);
  return {
    base: hex.replace('#', '').toUpperCase(),
    split1: rgbToHex(c1.r, c1.g, c1.b),
    split2: rgbToHex(c2.r, c2.g, c2.b),
  };
}

export const CANONICAL_BRAND_PRESETS = {
  volvo: {
    dark: {
      slideBg: '07111E',
      cardBg: '0F172A',
      cardBorder: '1E293B',
      titleColor: 'FFFFFF',
      subtitleColor: '38BDF8',
      textColor: 'E2E8F0',
      accentColor: '003057', // Swedish Heritage Iron Blue
      secondaryAccent: 'F59E0B', // Amber safety accent
      kicker: 'VOLVO CARS // NORDIC DESIGN LABS',
    },
    light: {
      slideBg: 'F8FAFC',
      cardBg: 'FFFFFF',
      cardBorder: 'E2E8F0',
      titleColor: '0F172A',
      subtitleColor: '0284C7',
      textColor: '334155',
      accentColor: '003057',
      secondaryAccent: 'D97706',
      kicker: 'VOLVO CARS // NORDIC DESIGN LABS',
    },
  },
  apple: {
    dark: {
      slideBg: '000000',
      cardBg: '161618',
      cardBorder: '2D2D30',
      titleColor: 'F5F5F7',
      subtitleColor: '86868B',
      textColor: 'D2D2D7',
      accentColor: '2997FF',
      secondaryAccent: 'FF375F',
      kicker: 'APPLE SPECIAL PROJECT',
    },
    light: {
      slideBg: 'FBFBFD',
      cardBg: 'FFFFFF',
      cardBorder: 'E5E5EA',
      titleColor: '1D1D1F',
      subtitleColor: '6E6E73',
      textColor: '333336',
      accentColor: '0071E3',
      secondaryAccent: 'FF2D55',
      kicker: 'APPLE SPECIAL PROJECT',
    },
  },
  nike: {
    dark: {
      slideBg: '0A0A0A',
      cardBg: '171717',
      cardBorder: '262626',
      titleColor: 'FFFFFF',
      subtitleColor: 'E5E5E5',
      textColor: 'D4D4D4',
      accentColor: 'FA5400', // Nike Total Orange
      secondaryAccent: 'CCFF00', // Volt Green
      kicker: 'NIKE INNOVATION KITCHEN',
    },
    light: {
      slideBg: 'F5F5F5',
      cardBg: 'FFFFFF',
      cardBorder: 'E5E5E5',
      titleColor: '111111',
      subtitleColor: '525252',
      textColor: '262626',
      accentColor: 'FA5400',
      secondaryAccent: '111111',
      kicker: 'NIKE INNOVATION KITCHEN',
    },
  },
  porsche: {
    dark: {
      slideBg: '0B0C10',
      cardBg: '16181D',
      cardBorder: '232730',
      titleColor: 'FFFFFF',
      subtitleColor: '94A3B8',
      textColor: 'E2E8F0',
      accentColor: 'D5001C', // Guards Red
      secondaryAccent: 'FCD116', // Speed Yellow
      kicker: 'PORSCHE MOTORSPORT // STUTTGART',
    },
    light: {
      slideBg: 'F8FAFC',
      cardBg: 'FFFFFF',
      cardBorder: 'E2E8F0',
      titleColor: '0F172A',
      subtitleColor: '64748B',
      textColor: '334155',
      accentColor: 'D5001C',
      secondaryAccent: '0F172A',
      kicker: 'PORSCHE MOTORSPORT // STUTTGART',
    },
  },
  tesla: {
    dark: {
      slideBg: '08090A',
      cardBg: '121417',
      cardBorder: '1F242B',
      titleColor: 'FFFFFF',
      subtitleColor: '94A3B8',
      textColor: 'E2E8F0',
      accentColor: 'E82127', // Tesla Red
      secondaryAccent: '38BDF8',
      kicker: 'TESLA DESIGN STUDIO',
    },
    light: {
      slideBg: 'F8FAFC',
      cardBg: 'FFFFFF',
      cardBorder: 'E2E8F0',
      titleColor: '171A20',
      subtitleColor: '5C5D61',
      textColor: '393C41',
      accentColor: 'E82127',
      secondaryAccent: '171A20',
      kicker: 'TESLA DESIGN STUDIO',
    },
  },
  chase: {
    dark: {
      slideBg: '07111E',
      cardBg: '0D1726',
      cardBorder: '1E293B',
      titleColor: 'FFFFFF',
      subtitleColor: '00A3E0',
      textColor: 'E2E8F0',
      accentColor: '005A9C',
      secondaryAccent: 'F58220',
      kicker: 'CHASE FREEDOM // CAMPAIGN PITCH',
    },
    light: {
      slideBg: 'F4F7FB',
      cardBg: 'FFFFFF',
      cardBorder: 'CBD5E1',
      titleColor: '07111E',
      subtitleColor: '005A9C',
      textColor: '1E293B',
      accentColor: '005A9C',
      secondaryAccent: 'F58220',
      kicker: 'CHASE FREEDOM // CAMPAIGN PITCH',
    },
  },
  knicks: {
    dark: {
      slideBg: '0A0E17',
      cardBg: '111827',
      cardBorder: '1F2937',
      titleColor: 'FFFFFF',
      subtitleColor: '005A9C',
      textColor: 'F1F5F9',
      accentColor: 'F58220',
      secondaryAccent: '005A9C',
      kicker: 'NEW YORK KNICKS SPECIAL BROADCAST',
    },
    light: {
      slideBg: 'F8FAFC',
      cardBg: 'FFFFFF',
      cardBorder: 'E2E8F0',
      titleColor: '0A0E17',
      subtitleColor: '005A9C',
      textColor: '1E293B',
      accentColor: 'F58220',
      secondaryAccent: '005A9C',
      kicker: 'NEW YORK KNICKS SPECIAL BROADCAST',
    },
  },
};

export function generateBrandPaletteFromHex(baseHex, brandName = '', theme = 'dark', harmony = 'split-complementary') {
  const cleanHex = baseHex.replace('#', '').toUpperCase();
  const rgb = hexToRgb(cleanHex);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

  let secondaryHex = 'F58220';
  let subtitleHex = '38BDF8';

  if (harmony === 'split-complementary') {
    const sc = computeSplitComplementary(cleanHex);
    secondaryHex = sc.split1;
    const subRgb = hslToRgb((hsl.h + 30) % 360, Math.min(hsl.s, 70), theme === 'dark' ? 65 : 40);
    subtitleHex = rgbToHex(subRgb.r, subRgb.g, subRgb.b);
  } else if (harmony === 'complementary') {
    const compRgb = hslToRgb((hsl.h + 180) % 360, hsl.s, hsl.l);
    secondaryHex = rgbToHex(compRgb.r, compRgb.g, compRgb.b);
    const subRgb = hslToRgb((hsl.h + 30) % 360, 60, theme === 'dark' ? 65 : 40);
    subtitleHex = rgbToHex(subRgb.r, subRgb.g, subRgb.b);
  } else {
    const triRgb = hslToRgb((hsl.h + 120) % 360, hsl.s, hsl.l);
    secondaryHex = rgbToHex(triRgb.r, triRgb.g, triRgb.b);
    const subRgb = hslToRgb((hsl.h + 240) % 360, 60, theme === 'dark' ? 65 : 40);
    subtitleHex = rgbToHex(subRgb.r, subRgb.g, subRgb.b);
  }

  const kickerLabel = brandName ? `${brandName.toUpperCase()} // STRATEGY & CREATIVE VISION` : 'EXECUTIVE PRESENTATION';

  if (theme === 'dark') {
    return {
      slideBg: '07111E',
      cardBg: '0F172A',
      cardBorder: '1E293B',
      titleColor: 'FFFFFF',
      subtitleColor: subtitleHex,
      textColor: 'E2E8F0',
      accentColor: cleanHex,
      secondaryAccent: secondaryHex,
      kicker: kickerLabel,
    };
  } else {
    return {
      slideBg: 'F8FAFC',
      cardBg: 'FFFFFF',
      cardBorder: 'E2E8F0',
      titleColor: '0F172A',
      subtitleColor: subtitleHex,
      textColor: '334155',
      accentColor: cleanHex,
      secondaryAccent: secondaryHex,
      kicker: kickerLabel,
    };
  }
}

export function resolveBrandPalette(brandName, customHex = null, theme = 'dark', harmony = 'split-complementary') {
  const norm = (brandName || '').toLowerCase().trim();
  if (customHex && typeof customHex === 'string') {
    return generateBrandPaletteFromHex(customHex, brandName, theme, harmony);
  }
  for (const [key, preset] of Object.entries(CANONICAL_BRAND_PRESETS)) {
    if (norm.includes(key)) {
      return preset[theme] || preset.dark;
    }
  }

  // Derive hash-based primary hue from brand name if not in presets!
  let hash = 0;
  for (let i = 0; i < norm.length; i++) {
    hash = norm.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  const brandRgb = hslToRgb(hue, 75, theme === 'dark' ? 45 : 40);
  const brandHex = rgbToHex(brandRgb.r, brandRgb.g, brandRgb.b);

  return generateBrandPaletteFromHex(brandHex, brandName, theme, harmony);
}

// ============================================================================
// 3. MARKDOWN AST PARSING & SEMANTIC CHUNKING
// ============================================================================

export function extractFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const rawYaml = match[1];
  const body = match[2];
  const frontmatter = {};

  for (const line of rawYaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
      frontmatter[key] = val;
    }
  }

  return { frontmatter, body };
}

export function parseMarkdownSlides(markdownText) {
  const normalized = markdownText.replace(/\n<!--\s*slide\s*-->\s*\n/gi, '\n---\n');
  const rawSections = normalized.split(/\n---\s*\n/);
  const slides = [];

  for (let idx = 0; idx < rawSections.length; idx++) {
    const section = rawSections[idx].trim();
    if (!section) continue;

    const lines = section.split('\n');
    let title = '';
    let subtitle = '';
    const bodyParagraphs = [];
    const bullets = [];
    const images = [];
    let speakerNotes = '';
    let blockquote = '';
    const tableLines = [];
    let inTable = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Skip code/carousel fences
      if (line.startsWith('````') || line.startsWith('```')) continue;

      // Scratchbox MCP Image Comment Directive
      const sbCommentMatch = line.match(/^<!--\s*scratchbox(?:-image)?:\s*([\s\S]*?)\s*-->$/i);
      if (sbCommentMatch) {
        const content = sbCommentMatch[1].trim();
        const aspectMatch = content.match(/aspect(?:Ratio)?[:=]\s*["']?([0-9:]+)["']?/i);
        const aspect = aspectMatch ? aspectMatch[1] : '16:9';
        const cleanPrompt = content.replace(/aspect(?:Ratio)?[:=]\s*["']?([0-9:]+)["']?/i, '').replace(/^prompt[:=]\s*["']?|["']$/g, '').trim();
        images.push({ alt: cleanPrompt, url: `scratchbox:${aspect}` });
        continue;
      }

      // Speaker Notes
      const commentMatch = line.match(/^<!--\s*([\s\S]*?)\s*-->$/);
      if (commentMatch) {
        if (!commentMatch[1].includes('slide')) {
          speakerNotes += (speakerNotes ? '\n' : '') + commentMatch[1].trim();
        }
        continue;
      }

      // Headers 1 through 4
      const headerMatch = line.match(/^(#{1,4})\s+(.*)$/);
      if (headerMatch) {
        const hText = headerMatch[2].trim();
        if (/^\d+[A-Z]\./.test(hText)) continue; // skip asset labels in body
        if (!title) {
          title = hText;
        } else if (!subtitle) {
          subtitle = hText;
        } else {
          bodyParagraphs.push(hText);
        }
        continue;
      }

      // Images: ![alt](url)
      const imgMatch = line.match(/!\[(.*?)\]\((.*?)\)/);
      if (imgMatch) {
        const cleanUrl = imgMatch[2].replace(/^file:\/\//, '');
        images.push({ alt: imgMatch[1], url: cleanUrl });
        continue;
      }

      // Blockquotes
      if (/^>\s+/.test(line)) {
        blockquote += (blockquote ? ' ' : '') + line.replace(/^>\s+/, '').trim();
        continue;
      }

      // Skip markdown italic captions
      if (/^\*[^*].*\*\s*$/.test(line) && !/^[*+-]\s+/.test(line)) {
        continue;
      }

      // Tables
      if (/^\|.*\|$/.test(line)) {
        inTable = true;
        tableLines.push(line);
        continue;
      } else if (inTable) {
        inTable = false;
      }

      // Bullets
      if (/^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
        bullets.push(line.replace(/^[-*+\d.]\s+/, '').trim());
        continue;
      }

      // Regular prose
      if (line.length > 0) {
        bodyParagraphs.push(line);
      }
    }

    // Process Table if found
    let parsedTable = null;
    if (tableLines.length >= 2) {
      const rows = tableLines
        .filter(l => !/^\|[\s\-:|]+\|$/.test(l))
        .map(l => l.split('|').slice(1, -1).map(c => sanitizeSlideText(c)));
      if (rows.length > 0) {
        parsedTable = {
          headers: rows[0],
          dataRows: rows.slice(1),
        };
      }
    }

    // Active assertion title inference (NEVER allow empty title or filename leak)
    let finalTitle = title;
    if (!finalTitle) {
      if (bodyParagraphs.length > 0) {
        const firstSentence = bodyParagraphs[0].split(/[.!?]/)[0].trim();
        finalTitle = firstSentence.length <= 80 ? firstSentence : firstSentence.slice(0, 77) + '...';
      } else if (subtitle) {
        finalTitle = subtitle;
        subtitle = '';
      } else if (images.length > 0 && images[0].alt) {
        finalTitle = images[0].alt.split(/[:—]/)[0].trim();
      } else {
        finalTitle = `Core Narrative Beat 0${idx + 1}`;
      }
    }

    slides.push({
      index: idx,
      title: cleanSlideText(finalTitle),
      subtitle: cleanSlideText(subtitle),
      body: bodyParagraphs.map(cleanSlideText).join('\n\n'),
      bullets: bullets.map(cleanSlideText),
      images,
      speakerNotes,
      blockquote: cleanSlideText(blockquote),
      table: parsedTable,
    });
  }

  return slides;
}

// ============================================================================
// 4. LAYOUT CLASSIFICATION (Scratchbox Studio Archetypes)
// ============================================================================

export function classifySlideArchetype(slide, index, total) {
  const isFirst = index === 0;
  const imageCount = slide.images.length;
  const hasTable = !!slide.table;
  const hasQuote = !!slide.blockquote;
  const bodyLen = (slide.body?.length || 0) + (slide.bullets?.length || 0) * 30;
  const bulletCount = slide.bullets ? slide.bullets.length : 0;
  const isNumberedRecap = bulletCount >= 6 && slide.bullets.every(b => b.length < 60);

  if (isFirst && imageCount > 0) return 'hero-opener';
  if (hasTable) return 'composite';
  if (imageCount >= 2) return 'text-left-images-right';
  if (imageCount === 1) {
    if (hasQuote && !slide.body && bulletCount === 0) return 'anamorphic-letterbox';
    return 'image-forward';
  }
  // imageCount === 0:
  if (isNumberedRecap) return 'recap-card-grid';
  if (hasQuote && !slide.body && bulletCount === 0) return 'quote-centered';
  if (bodyLen === 0 && slide.title) {
    if (slide.title.length < 35 && !slide.subtitle) return 'art-card';
    return 'section-divider';
  }
  return 'cards-executive';
}

// ============================================================================
// 5. PPTX GENERATION ENGINE
// ============================================================================

export async function compileMarkdownToPptx(markdownPath, options = {}) {
  const markdownText = fs.readFileSync(markdownPath, 'utf8');
  const { frontmatter, body } = extractFrontmatter(markdownText);

  const brandAnchor = options.brand || frontmatter.brand || 'Chase';
  const theme = options.theme || frontmatter.theme || 'dark';
  const harmony = options.harmony || frontmatter.harmony || 'split-complementary';
  const ratio = options.ratio || options.aspectRatio || frontmatter.ratio || frontmatter.aspect_ratio || '16:9';
  const is21x9 = ratio === '21:9' || ratio === '2.37:1' || ratio === 'ultrawide';
  options.ratio = ratio;

  const fontPairingKey = (options.fontPairing || options.fontPreset || frontmatter.font_pairing || frontmatter.fontPairing || frontmatter.font_preset || 'high-fashion').toLowerCase().trim();
  const fontPairing = EDITORIAL_FONT_PAIRINGS[fontPairingKey] || EDITORIAL_FONT_PAIRINGS['high-fashion'];
  options.fontPairing = fontPairingKey;

  const palette = resolveBrandPalette(brandAnchor, frontmatter.brand_colors, theme, harmony);
  const slides = parseMarkdownSlides(body);

  // 1.5 Scratchbox MCP Imagery Resolution
  const hasImageryRequests = slides.some(s => s.images.some(img => !img.url || img.url.startsWith('generate') || img.url.startsWith('scratchbox')));
  if (options.scratchboxImages || options.generateImages || hasImageryRequests) {
    console.log(`[SCRATCHBOX-MCP] Resolving slide imagery via Scratchbox MCP (https://scratchbox.ai)...`);
    await resolveScratchboxImages(slides, options.workspaceId || '126', Boolean(options.scratchboxImages || options.generateImages), brandAnchor, ratio);
  }

  const pptx = new PptxGenJS();
  pptx.theme = { headFontFace: fontPairing.displayFont, bodyFontFace: fontPairing.bodyFont };

  // Aspect Ratio & Layout Geometry: 16:9 Widescreen, 21:9 Ultrawide, or 4:3 Legacy
  if (is21x9) {
    pptx.defineLayout({ name: 'LAYOUT_21x9', width: 17.778, height: 7.5 });
    pptx.layout = 'LAYOUT_21x9';
  } else if (ratio === '4:3') {
    pptx.layout = 'LAYOUT_4x3';
  } else {
    pptx.layout = 'LAYOUT_WIDE';
  }
  pptx.title = options.title || frontmatter.title || 'Chase Freedom × New York Knicks — The Magic Snap';

  const slideWIn = is21x9 ? 17.778 : (ratio === '4:3' ? 10.0 : 13.333);
  const slideHIn = ratio === '4:3' ? 7.5 : 7.5;
  const padIn = is21x9 ? 1.0 : 0.8;

  function addCardContainer(slide, { x, y, w, h, fill = palette.cardBg, stroke = palette.cardBorder, radius = 0.1 }) {
    slide.addShape(pptx.ShapeType.roundRect, {
      x, y, w, h,
      rectRadius: radius,
      fill: { color: fill },
      line: { color: stroke, width: 1 },
    });
  }

  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    const archetype = classifySlideArchetype(s, i, slides.length);
    const slide = pptx.addSlide();

    // 1. Canvas Base Fill
    slide.background = { color: palette.slideBg };
    slide.addShape(pptx.ShapeType.rect, {
      x: 0, y: 0, w: slideWIn, h: slideHIn,
      fill: { color: palette.slideBg },
      line: { width: 0 },
    });

    // Signature Editorial Chrome: Top-Left Eyebrow & Bottom-Right Spelled-Out Page Number
    if (options.chrome || frontmatter.chrome) {
      const eyebrowText = (options.eyebrow || frontmatter.eyebrow || brandAnchor || 'THE ART').toUpperCase();
      slide.addText(eyebrowText, {
        x: padIn, y: padIn * 0.4, w: 3.5, h: 0.25,
        fontSize: 9, bold: true, color: palette.textColor, charSpacing: 2, margin: 0,
      });
      slide.addShape(pptx.ShapeType.rect, {
        x: padIn, y: padIn * 0.4 + 0.26, w: 0.8, h: 0.015,
        fill: { color: palette.textColor }, line: { width: 0 },
      });

      const spelledNum = SPELLED_NUMBERS[i + 1] || `${i + 1}`;
      slide.addText(spelledNum, {
        x: slideWIn - padIn - 2.5, y: slideHIn - padIn * 0.5 - 0.25, w: 2.5, h: 0.25,
        fontSize: 9, bold: true, color: palette.textColor, charSpacing: 2, align: 'right', margin: 0,
      });
      slide.addShape(pptx.ShapeType.rect, {
        x: slideWIn - padIn - 0.8, y: slideHIn - padIn * 0.5 + 0.03, w: 0.8, h: 0.015,
        fill: { color: palette.textColor }, line: { width: 0 },
      });
    }

    if (s.speakerNotes) {
      slide.addNotes(s.speakerNotes);
    }

    switch (archetype) {
      case 'hero-opener': {
        if (s.images.length > 0) {
          slide.addImage({
            path: s.images[0].url,
            x: 0, y: 0, w: slideWIn, h: slideHIn,
            sizing: { type: 'cover', w: slideWIn, h: slideHIn },
          });

          // Asymmetric Left-Anchored Scrim: protects typography while leaving 55%+ of 4K photo pristine
          slide.addShape(pptx.ShapeType.rect, {
            x: 0, y: 0, w: slideWIn * 0.58, h: slideHIn,
            fill: { color: palette.slideBg, transparency: 18 },
            line: { width: 0 },
          });
          slide.addShape(pptx.ShapeType.rect, {
            x: 0, y: slideHIn * 0.38, w: slideWIn * 0.65, h: slideHIn * 0.62,
            fill: { color: palette.slideBg, transparency: 22 },
            line: { width: 0 },
          });
        }

        // Kicker Badge
        const coverKicker = s.kicker || frontmatter.kicker || palette.kicker || 'DIRECTOR’S TREATMENT & PREVIS';
        slide.addText(coverKicker.toUpperCase(), {
          x: padIn, y: slideHIn * 0.46, w: slideWIn - padIn * 2, h: 0.35,
          fontSize: 10.5, bold: true, color: palette.accentColor,
          fontFace: fontPairing.monoFont,
          charSpacing: fontPairing.kickerTracking, margin: 0,
        });

        // Title (dynamic font sizing for perfect wrap)
        const coverTitle = stripMarkdownFormatting(s.title);
        const coverTitleSize = coverTitle.length < 25 ? 36 : (coverTitle.length < 45 ? 30 : 24);
        const coverTitleLines = Math.ceil(coverTitle.length / (coverTitleSize > 30 ? 30 : 40));
        const coverTitleH = Math.max(0.8, coverTitleLines * 0.55);

        slide.addText(coverTitle, {
          x: padIn, y: slideHIn * 0.52, w: (slideWIn - padIn * 2) * 0.72, h: coverTitleH,
          fontSize: coverTitleSize, bold: true,
          fontFace: fontPairing.displayFont,
          italic: fontPairing.italicDisplay,
          charSpacing: fontPairing.displayTracking,
          color: palette.titleColor,
          margin: 0,
        });

        // Subtitle
        if (s.subtitle) {
          const coverSub = stripMarkdownFormatting(s.subtitle);
          slide.addText(coverSub, {
            x: padIn, y: slideHIn * 0.52 + coverTitleH + 0.1, w: (slideWIn - padIn * 2) * 0.72, h: 0.7,
            fontSize: 15, color: palette.subtitleColor,
            fontFace: fontPairing.bodyFont,
            margin: 0,
          });
        }

        // Metadata footer pill (Dynamic)
        const director = options.director || frontmatter.director || 'ELI GREEN';
        const agency = options.agency || frontmatter.agency || 'DESIGN LABS';
        const client = options.brand || frontmatter.brand || options.client || frontmatter.client || brandAnchor;
        const studio = options.studio || frontmatter.studio || 'SCRATCHBOX STUDIO';
        const metaLine = `DIRECTOR: ${director.toUpperCase()}  |  AGENCY: ${agency.toUpperCase()}  |  CLIENT: ${client.toUpperCase()}  |  STUDIO: ${studio.toUpperCase()}`;

        slide.addShape(pptx.ShapeType.line, {
          x: padIn, y: slideHIn * 0.88, w: slideWIn - padIn * 2, h: 0,
          line: { color: '334155', width: 1 },
        });
        slide.addText(metaLine, {
          x: padIn, y: slideHIn * 0.89, w: slideWIn - padIn * 2, h: 0.35,
          fontSize: 9.5, bold: true, color: palette.textColor,
          fontFace: fontPairing.monoFont,
          charSpacing: 1.5, margin: 0,
        });
        break;
      }

      case 'section-divider': {
        const barY = slideHIn * 0.32;
        slide.addShape(pptx.ShapeType.rect, {
          x: padIn, y: barY, w: 1.2, h: 0.05,
          fill: { color: palette.accentColor }, line: { width: 0 },
        });

        slide.addText(s.title.toUpperCase(), {
          x: padIn, y: barY + 0.2, w: slideWIn - padIn * 2, h: 1.2,
          fontSize: 32, bold: true, color: palette.titleColor,
          fontFace: fontPairing.displayFont,
          charSpacing: fontPairing.displayTracking, margin: 0,
        });

        if (s.subtitle || s.body) {
          slide.addText(s.subtitle || s.body, {
            x: padIn, y: barY + 1.5, w: slideWIn * 0.75, h: 1.5,
            fontSize: 14, color: palette.subtitleColor,
            fontFace: fontPairing.bodyFont,
            lineSpacingMultiple: 1.4, margin: 0,
          });
        }
        break;
      }

      case 'art-card': {
        const isVs = s.title.trim().toUpperCase() === 'VS.' || s.title.trim().toUpperCase() === 'VS';
        const fontSize = isVs ? 64 : (s.title.length < 18 ? 46 : (s.title.length < 28 ? 38 : 32));

        slide.addText(s.title.toUpperCase(), {
          x: padIn,
          y: slideHIn * 0.36,
          w: slideWIn - padIn * 2,
          h: 2.0,
          fontSize,
          bold: true,
          fontFace: fontPairing.displayFont,
          color: palette.titleColor,
          align: 'center',
          valign: 'middle',
          charSpacing: fontPairing.displayTracking,
          margin: 0,
        });

        if (!isVs) {
          const barW = Math.min(2.2, Math.max(0.8, s.title.length * 0.08));
          slide.addShape(pptx.ShapeType.rect, {
            x: (slideWIn - barW) / 2,
            y: slideHIn * 0.62,
            w: barW,
            h: 0.05,
            fill: { color: palette.accentColor },
            line: { width: 0 },
          });
        }
        break;
      }

      case 'quote-centered': {
        const quoteText = s.blockquote || s.body || s.title;
        const quoteW = slideWIn * 0.72;
        const qx = (slideWIn - quoteW) / 2;
        const qy = slideHIn * 0.28;

        slide.addText('“', {
          x: qx - 0.6, y: qy - 0.3, w: 0.6, h: 0.8,
          fontSize: 60, bold: true, color: palette.accentColor,
          fontFace: fontPairing.displayFont,
          align: 'right', margin: 0,
        });

        slide.addText(quoteText, {
          x: qx, y: qy, w: quoteW, h: 2.6,
          fontSize: 22, bold: true,
          fontFace: fontPairing.displayFont,
          italic: fontPairing.italicDisplay,
          charSpacing: fontPairing.displayTracking,
          color: palette.titleColor, align: 'center', lineSpacingMultiple: 1.45, margin: 0,
        });

        slide.addText('”', {
          x: qx + quoteW, y: qy + 1.8, w: 0.6, h: 0.8,
          fontSize: 60, bold: true, color: palette.accentColor,
          fontFace: fontPairing.displayFont,
          align: 'left', margin: 0,
        });

        if (s.subtitle) {
          slide.addText(`- ${s.subtitle.toUpperCase()}`, {
            x: qx, y: qy + 2.7, w: quoteW, h: 0.4,
            fontSize: 11, bold: true, color: palette.subtitleColor,
            fontFace: fontPairing.monoFont,
            align: 'center', charSpacing: fontPairing.kickerTracking, margin: 0,
          });
        }
        break;
      }

      case 'anamorphic-letterbox': {
        const frameH = slideWIn / 2.39;
        const frameY = (slideHIn - frameH) / 2;

        if (s.images.length > 0) {
          slide.addImage({
            path: s.images[0].url,
            x: 0, y: frameY, w: slideWIn, h: frameH,
            sizing: { type: 'cover', w: slideWIn, h: frameH },
          });

          slide.addShape(pptx.ShapeType.rect, {
            x: 0, y: frameY, w: slideWIn, h: frameH,
            fill: { color: palette.slideBg, transparency: 40 },
            line: { width: 0 },
          });
        }

        slide.addShape(pptx.ShapeType.rect, {
          x: 0, y: 0, w: slideWIn, h: frameY,
          fill: { color: '000000' }, line: { width: 0 },
        });
        slide.addShape(pptx.ShapeType.rect, {
          x: 0, y: frameY + frameH, w: slideWIn, h: slideHIn - (frameY + frameH),
          fill: { color: '000000' }, line: { width: 0 },
        });

        const statement = (s.blockquote || s.body || s.title || '').toUpperCase();
        slide.addText(statement, {
          x: padIn, y: slideHIn * 0.44, w: slideWIn - padIn * 2, h: 1.2,
          fontSize: 15, bold: true, color: 'FFFFFF', align: 'center', charSpacing: 3, margin: 0,
        });
        break;
      }

      case 'recap-card-grid': {
        slide.addText(s.title ? s.title.toUpperCase() : 'DECK COMMANDMENTS // RECAP', {
          x: padIn, y: padIn * 0.7, w: slideWIn - padIn * 2, h: 0.5,
          fontSize: 18, bold: true, color: palette.titleColor, charSpacing: 2, margin: 0,
        });

        const bullets = s.bullets || [];
        const count = bullets.length;
        const cols = count > 6 ? (count >= 9 ? 3 : 2) : 2;
        const rows = Math.ceil(count / cols);
        const startY = padIn * 0.7 + 0.6;
        const gridH = slideHIn - startY - padIn * 0.7;
        const totalW = slideWIn - padIn * 2;
        const gapX = 0.3;
        const gapY = 0.2;
        const cardW = (totalW - gapX * (cols - 1)) / cols;
        const cardH = (gridH - gapY * (rows - 1)) / rows;

        for (let b = 0; b < count; b++) {
          const c = b % cols;
          const r = Math.floor(b / cols);
          const cx = padIn + c * (cardW + gapX);
          const cy = startY + r * (cardH + gapY);

          slide.addShape(pptx.ShapeType.rect, {
            x: cx, y: cy, w: cardW, h: cardH,
            fill: { color: 'FFFFFF' }, line: { width: 0 },
          });

          slide.addText(bullets[b].toUpperCase(), {
            x: cx + 0.2, y: cy + 0.1, w: cardW - 0.4, h: cardH - 0.2,
            fontSize: count > 8 ? 9.5 : 11, bold: true, color: '0D0D0E',
            align: 'center', valign: 'middle', charSpacing: 1.5, margin: 0,
          });
        }
        break;
      }

      case 'cards-executive': {
        // Dynamic Slide Header with Subtitle Support
        const topKicker = s.kicker || (s.subtitle && s.title.length < 30 ? s.subtitle.toUpperCase() : `${(options.brand || frontmatter.brand || brandAnchor || 'EXECUTIVE').toUpperCase()} // ALIGNMENT`);
        slide.addText(topKicker, {
          x: padIn, y: padIn, w: slideWIn - padIn * 2, h: 0.28,
          fontSize: 9.5, bold: true, color: palette.accentColor,
          fontFace: fontPairing.monoFont,
          charSpacing: fontPairing.kickerTracking, margin: 0,
        });

        const rawTitle = stripMarkdownFormatting(s.title);
        const titleFontSize = rawTitle.length > 50 ? 20 : (rawTitle.length > 35 ? 22 : 24);
        const titleLines = Math.ceil(rawTitle.length / (titleFontSize > 22 ? 38 : 46));
        const titleH = Math.max(0.4, titleLines * (titleFontSize / 72 * 1.3));

        slide.addText(rawTitle, {
          x: padIn, y: padIn + 0.32, w: slideWIn - padIn * 2, h: titleH,
          fontSize: titleFontSize, bold: true,
          fontFace: fontPairing.displayFont,
          italic: fontPairing.italicDisplay,
          charSpacing: fontPairing.displayTracking,
          color: palette.titleColor, margin: 0,
        });

        let curHeaderY = padIn + 0.32 + titleH;

        if (s.subtitle) {
          const rawSub = stripMarkdownFormatting(s.subtitle);
          const subLines = Math.ceil(rawSub.length / 65);
          const subH = Math.max(0.3, subLines * 0.26);
          slide.addText(rawSub, {
            x: padIn, y: curHeaderY + 0.05, w: slideWIn - padIn * 2, h: subH,
            fontSize: 13, color: palette.subtitleColor,
            fontFace: fontPairing.bodyFont,
            margin: 0,
          });
          curHeaderY += subH + 0.08;
        }

        slide.addShape(pptx.ShapeType.rect, {
          x: padIn, y: curHeaderY + 0.08, w: 0.8, h: 0.035,
          fill: { color: palette.accentColor }, line: { width: 0 },
        });

        const cardY = curHeaderY + 0.22;
        const cardH = slideHIn - cardY - padIn * 0.7;
        const totalW = slideWIn - padIn * 2;

        // Intelligent Card Chunking based on Content
        const paragraphs = (s.body || '').split('\n\n').filter(p => p.trim());
        const bullets = s.bullets || [];
        const hasBullets = bullets.length > 0;

        if (hasBullets && bullets.length >= 2 && bullets.length <= 4 && paragraphs.length === 0) {
          // 2 to 4 Distinct Milestone/Pillar Cards
          const count = bullets.length;
          const gap = 0.28;
          const cardW = (totalW - gap * (count - 1)) / count;

          for (let b = 0; b < count; b++) {
            const cx = padIn + b * (cardW + gap);
            addCardContainer(slide, { x: cx, y: cardY, w: cardW, h: cardH });

            // Extract badge and body text
            const raw = bullets[b];
            let badge = `PILLAR 0${b + 1}`;
            let textBody = raw;
            const match = raw.match(/^(\*\*[^*]+\*\*|[^:]{2,30}):\s*(.*)$/);
            if (match) {
              badge = match[1].replace(/\*\*/g, '').trim().toUpperCase();
              textBody = match[2].trim();
            }

            // Sequence pill badge
            slide.addShape(pptx.ShapeType.roundRect, {
              x: cx + 0.25, y: cardY + 0.25, w: Math.min(cardW - 0.5, Math.max(1.4, badge.length * 0.1 + 0.4)), h: 0.28,
              rectRadius: 0.14,
              fill: { color: palette.slideBg, transparency: 10 },
              line: { color: palette.accentColor, width: 1 },
            });
            slide.addText(badge, {
              x: cx + 0.25, y: cardY + 0.25, w: Math.min(cardW - 0.5, Math.max(1.4, badge.length * 0.1 + 0.4)), h: 0.28,
              fontSize: 9.5, bold: true, color: palette.accentColor,
              fontFace: fontPairing.monoFont,
              charSpacing: 1.5, align: 'center', valign: 'middle', margin: 0,
            });

            // Accent divider line under pill
            slide.addShape(pptx.ShapeType.rect, {
              x: cx + 0.25, y: cardY + 0.65, w: 0.5, h: 0.02,
              fill: { color: palette.secondaryAccent }, line: { width: 0 },
            });

            // Formatted text runs with bold lead-ins
            const runs = parseTextRuns(textBody, palette, {
              fontSize: count === 4 ? 10.5 : 11.5,
              color: palette.textColor,
              fontFace: fontPairing.bodyFont,
              lineSpacingMultiple: 1.4,
            });

            slide.addText(runs, {
              x: cx + 0.25, y: cardY + 0.8, w: cardW - 0.5, h: cardH - 1.0,
              valign: 'top', margin: 0,
            });
          }
        } else if (hasBullets && bullets.length > 4 && paragraphs.length === 0) {
          // > 4 Pure Bullets -> 2-Column Split
          const cardW = (totalW - 0.3) / 2;
          const mid = Math.ceil(bullets.length / 2);
          const leftBullets = bullets.slice(0, mid);
          const rightBullets = bullets.slice(mid);

          // Card 1: Left column
          addCardContainer(slide, { x: padIn, y: cardY, w: cardW, h: cardH });
          slide.addText('PRIMARY OBJECTIVES', {
            x: padIn + 0.3, y: cardY + 0.25, w: cardW - 0.6, h: 0.3,
            fontSize: 10, bold: true, color: palette.accentColor, charSpacing: 1.5, margin: 0,
          });
          const leftRuns = [];
          for (const b of leftBullets) {
            leftRuns.push(...parseTextRuns(b, palette, { fontSize: 10.5, color: palette.textColor, bullet: true, lineSpacingMultiple: 1.3 }));
            leftRuns.push({ text: '\n\n', options: { fontSize: 5 } });
          }
          slide.addText(leftRuns, {
            x: padIn + 0.3, y: cardY + 0.65, w: cardW - 0.6, h: cardH - 0.9,
            valign: 'top', margin: 0,
          });

          // Card 2: Right column
          const rx = padIn + cardW + 0.3;
          addCardContainer(slide, { x: rx, y: cardY, w: cardW, h: cardH });
          slide.addText('TECHNICAL DELIVERABLES', {
            x: rx + 0.3, y: cardY + 0.25, w: cardW - 0.6, h: 0.3,
            fontSize: 10, bold: true, color: palette.secondaryAccent, charSpacing: 1.5, margin: 0,
          });
          const rightRuns = [];
          for (const b of rightBullets) {
            rightRuns.push(...parseTextRuns(b, palette, { fontSize: 10.5, color: palette.textColor, bullet: true, lineSpacingMultiple: 1.3 }));
            rightRuns.push({ text: '\n\n', options: { fontSize: 5 } });
          }
          slide.addText(rightRuns, {
            x: rx + 0.3, y: cardY + 0.65, w: cardW - 0.6, h: cardH - 0.9,
            valign: 'top', margin: 0,
          });
        } else if (hasBullets && paragraphs.length > 0) {
          // 2-Card Split: Prose Left, Bullets Right
          const cardW = (totalW - 0.3) / 2;

          // Card 1: Overview
          addCardContainer(slide, { x: padIn, y: cardY, w: cardW, h: cardH });
          slide.addText('CORE CONCEPT & MANDATE', {
            x: padIn + 0.3, y: cardY + 0.25, w: cardW - 0.6, h: 0.3,
            fontSize: 10, bold: true, color: palette.accentColor, charSpacing: 1.5, margin: 0,
          });
          const proseRuns = [];
          for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
            proseRuns.push(...parseTextRuns(paragraphs[pIdx], palette, { fontSize: 11.5, color: palette.textColor, lineSpacingMultiple: 1.4 }));
            if (pIdx < paragraphs.length - 1) proseRuns.push({ text: '\n\n', options: { fontSize: 7 } });
          }
          slide.addText(proseRuns, {
            x: padIn + 0.3, y: cardY + 0.65, w: cardW - 0.6, h: cardH - 0.9,
            valign: 'top', margin: 0,
          });

          // Card 2: Bullets
          const rx = padIn + cardW + 0.3;
          addCardContainer(slide, { x: rx, y: cardY, w: cardW, h: cardH });
          slide.addText('EXECUTION SPECIFICATIONS', {
            x: rx + 0.3, y: cardY + 0.25, w: cardW - 0.6, h: 0.3,
            fontSize: 10, bold: true, color: palette.secondaryAccent, charSpacing: 1.5, margin: 0,
          });
          const bulletRuns = [];
          for (const b of bullets) {
            bulletRuns.push(...parseTextRuns(b, palette, {
              fontSize: bullets.length > 5 ? 9.5 : 10.5,
              color: palette.textColor,
              bullet: true,
              lineSpacingMultiple: bullets.length > 5 ? 1.2 : 1.3,
            }));
            bulletRuns.push({ text: '\n\n', options: { fontSize: 5 } });
          }
          slide.addText(bulletRuns, {
            x: rx + 0.3, y: cardY + 0.65, w: cardW - 0.6, h: cardH - 0.9,
            valign: 'top', margin: 0,
          });
        } else if (paragraphs.length >= 2 && paragraphs.length <= 3) {
          // Multi-paragraph cards (2 or 3 distinct pillar cards)
          const count = paragraphs.length;
          const gap = 0.3;
          const cardW = (totalW - gap * (count - 1)) / count;
          const defaultBadges = ['01 // THE MANDATE', '02 // THE EXECUTION', '03 // THE IMPACT'];

          for (let c = 0; c < count; c++) {
            const cx = padIn + c * (cardW + gap);
            addCardContainer(slide, { x: cx, y: cardY, w: cardW, h: cardH });
            const badgeText = defaultBadges[c] || `PILLAR 0${c + 1}`;
            slide.addText(badgeText, {
              x: cx + 0.3, y: cardY + 0.25, w: cardW - 0.6, h: 0.3,
              fontSize: 10, bold: true, color: palette.accentColor, charSpacing: 1.5, margin: 0,
            });
            const pRuns = parseTextRuns(paragraphs[c], palette, { fontSize: 11.5, color: palette.textColor, lineSpacingMultiple: 1.4 });
            slide.addText(pRuns, {
              x: cx + 0.3, y: cardY + 0.65, w: cardW - 0.6, h: cardH - 0.9,
              valign: 'top', margin: 0,
            });
          }
        } else {
          // Single powerful statement or multi-paragraph letter card (never drop paragraphs)
          const fullTextCombined = s.title + ' ' + (paragraphs[0] || '');
          const isLetter = /letter|droga5|chase|regards|sincerely/i.test(fullTextCombined);
          const letterW = isLetter ? Math.min(totalW, 10.0) : totalW;
          const letterX = padIn + (totalW - letterW) / 2;

          addCardContainer(slide, { x: letterX, y: cardY, w: letterW, h: cardH });
          slide.addText(isLetter ? 'DIRECTOR STATEMENT & SIGN-OFF' : 'KEY DIRECTORIAL VISION', {
            x: letterX + 0.4, y: cardY + 0.3, w: letterW - 0.8, h: 0.3,
            fontSize: 10, bold: true, color: palette.accentColor, charSpacing: 1.5, margin: 0,
          });

          const allRuns = [];
          const sourceParagraphs = paragraphs.length > 0 ? paragraphs : [s.body || s.blockquote || s.subtitle || s.title];
          for (let pIdx = 0; pIdx < sourceParagraphs.length; pIdx++) {
            allRuns.push(...parseTextRuns(sourceParagraphs[pIdx], palette, {
              fontSize: isLetter ? 11 : 14,
              color: palette.textColor,
              lineSpacingMultiple: 1.4,
            }));
            if (pIdx < sourceParagraphs.length - 1) {
              allRuns.push({ text: '\n\n', options: { fontSize: isLetter ? 7 : 10 } });
            }
          }

          slide.addText(allRuns, {
            x: letterX + 0.4, y: cardY + 0.7, w: letterW - 0.8, h: cardH - 0.9,
            valign: 'top', margin: 0,
          });
        }
        break;
      }

      case 'image-forward': {
        const textW = (slideWIn - padIn * 2) * 0.42;
        const rightAreaW = (slideWIn - padIn * 2) * 0.54;
        const rightAreaX = padIn + textW + 0.4;

        const kickerText = s.kicker || (s.subtitle && s.title.length < 30 ? s.subtitle.toUpperCase() : 'DIRECTOR VISION');
        slide.addText(kickerText, {
          x: padIn, y: padIn, w: textW, h: 0.28,
          fontSize: 9.5, bold: true, color: palette.accentColor,
          fontFace: fontPairing.monoFont,
          charSpacing: fontPairing.kickerTracking, margin: 0,
        });

        const rawTitle = stripMarkdownFormatting(s.title);
        const titleFontSize = rawTitle.length > 40 ? 18 : 21;
        const titleLines = Math.ceil(rawTitle.length / (titleFontSize > 19 ? 28 : 34));
        const titleH = Math.max(0.38, titleLines * (titleFontSize / 72 * 1.3));

        slide.addText(rawTitle, {
          x: padIn, y: padIn + 0.32, w: textW, h: titleH,
          fontSize: titleFontSize, bold: true,
          fontFace: fontPairing.displayFont,
          italic: fontPairing.italicDisplay,
          charSpacing: fontPairing.displayTracking,
          color: palette.titleColor, margin: 0,
        });

        let curHeaderY = padIn + 0.32 + titleH;

        if (s.subtitle) {
          const rawSub = stripMarkdownFormatting(s.subtitle);
          const subH = Math.max(0.28, Math.ceil(rawSub.length / 45) * 0.25);
          slide.addText(rawSub, {
            x: padIn, y: curHeaderY + 0.04, w: textW, h: subH,
            fontSize: 12, color: palette.subtitleColor,
            fontFace: fontPairing.bodyFont,
            margin: 0,
          });
          curHeaderY += subH + 0.06;
        }

        slide.addShape(pptx.ShapeType.rect, {
          x: padIn, y: curHeaderY + 0.06, w: 0.8, h: 0.035,
          fill: { color: palette.accentColor }, line: { width: 0 },
        });

        const cardY = curHeaderY + 0.18;
        const cardH = slideHIn - cardY - padIn * 0.7;
        addCardContainer(slide, { x: padIn, y: cardY, w: textW, h: cardH });

        const textParts = [];
        if (s.body) {
          const bodyRuns = parseTextRuns(s.body, palette, { fontSize: 11, color: palette.textColor, fontFace: fontPairing.bodyFont, lineSpacingMultiple: 1.35 });
          textParts.push(...bodyRuns);
          if (s.bullets && s.bullets.length > 0) {
            textParts.push({ text: '\n\n', options: { fontSize: 6 } });
          }
        }
        for (const b of s.bullets) {
          textParts.push(...parseTextRuns(b, palette, { fontSize: 10.5, color: palette.textColor, fontFace: fontPairing.bodyFont, bullet: true, lineSpacingMultiple: 1.3 }));
          textParts.push({ text: '\n\n', options: { fontSize: 5 } });
        }

        if (textParts.length > 0) {
          slide.addText(textParts, {
            x: padIn + 0.3, y: cardY + 0.3, w: textW - 0.6, h: cardH - 0.6,
            valign: 'top', margin: 0,
          });
        }

        if (s.images.length > 0) {
          const imgPath = s.images[0].url;
          const { aspect } = getImageDimensions(imgPath);

          // Dedicated 16:9 Cinema Container (NEVER a square box!)
          const maxMediaW = rightAreaW;
          const maxMediaH = 4.0;
          const { w: imgFitW, h: imgFitH } = fitDimensions(aspect, maxMediaW - 0.16, maxMediaH - 0.16);

          const mediaCardW = imgFitW + 0.16;
          const mediaCardH = imgFitH + 0.16;
          const mediaCardX = rightAreaX + (rightAreaW - mediaCardW) / 2;
          const mediaCardY = padIn;

          // True 16:9 Widescreen Card
          addCardContainer(slide, { x: mediaCardX, y: mediaCardY, w: mediaCardW, h: mediaCardH });

          // Exact native aspect ratio image
          slide.addImage({
            path: imgPath,
            x: mediaCardX + 0.08,
            y: mediaCardY + 0.08,
            w: imgFitW,
            h: imgFitH,
          });

          // Companion Technical Specifications Card
          const metaCardY = mediaCardY + mediaCardH + 0.25;
          const metaCardH = slideHIn - padIn - metaCardY;
          if (metaCardH >= 0.8) {
            addCardContainer(slide, { x: mediaCardX, y: metaCardY, w: mediaCardW, h: metaCardH });

            slide.addText('TECHNICAL PREVIS SPECIFICATIONS', {
              x: mediaCardX + 0.25, y: metaCardY + 0.2, w: mediaCardW - 0.5, h: 0.25,
              fontSize: 9.5, bold: true, color: palette.accentColor, charSpacing: 1.5, margin: 0,
            });

            const metaRuns = [
              { text: '• Timeline: ', options: { bold: true, color: palette.subtitleColor, fontSize: 10 } },
              { text: '15-Second Continuous Seamless Cycle (0.0s – 15.0s)\n', options: { color: palette.textColor, fontSize: 10 } },
              { text: '• Frame Rate & Frustum: ', options: { bold: true, color: palette.subtitleColor, fontSize: 10 } },
              { text: '30 FPS Broadcast Cadence  |  2:1 MSG Marquee Frustum\n', options: { color: palette.textColor, fontSize: 10 } },
              { text: '• Chirality & Rig: ', options: { bold: true, color: palette.subtitleColor, fontSize: 10 } },
              { text: 'Strict Left Arm (48° Incline)  |  55-Joint Articulated Hand Rig', options: { color: palette.textColor, fontSize: 10 } },
            ];

            slide.addText(metaRuns, {
              x: mediaCardX + 0.25, y: metaCardY + 0.48, w: mediaCardW - 0.5, h: metaCardH - 0.55,
              valign: 'top', lineSpacingMultiple: 1.25, margin: 0,
            });
          }
        }
        break;
      }

      case 'text-left-images-right': {
        const textW = (slideWIn - padIn * 2) * 0.42;
        const gridW = (slideWIn - padIn * 2) * 0.54;
        const gridX = padIn + textW + 0.4;

        const kickerText = s.kicker || (s.subtitle && s.title.length < 30 ? s.subtitle.toUpperCase() : 'TECHNICAL ARCHITECTURE');
        slide.addText(kickerText, {
          x: padIn, y: padIn, w: textW, h: 0.28,
          fontSize: 9.5, bold: true, color: palette.accentColor, charSpacing: 2, margin: 0,
        });

        const rawTitle = stripMarkdownFormatting(s.title);
        const titleFontSize = rawTitle.length > 40 ? 18 : 20;
        const titleLines = Math.ceil(rawTitle.length / (titleFontSize > 19 ? 28 : 34));
        const titleH = Math.max(0.38, titleLines * (titleFontSize / 72 * 1.3));

        slide.addText(rawTitle, {
          x: padIn, y: padIn + 0.32, w: textW, h: titleH,
          fontSize: titleFontSize, bold: true, color: palette.titleColor, margin: 0,
        });

        let curHeaderY = padIn + 0.32 + titleH;

        if (s.subtitle) {
          const rawSub = stripMarkdownFormatting(s.subtitle);
          const subH = Math.max(0.28, Math.ceil(rawSub.length / 45) * 0.25);
          slide.addText(rawSub, {
            x: padIn, y: curHeaderY + 0.04, w: textW, h: subH,
            fontSize: 12, color: palette.subtitleColor, margin: 0,
          });
          curHeaderY += subH + 0.06;
        }

        slide.addShape(pptx.ShapeType.rect, {
          x: padIn, y: curHeaderY + 0.06, w: 0.8, h: 0.035,
          fill: { color: palette.accentColor }, line: { width: 0 },
        });

        const cardY = curHeaderY + 0.18;
        const cardH = slideHIn - cardY - padIn * 0.7;
        addCardContainer(slide, { x: padIn, y: cardY, w: textW, h: cardH });

        const textProps = [];
        if (s.body) {
          const bodyRuns = parseTextRuns(s.body, palette, { fontSize: 11, color: palette.textColor, lineSpacingMultiple: 1.35 });
          textProps.push(...bodyRuns);
          if (s.bullets && s.bullets.length > 0) {
            textProps.push({ text: '\n\n', options: { fontSize: 6 } });
          }
        }
        for (const b of s.bullets) {
          textProps.push(...parseTextRuns(b, palette, { fontSize: 10, color: palette.textColor, bullet: true, lineSpacingMultiple: 1.3 }));
          textProps.push({ text: '\n\n', options: { fontSize: 5 } });
        }

        slide.addText(textProps, {
          x: padIn + 0.3, y: cardY + 0.3, w: textW - 0.6, h: cardH - 0.6,
          valign: 'top', margin: 0,
        });

        const imgCount = Math.min(s.images.length, 4);

        if (imgCount === 2) {
          // Two 16:9 images stacked vertically
          const gap = 0.2;
          const slotH = (slideHIn - padIn * 2 - gap) / 2;
          const slotW = gridW;

          for (let g = 0; g < 2; g++) {
            const imgPath = s.images[g].url;
            const { aspect } = getImageDimensions(imgPath);
            const { w: imgFitW, h: imgFitH } = fitDimensions(aspect, slotW - 0.16, slotH - 0.16);

            const cardW = imgFitW + 0.16;
            const cardH = imgFitH + 0.16;
            const cx = gridX + (gridW - cardW) / 2;
            const cy = padIn + g * (slotH + gap) + (slotH - cardH) / 2;

            addCardContainer(slide, { x: cx, y: cy, w: cardW, h: cardH });
            slide.addImage({
              path: imgPath,
              x: cx + 0.08,
              y: cy + 0.08,
              w: imgFitW,
              h: imgFitH,
            });
          }
        } else if (imgCount === 4) {
          // 4 images in a 2x2 grid (Beats 1-4, Beats 5-8)
          const cols = 2;
          const rows = 2;
          const gapX = 0.2;
          const gapY = 0.2;
          const slotW = (gridW - gapX) / 2;
          const slotH = (slideHIn - padIn * 2 - gapY) / 2;

          for (let g = 0; g < 4; g++) {
            const c = g % cols;
            const r = Math.floor(g / cols);
            const imgPath = s.images[g].url;
            const { aspect } = getImageDimensions(imgPath);
            const { w: imgFitW, h: imgFitH } = fitDimensions(aspect, slotW - 0.16, slotH - 0.16);

            const cardW = imgFitW + 0.16;
            const cardH = imgFitH + 0.16;
            const cx = gridX + c * (slotW + gapX) + (slotW - cardW) / 2;
            const cy = padIn + r * (slotH + gapY) + (slotH - cardH) / 2;

            addCardContainer(slide, { x: cx, y: cy, w: cardW, h: cardH });
            slide.addImage({
              path: imgPath,
              x: cx + 0.08,
              y: cy + 0.08,
              w: imgFitW,
              h: imgFitH,
            });
          }
        } else {
          // Single or other count
          for (let g = 0; g < imgCount; g++) {
            const imgPath = s.images[g].url;
            const { aspect } = getImageDimensions(imgPath);
            const { w: imgFitW, h: imgFitH } = fitDimensions(aspect, gridW - 0.16, slideHIn - padIn * 2 - 0.16);
            const cardW = imgFitW + 0.16;
            const cardH = imgFitH + 0.16;
            const cx = gridX + (gridW - cardW) / 2;
            const cy = padIn + (slideHIn - padIn * 2 - cardH) / 2;

            addCardContainer(slide, { x: cx, y: cy, w: cardW, h: cardH });
            slide.addImage({
              path: imgPath,
              x: cx + 0.08,
              y: cy + 0.08,
              w: imgFitW,
              h: imgFitH,
            });
          }
        }
        break;
      }

      case 'full-bleed-text-overlay': {
        if (s.images.length > 0) {
          slide.addImage({
            path: s.images[0].url,
            x: 0, y: 0, w: slideWIn, h: slideHIn,
            sizing: { type: 'cover', w: slideWIn, h: slideHIn },
          });
          slide.addShape(pptx.ShapeType.rect, {
            x: 0, y: 0, w: slideWIn, h: slideHIn,
            fill: { color: palette.slideBg, transparency: 30 },
            line: { width: 0 },
          });
        }

        const quoteW = slideWIn * 0.75;
        const quoteH = 2.8;
        const qx = (slideWIn - quoteW) / 2;
        const qy = (slideHIn - quoteH) / 2;

        addCardContainer(slide, { x: qx, y: qy, w: quoteW, h: quoteH, fill: '07111ECC' });

        slide.addText(`"${s.blockquote || s.body}"`, {
          x: qx + 0.5, y: qy + 0.4, w: quoteW - 1.0, h: quoteH - 0.8,
          fontSize: 18, italic: true, color: palette.titleColor, align: 'center', lineSpacingMultiple: 1.4, margin: 0,
        });
        break;
      }

      case 'composite':
      default: {
        const rawTitle = stripMarkdownFormatting(s.title);
        const titleFontSize = rawTitle.length > 50 ? 20 : (rawTitle.length > 35 ? 22 : 24);
        const titleLines = Math.ceil(rawTitle.length / (titleFontSize > 22 ? 38 : 46));
        const titleH = Math.max(0.4, titleLines * (titleFontSize / 72 * 1.3));

        slide.addText(rawTitle, {
          x: padIn, y: padIn, w: slideWIn - padIn * 2, h: titleH,
          fontSize: titleFontSize, bold: true, color: palette.titleColor, margin: 0,
        });

        let curHeaderY = padIn + titleH;

        if (s.subtitle) {
          const rawSub = stripMarkdownFormatting(s.subtitle);
          const subLines = Math.ceil(rawSub.length / 65);
          const subH = Math.max(0.3, subLines * 0.26);
          slide.addText(rawSub, {
            x: padIn, y: curHeaderY + 0.05, w: slideWIn - padIn * 2, h: subH,
            fontSize: 13, color: palette.subtitleColor, margin: 0,
          });
          curHeaderY += subH + 0.08;
        }

        slide.addShape(pptx.ShapeType.rect, {
          x: padIn, y: curHeaderY + 0.08, w: 0.8, h: 0.035,
          fill: { color: palette.accentColor }, line: { width: 0 },
        });

        if (s.table) {
          const tableTop = curHeaderY + 0.25;
          const tableH = slideHIn - tableTop - padIn;
          const tableW = slideWIn - padIn * 2;

          const rowsData = [];
          rowsData.push(
            s.table.headers.map(h => ({
              text: h.toUpperCase(),
              options: {
                fill: { color: palette.accentColor },
                color: 'FFFFFF',
                bold: true,
                fontSize: 9.5,
                align: 'left',
              },
            }))
          );

          const colCount = s.table.headers.length;
          let colW = undefined;
          if (colCount === 5 && /time/i.test(s.table.headers[0])) {
            colW = [1.1, 1.8, 3.2, 3.1, 2.533];
          } else if (colCount === 4) {
            colW = [1.8, 3.5, 3.4, 3.033];
          } else if (colCount > 0) {
            const defaultColW = tableW / colCount;
            colW = Array(colCount).fill(defaultColW);
          }

          for (let rIdx = 0; rIdx < s.table.dataRows.length; rIdx++) {
            const row = s.table.dataRows[rIdx];
            const isAlt = rIdx % 2 === 1;
            rowsData.push(
              row.map(cell => ({
                text: cell,
                options: {
                  fill: { color: isAlt ? palette.cardBg : palette.slideBg },
                  color: palette.textColor,
                  fontSize: 8,
                  margin: [2, 4, 2, 4],
                  align: 'left',
                },
              }))
            );
          }

          slide.addTable(rowsData, {
            x: padIn, y: tableTop, w: tableW, h: tableH,
            colW,
            border: { color: palette.cardBorder, pt: 1 },
            autoPage: false,
          });
        } else {
          const cardY = curHeaderY + 0.22;
          const cardH = slideHIn - cardY - padIn * 0.7;
          addCardContainer(slide, { x: padIn, y: cardY, w: slideWIn - padIn * 2, h: cardH });

          const textParts = [];
          if (s.body) {
            textParts.push(...parseTextRuns(s.body, palette, { fontSize: 12, color: palette.textColor, lineSpacingMultiple: 1.4 }));
            if (s.bullets && s.bullets.length > 0) textParts.push({ text: '\n\n', options: { fontSize: 8 } });
          }
          for (const b of s.bullets) {
            textParts.push(...parseTextRuns(b, palette, { fontSize: 11, color: palette.textColor, bullet: true, lineSpacingMultiple: 1.3 }));
            textParts.push({ text: '\n\n', options: { fontSize: 6 } });
          }

          slide.addText(textParts, {
            x: padIn + 0.4, y: cardY + 0.4, w: slideWIn - padIn * 2 - 0.8, h: cardH - 0.8,
            valign: 'top', margin: 0,
          });
        }
        break;
      }
    }

    // Slide Number & Footer Tracker (bottom right)
    if (!options.chrome && !frontmatter.chrome) {
      const footerBrand = (options.brand || frontmatter.brand || brandAnchor || '').toUpperCase();
      const footerTitle = (options.title || frontmatter.title || pptx.title || '').toUpperCase();
      const footerShortTitle = footerTitle.length > 36 ? footerTitle.slice(0, 33) + '...' : footerTitle;
      const footerLabel = [footerBrand, footerShortTitle].filter(Boolean).join(' // ') || 'PRESENTATION DECK';
      slide.addText(`${footerLabel}  //  ${i + 1} / ${slides.length}`, {
        x: slideWIn - padIn - 6.5, y: slideHIn - 0.45, w: 6.5, h: 0.3,
        fontSize: 8.5, color: '64748B',
        fontFace: fontPairing.monoFont,
        align: 'right', charSpacing: 1.5, margin: 0,
      });
    }
  }

  const outPath = options.out || markdownPath.replace(/\.md$/, '.pptx');
  await pptx.writeFile({ fileName: outPath });

  let htmlPath = null;
  if (options.html !== false) {
    htmlPath = outPath.replace(/\.pptx$/, '.html');
    generateHtmlDeck({
      title: pptx.title,
      slides,
      palette,
      outputPath: htmlPath,
      frontmatter,
      options,
    });
  }

  return {
    outPath,
    htmlPath,
    slideCount: slides.length,
    palette,
    brand: brandAnchor,
  };
}

// ============================================================================
// 6. GOOGLE DRIVE API & PUBLIC WRITE PERMISSIONS
// ============================================================================

export async function uploadPptxToGoogleSlides(pptxPath, title) {
  const { JWT } = await import('google-auth-library');

  const saCandidates = [
    '/Users/eligreen/.gemini/antigravity/brain/ac7cb5ba-ca0b-4872-b699-a89e29c9c80e/google_service_account.json',
    '/Users/eligreen/.gemini/antigravity/brain/b545620b-4fcf-4171-9ece-7a2c47573e3f/google_service_account.json',
    '/Users/eligreen/dev/SCRATCHBOX-STUDIO/attached_assets/Pasted--type-service-account-project-id-scratchbox-canvas-priv_1787240560989.txt',
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
  ];

  let saPath = null;
  for (const c of saCandidates) {
    if (c && fs.existsSync(c)) { saPath = c; break; }
  }

  if (!saPath) {
    throw new Error('Google service account key file not found');
  }

  const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
  const client = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
    subject: 'eli@scratchbox.ai',
  });

  await client.authorize();
  const token = (await client.getAccessToken()).token;

  const metadata = {
    name: title,
    mimeType: 'application/vnd.google-apps.presentation',
  };

  const fileData = fs.readFileSync(pptxPath);
  const boundary = 'foo_bar_baz_boundary_' + Date.now();
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const multipartRequestBody = Buffer.concat([
    Buffer.from(
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation\r\n\r\n'
    ),
    fileData,
    Buffer.from(closeDelimiter),
  ]);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartRequestBody,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Drive upload failed: ${res.status} ${txt}`);
  }

  const json = await res.json();
  const presentationId = json.id;

  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${presentationId}/permissions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'writer', type: 'anyone' }),
    });
  } catch (err) {
    console.warn('[WARN] Could not set public permission:', err.message);
  }

  const editUrl = `https://docs.google.com/presentation/d/${presentationId}/edit`;
  return { presentationId, editUrl };
}

// ============================================================================
// 7. CLI INVOCATION
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║               markdown-to-slides | Scratchbox Studio Engine                  ║
╚══════════════════════════════════════════════════════════════════════════════╝

Usage:
  markdown-to-slides <input.md> [options]

Options:
  --brand <name>        Brand identity to anchor colors (e.g., Chase, Knicks, Volvo)
  --color <hex>         Custom brand anchor color
  --harmony <mode>      Adobe Color harmony model: split-complementary, analogous, triadic
  --theme <dark|light>  Color scheme variant (default: dark)
  --ratio <16:9|21:9|4:3> Slide aspect ratio (default: 16:9, preferred ultrawide: 21:9)
  --chrome              Enable Signature Editorial Chrome (eyebrow + spelled-out page numbers)
  --eyebrow <text>      Eyebrow label for top-left header
  --scratchbox-images   Generate visuals via Scratchbox MCP (scratchbox.ai / Nano Banana Pro)
  --workspace <id>      Scratchbox Workspace ID to save generated assets (default: 126)
  --out <path>          Output file path
  --html                Generate standalone 1920x1080 HTML presentation
  --upload-drive        Directly upload and convert to live Google Slides deck
`);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const inputFile = args[0];
  const options = {};
  let shouldUploadDrive = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--brand') options.brand = args[++i];
    if (args[i] === '--color') options.color = args[++i];
    if (args[i] === '--harmony') options.harmony = args[++i];
    if (args[i] === '--theme') options.theme = args[++i];
    if (args[i] === '--out') options.out = args[++i];
    if (args[i] === '--ratio') options.ratio = args[++i];
    if (args[i] === '--chrome') options.chrome = true;
    if (args[i] === '--eyebrow') options.eyebrow = args[++i];
    if (args[i] === '--font-pairing' || args[i] === '--font-preset') options.fontPairing = args[++i];
    if (args[i] === '--scratchbox-images' || args[i] === '--generate-images') options.scratchboxImages = true;
    if (args[i] === '--workspace') options.workspaceId = args[++i];
    if (args[i] === '--html') options.html = true;
    if (args[i] === '--upload-drive') shouldUploadDrive = true;
  }

  compileMarkdownToPptx(inputFile, options)
    .then(async (res) => {
      console.log(`[SUCCESS] Compiled ${res.slideCount} slides for brand "${res.brand}" -> ${res.outPath}`);
      if (res.htmlPath) {
        console.log(`[SUCCESS] Generated Interactive 1920x1080 HTML deck -> ${res.htmlPath}`);
      }
      if (shouldUploadDrive) {
        console.log(`[DRIVE] Uploading and converting to Google Slides with public writer permissions...`);
        const title = options.title || `${res.brand} Presentation | Scratchbox Studio Engine`;
        const driveRes = await uploadPptxToGoogleSlides(res.outPath, title);
        console.log(`[SUCCESS] Live Google Slides URL: ${driveRes.editUrl}`);
      }
    })
    .catch((err) => {
      console.error('[ERROR] Compilation failed:', err);
      process.exit(1);
    });
}
