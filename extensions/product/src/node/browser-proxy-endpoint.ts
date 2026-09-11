/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { Application, Router, Request, Response } from '@theia/core/shared/express';
import { json } from 'body-parser';
import { ILogger } from '@theia/core/lib/common';
import { BrowserProxyService } from './browser-proxy-service';

@injectable()
export class BrowserProxyEndpoint implements BackendApplicationContribution {
    public static readonly PATH = '/api/browser';

    @inject(ILogger)
    protected readonly logger: ILogger;

    @inject(BrowserProxyService)
    protected readonly proxyService: BrowserProxyService;

    configure(app: Application): void {
        const router = Router();

        // Safe JSON parsing for POST/PUT
        router.use((req, res, next) => {
            if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
                json({ limit: '50mb' })(req, res, next);
            } else {
                next();
            }
        });

        // Route definitions
        router.get('/status', (req, res) => this.handleStatus(req, res));
        router.all('/proxy', (req, res) => this.handleProxy(req, res));
        router.all('/proxy/*', (req, res) => this.handleProxy(req, res));
        router.all('/gateway', (req, res) => this.handleProxy(req, res));
        router.all('/gateway/*', (req, res) => this.handleProxy(req, res));

        app.use(BrowserProxyEndpoint.PATH, router);
    }

    private handleStatus(_req: Request, res: Response): void {
        res.json({
            success: true,
            engine: 'Chromium Proxy Gateway',
            status: 'ready',
            timestamp: Date.now()
        });
    }

    private async handleProxy(req: Request, res: Response): Promise<void> {
        const targetUrlRaw = (req.query.url as string) || (req.body && req.body.url);
        if (!targetUrlRaw) {
            res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head><title>Scratchbox Browser Proxy Error</title></head>
                <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; background: #0f1015; color: #e2e8f0;">
                    <h2>Missing target URL parameter</h2>
                    <p>Usage: <code>/api/browser/proxy?url=https://example.com</code></p>
                </body>
                </html>
            `);
            return;
        }

        try {
            const targetUrl = this.proxyService.normalizeUrl(targetUrlRaw);
            const fetchResult = await this.proxyService.fetchTarget(targetUrl, {
                method: req.method,
                headers: req.headers as any,
                body: req.body,
                policy: {
                    capability: 'browser.proxy',
                    allowedOrigins: process.env.SCRATCHBOX_BROWSER_ALLOWED_ORIGINS
                        ? process.env.SCRATCHBOX_BROWSER_ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
                        : undefined
                }
            });

            // Set response status
            res.status(fetchResult.statusCode);

            // Apply sanitized response headers
            for (const [key, value] of Object.entries(fetchResult.headers)) {
                if (value !== undefined) {
                    res.setHeader(key, value as any);
                }
            }

            // Always ensure frame embedding is explicitly allowed
            res.removeHeader('x-frame-options');
            res.removeHeader('content-security-policy');
            res.removeHeader('content-security-policy-report-only');
            res.setHeader('Access-Control-Allow-Origin', '*');

            res.send(fetchResult.body);
        } catch (err: any) {
            this.logger.error(`Proxy gateway error for ${targetUrlRaw}: ${err.message}`, err);

            // Return a stylized dark-mode error page matching the Scratchbox design system
            res.status(502).send(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <title>Scratchbox Web Gateway - Navigation Error</title>
                    <style>
                        body {
                            margin: 0;
                            padding: 0;
                            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                            background: radial-gradient(circle at 50% 30%, #1a1b26 0%, #0c0d12 100%);
                            color: #e2e8f0;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            min-height: 100vh;
                        }
                        .error-card {
                            background: rgba(26, 27, 38, 0.85);
                            backdrop-filter: blur(20px);
                            border: 1px solid rgba(255, 255, 255, 0.1);
                            border-radius: 16px;
                            padding: 32px 40px;
                            max-width: 540px;
                            text-align: center;
                            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
                        }
                        .icon {
                            font-size: 40px;
                            margin-bottom: 16px;
                        }
                        h2 {
                            margin: 0 0 12px;
                            font-size: 20px;
                            font-weight: 600;
                            color: #f87171;
                        }
                        p {
                            color: #94a3b8;
                            font-size: 14px;
                            line-height: 1.6;
                            margin: 0 0 24px;
                        }
                        code {
                            background: rgba(0, 0, 0, 0.4);
                            padding: 3px 8px;
                            border-radius: 6px;
                            font-family: monospace;
                            color: #38bdf8;
                        }
                        .btn {
                            display: inline-block;
                            background: #6366f1;
                            color: #ffffff;
                            padding: 10px 20px;
                            border-radius: 8px;
                            text-decoration: none;
                            font-weight: 500;
                            font-size: 14px;
                            transition: background 0.2s;
                        }
                        .btn:hover {
                            background: #4f46e5;
                        }
                    </style>
                </head>
                <body>
                    <div class="error-card">
                        <div class="icon">🌐</div>
                        <h2>Unable to Load Web Destination</h2>
                        <p>The Scratchbox Chromium Web Gateway encountered an issue while reaching <code>${targetUrlRaw}</code>.</p>
                        <p style="font-size: 12px; color: #64748b;">Detail: ${err.message || 'Connection refused or upstream timeout'}</p>
                        <a href="javascript:location.reload()" class="btn">Retry Navigation</a>
                    </div>
                </body>
                </html>
            `);
        }
    }
}
