/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Settings > Account: Sign in with scratchbox.ai. The sign-in happens in the system browser (the IDE never sees a
 * password); the IDE keeps a credential bound to one workspace for up to 90 days, which it can revoke here.
 */
import * as React from 'react';
import { refreshAccountStatus, signOutOfAccount, startAccountSignIn, useScratchboxAccount, waitForAccountSignIn } from '../../services/scratchbox-account-client';

const formatDate = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

export const AccountTab: React.FC = () => {
    const status = useScratchboxAccount();
    const [phase, setPhase] = React.useState<'idle' | 'waiting' | 'signing-out'>('idle');
    const [message, setMessage] = React.useState<string>('');
    const [signInUrl, setSignInUrl] = React.useState<string>('');
    const cancelled = React.useRef(false);

    React.useEffect(() => {
        cancelled.current = false;
        void refreshAccountStatus();
        return () => { cancelled.current = true; };
    }, []);

    const signIn = async () => {
        setMessage('');
        try {
            const url = await startAccountSignIn();
            setSignInUrl(url);
            setPhase('waiting');
            const after = await waitForAccountSignIn(10 * 60_000, 2000, () => cancelled.current);
            if (!cancelled.current) {
                setPhase('idle');
                setSignInUrl('');
                if (!after?.signedIn) setMessage('The sign-in was not completed. Start it again when you are ready.');
            }
        } catch (err) {
            setPhase('idle');
            setMessage(err instanceof Error ? err.message : String(err));
        }
    };

    const signOut = async () => {
        setPhase('signing-out');
        setMessage('');
        try {
            const { revoked } = await signOutOfAccount();
            setMessage(revoked ? 'Signed out. The IDE\'s access was revoked on scratchbox.ai.' : 'Signed out on this computer. scratchbox.ai could not be reached to revoke the access; you can revoke it from scratchbox.ai\'s settings.');
        } catch (err) {
            setMessage(err instanceof Error ? err.message : String(err));
        } finally {
            setPhase('idle');
        }
    };

    const host = (() => { try { return new URL(status?.baseUrl ?? 'https://www.scratchbox.ai').host; } catch { return 'scratchbox.ai'; } })();

    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">Account</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
                Sign in with your scratchbox.ai account to use its credits, workspace and Style DNA from the IDE.
            </p>

            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">scratchbox.ai</div>
                <div className="sb-cursor-group-card" data-testid="account-card">
                    {status?.signedIn ? (
                        <>
                            <div className="sb-cursor-row-item">
                                <div className="sb-cursor-row-info">
                                    <span className="sb-cursor-row-title" data-testid="account-username">{status.user?.username}</span>
                                    <div className="sb-cursor-row-desc">
                                        {status.user?.email ? `${status.user.email} · ` : ''}{status.user?.tier ? `${status.user.tier} plan · ` : ''}{host}
                                    </div>
                                </div>
                                <button type="button" className="sb-cursor-row-btn" onClick={signOut} disabled={phase !== 'idle'}>
                                    <span>{phase === 'signing-out' ? 'Signing out…' : 'Sign out'}</span>
                                </button>
                            </div>
                            <div className="sb-cursor-row-item">
                                <div className="sb-cursor-row-info">
                                    <span className="sb-cursor-row-title">Workspace</span>
                                    <div className="sb-cursor-row-desc">{status.workspace?.name} — the IDE uses this workspace's credits and style.</div>
                                </div>
                            </div>
                            <div className="sb-cursor-row-item">
                                <div className="sb-cursor-row-info">
                                    <span className="sb-cursor-row-title">Access until</span>
                                    <div className={`sb-cursor-row-desc ${status.expiresSoon ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                                        {formatDate(status.expiresAt)}{status.expiresSoon ? ' — ends soon: sign in again to keep using your account.' : ''}
                                    </div>
                                </div>
                                {status.expiresSoon && (
                                    <button type="button" className="sb-btn sb-btn-primary sb-btn-sm" onClick={signIn} disabled={phase !== 'idle'}>
                                        <span>Sign in again</span>
                                    </button>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="sb-cursor-row-item">
                            <div className="sb-cursor-row-info">
                                <span className="sb-cursor-row-title">Not signed in</span>
                                <div className="sb-cursor-row-desc">
                                    {phase === 'waiting'
                                        ? `Finish signing in on ${host} in your browser, then come back here.`
                                        : status?.reason ?? `You choose a workspace on ${host}; the IDE gets access to that workspace for 90 days.`}
                                </div>
                            </div>
                            <button type="button" className="sb-btn sb-btn-primary sb-btn-sm" onClick={signIn} disabled={phase !== 'idle'} data-testid="account-sign-in">
                                <span>{phase === 'waiting' ? 'Waiting for browser…' : 'Sign in with scratchbox.ai'}</span>
                            </button>
                        </div>
                    )}
                </div>
                {phase === 'waiting' && signInUrl && (
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-desc">The browser did not open?</div>
                        </div>
                        <button type="button" className="sb-cursor-row-btn" onClick={() => window.open(signInUrl, '_blank', 'noopener')}>
                            <span>Open the sign-in page</span>
                        </button>
                    </div>
                )}
                {message && <div className="sb-cursor-row-desc mt-2" role="status">{message}</div>}
            </div>
        </div>
    );
};
