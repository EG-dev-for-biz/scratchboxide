import { defineConfig, loadEnv, Plugin, ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import crypto from 'crypto';
import path from 'path';

const API_TARGET = `http://127.0.0.1:${process.env.PORT || process.env.SCRATCHBOX_API_PORT || '3001'}`;

/**
 * Renderer Content-Security-Policy. 'unsafe-eval' is only added in dev because
 * Vite/React Fast Refresh need it; production bundles run without it. In dev the
 * Fast Refresh preamble is an inline script, so it is authorised via a nonce
 * (Vite `html.cspNonce`) rather than 'unsafe-inline'.
 */
export function buildRendererCsp(isDev: boolean, nonce?: string): string {
  const remote = 'https://*.googleapis.com https://*.gstatic.com https://tile.googleapis.com https://esm.sh https://unpkg.com https://cdn.tailwindcss.com https://cdn.jsdelivr.net';
  const local = 'http://127.0.0.1:* http://localhost:*';
  const ws = 'ws://127.0.0.1:* ws://localhost:*';
  const scriptSrc = [
    '\'self\'',
    '\'unsafe-eval\'',
    remote,
    local,
    isDev ? '\'unsafe-inline\'' : (nonce ? `'nonce-${nonce}' 'unsafe-inline'` : '\'unsafe-inline\'')
  ].filter(Boolean).join(' ');
  return [
    `default-src 'self' ${remote} ${local} blob: data:`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline' ${remote} ${local}`,
    `img-src 'self' ${remote} https://images.unsplash.com https://*.unsplash.com https://assets.mixkit.co https://*.mixkit.co https: ${local} blob: data:`,
    `font-src 'self' ${remote} ${local} data:`,
    `connect-src 'self' ${remote} ${local} ${ws} blob: data:`,
    `worker-src 'self' blob:`,
    `frame-src 'self' ${local} https://esm.sh https://unpkg.com https://cdn.jsdelivr.net blob: data:`,
    `media-src 'self' ${remote} ${local} https: blob: data:`,
    `object-src 'none'`,
    `base-uri 'self'`
  ].join('; ');
}

/** Injects the CSP <meta> tag (dev gets 'unsafe-eval'; production does not). */
function cspPlugin(isDev: boolean, nonce: string): Plugin {
  return {
    name: 'scratchbox-csp',
    transformIndexHtml(html) {
      const csp = buildRendererCsp(isDev, nonce);
      const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;
      if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) {
        return html.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i, meta);
      }
      return html.replace(/<head>/i, `<head>\n    ${meta}`);
    }
  };
}

/**
 * Dev proxy entry: forwards to the API and injects the per-launch token so the
 * renderer never has to hold it while running under Vite.
 */
function apiProxy(): ProxyOptions {
  return {
    target: API_TARGET,
    changeOrigin: true,
    configure(proxy) {
      proxy.on('error', (err, req, res) => {
        console.error('[Vite Proxy Error]', req.url, err.message);
        if (res && 'writeHead' in res && !res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'proxy_error', message: err.message }));
        }
      });
      proxy.on('proxyReq', proxyReq => {
        const token = process.env.SCRATCHBOX_LAUNCH_TOKEN;
        if (token && !proxyReq.getHeader('x-scratchbox-token') && !proxyReq.getHeader('authorization')) {
          proxyReq.setHeader('X-Scratchbox-Token', token);
        }
      });
    }
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, path.resolve(__dirname, '..'), '');
  const appEnv = loadEnv(mode, __dirname, '');
  const env = { ...rootEnv, ...appEnv };
  const isDev = mode !== 'production';
  const cspNonce = crypto.randomBytes(16).toString('base64');

  // Only the browser-safe Maps/Tiles key is ever compiled into the bundle.
  const googleMapsKey = env.GOOGLE_MAPS_API_KEY || env.MAP_TILES_API_KEY || '';

  return {
    plugins: [react(), cspPlugin(isDev, cspNonce)],
    html: !isDev && cspNonce ? { cspNonce } : undefined,
    define: {
      'process.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleMapsKey),
      'process.env.MAP_TILES_API_KEY': JSON.stringify(googleMapsKey)
    },
    server: {
      port: parseInt(process.env.SCRATCHBOX_WEB_PORT || '3030', 10),
      host: '127.0.0.1',
      fs: {
        allow: [
          path.resolve(__dirname, '..')
        ]
      },
      proxy: {
        '/api': apiProxy(),
        '/gemini': apiProxy(),
        '/workspace': apiProxy(),
        '/media': apiProxy(),
        '/video': apiProxy(),
        '/3d': apiProxy(),
        '/spatial': apiProxy(),
        '/models': apiProxy(),
        '/cpp': apiProxy()
      }
    },
    resolve: {
      alias: [
        { find: '@scratchbox/core/style.css', replacement: path.resolve(__dirname, '../packages/core/src/style.css') },
        { find: '@scratchbox/core', replacement: path.resolve(__dirname, '../packages/core/src') },
        { find: '@', replacement: path.resolve(__dirname, './src') }
      ]
    }
  };
});
