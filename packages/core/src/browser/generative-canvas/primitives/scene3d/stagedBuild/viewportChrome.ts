/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The viewport's chrome, in one place: the dark glass panel the staged-build overlay and the window check are drawn
 * as, its text colours, its buttons and its accent (the Okabe-Ito blue the overlay's active toggles use). The toolstrip
 * (Scene3DPrimitive) draws the same look with Tailwind classes.
 */

import type * as React from 'react';

export const CHROME_TEXT = '#e4e4e7';
export const CHROME_MUTED = '#b4b4bb';
export const CHROME_ACCENT = '#56B4E9';
export const CHROME_ACCENT_FILL = 'rgba(86, 180, 233, 0.25)';
export const CHROME_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

/** A viewport panel: dark glass, a hairline border, 10 px corners, 12 px text. Position and size are the caller's. */
export const CHROME_PANEL: React.CSSProperties = {
    boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10,
    background: 'rgba(18, 18, 22, 0.92)', border: '1px solid rgba(255, 255, 255, 0.14)',
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)', color: CHROME_TEXT,
    fontFamily: CHROME_FONT, fontSize: 12, lineHeight: 1.45, textAlign: 'left'
};

/**
 * A secondary button: translucent, hairline border. Border longhands only, never the `border` shorthand beside them
 * (React warns when an update sets a longhand the shorthand also set); the staged overlay's own BUTTON is the same look,
 * written out where staged-material-edit.test.ts guards it.
 */
export const CHROME_BUTTON: React.CSSProperties = {
    font: 'inherit', fontSize: 12, color: CHROME_TEXT, background: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(255, 255, 255, 0.18)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', textAlign: 'left'
};

/** The primary button: the accent, dark text. */
export const CHROME_BUTTON_PRIMARY: React.CSSProperties = {
    ...CHROME_BUTTON, background: CHROME_ACCENT, borderColor: CHROME_ACCENT, color: '#0b0b0e', fontWeight: 600
};
