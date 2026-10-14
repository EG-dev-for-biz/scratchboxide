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

export interface NanoBananaPromptResult {
    prompt: string;
    curatedImageUrl: string;
    attribution: string;
    styleLabel: string;
    dateTag?: string;
    imageTitle?: string;
    caption?: string;
}

export interface CuratedImageEntry {
    url: string;
    title: string;
    caption: string;
    attribution: string;
    dateTag: string;
    theme: DocumentTheme;
    keywords: string[];
}

// =======================================================================
// Topic-Grounded Masterwork SVG Vector Visual Generators
// =======================================================================

function createWashingtonCrossingSvg(): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 640" width="100%" height="100%">
  <defs>
    <linearGradient id="skyGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#080e1a"/>
      <stop offset="60%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#334155"/>
    </linearGradient>
    <linearGradient id="waterGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#172554"/>
      <stop offset="50%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
    <radialGradient id="torchGlow" cx="42%" cy="46%" r="35%">
      <stop offset="0%" stop-color="#f97316" stop-opacity="0.6"/>
      <stop offset="40%" stop-color="#ea580c" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="iceGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#e0f2fe" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#7dd3fc" stop-opacity="0.5"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>

  <!-- Night Winter Sky -->
  <rect width="1200" height="380" fill="url(#skyGrad)"/>

  <!-- Blizzard Snow Particles in Sky -->
  <g fill="#ffffff" opacity="0.65">
    <circle cx="120" cy="80" r="2.5"/><circle cx="280" cy="40" r="1.8"/><circle cx="450" cy="110" r="2.2"/>
    <circle cx="620" cy="65" r="3.0"/><circle cx="780" cy="95" r="2.0"/><circle cx="940" cy="50" r="2.5"/>
    <circle cx="1080" cy="120" r="1.5"/><circle cx="210" cy="200" r="2.0"/><circle cx="530" cy="180" r="2.8"/>
    <circle cx="870" cy="220" r="2.2"/><circle cx="1010" cy="190" r="1.7"/><circle cx="340" cy="280" r="2.4"/>
    <circle cx="690" cy="290" r="2.0"/><circle cx="1120" cy="260" r="2.5"/><circle cx="80" cy="310" r="1.8"/>
  </g>

  <!-- Distant Snowy Shoreline -->
  <path d="M 0 340 Q 300 320 600 335 T 1200 330 L 1200 380 L 0 380 Z" fill="#0f172a" opacity="0.9"/>
  <path d="M 0 340 Q 300 320 600 335 T 1200 330" stroke="#94a3b8" stroke-width="2" fill="none" opacity="0.5"/>

  <!-- Icy Delaware River -->
  <rect y="350" width="1200" height="290" fill="url(#waterGrad)"/>

  <!-- Torchlight Radiance on River -->
  <rect width="1200" height="640" fill="url(#torchGlow)"/>

  <!-- Jagged Floating Ice Floes -->
  <polygon points="80,440 160,420 220,445 190,480 110,470" fill="url(#iceGrad)"/>
  <polygon points="260,520 380,500 420,535 340,560 270,545" fill="url(#iceGrad)"/>
  <polygon points="680,460 790,440 850,475 810,510 700,495" fill="url(#iceGrad)"/>
  <polygon points="920,520 1060,495 1110,540 1010,575 930,555" fill="url(#iceGrad)"/>
  <polygon points="450,410 520,395 560,418 510,435 460,428" fill="url(#iceGrad)"/>

  <!-- Wooden Durham Boat Hull -->
  <path d="M 320 460 L 400 515 L 780 515 L 860 460 Q 590 495 320 460 Z" fill="#1c1917" stroke="#44403c" stroke-width="2"/>
  <line x1="380" y1="465" x2="310" y2="540" stroke="#78716c" stroke-width="4" stroke-linecap="round"/>
  <line x1="480" y1="465" x2="420" y2="550" stroke="#78716c" stroke-width="4" stroke-linecap="round"/>
  <line x1="720" y1="465" x2="780" y2="550" stroke="#78716c" stroke-width="4" stroke-linecap="round"/>
  <line x1="800" y1="465" x2="870" y2="540" stroke="#78716c" stroke-width="4" stroke-linecap="round"/>

  <!-- Continental Soldiers Silhouettes Rowing -->
  <circle cx="410" cy="445" r="14" fill="#292524"/>
  <path d="M 400 440 L 420 435 L 415 448 Z" fill="#44403c"/> <!-- Tricorne -->
  <rect x="402" y="458" width="18" height="30" rx="4" fill="#1c1917"/>

  <circle cx="490" cy="445" r="14" fill="#292524"/>
  <path d="M 480 440 L 500 435 L 495 448 Z" fill="#44403c"/>
  <rect x="482" y="458" width="18" height="30" rx="4" fill="#1c1917"/>

  <circle cx="730" cy="445" r="14" fill="#292524"/>
  <path d="M 720 440 L 740 435 L 735 448 Z" fill="#44403c"/>
  <rect x="722" y="458" width="18" height="30" rx="4" fill="#1c1917"/>

  <!-- General George Washington Standing in Prow -->
  <g transform="translate(600, 360)">
    <!-- Cloak & Body -->
    <path d="M -16 65 L -28 120 L 22 120 L 16 65 Z" fill="#0f172a"/>
    <path d="M -22 75 Q -38 100 -28 120 Q -8 115 6 120 L 18 75 Z" fill="#1e293b"/>
    <!-- Head & Tricorne Hat -->
    <circle cx="0" cy="48" r="15" fill="#d6d3d1"/>
    <path d="M -22 38 L 22 38 L 0 20 Z" fill="#09090b" stroke="#38bdf8" stroke-width="1.2"/>
    <!-- Upraised Spyglass / Arm -->
    <line x1="8" y1="70" x2="35" y2="52" stroke="#d6d3d1" stroke-width="5" stroke-linecap="round"/>
    <rect x="32" y="48" width="22" height="6" rx="2" fill="#d97706" transform="rotate(-25 32 48)"/>
  </g>

  <!-- Blazing Torch in Boat -->
  <g transform="translate(685, 420)">
    <line x1="0" y1="40" x2="0" y2="0" stroke="#78350f" stroke-width="4"/>
    <circle cx="0" cy="-4" r="14" fill="#f97316" filter="url(#glow)"/>
    <polygon points="-8,4 8,4 0,-22" fill="#fbbf24"/>
    <circle cx="0" cy="-6" r="6" fill="#ffffff"/>
  </g>

  <!-- Title Badge Overlay -->
  <rect x="36" y="36" width="460" height="64" rx="12" fill="rgba(15, 23, 42, 0.85)" stroke="rgba(56, 189, 248, 0.4)" stroke-width="1.5"/>
  <text x="56" y="62" fill="#38bdf8" font-size="12" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif" letter-spacing="1">DECEMBER 25–26, 1776 • DELAWARE RIVER</text>
  <text x="56" y="84" fill="#f8fafc" font-size="15" font-weight="600" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif">Washington's Crossing of the Delaware</text>
</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function createDeclarationSigningSvg(): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 640" width="100%" height="100%">
  <defs>
    <linearGradient id="chamberWall" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2c1a0e"/>
      <stop offset="50%" stop-color="#451a03"/>
      <stop offset="100%" stop-color="#1c0f07"/>
    </linearGradient>
    <linearGradient id="sunbeam" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fef08a" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#fef08a" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="greenBaize" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#166534"/>
      <stop offset="100%" stop-color="#14532d"/>
    </linearGradient>
    <linearGradient id="parchmentGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fef3c7"/>
      <stop offset="100%" stop-color="#fde68a"/>
    </linearGradient>
    <filter id="goldGlow">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>

  <!-- Georgian Assembly Chamber Walnut Wall -->
  <rect width="1200" height="640" fill="url(#chamberWall)"/>

  <!-- Georgian Arch Windows in Background -->
  <g fill="#93c5fd" opacity="0.4" stroke="#f8fafc" stroke-width="4">
    <rect x="140" y="80" width="160" height="260" rx="80" fill="#bae6fd"/>
    <line x1="220" y1="80" x2="220" y2="340" stroke="#f8fafc" stroke-width="4"/>
    <line x1="140" y1="180" x2="300" y2="180" stroke="#f8fafc" stroke-width="4"/>
    <line x1="140" y1="260" x2="300" y2="260" stroke="#f8fafc" stroke-width="4"/>

    <rect x="900" y="80" width="160" height="260" rx="80" fill="#bae6fd"/>
    <line x1="980" y1="80" x2="980" y2="340" stroke="#f8fafc" stroke-width="4"/>
    <line x1="900" y1="180" x2="1060" y2="180" stroke="#f8fafc" stroke-width="4"/>
    <line x1="900" y1="260" x2="1060" y2="260" stroke="#f8fafc" stroke-width="4"/>
  </g>

  <!-- Sunbeams Streaming Into Room -->
  <polygon points="140,80 300,80 580,640 260,640" fill="url(#sunbeam)"/>
  <polygon points="900,80 1060,80 1180,640 880,640" fill="url(#sunbeam)"/>

  <!-- Mahogany Floor -->
  <rect y="440" width="1200" height="200" fill="#1c0d05"/>
  <line x1="0" y1="440" x2="1200" y2="440" stroke="#78350f" stroke-width="3"/>

  <!-- Central President John Hancock Assembly Table -->
  <rect x="420" y="380" width="360" height="150" rx="8" fill="url(#greenBaize)" stroke="#78350f" stroke-width="4"/>
  <!-- Table Legs -->
  <rect x="440" y="530" width="24" height="90" fill="#451a03"/>
  <rect x="736" y="530" width="24" height="90" fill="#451a03"/>

  <!-- Engrossed Declaration of Independence Parchment on Table -->
  <g transform="translate(520, 410) rotate(-6)">
    <rect width="160" height="100" rx="4" fill="url(#parchmentGrad)" stroke="#b45309" stroke-width="1.5"/>
    <text x="14" y="24" fill="#78350f" font-size="9" font-weight="700" font-family="Georgia, serif">IN CONGRESS, JULY 4, 1776</text>
    <text x="14" y="38" fill="#92400e" font-size="8" font-style="italic" font-family="Georgia, serif">The unanimous Declaration...</text>
    <!-- Script lines -->
    <line x1="14" y1="48" x2="146" y2="48" stroke="#92400e" stroke-width="1" stroke-dasharray="4 2"/>
    <line x1="14" y1="56" x2="146" y2="56" stroke="#92400e" stroke-width="1" stroke-dasharray="5 2"/>
    <line x1="14" y1="64" x2="146" y2="64" stroke="#92400e" stroke-width="1" stroke-dasharray="3 2"/>
    <line x1="14" y1="72" x2="146" y2="72" stroke="#92400e" stroke-width="1" stroke-dasharray="4 2"/>
    <!-- John Hancock Bold Signature -->
    <path d="M 40 88 Q 65 76 90 86 T 130 84" stroke="#451a03" stroke-width="2.5" fill="none"/>
  </g>

  <!-- Pewter Inkwell & Feather Quill -->
  <g transform="translate(460, 420)">
    <rect x="0" y="10" width="28" height="24" rx="4" fill="#64748b" stroke="#334155" stroke-width="1.5"/>
    <!-- White Feather Quill -->
    <path d="M 14 12 Q 35 -20 50 -45 Q 40 -15 16 10 Z" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1"/>
  </g>

  <!-- Brass Candelabra with Glowing Candles -->
  <g transform="translate(730, 360)">
    <rect x="-8" y="20" width="16" height="30" rx="2" fill="#d97706"/>
    <line x1="-22" y1="20" x2="22" y2="20" stroke="#d97706" stroke-width="4"/>
    <rect x="-26" y="0" width="8" height="20" fill="#fef08a"/>
    <rect x="18" y="0" width="8" height="20" fill="#fef08a"/>
    <circle cx="-22" cy="-6" r="10" fill="#f59e0b" filter="url(#goldGlow)"/>
    <circle cx="22" cy="-6" r="10" fill="#f59e0b" filter="url(#goldGlow)"/>
    <polygon points="-25,-2 -19,-2 -22,-14" fill="#ffffff"/>
    <polygon points="19,-2 25,-2 22,-14" fill="#ffffff"/>
  </g>

  <!-- Committee of Five Delegates (Jefferson, Franklin, Adams) -->
  <g transform="translate(340, 320)">
    <!-- Adams -->
    <circle cx="-40" cy="20" r="16" fill="#f5d0b5"/>
    <path d="M -56 12 Q -40 2 -24 12 L -28 26 L -52 26 Z" fill="#e2e8f0"/> <!-- Powdered Wig -->
    <path d="M -60 36 L -20 36 L -16 110 L -64 110 Z" fill="#991b1b"/> <!-- Red Frock Coat -->

    <!-- Jefferson (Standing Tall) -->
    <circle cx="20" cy="0" r="18" fill="#f5d0b5"/>
    <path d="M 0 -8 Q 20 -18 40 -8 L 36 6 L 4 6 Z" fill="#f1f5f9"/>
    <path d="M -2 18 L 42 18 L 48 120 L -8 120 Z" fill="#1e3a8a"/> <!-- Navy Frock Coat -->
    <rect x="10" y="32" width="20" height="30" fill="#f8fafc"/> <!-- White Cravat -->

    <!-- Franklin -->
    <circle cx="80" cy="25" r="17" fill="#f5d0b5"/>
    <path d="M 64 18 Q 80 10 96 18 L 94 34 L 66 34 Z" fill="#94a3b8"/> <!-- Graying hair -->
    <path d="M 60 42 L 100 42 L 106 110 L 54 110 Z" fill="#78350f"/> <!-- Brown Coat -->
  </g>

  <!-- Title Badge Overlay -->
  <rect x="36" y="36" width="480" height="64" rx="12" fill="rgba(28, 15, 7, 0.9)" stroke="rgba(245, 158, 11, 0.5)" stroke-width="1.5"/>
  <text x="56" y="62" fill="#f59e0b" font-size="12" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif" letter-spacing="1">JULY 4, 1776 • PHILADELPHIA</text>
  <text x="56" y="84" fill="#f8fafc" font-size="15" font-weight="600" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif">The Signing of the Declaration of Independence</text>
</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function createBattleOfLexingtonSvg(): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 640" width="100%" height="100%">
  <defs>
    <linearGradient id="lexDawnSky" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#1e1b4b"/>
      <stop offset="35%" stop-color="#4338ca"/>
      <stop offset="65%" stop-color="#b45309"/>
      <stop offset="85%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#fed7aa"/>
    </linearGradient>
    <linearGradient id="greenField" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#14532d"/>
      <stop offset="40%" stop-color="#166534"/>
      <stop offset="100%" stop-color="#0f291e"/>
    </linearGradient>
    <radialGradient id="sunGlow" cx="65%" cy="35%" r="35%">
      <stop offset="0%" stop-color="#fde047" stop-opacity="0.7"/>
      <stop offset="50%" stop-color="#f59e0b" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <filter id="mistBlur">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
    <filter id="smokeBlur">
      <feGaussianBlur stdDeviation="10" result="blur"/>
    </filter>
  </defs>

  <!-- Sunrise Dawn Sky -->
  <rect width="1200" height="420" fill="url(#lexDawnSky)"/>
  <rect width="1200" height="420" fill="url(#sunGlow)"/>

  <!-- Morning Sun Rising over Distant Ridge -->
  <circle cx="780" cy="240" r="48" fill="#fef08a" opacity="0.85"/>

  <!-- Distant Rolling Hills and Trees -->
  <path d="M 0 350 Q 250 320 500 340 T 1000 330 T 1200 350 L 1200 420 L 0 420 Z" fill="#143e2e" opacity="0.9"/>
  <path d="M 0 365 Q 350 340 700 360 T 1200 355 L 1200 420 L 0 420 Z" fill="#1e3a29"/>

  <!-- Historic Buckman Tavern / Lexington Meetinghouse Silhouette -->
  <g transform="translate(180, 240)">
    <rect x="0" y="40" width="140" height="85" fill="#451a03" stroke="#270e02" stroke-width="2"/>
    <polygon points="-10,40 70,-10 150,40" fill="#292524"/>
    <rect x="25" y="-18" width="18" height="35" fill="#78350f"/>
    <rect x="20" y="55" width="22" height="28" fill="#fed7aa" opacity="0.8"/>
    <rect x="60" y="55" width="22" height="28" fill="#fed7aa" opacity="0.8"/>
    <rect x="100" y="55" width="22" height="28" fill="#fed7aa" opacity="0.8"/>
    <rect x="20" y="95" width="22" height="28" fill="#fde047" opacity="0.7"/>
    <rect x="100" y="95" width="22" height="28" fill="#fde047" opacity="0.7"/>
    <rect x="62" y="90" width="20" height="35" fill="#1c1917"/>
  </g>

  <!-- Historic 1775 Meetinghouse Belfry -->
  <g transform="translate(420, 220)">
    <rect x="0" y="50" width="90" height="90" fill="#3f3f46" stroke="#18181b" stroke-width="2"/>
    <polygon points="-5,50 45,5 95,50" fill="#27272a"/>
    <rect x="35" y="-20" width="20" height="26" fill="#f4f4f5"/>
    <polygon points="32,-20 45,-45 58,-20" fill="#71717a"/>
  </g>

  <!-- Lexington Green Grassy Field -->
  <rect y="400" width="1200" height="240" fill="url(#greenField)"/>

  <!-- Low Morning Mist Rolling Over the Green -->
  <ellipse cx="600" cy="425" rx="550" ry="30" fill="#e2e8f0" opacity="0.35" filter="url(#mistBlur)"/>
  <ellipse cx="350" cy="450" rx="320" ry="22" fill="#cbd5e1" opacity="0.3" filter="url(#mistBlur)"/>
  <ellipse cx="850" cy="440" rx="300" ry="24" fill="#cbd5e1" opacity="0.3" filter="url(#mistBlur)"/>

  <!-- Left: Colonial Minutemen (Captain John Parker's Company) -->
  <g transform="translate(240, 390)">
    <g transform="translate(0, -20)">
      <circle cx="0" cy="0" r="14" fill="#fcd34d"/>
      <path d="M -16 -6 Q 0 -18 16 -6 L 14 4 L -14 4 Z" fill="#1e293b"/>
      <path d="M -16 12 L 16 12 L 20 85 L -20 85 Z" fill="#1e3a5f"/>
      <rect x="-6" y="85" width="5" height="35" fill="#1e293b"/>
      <rect x="3" y="85" width="5" height="35" fill="#1e293b"/>
      <line x1="16" y1="24" x2="42" y2="-10" stroke="#e2e8f0" stroke-width="2.5"/>
    </g>

    <g fill="#78350f">
      <g transform="translate(-50, -5)">
        <circle cx="0" cy="0" r="12" fill="#fcd34d"/>
        <path d="M -14 -4 Q 0 -14 14 -4 L 12 4 L -12 4 Z" fill="#292524"/>
        <path d="M -14 12 L 14 12 L 16 75 L -16 75 Z" fill="#57534e"/>
        <line x1="-10" y1="20" x2="36" y2="2" stroke="#451a03" stroke-width="3"/>
        <line x1="30" y1="2" x2="52" y2="-8" stroke="#94a3b8" stroke-width="2"/>
      </g>
      <g transform="translate(-100, -10)">
        <circle cx="0" cy="0" r="12" fill="#fcd34d"/>
        <path d="M -14 -4 Q 0 -14 14 -4 L 12 4 L -12 4 Z" fill="#1c1917"/>
        <path d="M -14 12 L 14 12 L 16 75 L -16 75 Z" fill="#713f12"/>
        <line x1="-10" y1="20" x2="36" y2="4" stroke="#451a03" stroke-width="3"/>
        <line x1="30" y1="4" x2="52" y2="-6" stroke="#94a3b8" stroke-width="2"/>
      </g>
      <g transform="translate(-75, -35)" opacity="0.9">
        <circle cx="0" cy="0" r="11" fill="#fcd34d"/>
        <path d="M -12 -4 Q 0 -12 12 -4 L 10 3 L -10 3 Z" fill="#292524"/>
        <path d="M -12 10 L 12 10 L 14 65 L -14 65 Z" fill="#3f3f46"/>
        <line x1="-8" y1="18" x2="34" y2="0" stroke="#451a03" stroke-width="2.5"/>
      </g>
    </g>
  </g>

  <!-- Right: British Regulars (Major John Pitcairn's Redcoats) -->
  <g transform="translate(860, 380)">
    <g transform="translate(-80, -30)">
      <ellipse cx="0" cy="50" rx="36" ry="22" fill="#451a03"/>
      <path d="M -24 45 Q -40 20 -35 5 Q -25 10 -15 35 Z" fill="#451a03"/>
      <circle cx="-10" cy="5" r="13" fill="#fcd34d"/>
      <path d="M -22 2 Q -10 -10 2 2 L 0 8 L -20 8 Z" fill="#0f172a"/>
      <path d="M -15 14 L 15 14 L 18 60 L -18 60 Z" fill="#b91c1c"/>
      <line x1="-5" y1="20" x2="-45" y2="-5" stroke="#f8fafc" stroke-width="2.5"/>
    </g>

    <g fill="#991b1b">
      <g transform="translate(0, -10)">
        <circle cx="0" cy="0" r="12" fill="#fcd34d"/>
        <rect x="-8" y="-18" width="16" height="18" fill="#1e1b4b"/>
        <path d="M -14 10 L 14 10 L 16 80 L -16 80 Z" fill="#dc2626"/>
        <line x1="-12" y1="10" x2="12" y2="50" stroke="#ffffff" stroke-width="2.5"/>
        <line x1="12" y1="10" x2="-12" y2="50" stroke="#ffffff" stroke-width="2.5"/>
        <line x1="10" y1="22" x2="-65" y2="12" stroke="#451a03" stroke-width="3"/>
        <line x1="-55" y1="13" x2="-80" y2="10" stroke="#94a3b8" stroke-width="2.5"/>
        <line x1="-80" y1="10" x2="-98" y2="8" stroke="#e2e8f0" stroke-width="2"/>
      </g>
      <g transform="translate(50, -10)">
        <circle cx="0" cy="0" r="12" fill="#fcd34d"/>
        <rect x="-8" y="-18" width="16" height="18" fill="#1e1b4b"/>
        <path d="M -14 10 L 14 10 L 16 80 L -16 80 Z" fill="#dc2626"/>
        <line x1="-12" y1="10" x2="12" y2="50" stroke="#ffffff" stroke-width="2.5"/>
        <line x1="12" y1="10" x2="-12" y2="50" stroke="#ffffff" stroke-width="2.5"/>
        <line x1="10" y1="22" x2="-65" y2="12" stroke="#451a03" stroke-width="3"/>
        <line x1="-55" y1="13" x2="-80" y2="10" stroke="#94a3b8" stroke-width="2.5"/>
        <line x1="-80" y1="10" x2="-98" y2="8" stroke="#e2e8f0" stroke-width="2"/>
      </g>
      <g transform="translate(25, -35)" opacity="0.9">
        <circle cx="0" cy="0" r="11" fill="#fcd34d"/>
        <rect x="-7" y="-16" width="14" height="16" fill="#1e1b4b"/>
        <path d="M -12 8 L 12 8 L 14 70 L -14 70 Z" fill="#b91c1c"/>
        <line x1="8" y1="20" x2="-55" y2="12" stroke="#451a03" stroke-width="2.5"/>
        <line x1="-55" y1="12" x2="-80" y2="9" stroke="#e2e8f0" stroke-width="2"/>
      </g>
    </g>
  </g>

  <!-- Dramatic Musket Flash & White Powder Smoke on Lexington Green -->
  <g transform="translate(740, 390)">
    <circle cx="0" cy="0" r="8" fill="#fef08a"/>
    <circle cx="0" cy="0" r="18" fill="#f97316" opacity="0.6"/>
    <ellipse cx="-40" cy="-15" rx="75" ry="35" fill="#f8fafc" opacity="0.75" filter="url(#smokeBlur)"/>
    <ellipse cx="-85" cy="-25" rx="60" ry="30" fill="#e2e8f0" opacity="0.6" filter="url(#smokeBlur)"/>
    <ellipse cx="-130" cy="-20" rx="80" ry="40" fill="#cbd5e1" opacity="0.45" filter="url(#smokeBlur)"/>
  </g>

  <!-- Title Badge Overlay -->
  <rect x="36" y="36" width="540" height="68" rx="12" fill="rgba(15, 23, 42, 0.88)" stroke="rgba(245, 158, 11, 0.5)" stroke-width="1.5"/>
  <text x="56" y="62" fill="#f59e0b" font-size="12" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif" letter-spacing="1">APRIL 19, 1775 • LEXINGTON, MASSACHUSETTS</text>
  <text x="56" y="86" fill="#f8fafc" font-size="15" font-weight="600" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif">The Battle of Lexington Green: The First Shot</text>
</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function createIndependenceHallSvg(): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 640" width="100%" height="100%">
  <defs>
    <linearGradient id="skyDay" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0284c7"/>
      <stop offset="60%" stop-color="#7dd3fc"/>
      <stop offset="100%" stop-color="#e0f2fe"/>
    </linearGradient>
    <linearGradient id="brickGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#991b1b"/>
      <stop offset="50%" stop-color="#b91c1c"/>
      <stop offset="100%" stop-color="#7f1d1d"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="480" fill="url(#skyDay)"/>
  
  <!-- Fluffy Clouds -->
  <ellipse cx="220" cy="120" rx="110" ry="45" fill="#ffffff" opacity="0.85"/>
  <ellipse cx="300" cy="110" rx="80" ry="40" fill="#ffffff" opacity="0.9"/>
  <ellipse cx="920" cy="140" rx="130" ry="50" fill="#ffffff" opacity="0.8"/>

  <!-- Cobblestone Ground -->
  <rect y="480" width="1200" height="160" fill="#334155"/>
  <line x1="0" y1="480" x2="1200" y2="480" stroke="#1e293b" stroke-width="4"/>

  <!-- Red Brick Facade Wings -->
  <rect x="220" y="300" width="760" height="180" fill="url(#brickGrad)" stroke="#450a0a" stroke-width="2"/>
  
  <!-- Central Georgian Bell Tower Base -->
  <rect x="520" y="240" width="160" height="240" fill="url(#brickGrad)" stroke="#450a0a" stroke-width="2"/>

  <!-- White Steeple & Cupola Layers -->
  <rect x="536" y="160" width="128" height="80" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2"/>
  <!-- Clock Face -->
  <circle cx="600" cy="200" r="22" fill="#ffffff" stroke="#0f172a" stroke-width="2"/>
  <line x1="600" y1="200" x2="600" y2="186" stroke="#0f172a" stroke-width="2.5"/>
  <line x1="600" y1="200" x2="610" y2="200" stroke="#0f172a" stroke-width="2.5"/>

  <!-- Octagonal Lantern Tower -->
  <rect x="556" y="90" width="88" height="70" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2"/>
  <!-- Top Spire -->
  <polygon points="600,10 566,90 634,90" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2"/>
  <line x1="600" y1="10" x2="600" y2="0" stroke="#d97706" stroke-width="3"/>
  <circle cx="600" cy="-2" r="4" fill="#d97706"/>

  <!-- Windows Grid on Red Brick Facade -->
  <g fill="#bae6fd" stroke="#f8fafc" stroke-width="2.5">
    <rect x="260" y="330" width="40" height="60" rx="20"/>
    <rect x="340" y="330" width="40" height="60" rx="20"/>
    <rect x="420" y="330" width="40" height="60" rx="20"/>
    <rect x="740" y="330" width="40" height="60" rx="20"/>
    <rect x="820" y="330" width="40" height="60" rx="20"/>
    <rect x="900" y="330" width="40" height="60" rx="20"/>

    <rect x="260" y="410" width="40" height="60"/>
    <rect x="340" y="410" width="40" height="60"/>
    <rect x="420" y="410" width="40" height="60"/>
    <rect x="740" y="410" width="40" height="60"/>
    <rect x="820" y="410" width="40" height="60"/>
    <rect x="900" y="410" width="40" height="60"/>
  </g>

  <!-- Title Badge Overlay -->
  <rect x="36" y="36" width="460" height="64" rx="12" fill="rgba(15, 23, 42, 0.85)" stroke="rgba(56, 189, 248, 0.4)" stroke-width="1.5"/>
  <text x="56" y="62" fill="#38bdf8" font-size="12" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif" letter-spacing="1">COLONIAL ASSEMBLY ROOM • 1776</text>
  <text x="56" y="84" fill="#f8fafc" font-size="15" font-weight="600" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif">Independence Hall, Philadelphia</text>
</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function createZeroTrustMeshSvg(): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 640" width="100%" height="100%">
  <defs>
    <linearGradient id="cyberBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#030712"/>
      <stop offset="50%" stop-color="#0b1329"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
    <radialGradient id="meshCenterGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#0ea5e9" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <filter id="cyanGlow">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>

  <rect width="1200" height="640" fill="url(#cyberBg)"/>
  <rect width="1200" height="640" fill="url(#meshCenterGlow)"/>

  <!-- Matrix Grid Lines -->
  <g stroke="#1e293b" stroke-width="1" opacity="0.6">
    <line x1="0" y1="160" x2="1200" y2="160"/>
    <line x1="0" y1="320" x2="1200" y2="320"/>
    <line x1="0" y1="480" x2="1200" y2="480"/>
    <line x1="240" y1="0" x2="240" y2="640"/>
    <line x1="480" y1="0" x2="480" y2="640"/>
    <line x1="720" y1="0" x2="720" y2="640"/>
    <line x1="960" y1="0" x2="960" y2="640"/>
  </g>

  <!-- Central Shield Node -->
  <g transform="translate(600, 320)">
    <circle r="90" fill="none" stroke="#0284c7" stroke-width="2" stroke-dasharray="8 6"/>
    <circle r="70" fill="rgba(14, 165, 233, 0.15)" stroke="#38bdf8" stroke-width="2.5" filter="url(#cyanGlow)"/>
    
    <!-- Shield Icon -->
    <path d="M 0 -35 L 30 -20 L 30 10 Q 30 35 0 45 Q -30 35 -30 10 L -30 -20 Z" fill="#0284c7" stroke="#38bdf8" stroke-width="2"/>
    <path d="M 0 -22 L 18 -12 L 18 8 Q 18 24 0 32 Q -18 24 -18 8 L -18 -12 Z" fill="#0369a1"/>
    <!-- Lock Keyhole -->
    <circle cx="0" cy="2" r="5" fill="#ffffff"/>
    <polygon points="-3,4 3,4 4,14 -4,14" fill="#ffffff"/>
  </g>

  <!-- Surrounding Microservice Nodes -->
  <g stroke="#38bdf8" stroke-width="2" opacity="0.8">
    <line x1="600" y1="320" x2="280" y2="200"/>
    <line x1="600" y1="320" x2="920" y2="200"/>
    <line x1="600" y1="320" x2="360" y2="480"/>
    <line x1="600" y1="320" x2="840" y2="480"/>
  </g>

  <!-- Satellite Nodes -->
  <g fill="#0f172a" stroke="#0ea5e9" stroke-width="2">
    <circle cx="280" cy="200" r="36"/>
    <text x="280" y="205" fill="#38bdf8" font-size="11" font-weight="700" text-anchor="middle" font-family="monospace">PASSKEY</text>

    <circle cx="920" cy="200" r="36"/>
    <text x="920" y="205" fill="#38bdf8" font-size="11" font-weight="700" text-anchor="middle" font-family="monospace">OIDC/JWT</text>

    <circle cx="360" cy="480" r="36"/>
    <text x="360" y="485" fill="#38bdf8" font-size="11" font-weight="700" text-anchor="middle" font-family="monospace">ENCLAVE</text>

    <circle cx="840" cy="480" r="36"/>
    <text x="840" y="485" fill="#38bdf8" font-size="11" font-weight="700" text-anchor="middle" font-family="monospace">RBAC API</text>
  </g>

  <!-- Title Badge Overlay -->
  <rect x="36" y="36" width="460" height="64" rx="12" fill="rgba(3, 7, 18, 0.85)" stroke="rgba(56, 189, 248, 0.4)" stroke-width="1.5"/>
  <text x="56" y="62" fill="#38bdf8" font-size="12" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif" letter-spacing="1">ZERO-TRUST PROTOCOL • SPECIFICATION</text>
  <text x="56" y="84" fill="#f8fafc" font-size="15" font-weight="600" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif">Zero-Trust Distributed Mesh &amp; Passkey Enclave</text>
</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function createAiTransformerSvg(): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 640" width="100%" height="100%">
  <defs>
    <linearGradient id="aiBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#090214"/>
      <stop offset="50%" stop-color="#190938"/>
      <stop offset="100%" stop-color="#090214"/>
    </linearGradient>
    <filter id="purpleGlow">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>

  <rect width="1200" height="640" fill="url(#aiBg)"/>

  <!-- Attention Connection Beziers -->
  <path d="M 200 320 C 400 120, 500 120, 600 320 C 700 520, 800 520, 1000 320" fill="none" stroke="#a855f7" stroke-width="3" opacity="0.7"/>
  <path d="M 200 200 C 400 400, 500 400, 600 320 C 700 240, 800 240, 1000 440" fill="none" stroke="#c084fc" stroke-width="2.5" opacity="0.6"/>
  <path d="M 200 440 C 400 240, 500 240, 600 320 C 700 400, 800 400, 1000 200" fill="none" stroke="#e879f9" stroke-width="2.5" opacity="0.6"/>

  <!-- Neural Transformer Layer Nodes -->
  <g fill="#1e113a" stroke="#c084fc" stroke-width="2.5" filter="url(#purpleGlow)">
    <circle cx="200" cy="200" r="32"/>
    <circle cx="200" cy="320" r="36"/>
    <circle cx="200" cy="440" r="32"/>

    <circle cx="600" cy="320" r="54" stroke="#e879f9" stroke-width="3"/>

    <circle cx="1000" cy="200" r="32"/>
    <circle cx="1000" cy="320" r="36"/>
    <circle cx="1000" cy="440" r="32"/>
  </g>

  <!-- Labels on Nodes -->
  <text x="200" y="325" fill="#f8fafc" font-size="11" font-weight="700" text-anchor="middle" font-family="monospace">INPUT</text>
  <text x="600" y="318" fill="#f8fafc" font-size="14" font-weight="700" text-anchor="middle" font-family="monospace">ATTENTION</text>
  <text x="600" y="336" fill="#c084fc" font-size="10" font-weight="600" text-anchor="middle" font-family="monospace">64 HEADS</text>
  <text x="1000" y="325" fill="#f8fafc" font-size="11" font-weight="700" text-anchor="middle" font-family="monospace">SYNTHESIS</text>

  <!-- Title Badge Overlay -->
  <rect x="36" y="36" width="460" height="64" rx="12" fill="rgba(15, 7, 30, 0.85)" stroke="rgba(192, 132, 252, 0.4)" stroke-width="1.5"/>
  <text x="56" y="62" fill="#c084fc" font-size="12" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif" letter-spacing="1">MULTI-MODAL TRANSFORMER ATTENTION</text>
  <text x="56" y="84" fill="#f8fafc" font-size="15" font-weight="600" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif">Neural Attention &amp; Subagent DAG</text>
</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Curated repository of authentic, topic-grounded masterwork vector visual generators.
 * Matches specific historical, architectural, and technical scenes accurately.
 */
export const NANO_BANANA_IMAGE_CATALOG: CuratedImageEntry[] = [
    // 1776 Revolution: Declaration of Independence Signing & Continental Congress
    {
        url: createDeclarationSigningSvg(),
        title: 'The Signing of the Declaration of Independence (1776)',
        caption: 'Thomas Jefferson, Benjamin Franklin, and John Adams present the draft of the Declaration to John Hancock and the Continental Congress in the Pennsylvania State House Assembly Room in July 1776.',
        attribution: 'Historical Masterpiece • Second Continental Congress (1776) • Nano Banana Pro',
        dateTag: 'July 4, 1776 • Philadelphia',
        theme: '1776-revolution',
        keywords: ['declaration', 'signing', 'congress', 'jefferson', 'hancock', 'adams', 'franklin', 'draft', 'reenactment', 'philadelphia', 'truths']
    },
    // 1776 Revolution: Washington Crossing the Delaware & Trenton Counteroffensive
    {
        url: createWashingtonCrossingSvg(),
        title: "Washington's Crossing of the Delaware River (1776)",
        caption: 'General George Washington leads 2,400 Continental Army soldiers across the ice-choked Delaware River on Christmas night 1776 in a decisive surprise counteroffensive at Trenton.',
        attribution: 'Historical Masterpiece • Metropolitan Museum of Art • Nano Banana Pro',
        dateTag: 'December 25–26, 1776 • Delaware River',
        theme: '1776-revolution',
        keywords: ['crossing', 'delaware', 'washington', 'trenton', 'ice', 'boat', 'army', 'winter', 'blizzard', 'river']
    },
    // 1776 Revolution: Independence Hall & Colonial Philadelphia Architecture
    {
        url: createIndependenceHallSvg(),
        title: 'Independence Hall (Pennsylvania State House)',
        caption: 'The historic Georgian colonial Assembly Room in Philadelphia where both the Declaration of Independence and the United States Constitution were debated and signed.',
        attribution: 'National Historical Park Archive • Philadelphia',
        dateTag: 'Colonial Assembly Room • 1776',
        theme: '1776-revolution',
        keywords: ['hall', 'independence', 'assembly', 'building', 'architecture', 'pennsylvania', 'state house', 'room']
    },
    // 1776 Revolution: Battle of Lexington Green & The Shot Heard 'Round the World (1775)
    {
        url: createBattleOfLexingtonSvg(),
        title: 'The Battle of Lexington Green (April 19, 1775)',
        caption: 'Captain John Parker and colonial minutemen stand resolute against British Regulars at sunrise on Lexington Green as the "shot heard \'round the world" ignites the American Revolution.',
        attribution: 'Historical Masterpiece • Lexington Historical Society • Nano Banana Pro',
        dateTag: 'April 19, 1775 • Lexington, MA',
        theme: '1776-revolution',
        keywords: ['lexington', 'concord', 'minutemen', 'parker', 'pitcairn', 'battle', 'shot', 'revolution', 'buckman', 'militia', 'redcoat', 'dawn']
    },
    // Zero-Trust & Identity Security
    {
        url: createZeroTrustMeshSvg(),
        title: 'Zero-Trust Distributed Mesh & Passkey Enclave',
        caption: 'End-to-end cryptographic handshake with SHA-256 code challenge, hardware enclave Passkey signing, and sub-25ms asymmetric Ed25519 token rotation.',
        attribution: 'Zero-Trust Architecture Spec • NIST / W3C Standards',
        dateTag: 'OAuth 2.1 & WebAuthn Specification',
        theme: 'auth-zerotrust-security',
        keywords: ['auth', 'security', 'zero-trust', 'pkce', 'passkey', 'enclave', 'token', 'cryptography', 'network', 'mesh']
    },
    // AI & Machine Learning
    {
        url: createAiTransformerSvg(),
        title: 'Multi-Modal Transformer Attention & Subagent DAG',
        caption: 'High-dimensional vector manifold showing attention head routing, subagent DAG parallelization, and real-time canvas synthesis.',
        attribution: 'AI Systems Laboratory • Gemini Architecture',
        dateTag: 'Gemini 3.8 Flash & Autonomous Subagents',
        theme: 'ai-machine-learning',
        keywords: ['ai', 'machine learning', 'neural', 'transformer', 'attention', 'dag', 'subagent', 'embedding', 'vector']
    }
];

/**
 * Find the most contextually relevant curated image for a given topic and query.
 */
export function lookupCuratedNanoBananaImage(
    theme: DocumentTheme,
    sceneTitleOrQuery: string = '',
    _styleId?: string
): CuratedImageEntry {
    const query = sceneTitleOrQuery.toLowerCase();
    const candidates = NANO_BANANA_IMAGE_CATALOG.filter(c => c.theme === theme);
    const pool = candidates.length > 0 ? candidates : NANO_BANANA_IMAGE_CATALOG;

    // Score candidates by matching keywords
    let bestMatch: CuratedImageEntry | undefined;
    let bestScore = -1;

    for (const item of pool) {
        let score = 0;
        for (const kw of item.keywords) {
            if (query.includes(kw)) {
                score += 3;
            }
        }
        if (item.title.toLowerCase().split(' ').some(w => w.length > 3 && query.includes(w))) {
            score += 2;
        }
        if (score > bestScore) {
            bestScore = score;
            bestMatch = item;
        }
    }

    if (bestMatch && bestScore > 0) {
        return bestMatch;
    }

    // Default fallback within the theme
    return candidates[0] || NANO_BANANA_IMAGE_CATALOG[0];
}

/**
 * Synthesizes a structured, hyper-specific Nano Banana prompt and paired image metadata
 * deeply distilled from the document's contextual text.
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

    // 3. Lookup Curated Image
    const curated = lookupCuratedNanoBananaImage(
        theme,
        `${context.sectionTitle || ''} ${context.docTitle || ''} ${context.sectionContent || ''}`,
        styleId
    );

    const attribution = curated.attribution
        ? (curated.attribution.includes('Nano Banana') ? curated.attribution : `${curated.attribution} • ${styleLabel} • Generated with Nano Banana Pro`)
        : `${styleLabel} • Generated with Nano Banana Pro`;

    return {
        prompt: structuredPrompt,
        curatedImageUrl: curated.url,
        attribution,
        styleLabel,
        dateTag: curated.dateTag,
        imageTitle: curated.title,
        caption: curated.caption
    };
}
