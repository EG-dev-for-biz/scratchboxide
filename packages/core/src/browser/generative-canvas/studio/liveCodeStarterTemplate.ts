/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Starter source shown in a freshly created Live Code Preview tab. */
export const LIVE_CODE_STARTER_APP = `import React, { useState } from 'react';\n\nexport default function App() {\n    const [count, setCount] = useState(0);\n    return (\n        <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif', color: '#f8fafc', background: '#090d16', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>\n            <div style={{ background: '#131b2e', padding: 32, borderRadius: 16, border: '1px solid #1e293b', textAlign: 'center', maxWidth: 440, width: '100%' }}>\n                <h1 style={{ fontSize: 24, margin: '0 0 12px 0', color: '#60a5fa' }}>⚡ Scratchbox Live Preview</h1>\n                <p style={{ color: '#94a3b8', fontSize: 14, margin: '0 0 24px 0' }}>Edit this code in Split or Code mode, and watch your changes render instantly.</p>\n                <button onClick={() => setCount(c => c + 1)} style={{ padding: '10px 24px', fontSize: 15, fontWeight: 600, borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', boxShadow: '0 4px 12px rgba(37,99,235,0.3)' }}>\n                    Interactive Counter: {count}\n                </button>\n            </div>\n        </div>\n    );\n}`;
