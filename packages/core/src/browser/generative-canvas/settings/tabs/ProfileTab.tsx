/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Profile settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const ProfileTab: React.FC = () => {
    const { avatarInputRef, customAvatar, firstName, handle, lastName, link1, profileSavedFeedback, publicProfile, setCustomAvatar, setFirstName, setHandle, setLastName, setLink1, setProfileSavedFeedback, setPublicProfile } = useSettingsContext();
    // Read-only in the current build (no setter existed in the original component).
    const profileEmail = 'developer@scratchbox.dev';
    const [extraLinks, setExtraLinks] = React.useState<string[]>([]);
    const [newLinkVal, setNewLinkVal] = React.useState('');
    const [isAddingLink, setIsAddingLink] = React.useState(false);

    const handleAddLink = () => {
        if (newLinkVal.trim()) {
            setExtraLinks(prev => [...prev, newLinkVal.trim()]);
            setNewLinkVal('');
            setIsAddingLink(false);
        }
    };

    const handleRemoveLink = (index: number) => {
        setExtraLinks(prev => prev.filter((_, i) => i !== index));
    };
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">Profile</h2>

            <input
                ref={avatarInputRef}
                type="file"
                accept="image/png, image/jpeg, image/webp"
                style={{ display: 'none' }}
                onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) {
                        const reader = new FileReader();
                        reader.onload = ev => setCustomAvatar(ev.target?.result as string);
                        reader.readAsDataURL(file);
                    }
                }}
            />

            <div className="sb-cursor-group-card">
                {/* Email */}
                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Email</div>
                    </div>
                    <span className="text-xs text-zinc-700 dark:text-zinc-300 font-mono">{profileEmail}</span>
                </div>

                {/* Profile Image */}
                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Profile Image</div>
                    </div>
                    <div className="flex items-center gap-3">
                        {customAvatar ? (
                            <img src={customAvatar} alt="Profile" className="w-9 h-9 rounded-full object-cover border border-blue-500/40" />
                        ) : (
                            <div className="w-9 h-9 rounded-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-700 dark:text-zinc-200">
                                CUSTOM
                            </div>
                        )}
                        <button type="button" className="sb-cursor-row-btn" onClick={() => avatarInputRef.current?.click()}>
                            Upload image
                        </button>
                        {customAvatar && (
                            <button type="button" className="sb-cursor-row-btn" onClick={() => setCustomAvatar(null)}>
                                Remove
                            </button>
                        )}
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">PNG, JPEG, or WebP</span>
                    </div>
                </div>

                {/* First Name */}
                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">First Name</div>
                    </div>
                    <input
                        type="text"
                        className="sb-cursor-text-input"
                        value={firstName}
                        onChange={e => setFirstName(e.target.value)}
                        placeholder="First name"
                    />
                </div>

                {/* Last Name */}
                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Last Name</div>
                    </div>
                    <input
                        type="text"
                        className="sb-cursor-text-input"
                        value={lastName}
                        onChange={e => setLastName(e.target.value)}
                        placeholder="Last name"
                    />
                </div>
            </div>

            {/* Developer Identity Card */}
            <div className="sb-cursor-group-card">
                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Username / Handle</div>
                        <div className="sb-cursor-row-desc">Author handle for git commits, generated code, and local project metadata</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <span className="text-xs text-zinc-400 font-mono">@</span>
                        <input
                            type="text"
                            className="sb-cursor-text-input w-48 font-mono text-xs"
                            value={handle}
                            onChange={e => setHandle(e.target.value)}
                            placeholder="username"
                        />
                        <button
                            type="button"
                            className="sb-cursor-btn-secondary text-xs px-2.5 py-1"
                            onClick={() => {}}
                        >
                            Claim handle
                        </button>
                    </div>
                </div>

                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Links &amp; Socials</div>
                        <div className="sb-cursor-row-desc">External profiles for git commit links, repository remotes, and developer attribution</div>
                    </div>
                    <div className="flex flex-col items-end gap-2 min-w-[240px]">
                        <div className="flex items-center gap-1.5 w-full justify-end">
                            <span className="text-xs text-zinc-400">Primary:</span>
                            <input
                                type="text"
                                className="sb-cursor-text-input text-xs w-48"
                                value={link1}
                                onChange={e => setLink1(e.target.value)}
                                placeholder="github.com/handle"
                            />
                        </div>

                        {extraLinks.map((lnk, idx) => (
                            <div key={`extra-link-${idx}`} className="flex items-center gap-1.5 w-full justify-end">
                                <span className="text-xs text-zinc-400">Link {idx + 2}:</span>
                                <span className="text-xs text-zinc-700 dark:text-zinc-200 bg-zinc-100/80 dark:bg-zinc-900/60 px-2 py-1 rounded border border-zinc-200 dark:border-zinc-800 font-mono w-44 truncate">
                                    {lnk}
                                </span>
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-ghost sb-btn-xs text-zinc-500 hover:text-red-400 px-1"
                                    onClick={() => handleRemoveLink(idx)}
                                    title="Remove link"
                                >
                                    ×
                                </button>
                            </div>
                        ))}

                        {isAddingLink ? (
                            <div className="flex items-center gap-1.5 w-full justify-end pt-1">
                                <input
                                    type="text"
                                    className="sb-cursor-text-input text-xs w-44"
                                    value={newLinkVal}
                                    onChange={e => setNewLinkVal(e.target.value)}
                                    placeholder="https://..."
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') handleAddLink();
                                        if (e.key === 'Escape') setIsAddingLink(false);
                                    }}
                                    autoFocus
                                />
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-primary sb-btn-xs"
                                    onClick={handleAddLink}
                                >
                                    Add
                                </button>
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-ghost sb-btn-xs text-zinc-400"
                                    onClick={() => {
                                        setIsAddingLink(false);
                                        setNewLinkVal('');
                                    }}
                                >
                                    Cancel
                                </button>
                            </div>
                        ) : (
                            <button
                                type="button"
                                className="sb-btn sb-btn-ghost sb-btn-xs text-blue-400 hover:text-blue-300"
                                onClick={() => setIsAddingLink(true)}
                            >
                                + Add link
                            </button>
                        )}
                    </div>
                </div>

                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Public Profile</div>
                        <div className="sb-cursor-row-desc">
                            When enabled, your profile page is visible to anyone with the link.
                        </div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={publicProfile}
                        className={`sb-cursor-toggle ${publicProfile ? 'sb-cursor-toggle-on' : ''}`}
                        onClick={() => setPublicProfile(!publicProfile)}
                    >
                        <span className="sb-cursor-toggle-thumb" />
                    </button>
                </div>
            </div>

            <div className="flex justify-end pt-2">
                <button
                    type="button"
                    className="sb-btn sb-btn-primary sb-btn-sm"
                    onClick={() => {
                        setProfileSavedFeedback(true);
                        setTimeout(() => setProfileSavedFeedback(false), 2500);
                    }}
                >
                    {profileSavedFeedback ? '✓ Saved' : 'Save'}
                </button>
            </div>
        </div>
    );
};
