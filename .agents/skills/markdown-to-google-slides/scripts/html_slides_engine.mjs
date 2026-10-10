#!/usr/bin/env node
/**
 * html_slides_engine.mjs
 * Generates a self-contained, zero-dependency, fixed 1920x1080 HTML/CSS presentation deck
 * Inspired by @zarazhangrui/frontend-slides architecture.
 */

import fs from 'node:fs';
import path from 'node:path';

export const EDITORIAL_FONT_PAIRINGS = {
  'high-fashion': {
    name: 'High-Fashion & Culture',
    display: "'Bodoni Moda', 'Newsreader', serif",
    displayStyle: 'italic',
    body: "'Plus Jakarta Sans', sans-serif",
    mono: "'JetBrains Mono', monospace",
    titleTracking: '-0.02em',
    kickerTracking: '3.5px',
  },
  'brutalist-scale': {
    name: 'Brutalist Scale-Contrast',
    display: "'Syne', sans-serif",
    displayStyle: 'normal',
    body: "'Source Serif 4', serif",
    mono: "'Space Grotesk', monospace",
    titleTracking: '-0.04em',
    kickerTracking: '4px',
  },
  'intellectual-editorial': {
    name: 'Intellectual / Editorial Warmth',
    display: "'Newsreader', serif",
    displayStyle: 'italic',
    body: "'Plus Jakarta Sans', sans-serif",
    mono: "'JetBrains Mono', monospace",
    titleTracking: '-0.02em',
    kickerTracking: '3px',
  },
  'technical-vanguard': {
    name: 'Technical Vanguard',
    display: "'Instrument Sans', sans-serif",
    displayStyle: 'normal',
    body: "'Instrument Sans', sans-serif",
    mono: "'JetBrains Mono', monospace",
    titleTracking: '-0.02em',
    kickerTracking: '3px',
  },
  'modern-grotesk': {
    name: 'Modern Neo-Grotesk',
    display: "'Plus Jakarta Sans', sans-serif",
    displayStyle: 'normal',
    body: "'Plus Jakarta Sans', sans-serif",
    mono: "'JetBrains Mono', monospace",
    titleTracking: '-0.03em',
    kickerTracking: '2.5px',
  },
};

export function generateHtmlDeck({ title, slides, palette, outputPath, frontmatter = {}, options = {} }) {
  const brandName = palette.name || frontmatter.brand || options.brand || 'Brand Presentation';
  const directorName = options.director || frontmatter.director || 'ELI GREEN';
  const agencyName = options.agency || frontmatter.agency || 'DESIGN LABS';
  const clientName = options.brand || frontmatter.brand || options.client || frontmatter.client || brandName;
  const studioName = options.studio || frontmatter.studio || 'SCRATCHBOX STUDIO';
  const footerBrand = (options.brand || frontmatter.brand || brandName || '').toUpperCase();
  const footerTitle = (options.title || frontmatter.title || title || '').toUpperCase();
  const footerText = [footerBrand, footerTitle].filter(Boolean).join(' // ') || 'PRESENTATION DECK';

  const fontPairingKey = (options.fontPairing || frontmatter.font_pairing || frontmatter.fontPairing || 'high-fashion').toLowerCase().trim();
  const pairing = EDITORIAL_FONT_PAIRINGS[fontPairingKey] || EDITORIAL_FONT_PAIRINGS['high-fashion'];

  const rawRatio = options.ratio || options.aspectRatio || frontmatter.aspect_ratio || frontmatter.ratio || '16:9';
  const is21x9 = rawRatio === '21:9' || rawRatio === '2.37:1' || rawRatio === 'ultrawide';
  const stageW = is21x9 ? 2560 : 1920;
  const stageH = 1080;

  const bg = '#' + palette.slideBg.replace('#', '');
  const titleColor = '#' + palette.titleColor.replace('#', '');
  const subtitleColor = '#' + palette.subtitleColor.replace('#', '');
  const textColor = '#' + palette.textColor.replace('#', '');
  const accent = '#' + palette.accentColor.replace('#', '');
  const secondaryAccent = '#' + palette.secondaryAccent.replace('#', '');
  const cardBg = 'rgba(15, 23, 42, 0.75)';
  const cardBorder = 'rgba(255, 255, 255, 0.12)';

  const slidesHtml = slides.map((s, idx) => {
    const isFirst = idx === 0;
    const slideNumber = idx + 1;
    const titleText = s.title && !s.title.toLowerCase().includes('directors_treatment')
      ? s.title
      : (s.headline || `Key Insight ${slideNumber}`);

    // Determine layout
    const hasImages = s.images && s.images.length > 0;
    const imgCount = s.images ? s.images.length : 0;

    let innerContent = '';

    const slideHeaderHtml = `
      <div class="slide-header">
        <div class="kicker-tag">${formatMarkdownHtml(s.kicker || (s.subtitle && s.title.length < 30 ? s.subtitle.toUpperCase() : `${footerBrand} // EXECUTIVE PERSPECTIVE`))}</div>
        <h2 class="slide-title">${formatMarkdownHtml(titleText)}</h2>
        ${s.subtitle ? `<p class="slide-subtitle">${formatMarkdownHtml(s.subtitle)}</p>` : ''}
        <div class="accent-bar"></div>
      </div>
    `;

    if (isFirst) {
      // Hero opener slide
      const heroImg = hasImages ? s.images[0].url.replace('file://', '') : '';
      innerContent = `
        <div class="hero-slide ${heroImg ? 'has-bg' : ''}">
          ${heroImg ? `<img src="${heroImg}" class="hero-bg-img" alt="Cover"/>` : ''}
          <div class="hero-scrim"></div>
          <div class="hero-content">
            <div class="kicker-badge">${palette.kicker || 'DIRECTOR’S TREATMENT & PREVIS'}</div>
            <h1 class="hero-title">${formatMarkdownHtml(titleText)}</h1>
            ${s.subtitle ? `<p class="hero-subtitle">${formatMarkdownHtml(s.subtitle)}</p>` : ''}
            <div class="hero-meta">
              <span>Prepared for: <strong>${clientName}</strong></span>
              <span>Director: <strong>${directorName}</strong></span>
              <span>Production: <strong>${studioName}</strong></span>
            </div>
          </div>
        </div>
      `;
    } else if (hasImages && imgCount === 1) {
      // Split layout: Text left (cards), Media right
      const imgPath = s.images[0].url.replace('file://', '');
      innerContent = `
        <div class="split-layout">
          <div class="split-left">
            ${slideHeaderHtml}
            <div class="content-cards">
              ${renderTextCards(s, textColor, accent)}
            </div>
          </div>
          <div class="split-right">
            <div class="media-container ${imgPath.endsWith('.gif') ? 'is-gif' : ''}">
              <img src="${imgPath}" alt="${titleText}" class="main-media" />
              ${s.imageCaption ? `<div class="media-caption">${s.imageCaption}</div>` : ''}
            </div>
          </div>
        </div>
      `;
    } else if (hasImages && imgCount > 1) {
      // Grid layout: Text left or top, multi-image grid
      const gridCols = imgCount >= 4 ? 2 : (imgCount === 2 ? 2 : 3);
      innerContent = `
        <div class="grid-slide-layout">
          ${slideHeaderHtml}
          <div class="grid-content-split">
            <div class="grid-text-pane">
              ${renderTextCards(s, textColor, accent)}
            </div>
            <div class="media-grid cols-${gridCols}">
              ${s.images.slice(0, 4).map((img, i) => `
                <div class="grid-item">
                  <img src="${img.url.replace('file://', '')}" alt="Beat ${i+1}" />
                  ${img.caption ? `<span class="img-label">${img.caption}</span>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `;
    } else if (s.table && s.table.length > 0) {
      // Table slide
      innerContent = `
        <div class="table-slide-layout">
          ${slideHeaderHtml}
          <div class="table-container">
            ${renderHtmlTable(s.table)}
          </div>
        </div>
      `;
    } else {
      // Clean Executive Card Layout (no images)
      innerContent = `
        <div class="full-content-layout">
          ${slideHeaderHtml}
          <div class="cards-row">
            ${renderThreeCards(s, textColor, accent)}
          </div>
        </div>
      `;
    }

    return `
      <section class="slide ${isFirst ? 'active' : ''}" id="slide-${slideNumber}" data-slide="${slideNumber}">
        <div class="stage-frame">
          ${innerContent}
        </div>
        <div class="slide-footer">
          <div class="footer-left">${footerText}</div>
          <div class="footer-right">${slideNumber} / ${slides.length}</div>
        </div>
      </section>
    `;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | Interactive Presentation</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400..900;1,6..96,400..900&family=Instrument+Sans:wght@400;600;700&family=JetBrains+Mono:wght@400;500;700&family=Newsreader:ital,opsz,wght@0,6..72,400..800;1,6..72,400..800&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Source+Serif+4:ital,opsz,wght@0,8..60,400..700;1,8..60,400..700&family=Space+Grotesk:wght@500;700&family=Syne:wght@500;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-canvas: ${bg};
      --title-color: ${titleColor};
      --subtitle-color: ${subtitleColor};
      --text-color: ${textColor};
      --accent: ${accent};
      --secondary-accent: ${secondaryAccent};
      --card-bg: ${cardBg};
      --card-border: ${cardBorder};
      --stage-w: ${stageW}px;
      --stage-h: ${stageH}px;
      --font-display: ${pairing.display};
      --font-display-style: ${pairing.displayStyle};
      --font-body: ${pairing.body};
      --font-mono: ${pairing.mono};
      --title-letter-spacing: ${pairing.titleTracking};
      --kicker-letter-spacing: ${pairing.kickerTracking};
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background: #030712;
      color: var(--text-color);
      font-family: var(--font-body), -apple-system, BlinkMacSystemFont, sans-serif;
      overflow: hidden;
      width: 100vw;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* Fixed 1920x1080 Stage with auto-scale */
    #viewport-container {
      position: relative;
      width: var(--stage-w);
      height: var(--stage-h);
      transform-origin: center center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
      background: var(--bg-canvas);
      overflow: hidden;
    }

    .slide {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1), transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      transform: scale(0.99);
      padding: 70px 90px 60px 90px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }

    .slide.active {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: scale(1);
      z-index: 2;
    }

    .stage-frame {
      flex: 1;
      display: flex;
      flex-direction: column;
      height: 100%;
      position: relative;
      z-index: 1;
    }

    /* Typography */
    .kicker-tag, .kicker-badge {
      font-family: var(--font-mono), 'Space Grotesk', monospace;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: var(--kicker-letter-spacing);
      color: var(--accent);
      text-transform: uppercase;
      margin-bottom: 12px;
    }

    .slide-title {
      font-family: var(--font-display);
      font-style: var(--font-display-style);
      font-size: 42px;
      font-weight: 700;
      line-height: 1.15;
      color: var(--title-color);
      letter-spacing: var(--title-letter-spacing);
      max-width: 1500px;
      text-wrap: balance;
    }

    .slide-subtitle {
      font-size: 19px;
      font-weight: 500;
      line-height: 1.4;
      color: var(--subtitle-color);
      margin-top: 8px;
      max-width: 1350px;
      text-wrap: pretty;
    }

    .accent-bar {
      width: 72px;
      height: 4px;
      background: var(--accent);
      margin-top: 14px;
      margin-bottom: 28px;
      border-radius: 2px;
    }

    /* Split Layout */
    .split-layout {
      display: grid;
      grid-template-columns: ${is21x9 ? '1fr 1.35fr' : '1fr 1fr'};
      gap: ${is21x9 ? '80px' : '60px'};
      height: 100%;
      align-items: center;
    }

    .split-left {
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .split-right {
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .media-container {
      width: 100%;
      aspect-ratio: ${is21x9 ? '21 / 9' : '16 / 9'};
      height: auto;
      max-height: ${is21x9 ? '620px' : '540px'};
      background: rgba(10, 18, 30, 0.9);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
      position: relative;
    }

    .media-container img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center;
    }

    .media-caption {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      background: rgba(7, 17, 30, 0.9);
      padding: 12px 20px;
      font-size: 14px;
      color: var(--subtitle-color);
      border-top: 1px solid var(--card-border);
    }

    /* Cards */
    .content-cards {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 26px 30px;
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.45);
      display: flex;
      flex-direction: column;
    }

    .card-badge {
      font-family: var(--font-mono), 'Space Grotesk', monospace;
      font-size: 11px;
      font-weight: 700;
      color: var(--secondary-accent);
      letter-spacing: 2px;
      text-transform: uppercase;
      margin-bottom: 12px;
    }

    .card-badge-pill {
      display: inline-block;
      align-self: flex-start;
      font-family: var(--font-mono), 'Space Grotesk', monospace;
      font-size: 11.5px;
      font-weight: 700;
      color: var(--accent);
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--card-border);
      padding: 6px 14px;
      border-radius: 20px;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      margin-bottom: 16px;
    }

    .card-title {
      font-size: 22px;
      font-weight: 700;
      color: var(--title-color);
      margin-bottom: 12px;
      letter-spacing: -0.01em;
    }

    .card-body {
      font-size: 15.5px;
      line-height: 1.65;
      color: var(--text-color);
      text-wrap: pretty;
    }

    .card-bullets {
      list-style: none;
      margin-top: 12px;
    }

    .card-bullets li {
      position: relative;
      padding-left: 22px;
      margin-bottom: 12px;
      font-size: 15.5px;
      line-height: 1.55;
      color: var(--text-color);
    }

    .card-bullets li::before {
      content: '■';
      position: absolute;
      left: 0;
      color: var(--accent);
      font-size: 10px;
      top: 3px;
    }

    .bullet-lead {
      font-weight: 700;
      color: var(--title-color);
      font-family: 'Space Grotesk', sans-serif;
      letter-spacing: 0.5px;
      margin-right: 4px;
    }

    .bullet-desc {
      color: var(--text-color);
    }

    strong.highlight {
      color: var(--accent);
      font-weight: 700;
    }

    /* Grid Slide Layout */
    .grid-slide-layout {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .grid-content-split {
      display: grid;
      grid-template-columns: 0.9fr 1.1fr;
      gap: 50px;
      flex: 1;
      align-items: center;
    }

    .media-grid {
      display: grid;
      gap: 16px;
      width: 100%;
      height: auto;
    }

    .media-grid.cols-2 {
      grid-template-columns: 1fr 1fr;
    }

    .grid-item {
      background: #07111E;
      border: 1px solid var(--card-border);
      border-radius: 12px;
      overflow: hidden;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      aspect-ratio: 16 / 9;
      max-height: 380px;
    }

    .grid-item img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }

    .grid-item .img-label {
      position: absolute;
      bottom: 8px;
      left: 12px;
      background: rgba(0, 0, 0, 0.8);
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      color: #fff;
      letter-spacing: 0.5px;
    }

    /* Table Slide */
    .table-slide-layout {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .table-container {
      flex: 1;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 30px;
      overflow: auto;
    }

    .slide-table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }

    .slide-table th {
      background: rgba(0, 90, 156, 0.4);
      color: #fff;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      padding: 16px 20px;
      border-bottom: 2px solid var(--accent);
    }

    .slide-table td {
      padding: 16px 20px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 14px;
      line-height: 1.5;
    }

    .slide-table tr:hover td {
      background: rgba(255, 255, 255, 0.03);
    }

    /* Hero Slide */
    .hero-slide {
      position: absolute;
      inset: -70px -90px -60px -90px;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      padding: 100px;
    }

    .hero-bg-img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: right center;
      z-index: 1;
    }

    /* Asymmetric Directional Scrim: protects copy while keeping 55%+ of 4K photo pristine */
    .hero-scrim {
      position: absolute;
      inset: 0;
      background: linear-gradient(
        90deg,
        rgba(7, 11, 20, 0.94) 0%,
        rgba(7, 11, 20, 0.82) 32%,
        rgba(7, 11, 20, 0.25) 54%,
        rgba(7, 11, 20, 0.05) 70%,
        transparent 85%
      );
      z-index: 2;
      pointer-events: none;
    }

    .hero-content {
      position: relative;
      z-index: 3;
      max-width: 1200px;
    }

    .hero-title {
      font-family: var(--font-display);
      font-style: var(--font-display-style);
      font-size: 64px;
      font-weight: 700;
      line-height: 1.08;
      color: #fff;
      margin-bottom: 24px;
      letter-spacing: var(--title-letter-spacing);
    }

    .hero-subtitle {
      font-size: 24px;
      line-height: 1.5;
      color: var(--subtitle-color);
      margin-bottom: 40px;
    }

    .hero-meta {
      font-family: var(--font-mono);
      display: flex;
      gap: 40px;
      border-top: 1px solid rgba(255, 255, 255, 0.15);
      padding-top: 24px;
      font-size: 13px;
      letter-spacing: 0.5px;
      color: rgba(255, 255, 255, 0.7);
    }

    .hero-meta strong {
      color: #fff;
      margin-left: 6px;
    }

    /* Adaptive Card Row */
    .cards-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: 32px;
      margin-top: 20px;
      align-items: stretch;
    }

    /* Footer */
    .slide-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 20px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 13px;
      color: rgba(255, 255, 255, 0.4);
      font-family: 'Space Grotesk', sans-serif;
      letter-spacing: 1px;
      z-index: 10;
    }

    /* Floating Navigation Controls */
    #nav-controls {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 40px;
      padding: 8px 18px;
      display: flex;
      align-items: center;
      gap: 16px;
      z-index: 1000;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    }

    .nav-btn {
      background: transparent;
      border: none;
      color: #fff;
      font-size: 18px;
      cursor: pointer;
      padding: 6px 12px;
      border-radius: 20px;
      transition: background 0.2s;
    }

    .nav-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    #slide-indicator {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 13px;
      font-weight: 700;
      color: var(--accent);
      min-width: 60px;
      text-align: center;
    }

    @media print {
      body {
        overflow: visible;
        background: #fff;
      }
      #viewport-container {
        transform: none !important;
        box-shadow: none;
      }
      .slide {
        position: relative !important;
        page-break-after: always;
        opacity: 1 !important;
        visibility: visible !important;
        transform: none !important;
        height: 100vh;
      }
      #nav-controls {
        display: none !important;
      }
    }
  </style>
</head>
<body>

  <div id="viewport-container">
    ${slidesHtml}
  </div>

  <div id="nav-controls">
    <button class="nav-btn" id="prev-btn" title="Previous (Left Arrow)">◀</button>
    <div id="slide-indicator">1 / ${slides.length}</div>
    <button class="nav-btn" id="next-btn" title="Next (Right Arrow / Space)">▶</button>
    <button class="nav-btn" id="fullscreen-btn" title="Toggle Fullscreen (F)">⛶</button>
  </div>

  <script>
    (function() {
      const container = document.getElementById('viewport-container');
      const slides = document.querySelectorAll('.slide');
      const indicator = document.getElementById('slide-indicator');
      const prevBtn = document.getElementById('prev-btn');
      const nextBtn = document.getElementById('next-btn');
      const fsBtn = document.getElementById('fullscreen-btn');
      let currentIdx = 0;

      // Auto Scale fixed stage (${stageW}x${stageH})
      function resizeStage() {
        const stageW = ${stageW};
        const stageH = ${stageH};
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        const scale = Math.min(winW / stageW, winH / stageH);
        container.style.transform = \`scale(\${scale})\`;
      }

      window.addEventListener('resize', resizeStage);
      resizeStage();

      function updateSlide(newIdx) {
        if (newIdx < 0 || newIdx >= slides.length) return;
        slides[currentIdx].classList.remove('active');
        currentIdx = newIdx;
        slides[currentIdx].classList.add('active');
        indicator.textContent = \`\${currentIdx + 1} / \${slides.length}\`;
      }

      prevBtn.addEventListener('click', () => updateSlide(currentIdx - 1));
      nextBtn.addEventListener('click', () => updateSlide(currentIdx + 1));

      fsBtn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      });

      window.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
          e.preventDefault();
          updateSlide(currentIdx + 1);
        } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
          e.preventDefault();
          updateSlide(currentIdx - 1);
        } else if (e.key === 'Home') {
          e.preventDefault();
          updateSlide(0);
        } else if (e.key === 'End') {
          e.preventDefault();
          updateSlide(slides.length - 1);
        } else if (e.key === 'f' || e.key === 'F') {
          if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
          } else {
            document.exitFullscreen().catch(() => {});
          }
        }
      });
    })();
  </script>
</body>
</html>
`;

  fs.writeFileSync(outputPath, html, 'utf8');
  return outputPath;
}

export function formatMarkdownHtml(text) {
  if (!text) return '';
  return text
    .replace(/\\text\{([^}]+)\}/g, '$1')
    .replace(/\\times/g, '×')
    .replace(/\\circ/g, '°')
    .replace(/\$([^\$]+)\$/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="highlight">$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderFormattedBulletItem(bulletText) {
  const match = bulletText.match(/^(\*\*[^*]+\*\*|[^:]{2,35}):\s*(.*)$/);
  if (match) {
    const lead = match[1].replace(/\*\*/g, '').trim();
    const rest = match[2].trim();
    return `<li><span class="bullet-lead">${lead}:</span> <span class="bullet-desc">${formatMarkdownHtml(rest)}</span></li>`;
  }
  return `<li>${formatMarkdownHtml(bulletText)}</li>`;
}

function renderTextCards(s, textColor, accent) {
  const cards = [];

  // If there's body prose, convert into structured cards
  if (s.body) {
    const paragraphs = s.body.split('\n\n').filter(p => p.trim());
    for (let i = 0; i < Math.min(paragraphs.length, 2); i++) {
      const p = paragraphs[i].trim();
      cards.push(`
        <div class="card">
          <div class="card-badge">STRATEGIC FOCUS 0${i+1}</div>
          <div class="card-body">${formatMarkdownHtml(p)}</div>
        </div>
      `);
    }
  }

  // If there are bullets, render as a bullet card
  if (s.bullets && s.bullets.length > 0) {
    cards.push(`
      <div class="card">
        <div class="card-badge">KEY SPECIFICATIONS</div>
        <ul class="card-bullets">
          ${s.bullets.map(renderFormattedBulletItem).join('')}
        </ul>
      </div>
    `);
  }

  return cards.join('\n');
}

function renderThreeCards(s, textColor, accent) {
  const cards = [];
  const paragraphs = (s.body || '').split('\n\n').filter(p => p.trim());
  const bullets = s.bullets || [];

  // Case 1: Pure Bullets (2 to 4 items) -> distinct cards for each bullet (e.g. milestones)
  if (bullets.length >= 2 && bullets.length <= 4 && paragraphs.length === 0) {
    for (let i = 0; i < bullets.length; i++) {
      const raw = bullets[i];
      let badge = `PILLAR 0${i + 1}`;
      let textBody = raw;
      const match = raw.match(/^(\*\*[^*]+\*\*|[^:]{2,30}):\s*(.*)$/);
      if (match) {
        badge = match[1].replace(/\*\*/g, '').trim().toUpperCase();
        textBody = match[2].trim();
      }
      cards.push(`
        <div class="card">
          <div class="card-badge-pill">${badge}</div>
          <div class="card-body" style="font-size: 17px; line-height: 1.6; color: var(--text-color);">${formatMarkdownHtml(textBody)}</div>
        </div>
      `);
    }
    return cards.join('\n');
  }

  // Case 2: Bullets (> 4 items) -> 2-column or list cards
  if (bullets.length > 4 && paragraphs.length === 0) {
    const mid = Math.ceil(bullets.length / 2);
    const left = bullets.slice(0, mid);
    const right = bullets.slice(mid);
    return `
      <div class="card">
        <div class="card-badge">PRIMARY OBJECTIVES</div>
        <ul class="card-bullets">
          ${left.map(renderFormattedBulletItem).join('')}
        </ul>
      </div>
      <div class="card">
        <div class="card-badge">TECHNICAL DELIVERABLES</div>
        <ul class="card-bullets">
          ${right.map(renderFormattedBulletItem).join('')}
        </ul>
      </div>
    `;
  }

  // Case 3: Prose + Bullets
  if (paragraphs.length > 0 && bullets.length > 0) {
    return `
      <div class="card">
        <div class="card-badge">CORE CONCEPT & MANDATE</div>
        <div class="card-body">${paragraphs.map(p => `<p style="margin-bottom: 12px; font-size: 16px; line-height: 1.55;">${formatMarkdownHtml(p)}</p>`).join('')}</div>
      </div>
      <div class="card">
        <div class="card-badge">KEY DELIVERABLES</div>
        <ul class="card-bullets">
          ${bullets.map(renderFormattedBulletItem).join('')}
        </ul>
      </div>
    `;
  }

  // Case 4: Pure Prose (Multiple Paragraphs)
  if (paragraphs.length >= 2) {
    const count = Math.min(paragraphs.length, 3);
    for (let i = 0; i < count; i++) {
      const defaultBadges = ['01 // THE MANDATE', '02 // THE EXECUTION', '03 // THE IMPACT'];
      cards.push(`
        <div class="card">
          <div class="card-badge">${defaultBadges[i] || `PILLAR 0${i + 1}`}</div>
          <div class="card-body" style="font-size: 16px; line-height: 1.6;">${formatMarkdownHtml(paragraphs[i])}</div>
        </div>
      `);
    }
    return cards.join('\n');
  }

  // Case 5: Single Paragraph or Statement
  const statement = paragraphs[0] || s.body || s.blockquote || s.subtitle || s.title;
  return `
    <div class="card statement-card" style="grid-column: 1 / -1; padding: 40px;">
      <div class="card-badge" style="margin-bottom: 16px;">KEY DIRECTORIAL VISION</div>
      <div class="card-body" style="font-size: 24px; line-height: 1.6; color: var(--title-color);">${formatMarkdownHtml(statement)}</div>
    </div>
  `;
}

function renderHtmlTable(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = rows[0];
  const bodyRows = rows.slice(1);

  return `
    <table class="slide-table">
      <thead>
        <tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${bodyRows.map(r => `
          <tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>
        `).join('')}
      </tbody>
    </table>
  `;
}
