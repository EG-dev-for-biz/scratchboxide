/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** Tab settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const TabTab: React.FC = () => {
    const { autoImportPython, autoImportsTs, cursorTabEnabled, ignoredFilesGlob, partialAccepts, setAutoImportPython, setAutoImportsTs, setCursorTabEnabled, setIgnoredFilesGlob, setPartialAccepts, setSuggestionsWhileCommenting, setWhitespaceOnlySuggestions, suggestionsWhileCommenting, whitespaceOnlySuggestions } = useSettingsContext();
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">Tab</h2>

            <div className="sb-cursor-group-card">
                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Scratchbox Tab</div>
                        <div className="sb-cursor-row-desc">Context-aware, multi-line suggestions around your cursor based on recent edits</div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={cursorTabEnabled}
                        className={`sb-cursor-toggle ${cursorTabEnabled ? 'sb-cursor-toggle-on' : ''}`}
                        onClick={() => setCursorTabEnabled(!cursorTabEnabled)}
                    >
                        <span className="sb-cursor-toggle-thumb" />
                    </button>
                </div>

                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Partial Accepts ⓘ</div>
                        <div className="sb-cursor-row-desc">Accept the next word of a suggestion via ⌘→</div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={partialAccepts}
                        className={`sb-cursor-toggle ${partialAccepts ? 'sb-cursor-toggle-on' : ''}`}
                        onClick={() => setPartialAccepts(!partialAccepts)}
                    >
                        <span className="sb-cursor-toggle-thumb" />
                    </button>
                </div>

                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Suggestions While Commenting</div>
                        <div className="sb-cursor-row-desc">Allow Tab to trigger while in a comment region</div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={suggestionsWhileCommenting}
                        className={`sb-cursor-toggle ${suggestionsWhileCommenting ? 'sb-cursor-toggle-on' : ''}`}
                        onClick={() => setSuggestionsWhileCommenting(!suggestionsWhileCommenting)}
                    >
                        <span className="sb-cursor-toggle-thumb" />
                    </button>
                </div>

                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Whitespace-Only Suggestions</div>
                        <div className="sb-cursor-row-desc">Suggest edits like new lines and indentation that modify whitespace only</div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={whitespaceOnlySuggestions}
                        className={`sb-cursor-toggle ${whitespaceOnlySuggestions ? 'sb-cursor-toggle-on' : ''}`}
                        onClick={() => setWhitespaceOnlySuggestions(!whitespaceOnlySuggestions)}
                    >
                        <span className="sb-cursor-toggle-thumb" />
                    </button>
                </div>

                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Imports</div>
                        <div className="sb-cursor-row-desc">Automatically import necessary modules for TypeScript</div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={autoImportsTs}
                        className={`sb-cursor-toggle ${autoImportsTs ? 'sb-cursor-toggle-on' : ''}`}
                        onClick={() => setAutoImportsTs(!autoImportsTs)}
                    >
                        <span className="sb-cursor-toggle-thumb" />
                    </button>
                </div>

                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Auto Import for Python <span className="sb-badge-unified sb-badge-zinc">BETA</span></div>
                        <div className="sb-cursor-row-desc">Enable auto import for Python. This is a beta feature.</div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={autoImportPython}
                        className={`sb-cursor-toggle ${autoImportPython ? 'sb-cursor-toggle-on' : ''}`}
                        onClick={() => setAutoImportPython(!autoImportPython)}
                    >
                        <span className="sb-cursor-toggle-thumb" />
                    </button>
                </div>

                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Ignored Files</div>
                        <div className="sb-cursor-row-desc">Glob patterns for files where Scratchbox Tab will not suggest</div>
                    </div>
                    <input
                        type="text"
                        className="sb-cursor-text-input"
                        value={ignoredFilesGlob}
                        onChange={e => setIgnoredFilesGlob(e.target.value)}
                        placeholder="e.g., *.md, **/generated/*"
                    />
                </div>
            </div>
        </div>
    );
};
