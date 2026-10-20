import type { ChatFailureKind } from '../gemini-client';

export interface ChatFailureMessage {
    text: string;
    toast: string;
}

const REASON_HINTS: Record<string, string> = {
    API_KEY_SERVICE_BLOCKED: 'This API key is not allowed to call the Gemini API. Add a working key or service account in Settings → Models.',
    API_KEY_INVALID: 'The saved API key is not valid. Update it in Settings → Models.',
    IAM_PERMISSION_DENIED: 'The service account is missing permission. Grant it the "Vertex AI User" role in its Google Cloud project.'
};

const STATUS_HINTS: Record<string, string> = {
    RESOURCE_EXHAUSTED: "Google's rate limit or quota was reached. Wait a minute and try again.",
    UNAUTHENTICATED: 'The saved credentials were rejected. Update them in Settings → Models.',
    PERMISSION_DENIED: 'The saved credentials do not have access. Check them in Settings → Models.'
};

/** Pulls Google's own message out of errors like `AI request failed (403): { "error": { ... } }`. */
function parseGoogleError(raw: string): { message: string; status?: string; reason?: string } {
    // Some Google endpoints answer with an HTML error page (e.g. an unknown Vertex region).
    if (/<!doctype html|<html/i.test(raw)) {
        const text = raw.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return { message: text };
    }
    const jsonStart = raw.indexOf('{');
    if (jsonStart < 0) return { message: raw };
    try {
        const body = JSON.parse(raw.slice(jsonStart));
        const err = body?.error ?? body;
        const reason = (Array.isArray(err?.details) ? err.details : [])
            .map((d: any) => d?.reason)
            .find((r: unknown): r is string => typeof r === 'string');
        return {
            message: typeof err?.message === 'string' ? err.message : raw,
            status: typeof err?.status === 'string' ? err.status : undefined,
            reason
        };
    } catch {
        return { message: raw };
    }
}

export function describeChatFailure(kind: ChatFailureKind, raw: string, httpStatus?: number): ChatFailureMessage {
    if (kind === 'unreachable') {
        return {
            text: `⚠️ **Can't reach the Scratchbox server**\n\nThe app couldn't connect to its local server (${raw}). Restart the app; if you run it with \`npm run dev\`, check that terminal for errors.`,
            toast: "Can't reach the Scratchbox server"
        };
    }
    if (kind === 'server') {
        if (httpStatus === 401) {
            return {
                text: `⚠️ **The Scratchbox server rejected the request**\n\nThe app's access token was not accepted (${raw}). In a browser, open the link the server printed when it started (it ends in \`?token=…\`): a page opened without it, or with the token from an earlier start, is rejected. In the desktop app, restart the app.`,
                toast: 'Server rejected the request'
            };
        }
        return {
            text: `⚠️ **The Scratchbox server returned an error**\n\n${raw}`,
            toast: `Server error${httpStatus ? ` (${httpStatus})` : ''}`
        };
    }
    const google = parseGoogleError(raw);
    const hint = (google.reason && REASON_HINTS[google.reason]) || (google.status && STATUS_HINTS[google.status]);
    return {
        text: `⚠️ **The AI request failed**\n\n${google.message}${hint ? `\n\n${hint}` : ''}`,
        toast: 'AI request failed'
    };
}
