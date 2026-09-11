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
    const { avatarInputRef, customAvatar, firstName, handle, handleClaimedFeedback, lastName, link1, profileSavedFeedback, publicProfile, setCustomAvatar, setFirstName, setHandle, setHandleClaimedFeedback, setLastName, setLink1, setProfileSavedFeedback, setPublicProfile } = useSettingsContext();
    // Read-only in the current build (no setter existed in the original component).
    const profileEmail = '';
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
                    <span className="text-xs text-zinc-300 font-mono">{profileEmail}</span>
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
                            <div className="w-9 h-9 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-200">
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
                        <span className="text-[11px] text-zinc-500">PNG, JPEG, or...</span>
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

            {/* Public Profile Card */}
            <div className="sb-cursor-group-card">
                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Handle</div>
                    </div>
                    <div className="flex items-center gap-2">
                        <input
                            type="text"
                            className="sb-cursor-text-input"
                            value={handle}
                            onChange={e => setHandle(e.target.value)}
                            placeholder="username"
                        />
                        <button
                            type="button"
                            className="sb-cursor-row-btn"
                            onClick={() => {
                                setHandleClaimedFeedback(`✓ Claimed @${handle}`);
                                setTimeout(() => setHandleClaimedFeedback(null), 3000);
                            }}
                        >
                            {handleClaimedFeedback || 'Claim handle'}
                        </button>
                    </div>
                </div>

                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Link 1</div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                        <input
                            type="text"
                            className="sb-cursor-text-input"
                            value={link1}
                            onChange={e => setLink1(e.target.value)}
                            placeholder="x.com/handle"
                        />
                        <button type="button" className="sb-btn sb-btn-ghost sb-btn-xs text-blue-400">
                            + Add link
                        </button>
                    </div>
                </div>

                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Public Profile</div>
                        <div className="sb-cursor-row-desc">
                            When enabled, your cursor.com profile page is visible to anyone with the link.
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
