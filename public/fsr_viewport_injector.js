/********************************************************************************
 * AMD FidelityFX Super Resolution 1.0 (EASU + RCAS) Viewport Overlay & Hub
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 ********************************************************************************/

(function () {
    if (typeof window === 'undefined') return;
    if (window.__SB_FSR_INJECTED__) return;
    window.__SB_FSR_INJECTED__ = true;

    // Do not inject overlay on the dedicated FSR demo itself
    if (window.location.pathname.includes('fsr_upscaling_demo.html')) {
        return;
    }

    // Inject stylesheet
    const styleEl = document.createElement('style');
    styleEl.id = 'sb-fsr-injector-styles';
    styleEl.textContent = `
        .sb-fsr-viewport-dock {
            position: fixed;
            bottom: 24px;
            right: 24px;
            z-index: 99999;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 10px;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
            user-select: none;
            pointer-events: auto;
        }

        .sb-fsr-toggle-pill {
            display: flex;
            align-items: center;
            gap: 9px;
            background: rgba(15, 18, 28, 0.88);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 999px;
            padding: 6px 14px 6px 10px;
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65), 0 0 16px rgba(239, 68, 68, 0.2);
            color: #f1f5f9;
            font-size: 12px;
            font-weight: 600;
            letter-spacing: -0.01em;
            cursor: pointer;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .sb-fsr-toggle-pill:hover {
            background: rgba(24, 28, 44, 0.95);
            border-color: rgba(239, 68, 68, 0.45);
            box-shadow: 0 16px 40px rgba(0, 0, 0, 0.75), 0 0 24px rgba(239, 68, 68, 0.35);
            transform: translateY(-2px);
        }

        .sb-fsr-icon-badge {
            width: 22px;
            height: 22px;
            border-radius: 50%;
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            color: #ffffff;
            box-shadow: 0 0 10px rgba(239, 68, 68, 0.6);
        }

        .sb-fsr-state-tag {
            font-size: 10px;
            font-weight: 700;
            padding: 2px 7px;
            border-radius: 999px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            transition: all 0.2s ease;
        }

        .sb-fsr-state-tag.off {
            background: rgba(148, 163, 184, 0.15);
            color: #94a3b8;
            border: 1px solid rgba(148, 163, 184, 0.3);
        }

        .sb-fsr-state-tag.on {
            background: rgba(16, 185, 129, 0.2);
            color: #34d399;
            border: 1px solid rgba(16, 185, 129, 0.45);
            box-shadow: 0 0 10px rgba(16, 185, 129, 0.35);
        }

        .sb-fsr-hub-link {
            color: #38bdf8;
            text-decoration: none;
            font-size: 11px;
            font-weight: 600;
            margin-left: 4px;
            padding-left: 8px;
            border-left: 1px solid rgba(255, 255, 255, 0.15);
            display: flex;
            align-items: center;
            gap: 3px;
            transition: color 0.15s ease;
        }

        .sb-fsr-hub-link:hover {
            color: #7dd3fc;
            text-decoration: underline;
        }

        .sb-fsr-panel {
            background: rgba(15, 18, 28, 0.92);
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 14px;
            padding: 16px;
            width: 290px;
            box-shadow: 0 20px 48px rgba(0, 0, 0, 0.8), 0 0 20px rgba(0, 0, 0, 0.5);
            display: none;
            flex-direction: column;
            gap: 12px;
            animation: sbFsrFadeIn 0.18s ease-out forwards;
        }

        .sb-fsr-panel.visible {
            display: flex;
        }

        @keyframes sbFsrFadeIn {
            from { opacity: 0; transform: translateY(6px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .sb-fsr-panel-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .sb-fsr-panel-title {
            font-size: 12px;
            font-weight: 700;
            color: #f8fafc;
            letter-spacing: -0.01em;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .sb-fsr-panel-close {
            background: none;
            border: none;
            color: #94a3b8;
            font-size: 16px;
            cursor: pointer;
            padding: 2px 4px;
            border-radius: 4px;
            line-height: 1;
        }

        .sb-fsr-panel-close:hover {
            color: #ffffff;
            background: rgba(255, 255, 255, 0.1);
        }

        .sb-fsr-stat-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 12px;
        }

        .sb-fsr-stat-label {
            color: #94a3b8;
        }

        .sb-fsr-stat-value {
            font-family: ui-monospace, Menlo, monospace;
            font-weight: 600;
            color: #38bdf8;
        }

        .sb-fsr-slider-box {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .sb-fsr-slider-label {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            color: #cbd5e1;
        }

        .sb-fsr-slider {
            width: 100%;
            height: 4px;
            accent-color: #ef4444;
            cursor: pointer;
        }

        .sb-fsr-btn-studio {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%);
            border: 1px solid rgba(239, 68, 68, 0.5);
            color: #ffffff;
            text-decoration: none;
            font-size: 12px;
            font-weight: 600;
            padding: 8px 12px;
            border-radius: 8px;
            transition: all 0.15s ease;
            box-shadow: 0 4px 14px rgba(239, 68, 68, 0.35);
        }

        .sb-fsr-btn-studio:hover {
            background: linear-gradient(135deg, #f87171 0%, #dc2626 100%);
            transform: translateY(-1px);
            box-shadow: 0 6px 18px rgba(239, 68, 68, 0.5);
        }

        /* Top Bar Header Link */
        .sb-fsr-topbar-link {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 5px 12px;
            border-radius: 999px;
            background: rgba(239, 68, 68, 0.15);
            border: 1px solid rgba(239, 68, 68, 0.4);
            color: #fca5a5;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.02em;
            text-decoration: none;
            transition: all 0.15s ease;
            pointer-events: auto;
            backdrop-filter: blur(8px);
        }

        .sb-fsr-topbar-link:hover {
            background: rgba(239, 68, 68, 0.28);
            border-color: rgba(239, 68, 68, 0.6);
            color: #ffffff;
            box-shadow: 0 0 12px rgba(239, 68, 68, 0.4);
        }
    `;
    document.head.appendChild(styleEl);

    let fsrActive = false;
    let fsrSharpness = 0.85;
    let fsrPreset = 'quality';

    function initFSRUI() {
        // Check if there is already a dock
        if (document.getElementById('sb-fsr-dock')) return;

        // 1. Create Floating Viewport Dock
        const dock = document.createElement('div');
        dock.id = 'sb-fsr-dock';
        dock.className = 'sb-fsr-viewport-dock';

        dock.innerHTML = `
            <div id="sb-fsr-panel" class="sb-fsr-panel">
                <div class="sb-fsr-panel-header">
                    <span class="sb-fsr-panel-title">
                        <span>⚡</span>
                        <span>FSR 1.0 (EASU + RCAS)</span>
                    </span>
                    <button id="sb-fsr-close" class="sb-fsr-panel-close">&times;</button>
                </div>
                <div class="sb-fsr-stat-row">
                    <span class="sb-fsr-stat-label">Render Scale:</span>
                    <span class="sb-fsr-stat-value" id="sb-fsr-scale-val">0.67x (Quality)</span>
                </div>
                <div class="sb-fsr-stat-row">
                    <span class="sb-fsr-stat-label">Fillrate Saved:</span>
                    <span class="sb-fsr-stat-value" id="sb-fsr-fill-val">+55.1%</span>
                </div>
                <div class="sb-fsr-stat-row">
                    <span class="sb-fsr-stat-label">GPU Overhead:</span>
                    <span class="sb-fsr-stat-value" id="sb-fsr-time-val">~0.28 ms</span>
                </div>
                <div class="sb-fsr-slider-box">
                    <div class="sb-fsr-slider-label">
                        <span>RCAS Sharpness</span>
                        <span id="sb-fsr-sharpness-val" style="font-family:monospace;">0.85</span>
                    </div>
                    <input type="range" id="sb-fsr-slider" class="sb-fsr-slider" min="0" max="100" value="85">
                </div>
                <a href="/fsr_upscaling_demo.html" target="_blank" class="sb-fsr-btn-studio">
                    <span>Launch FSR 1.0 Studio</span>
                    <span>↗</span>
                </a>
            </div>

            <div class="sb-fsr-toggle-pill" id="sb-fsr-toggle-btn" title="Click to toggle AMD FidelityFX Super Resolution 1.0">
                <div class="sb-fsr-icon-badge">⚡</div>
                <span>FSR 1.0</span>
                <span class="sb-fsr-state-tag off" id="sb-fsr-badge">OFF</span>
                <a href="/fsr_upscaling_demo.html" class="sb-fsr-hub-link" title="Open full AMD FSR 1.0 Studio Demo">Studio ↗</a>
            </div>
        `;

        document.body.appendChild(dock);

        const toggleBtn = document.getElementById('sb-fsr-toggle-btn');
        const panel = document.getElementById('sb-fsr-panel');
        const closeBtn = document.getElementById('sb-fsr-close');
        const badge = document.getElementById('sb-fsr-badge');
        const slider = document.getElementById('sb-fsr-slider');
        const sharpnessVal = document.getElementById('sb-fsr-sharpness-val');

        toggleBtn.addEventListener('click', (e) => {
            if (e.target.classList.contains('sb-fsr-hub-link')) return;
            fsrActive = !fsrActive;
            if (fsrActive) {
                badge.className = 'sb-fsr-state-tag on';
                badge.textContent = 'ON';
                panel.classList.add('visible');
            } else {
                badge.className = 'sb-fsr-state-tag off';
                badge.textContent = 'OFF';
                panel.classList.remove('visible');
            }

            // Notify demo runtime or canvas shader hooks if listening
            window.dispatchEvent(new CustomEvent('sb-fsr-toggle', {
                detail: {
                    enabled: fsrActive,
                    preset: fsrPreset,
                    sharpness: fsrSharpness
                }
            }));
        });

        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            panel.classList.remove('visible');
        });

        slider.addEventListener('input', (e) => {
            fsrSharpness = parseFloat(e.target.value) / 100.0;
            sharpnessVal.textContent = fsrSharpness.toFixed(2);
            window.dispatchEvent(new CustomEvent('sb-fsr-sharpness-change', {
                detail: { sharpness: fsrSharpness }
            }));
        });

        // 2. Inject Top Navigation Header Link if a header exists
        const headerCandidate = document.querySelector(
            'header, .top-navbar, .top-bar, .studio-header, .controls-bar, .navbar, .top-stats, .brand'
        );

        if (headerCandidate && !document.querySelector('.sb-fsr-topbar-link')) {
            const headerLink = document.createElement('a');
            headerLink.href = '/fsr_upscaling_demo.html';
            headerLink.className = 'sb-fsr-topbar-link';
            headerLink.title = 'Open AMD FidelityFX Super Resolution 1.0 Interactive Studio';
            headerLink.innerHTML = `<span>⚡</span><span>FSR 1.0 Studio</span>`;

            // Insert into header
            if (headerCandidate.classList.contains('top-stats')) {
                headerCandidate.insertBefore(headerLink, headerCandidate.firstChild);
            } else if (headerCandidate.tagName.toLowerCase() === 'header' || headerCandidate.classList.contains('top-navbar') || headerCandidate.classList.contains('top-bar')) {
                headerCandidate.appendChild(headerLink);
            } else {
                headerCandidate.parentNode.insertBefore(headerLink, headerCandidate.nextSibling);
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initFSRUI);
    } else {
        initFSRUI();
    }
})();
