const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

async function getCDPClient() {
  const pages = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json/list', res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
  const page = pages.find(p => p.type === 'page' && p.url.includes('3030')) || pages[0];
  if (!page || !page.webSocketDebuggerUrl) {
    throw new Error('No inspectable CDP page found');
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));

  let id = 1;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const curId = id++;
    const handler = msg => {
      const d = JSON.parse(msg);
      if (d.id === curId) {
        ws.off('message', handler);
        if (d.error) reject(d.error);
        else resolve(d.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id: curId, method, params }));
  });

  return { ws, send };
}

async function evaluate(code) {
  const { ws, send } = await getCDPClient();
  const res = await send('Runtime.evaluate', {
    expression: code,
    returnByValue: true,
    awaitPromise: true
  });
  ws.close();
  return res;
}

async function takeScreenshot(outputPath) {
  const { ws, send } = await getCDPClient();
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  const buffer = Buffer.from(screenshot.data, 'base64');
  fs.writeFileSync(outputPath, buffer);
  ws.close();
  console.log(`Screenshot saved to ${outputPath} (${buffer.length} bytes)`);
}

module.exports = { evaluate, takeScreenshot, getCDPClient };

if (require.main === module) {
  const cmd = process.argv[2];
  const arg = process.argv[3];
  if (cmd === 'eval') {
    evaluate(arg).then(r => console.log('Eval result:', JSON.stringify(r, null, 2))).catch(console.error);
  } else if (cmd === 'screenshot') {
    takeScreenshot(arg || '/Users/eligreen/.gemini/antigravity/brain/29954617-6067-4894-8ba1-420c57425aea/cdp_test_screenshot.png').catch(console.error);
  }
}
