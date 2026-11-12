/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Settings > Account: Sign in with scratchbox.ai. The user approves one workspace in the system browser (the IDE never
 * sees a password); the IDE then uses that workspace's credits, style and tools until it is disconnected here or
 * revoked on scratchbox.ai.
 */
import * as React from 'react';
import { cancelAccountSignIn, refreshAccountStatus, signOutOfAccount, startAccountSignIn, useScratchboxAccount, waitForAccountSignIn } from '../../services/scratchbox-account-client';

export const AccountTab: React.FC = () => {
    const status = useScratchboxAccount();
    const [busy, setBusy] = React.useState<'idle' | 'starting' | 'signing-out'>('idle');
    const [message, setMessage] = React.useState<string>('');
    const [signInUrl, setSignInUrl] = React.useState<string>('');
    const cancelled = React.useRef(false);

    React.useEffect(() => {
        cancelled.current = false;
        void refreshAccountStatus();
        return () => { cancelled.current = true; };
    }, []);

    const waiting = !!status?.connecting;

    const signIn = async () => {
        setMessage('');
        setBusy('starting');
        try {
            const url = await startAccountSignIn();
            setSignInUrl(url);
            setBusy('idle');
            const after = await waitForAccountSignIn(6 * 60_000, 1500, () => cancelled.current);
            if (cancelled.current) return;
            setSignInUrl('');
            if (after?.connected) {
                // The name arrives just after the connection; read it once more.
                setTimeout(() => { if (!cancelled.current) void refreshAccountStatus(); }, 1500);
            } else {
                setMessage(after?.reason ?? 'The sign-in was not completed. Start it again when you are ready.');
            }
        } catch (err) {
            setBusy('idle');
            setMessage(err instanceof Error ? err.message : String(err));
        }
    };

    const cancel = async () => {
        try { await cancelAccountSignIn(); setSignInUrl(''); setMessage('Sign-in cancelled.'); }
        catch (err) { setMessage(err instanceof Error ? err.message : String(err)); }
    };

    const signOut = async () => {
        setBusy('signing-out');
        setMessage('');
        try {
            const { revoked } = await signOutOfAccount();
            setMessage(revoked
                ? 'Disconnected. This device\'s access was revoked on scratchbox.ai.'
                : 'Disconnected on this computer, but scratchbox.ai did not confirm the revoke. Revoke this device in scratchbox.ai\'s device settings.');
        } catch (err) {
            setMessage(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy('idle');
        }
    };

    const host = (() => { try { return new URL(status?.origin ?? 'https://www.scratchbox.ai').host; } catch { return 'scratchbox.ai'; } })();
    const who = status?.identity?.username;
    const workspace = status?.identity?.workspaceName ?? (status?.workspaceId != null ? `Workspace ${status.workspaceId}` : '');

    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">Account</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
                Sign in with your scratchbox.ai account to use its credits, workspace and Style DNA from the IDE.
            </p>

            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">scratchbox.ai</div>
                <div className="sb-cursor-group-card" data-testid="account-card">
                    {status?.connected ? (
                        <>
                            <div className="sb-cursor-row-item">
                                <div className="sb-cursor-row-info">
                                    <span className="sb-cursor-row-title" data-testid="account-username">{who ?? workspace}</span>
                                    <div className="sb-cursor-row-desc">
                                        {status.identity?.email ? `${status.identity.email} · ` : ''}{status.identity?.tier ? `${status.identity.tier} plan · ` : ''}{host}
                                    </div>
                                </div>
                                <button type="button" className="sb-cursor-row-btn" onClick={signOut} disabled={busy !== 'idle'}>
                                    <span>{busy === 'signing-out' ? 'Disconnecting…' : 'Disconnect'}</span>
                                </button>
                            </div>
                            <div className="sb-cursor-row-item">
                                <div className="sb-cursor-row-info">
                                    <span className="sb-cursor-row-title">Workspace</span>
                                    <div className="sb-cursor-row-desc">{workspace} — the IDE uses this workspace's credits, style and tools.</div>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="sb-cursor-row-item">
                            <div className="sb-cursor-row-info">
                                <span className="sb-cursor-row-title">{waiting ? 'Waiting for your browser' : 'Not signed in'}</span>
                                <div className="sb-cursor-row-desc">
                                    {waiting
                                        ? `Approve a workspace on ${host} in your browser, then come back here.`
                                        : status?.reason ?? `You approve one workspace on ${host}; the IDE uses it until you disconnect.`}
                                </div>
                            </div>
                            {waiting ? (
                                <button type="button" className="sb-cursor-row-btn" onClick={cancel} data-testid="account-cancel">
                                    <span>Cancel</span>
                                </button>
                            ) : (
                                <button type="button" className="sb-btn sb-btn-primary sb-btn-sm" onClick={signIn} disabled={busy !== 'idle'} data-testid="account-sign-in">
                                    <span>{busy === 'starting' ? 'Opening…' : 'Sign in with scratchbox.ai'}</span>
                                </button>
                            )}
                        </div>
                    )}
                    {waiting && signInUrl && (
                        <div className="sb-cursor-row-item">
                            <div className="sb-cursor-row-info">
                                <div className="sb-cursor-row-desc">The browser did not open?</div>
                            </div>
                            <button type="button" className="sb-cursor-row-btn" onClick={() => window.open(signInUrl, '_blank', 'noopener')}>
                                <span>Open the sign-in page</span>
                            </button>
                        </div>
                    )}
                </div>
                {message && <div className="sb-cursor-row-desc mt-2" role="status">{message}</div>}
            </div>
        </div>
    );
};
