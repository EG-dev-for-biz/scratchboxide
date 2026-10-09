const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

function getPageTarget() {
    return new Promise((resolve, reject) => {
        const req = http.get('http://127.0.0.1:9222/json/list', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const list = JSON.parse(data);
                    const page = list.find(item => item.type === 'page' && item.url.includes('3030')) || list.find(item => item.type === 'page') || list[0];
                    if (!page) reject(new Error('No page target found'));
                    else resolve(page);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
    });
}

class CDPClient {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.seq = 1;
        this.callbacks = new Map();
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.on('open', () => resolve());
            this.ws.on('error', reject);
            this.ws.on('message', (msg) => {
                try {
                    const data = JSON.parse(msg.toString());
                    if (data.id && this.callbacks.has(data.id)) {
                        const { resolve, reject } = this.callbacks.get(data.id);
                        this.callbacks.delete(data.id);
                        if (data.error) reject(new Error(JSON.stringify(data.error)));
                        else resolve(data.result);
                    }
                } catch (e) {
                    console.error('Error handling CDP message:', e);
                }
            });
        });
    }

    send(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = this.seq++;
            this.callbacks.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async evaluate(expression) {
        const res = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
        });
        if (res.exceptionDetails) {
            throw new Error(JSON.stringify(res.exceptionDetails));
        }
        return res.result?.value;
    }

    async screenshot(filePath) {
        const res = await this.send('Page.captureScreenshot', { format: 'png' });
        const buffer = Buffer.from(res.data, 'base64');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buffer);
        console.log(`Saved screenshot to ${filePath} (${buffer.length} bytes)`);
    }

    close() {
        if (this.ws) this.ws.close();
    }
}

async function main() {
    const action = process.argv[2] || 'screenshot';
    const arg = process.argv[3];

    const target = await getPageTarget();
    const client = new CDPClient(target.webSocketDebuggerUrl);
    await client.connect();

    if (action === 'screenshot') {
        const outputPath = arg || 'test-screenshots/current_state.png';
        await client.screenshot(outputPath);
    } else if (action === 'eval') {
        const result = await client.evaluate(arg);
        console.log(JSON.stringify(result, null, 2));
    } else if (action === 'click') {
        const selector = arg;
        const res = await client.evaluate(`
            (() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return 'NOT_FOUND';
                el.click();
                return 'CLICKED';
            })()
        `);
        console.log('Click result:', res);
    } else if (action === 'type') {
        const selector = arg;
        const text = process.argv[4] || '';
        const res = await client.evaluate(`
            (() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return 'NOT_FOUND';
                el.focus();
                el.value = ${JSON.stringify(text)};
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return 'TYPED';
            })()
        `);
        console.log('Type result:', res);
    }

    client.close();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
