const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

async function main() {
  const outputPath = process.argv[2] || '/Users/eligreen/.gemini/antigravity/brain/29954617-6067-4894-8ba1-420c57425aea/cdp_test_screenshot.png';

  const pagesJson = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json/list', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });

  const page = pagesJson.find(p => p.type === 'page' && p.url.includes('3030')) || pagesJson[0];
  if (!page || !page.webSocketDebuggerUrl) {
    throw new Error('No inspectable CDP page found');
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  let id = 1;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const curId = id++;
    const handler = (msg) => {
      const data = JSON.parse(msg);
      if (data.id === curId) {
        ws.off('message', handler);
        if (data.error) reject(data.error);
        else resolve(data.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id: curId, method, params }));
  });

  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  const buffer = Buffer.from(screenshot.data, 'base64');
  fs.writeFileSync(outputPath, buffer);
  ws.close();
  console.log(`Screenshot saved to ${outputPath} (${buffer.length} bytes)`);
}

main().catch(err => {
  console.error('Failed to capture CDP screenshot:', err);
  process.exit(1);
});
