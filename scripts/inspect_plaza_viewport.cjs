const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

async function main() {
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const port = 9336;
  const proc = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--window-size=1920,1080',
    'http://127.0.0.1:5173/plaza_matchmove_demo.html'
  ]);

  await new Promise(r => setTimeout(r, 2000));
  const targets = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}/json`, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
  });
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));

  let id = 1;
  function send(method, params = {}) {
    return new Promise((resolve) => {
      const curId = id++;
      const handler = (msg) => {
        const parsed = JSON.parse(msg);
        if (parsed.id === curId) {
          ws.off('message', handler);
          resolve(parsed.result);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });
  }

  await new Promise(r => setTimeout(r, 4000));

  // Tweak fog and camera to see tiles clearly
  await send('Runtime.evaluate', {
    expression: `(() => {
      scene.fog.density = 0.0015;
      orbitDistance = 75;
      updateOrbitCamera();
      // Ensure all mesh materials in plazaGroup respond to lighting
      plazaGroup.traverse(c => {
        if (c.isMesh) {
          c.visible = true;
        }
      });
    })()`
  });

  await new Promise(r => setTimeout(r, 1000));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(shot.data, 'base64');
  fs.writeFileSync('public/test_plaza_tiles_clear.png', buf);
  console.log('Saved public/test_plaza_tiles_clear.png');

  proc.kill();
  process.exit(0);
}

main().catch(console.error);
