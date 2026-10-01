/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import * as http from 'http';
import * as https from 'https';
import * as url from 'url';
import * as zlib from 'zlib';
import * as dns from 'dns';
import * as net from 'net';

export interface ProxyFetchResult {
    statusCode: number;
    statusText?: string;
    headers: Record<string, string | string[]>;
    contentType: string;
    body: Buffer | string;
    resolvedUrl: string;
    isHtml: boolean;
}

export interface BrowserProxyRequestPolicy {
    capability?: 'browser.fetch' | 'browser.proxy';
    allowedOrigins?: string[];
    /**
     * @deprecated Ignored. Private-network access is a server-side decision
     * (constructor option / `SCRATCHBOX_PROXY_ALLOW_PRIVATE=1`) and never
     * honoured from a request body.
     */
    allowPrivateNetwork?: boolean;
}

export interface ResolvedAddress {
    address: string;
    family: number;
}

export type HostnameResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface BrowserProxyServiceOptions {
    /** Allow loopback / RFC1918 / link-local targets. Defaults to `SCRATCHBOX_PROXY_ALLOW_PRIVATE === '1'`. */
    allowPrivateNetwork?: boolean;
    /** Custom DNS resolver (tests). Defaults to `dns.promises.lookup(host, { all: true })`. */
    resolver?: HostnameResolver;
}

export interface ValidatedTarget {
    url: URL;
    addresses: ResolvedAddress[];
}

/** Request headers from the caller that are never forwarded to the upstream target. */
const STRIPPED_REQUEST_HEADERS = new Set([
    // Credentials for *our* API, not the upstream.
    'authorization',
    'proxy-authorization',
    'cookie',
    'x-scratchbox-token',
    // Hop-by-hop (RFC 7230 §6.1) and connection-specific headers.
    'connection',
    'keep-alive',
    'proxy-connection',
    'proxy-authenticate',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    // Request-specific values that must be recomputed for the upstream request.
    'host',
    'origin',
    'referer',
    'content-length',
    'accept-encoding'
]);

const METADATA_HOSTS = new Set([
    'metadata.google.internal',
    'metadata',
    '169.254.169.254',
    '100.100.100.200',
    'fd00:ec2::254',
    'metadata.azure.com',
    'metadata.oraclecloud.com'
]);

export class BrowserProxyService {
    protected readonly DEFAULT_USER_AGENT =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

    protected readonly allowPrivateNetwork: boolean;
    protected readonly resolver: HostnameResolver;

    constructor(options: BrowserProxyServiceOptions = {}) {
        this.allowPrivateNetwork = options.allowPrivateNetwork ?? process.env.SCRATCHBOX_PROXY_ALLOW_PRIVATE === '1';
        this.resolver = options.resolver || (async hostname => {
            const entries = await dns.promises.lookup(hostname, { all: true });
            return entries.map(entry => ({ address: entry.address, family: entry.family }));
        });
    }

    // In-memory active browser session state
    public activeState = {
        url: 'https://example.com',
        title: 'Web Browser',
        accessibilityTree: 'No active snapshot.',
        markdown: ''
    };

    // Pending action queue & deferred promises
    private pendingActions: any[] = [];
    private actionPromises = new Map<string, { resolve: (val: any) => void, reject: (err: any) => void }>();

    public updateState(state: any) {
        this.activeState = { ...this.activeState, ...state };
    }

    public getActiveState() {
        return this.activeState;
    }

    public queueAction(action: string, params: any): Promise<any> {
        const id = Math.random().toString(36).substring(2, 11);
        const pending = { id, action, params };
        this.pendingActions.push(pending);

        return new Promise((resolve, reject) => {
            this.actionPromises.set(id, { resolve, reject });
            // Timeout after 15 seconds to prevent hanging
            setTimeout(() => {
                if (this.actionPromises.has(id)) {
                    this.actionPromises.delete(id);
                    this.pendingActions = this.pendingActions.filter(a => a.id !== id);
                    reject(new Error(`Action ${action} timed out`));
                }
            }, 15000);
        });
    }

    public getPendingActions() {
        const actions = [...this.pendingActions];
        this.pendingActions = []; // Clear pending list
        return actions;
    }

    public resolveAction(id: string, success: boolean, result: any, error?: string) {
        const promise = this.actionPromises.get(id);
        if (promise) {
            this.actionPromises.delete(id);
            if (success) {
                promise.resolve(result);
            } else {
                promise.reject(new Error(error || 'Action failed'));
            }
            return true;
        }
        return false;
    }

    /**
     * Normalizes a raw URL input string to an absolute valid HTTP/HTTPS URL.
     */
    normalizeUrl(raw: string): string {
        let trimmed = (raw || '').trim();
        if (!trimmed) {
            return 'https://example.com';
        }
        if (trimmed.includes('/api/browser/proxy?url=')) {
            const match = trimmed.match(/[?&]url=([^&]+)/);
            if (match && match[1]) {
                try {
                    trimmed = decodeURIComponent(match[1]);
                } catch(e) {}
            }
        }
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('data:') || trimmed.startsWith('about:')) {
            return trimmed;
        }
        if (trimmed.startsWith('localhost') || trimmed.startsWith('127.0.0.1') || trimmed.startsWith('0.0.0.0')) {
            return `http://${trimmed}`;
        }
        return `https://${trimmed}`;
    }

    /**
     * Sanitizes response headers by stripping restrictive iframe embedding headers
     * and adding permissive CORS headers.
     */
    sanitizeResponseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
        const sanitized: Record<string, string | string[]> = {};
        const blockedHeaders = new Set([
            'x-frame-options',
            'content-security-policy',
            'content-security-policy-report-only',
            'frame-options',
            'strict-transport-security',
            'cross-origin-embedder-policy',
            'cross-origin-opener-policy',
            'cross-origin-resource-policy'
        ]);

        for (const [key, value] of Object.entries(headers)) {
            if (!value) continue;
            const lowerKey = key.toLowerCase();
            if (!blockedHeaders.has(lowerKey)) {
                sanitized[lowerKey] = value;
            }
        }

        // Add permissive CORS & embedding headers
        sanitized['access-control-allow-origin'] = '*';
        sanitized['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS, HEAD';
        sanitized['access-control-allow-headers'] = '*';

        return sanitized;
    }

    /**
     * Injects <base href="..."> and the Scratchbox client bridge script into HTML content.
     */
    rewriteHtml(html: string, originalUrl: string, resolvedUrl: string): string {
        if (!html || typeof html !== 'string') {
            return html;
        }

        const effectiveUrl = resolvedUrl || originalUrl;

        // Strip any <meta http-equiv="Content-Security-Policy"> or <meta http-equiv="X-Frame-Options"> tags
        const processedHtml = html.replace(
            /<meta[^>]*http-equiv=["']?(content-security-policy|x-frame-options|frame-options)["']?[^>]*>/gi,
            ''
        );

        // Inject <base href="..."> if not already present
        const hasBaseTag = /<base\s+[^>]*href=/i.test(processedHtml);
        const baseTagHtml = hasBaseTag ? '' : `<base href="${effectiveUrl}">\n`;

        // Client-side Scratchbox Browser Bridge Script
        const bridgeScript = `
<script id="scratchbox-browser-bridge">
(function() {
    if (window.__scratchboxBridgeInitialized) return;
    window.__scratchboxBridgeInitialized = true;

    // Helper to send messages safely to the IDE canvas parent frame
    function postToParent(msg) {
        try {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage(msg, '*');
            }
        } catch(e) {}
    }

    // Interactive elements registry
    var elementsRegistry = [];
    function indexElements() {
        var selectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [tabindex]:not([tabindex="-1"])';
        var candidates = document.querySelectorAll(selectors);
        var idCounter = 1;
        elementsRegistry = [];
        candidates.forEach(function(el) {
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return;
            var rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return;

            var sbId = String(idCounter++);
            el.setAttribute('data-sb-id', sbId);
            elementsRegistry.push({
                id: sbId,
                element: el,
                tagName: el.tagName.toLowerCase(),
                role: el.getAttribute('role') || el.tagName.toLowerCase(),
                text: (el.textContent || el.placeholder || el.value || '').trim().slice(0, 80),
                bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
            });
        });
    }

    function generateAccessibilityTree() {
        indexElements();
        var lines = [];
        elementsRegistry.forEach(function(item) {
            var stateStr = '';
            if (item.element.disabled) stateStr += ' [disabled]';
            if (item.element.checked) stateStr += ' [checked]';
            var boundsStr = '(x:' + Math.round(item.bounds.x) + ', y:' + Math.round(item.bounds.y) + ', w:' + Math.round(item.bounds.width) + ', h:' + Math.round(item.bounds.height) + ')';
            lines.push('[' + item.id + '] <' + item.role + '> "' + item.text + '" ' + boundsStr + stateStr);
        });
        return lines.join('\n');
    }

    function convertHtmlToMarkdown(root) {
        if (!root) root = document.body;
        
        function cleanText(text) {
            return text.replace(/\\s+/g, ' ');
        }

        function traverse(node) {
            if (node.nodeType === Node.TEXT_NODE) {
                return cleanText(node.nodeValue);
            }
            if (node.nodeType !== Node.ELEMENT_NODE) {
                return '';
            }

            var tagName = node.tagName.toLowerCase();
            if (/^(script|style|noscript|iframe|svg|canvas|head|link|meta)$/.test(tagName)) {
                return '';
            }

            var childContent = '';
            var childNodes = node.childNodes;
            for (var i = 0; i < childNodes.length; i++) {
                childContent += traverse(childNodes[i]);
            }

            if (/^h[1-6]$/.test(tagName)) {
                var level = parseInt(tagName.charAt(1));
                var hashes = '';
                for (var j = 0; j < level; j++) hashes += '#';
                return '\\n\\n' + hashes + ' ' + childContent.trim() + '\\n\\n';
            }
            if (tagName === 'p') {
                return '\\n\\n' + childContent.trim() + '\\n\\n';
            }
            if (tagName === 'br') {
                return '\\n';
            }
            if (tagName === 'li') {
                return '\\n* ' + childContent.trim();
            }
            if (tagName === 'ul' || tagName === 'ol') {
                return '\\n' + childContent + '\\n';
            }
            if (tagName === 'a') {
                var href = node.getAttribute('href') || '';
                var sbId = node.getAttribute('data-sb-id');
                var sbIdSuffix = sbId ? ' [id: ' + sbId + ']' : '';
                return '[' + childContent.trim() + '](' + href + ')' + sbIdSuffix;
            }
            if (/^(button|input|textarea|select)$/.test(tagName)) {
                var sbId = node.getAttribute('data-sb-id');
                var sbIdSuffix = sbId ? ' [id: ' + sbId + ']' : '';
                var type = node.getAttribute('type') || '';
                var placeholder = node.getAttribute('placeholder') || '';
                var label = childContent.trim() || placeholder || type || tagName;
                return ' <' + tagName.toUpperCase() + ' "' + label + '">' + sbIdSuffix + ' ';
            }
            if (tagName === 'tr') {
                return '\\n| ' + childContent.trim() + ' |';
            }
            if (tagName === 'td' || tagName === 'th') {
                return childContent.trim() + ' | ';
            }
            return childContent;
        }

        var md = traverse(root);
        return md.replace(/\\n{3,}/g, '\\n\\n').trim();
    }

    // 1. Intercept link clicks to keep parent address bar and history in sync
    document.addEventListener('click', function(e) {
        var el = e.target;
        while (el && el.tagName !== 'A' && el !== document.body) {
            el = el.parentElement;
        }
        if (el && el.tagName === 'A' && el.href) {
            var href = el.href;
            if (href.startsWith('http://') || href.startsWith('https://')) {
                // If it's a hash jump on the same page, let browser handle anchor scroll
                if (href.split('#')[0] === window.location.href.split('#')[0] && href.includes('#')) {
                    postToParent({ type: 'scratchbox-browser-navigate', url: href, isHash: true });
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                postToParent({ type: 'scratchbox-browser-navigate', url: href });
            }
        }
    }, true);

    // 2. Intercept client-side routing & history modifications
    var origPushState = history.pushState;
    if (origPushState) {
        history.pushState = function(state, unused, url) {
            var result = origPushState.apply(this, arguments);
            try {
                var fullUrl = url ? new URL(url, window.location.href).href : window.location.href;
                postToParent({ type: 'scratchbox-browser-navigate', url: fullUrl, pushState: true });
            } catch(err) {}
            return result;
        };
    }

    var origReplaceState = history.replaceState;
    if (origReplaceState) {
        history.replaceState = function(state, unused, url) {
            var result = origReplaceState.apply(this, arguments);
            try {
                var fullUrl = url ? new URL(url, window.location.href).href : window.location.href;
                postToParent({ type: 'scratchbox-browser-navigate', url: fullUrl, pushState: false });
            } catch(err) {}
            return result;
        };
    }

    window.addEventListener('hashchange', function() {
        postToParent({ type: 'scratchbox-browser-navigate', url: window.location.href });
    });

    window.addEventListener('popstate', function() {
        postToParent({ type: 'scratchbox-browser-navigate', url: window.location.href });
    });

    // 3. Monitor page title and favicon mutations
    function notifyMetadata() {
        var iconEl = document.querySelector("link[rel*='icon']");
        var faviconUrl = iconEl ? iconEl.href : '';
        postToParent({
            type: 'scratchbox-browser-metadata',
            title: document.title || 'Web Page',
            favicon: faviconUrl,
            url: window.location.href
        });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        notifyMetadata();
        indexElements();
    } else {
        document.addEventListener('DOMContentLoaded', function() {
            notifyMetadata();
            indexElements();
        });
    }

    try {
        var titleEl = document.querySelector('title') || document.head || document.documentElement;
        if (titleEl) {
            var obs = new MutationObserver(notifyMetadata);
            obs.observe(titleEl, { subtree: true, characterData: true, childList: true });
        }
    } catch(e) {}

    try {
        var observer = new MutationObserver(function() {
            indexElements();
        });
        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });
    } catch(e) {}

    // 4. Forward console logs to IDE DevTools drawer
    ['log', 'info', 'warn', 'error'].forEach(function(level) {
        var origConsole = console[level];
        console[level] = function() {
            if (origConsole) {
                origConsole.apply(console, arguments);
            }
            try {
                var text = Array.from(arguments).map(function(item) {
                    if (item === null) return 'null';
                    if (item === undefined) return 'undefined';
                    if (typeof item === 'object') {
                        try { return JSON.stringify(item); } catch(_) { return String(item); }
                    }
                    return String(item);
                }).join(' ');
                postToParent({ type: 'scratchbox-browser-console', level: level, text: text });
            } catch(err) {}
        };
    });

    // 5. Handle postMessage actions from parent
    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (!msg || typeof msg !== 'object' || msg.type !== 'scratchbox-browser-action') return;

        var action = msg.action;
        var requestId = msg.requestId;
        var params = msg.params || {};

        function sendResponse(success, result, error) {
            postToParent({
                type: 'scratchbox-browser-action-response',
                requestId: requestId,
                success: success,
                result: result,
                error: error
            });
        }

        try {
            indexElements();

            if (action === 'snapshot') {
                var tree = generateAccessibilityTree();
                var markdown = convertHtmlToMarkdown(document.body);
                sendResponse(true, {
                    accessibilityTree: tree,
                    markdown: markdown,
                    url: window.location.href,
                    title: document.title,
                    devicePixelRatio: window.devicePixelRatio || 1
                });
                return;
            }

            if (action === 'click') {
                var targetId = String(params.elementId);
                var found = elementsRegistry.find(function(item) { return item.id === targetId; });
                if (!found && params.selector) {
                    var el = document.querySelector(params.selector);
                    if (el) {
                        var rect = el.getBoundingClientRect();
                        found = { element: el, bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
                    }
                }

                if (!found) {
                    sendResponse(false, null, 'Element with ID ' + targetId + ' not found');
                    return;
                }

                found.element.scrollIntoView({ block: 'center', inline: 'center' });
                var rect = found.element.getBoundingClientRect();
                var clickX = rect.left + rect.width / 2;
                var clickY = rect.top + rect.height / 2;

                var clickEvent = new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: clickX,
                    clientY: clickY
                });
                found.element.dispatchEvent(clickEvent);
                if (found.element.focus) found.element.focus();

                sendResponse(true, {
                    coords: { x: clickX, y: clickY },
                    text: found.text || found.element.textContent,
                    devicePixelRatio: window.devicePixelRatio || 1
                });
                return;
            }

            if (action === 'fill') {
                var targetId = String(params.elementId);
                var text = params.text || '';
                var found = elementsRegistry.find(function(item) { return item.id === targetId; });
                if (!found) {
                    sendResponse(false, null, 'Element with ID ' + targetId + ' not found');
                    return;
                }

                found.element.scrollIntoView({ block: 'center', inline: 'center' });
                found.element.focus();
                found.element.value = text;

                found.element.dispatchEvent(new Event('input', { bubbles: true }));
                found.element.dispatchEvent(new Event('change', { bubbles: true }));

                var rect = found.element.getBoundingClientRect();
                var centerX = rect.left + rect.width / 2;
                var centerY = rect.top + rect.height / 2;

                sendResponse(true, {
                    coords: { x: centerX, y: centerY },
                    devicePixelRatio: window.devicePixelRatio || 1
                });
                return;
            }

            if (action === 'scroll') {
                var direction = params.direction || 'down';
                var amount = params.amount || 300;
                if (direction === 'down') {
                    window.scrollBy(0, amount);
                } else if (direction === 'up') {
                    window.scrollBy(0, -amount);
                } else if (direction === 'left') {
                    window.scrollBy(-amount, 0);
                } else if (direction === 'right') {
                    window.scrollBy(amount, 0);
                }
                sendResponse(true, {
                    scrollX: window.scrollX,
                    scrollY: window.scrollY
                });
                return;
            }

            if (action === 'hover') {
                var targetId = String(params.elementId);
                var found = elementsRegistry.find(function(item) { return item.id === targetId; });
                if (!found) {
                    sendResponse(false, null, 'Element with ID ' + targetId + ' not found');
                    return;
                }

                found.element.scrollIntoView({ block: 'center', inline: 'center' });
                var rect = found.element.getBoundingClientRect();
                var centerX = rect.left + rect.width / 2;
                var centerY = rect.top + rect.height / 2;

                found.element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: centerX, clientY: centerY }));
                found.element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: centerX, clientY: centerY }));

                sendResponse(true, {
                    coords: { x: centerX, y: centerY },
                    devicePixelRatio: window.devicePixelRatio || 1
                });
                return;
            }

            if (action === 'evaluate') {
                var expression = params.expression || '';
                var result = eval(expression);
                sendResponse(true, {
                    result: result
                });
                return;
            }

            sendResponse(false, null, 'Unknown browser action: ' + action);

        } catch (err) {
            sendResponse(false, null, err.message || String(err));
        }
    });
})();
</script>
`;

        // Inject into <head> or at start of document
        if (/<head[^>]*>/i.test(processedHtml)) {
            return processedHtml.replace(/<head[^>]*>/i, `$& \n${baseTagHtml}${bridgeScript}`);
        } else if (/<html[^>]*>/i.test(processedHtml)) {
            return processedHtml.replace(/<html[^>]*>/i, `$& \n<head>${baseTagHtml}${bridgeScript}</head>`);
        } else {
            return `${baseTagHtml}${bridgeScript}\n${processedHtml}`;
        }
    }

    /**
     * Fetches the target URL with Chromium-grade headers, handles redirects,
     * strips frame restrictions, and returns the rewritten proxy response.
     */
    async fetchTarget(
        targetUrl: string,
        options: {
            method?: string;
            headers?: Record<string, string>;
            body?: any;
            maxRedirects?: number;
            policy?: BrowserProxyRequestPolicy;
        } = {}
    ): Promise<ProxyFetchResult> {
        const normalized = this.normalizeUrl(targetUrl);
        let validated = await this.validateTarget(normalized, options.policy);
        const maxRedirects = options.maxRedirects ?? 10;
        let currentUrl = normalized;
        let redirectsCount = 0;

        // Serialize the body once so we can send an accurate Content-Length.
        let bodyBuffer: Buffer | undefined;
        if (options.body !== undefined && options.body !== null && options.body !== '') {
            if (Buffer.isBuffer(options.body)) {
                bodyBuffer = options.body;
            } else if (typeof options.body === 'string') {
                bodyBuffer = Buffer.from(options.body, 'utf8');
            } else if (typeof options.body === 'object' && Object.keys(options.body).length === 0) {
                bodyBuffer = undefined;
            } else {
                bodyBuffer = Buffer.from(JSON.stringify(options.body), 'utf8');
            }
        }

        while (redirectsCount < maxRedirects) {
            const parsedUrl = url.parse(currentUrl);
            const isHttps = parsedUrl.protocol === 'https:';
            const protocolClient = isHttps ? https : http;
            const pinned = validated.addresses[0];

            const requestHeaders: Record<string, string> = {
                'User-Agent': this.DEFAULT_USER_AGENT,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"macOS"',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
                ...this.sanitizeRequestHeaders(options.headers)
            };
            if (bodyBuffer) {
                requestHeaders['Content-Length'] = String(bodyBuffer.length);
            }

            const result = await new Promise<ProxyFetchResult>((resolve, reject) => {
                const req = protocolClient.request(
                    {
                        protocol: parsedUrl.protocol,
                        hostname: parsedUrl.hostname,
                        // Pin the connection to the address we just validated so a
                        // DNS answer cannot change between validation and connect.
                        lookup: this.createPinnedLookup(pinned),
                        servername: isHttps ? parsedUrl.hostname || undefined : undefined,
                        port: parsedUrl.port || (isHttps ? 443 : 80),
                        path: parsedUrl.path || '/',
                        method: options.method || 'GET',
                        headers: requestHeaders,
                        rejectUnauthorized: false // Allow self-signed or local dev certs
                    } as https.RequestOptions,
                    res => {
                        const statusCode = res.statusCode || 200;
                        const statusText = res.statusMessage;

                        // Check for HTTP Redirects
                        if (
                            (statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308) &&
                            res.headers.location
                        ) {
                            const redirectTarget = url.resolve(currentUrl, res.headers.location);
                            res.resume(); // consume response data to free memory
                            resolve({
                                statusCode,
                                statusText,
                                headers: res.headers as any,
                                contentType: (res.headers['content-type'] as string) || '',
                                body: Buffer.alloc(0),
                                resolvedUrl: redirectTarget,
                                isHtml: false
                            });
                            return;
                        }

                        const rawContentType = (res.headers['content-type'] as string) || '';
                        const isHtml = rawContentType.toLowerCase().includes('text/html') || rawContentType.toLowerCase().includes('application/xhtml+xml');

                        // Handle Content-Encoding (gzip, deflate, br)
                        let responseStream: NodeJS.ReadableStream = res;
                        const contentEncoding = (res.headers['content-encoding'] as string || '').toLowerCase();

                        if (contentEncoding === 'gzip') {
                            const gunzip = zlib.createGunzip();
                            res.pipe(gunzip);
                            responseStream = gunzip;
                        } else if (contentEncoding === 'deflate') {
                            const inflate = zlib.createInflate();
                            res.pipe(inflate);
                            responseStream = inflate;
                        } else if (contentEncoding === 'br') {
                            const brotli = zlib.createBrotliDecompress();
                            res.pipe(brotli);
                            responseStream = brotli;
                        }

                        const chunks: Buffer[] = [];
                        responseStream.on('data', chunk => {
                            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                        });

                        responseStream.on('end', () => {
                            const fullBuffer = Buffer.concat(chunks);
                            const sanitizedHeaders = this.sanitizeResponseHeaders(res.headers);
                            delete sanitizedHeaders['content-encoding']; // decompressed

                            if (isHtml) {
                                const rawHtml = fullBuffer.toString('utf-8');
                                const rewritten = this.rewriteHtml(rawHtml, normalized, currentUrl);
                                const rewrittenBuffer = Buffer.from(rewritten, 'utf-8');
                                sanitizedHeaders['content-length'] = String(rewrittenBuffer.length);
                                resolve({
                                    statusCode,
                                    statusText,
                                    headers: sanitizedHeaders,
                                    contentType: rawContentType,
                                    body: rewrittenBuffer,
                                    resolvedUrl: currentUrl,
                                    isHtml: true
                                });
                            } else {
                                sanitizedHeaders['content-length'] = String(fullBuffer.length);
                                resolve({
                                    statusCode,
                                    statusText,
                                    headers: sanitizedHeaders,
                                    contentType: rawContentType,
                                    body: fullBuffer,
                                    resolvedUrl: currentUrl,
                                    isHtml: false
                                });
                            }
                        });

                        responseStream.on('error', err => {
                            reject(err);
                        });
                    }
                );

                req.on('error', err => {
                    reject(err);
                });

                if (bodyBuffer) {
                    req.write(bodyBuffer);
                }

                req.end();
            });

            // If redirect, loop to next URL
            if (
                (result.statusCode === 301 || result.statusCode === 302 || result.statusCode === 303 || result.statusCode === 307 || result.statusCode === 308) &&
                result.resolvedUrl !== currentUrl
            ) {
                validated = await this.validateTarget(result.resolvedUrl, options.policy);
                currentUrl = result.resolvedUrl;
                redirectsCount++;
                continue;
            }

            return result;
        }

        throw new Error(`Exceeded maximum redirect limit (${maxRedirects}) while fetching ${targetUrl}`);
    }

    /**
     * Drops caller headers that must never reach the upstream target: our own
     * API credentials, hop-by-hop headers, and request-specific values.
     */
    sanitizeRequestHeaders(headers: Record<string, string | string[] | undefined> = {}): Record<string, string> {
        const result: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
            if (value === undefined || value === null) continue;
            const lower = key.toLowerCase();
            if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
            if (lower.startsWith('proxy-') || lower.startsWith('sec-fetch-')) continue;
            result[key] = Array.isArray(value) ? value.join(', ') : String(value);
        }
        return result;
    }

    /**
     * Validates the target URL scheme/credentials/policy, resolves its hostname
     * and rejects private, loopback, link-local and cloud-metadata destinations
     * unless the server was configured to allow private networks.
     */
    async validateTarget(targetUrl: string, policy: BrowserProxyRequestPolicy = {}): Promise<ValidatedTarget> {
        const parsed = new URL(targetUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`Unsupported browser proxy protocol: ${parsed.protocol}`);
        }
        if (parsed.username || parsed.password) {
            throw new Error('Browser proxy targets cannot contain credentials');
        }
        if (policy.capability && policy.capability !== 'browser.fetch' && policy.capability !== 'browser.proxy') {
            throw new Error(`Invalid browser proxy capability: ${policy.capability}`);
        }
        if (policy.allowedOrigins?.length && !policy.allowedOrigins.includes(parsed.origin)) {
            throw new Error(`Browser proxy origin is not granted: ${parsed.origin}`);
        }

        const host = this.normalizeHostname(parsed.hostname);
        if (METADATA_HOSTS.has(host) || host.endsWith('.internal')) {
            throw new Error('Cloud metadata targets are blocked');
        }

        let addresses: ResolvedAddress[];
        if (net.isIP(host)) {
            addresses = [{ address: host, family: net.isIP(host) }];
        } else {
            try {
                addresses = await this.resolver(host);
            } catch (err: any) {
                throw new Error(`Browser proxy target could not be resolved: ${host} (${err?.code || err?.message || 'lookup failed'})`);
            }
        }
        if (!addresses.length) {
            throw new Error(`Browser proxy target could not be resolved: ${host}`);
        }

        // Metadata endpoints are blocked even when private networking is enabled.
        if (addresses.some(entry => METADATA_HOSTS.has(this.normalizeHostname(entry.address)))) {
            throw new Error('Cloud metadata targets are blocked');
        }

        if (!this.allowPrivateNetwork) {
            if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
                throw new Error(`Private network browser proxy target is blocked: ${host}`);
            }
            const offending = addresses.find(entry => this.isPrivateAddress(entry.address));
            if (offending) {
                throw new Error(`Private network browser proxy target is blocked: ${host} (${offending.address})`);
            }
        }

        return { url: parsed, addresses };
    }

    private normalizeHostname(hostname: string): string {
        let host = (hostname || '').toLowerCase().replace(/\.$/, '');
        if (host.startsWith('[') && host.endsWith(']')) {
            host = host.slice(1, -1);
        }
        return host;
    }

    /**
     * Builds a `lookup` implementation for `http.request` that always answers
     * with the address validated a moment ago (prevents DNS rebinding).
     */
    private createPinnedLookup(pinned: ResolvedAddress): any {
        return (_hostname: string, optionsOrCb: any, maybeCb?: any) => {
            const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
            const opts = typeof optionsOrCb === 'function' ? {} : (optionsOrCb || {});
            const family = pinned.family || net.isIP(pinned.address) || 4;
            if (opts.all) {
                cb(null, [{ address: pinned.address, family }]);
            } else {
                cb(null, pinned.address, family);
            }
        };
    }

    private isPrivateAddress(address: string): boolean {
        const normalized = this.normalizeHostname(address);

        // IPv6 checks
        if (normalized.includes(':')) {
            if (normalized === '::1' || normalized === '::' || normalized === '0:0:0:0:0:0:0:1' || normalized === '0:0:0:0:0:0:0:0') {
                return true;
            }
            if (normalized.startsWith('fe80:') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
                return true; // link-local fe80::/10
            }
            if (/^f[cd][0-9a-f]{2}:/.test(normalized)) {
                return true; // unique local fc00::/7
            }
            const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
            if (mapped) {
                return this.isPrivateAddress(mapped[1]);
            }
            const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
            if (mappedHex) {
                const hi = parseInt(mappedHex[1], 16);
                const lo = parseInt(mappedHex[2], 16);
                return this.isPrivateAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
            }
            return false;
        }

        const parts = normalized.split('.').map(Number);
        if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
            return false;
        }
        return parts[0] === 10 ||
            parts[0] === 127 ||
            parts[0] === 0 ||
            (parts[0] === 169 && parts[1] === 254) ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
            (parts[0] === 192 && parts[1] === 168) ||
            (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || // CGNAT 100.64/10
            (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) ||
            (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) ||
            parts[0] >= 224; // multicast / reserved
    }
}
