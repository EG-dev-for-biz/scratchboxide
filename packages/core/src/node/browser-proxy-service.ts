/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
    allowPrivateNetwork?: boolean;
}
export class BrowserProxyService {
    protected readonly DEFAULT_USER_AGENT =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

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
        let processedHtml = html.replace(
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
        await this.validateTarget(normalized, options.policy);
        const maxRedirects = options.maxRedirects ?? 10;
        let currentUrl = normalized;
        let redirectsCount = 0;

        while (redirectsCount < maxRedirects) {
            const parsedUrl = url.parse(currentUrl);
            const isHttps = parsedUrl.protocol === 'https:';
            const protocolClient = isHttps ? https : http;

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
                ...(options.headers || {})
            };

            // Remove host/origin from forwarded headers to avoid conflicting upstream
            delete requestHeaders['host'];
            delete requestHeaders['Host'];
            delete requestHeaders['origin'];
            delete requestHeaders['Origin'];
            delete requestHeaders['referer'];
            delete requestHeaders['Referer'];

            const result = await new Promise<ProxyFetchResult>((resolve, reject) => {
                const req = protocolClient.request(
                    {
                        protocol: parsedUrl.protocol,
                        hostname: parsedUrl.hostname,
                        port: parsedUrl.port || (isHttps ? 443 : 80),
                        path: parsedUrl.path || '/',
                        method: options.method || 'GET',
                        headers: requestHeaders,
                        rejectUnauthorized: false // Allow self-signed or local dev certs
                    },
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

                if (options.body) {
                    if (Buffer.isBuffer(options.body) || typeof options.body === 'string') {
                        req.write(options.body);
                    } else {
                        req.write(JSON.stringify(options.body));
                    }
                }

                req.end();
            });

            // If redirect, loop to next URL
            if (
                (result.statusCode === 301 || result.statusCode === 302 || result.statusCode === 303 || result.statusCode === 307 || result.statusCode === 308) &&
                result.resolvedUrl !== currentUrl
            ) {
                await this.validateTarget(result.resolvedUrl, options.policy);
                currentUrl = result.resolvedUrl;
                redirectsCount++;
                continue;
            }

            return result;
        }

        throw new Error(`Exceeded maximum redirect limit (${maxRedirects}) while fetching ${targetUrl}`);
    }

    async validateTarget(targetUrl: string, policy: BrowserProxyRequestPolicy = {}): Promise<void> {
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
        const host = parsed.hostname.toLowerCase();
        if (host === 'metadata.google.internal' || host === '169.254.169.254') {
            throw new Error('Cloud metadata targets are blocked');
        }
        const localDevelopmentHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
        if (localDevelopmentHost || policy.allowPrivateNetwork) {
            return;
        }
        const addresses = net.isIP(host)
            ? [{ address: host }]
            : await dns.promises.lookup(host, { all: true });
        if (addresses.some(entry => this.isPrivateAddress(entry.address))) {
            throw new Error(`Private network browser proxy target is blocked: ${host}`);
        }
    }

    private isPrivateAddress(address: string): boolean {
        const normalized = address.toLowerCase();
        if (normalized === '::1' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) {
            return true;
        }
        const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
        const parts = ipv4.split('.').map(Number);
        if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) {
            return false;
        }
        return parts[0] === 10 ||
            parts[0] === 127 ||
            (parts[0] === 169 && parts[1] === 254) ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
            (parts[0] === 192 && parts[1] === 168) ||
            parts[0] === 0;
    }
}
