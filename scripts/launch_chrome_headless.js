const { spawn } = require('child_process');
const fs = require('fs');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const tmpDir = '/tmp/scratchbox_chrome_debug';
try {
  fs.mkdirSync(tmpDir, { recursive: true });
} catch (e) {}

const args = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--remote-debugging-port=9222',
  '--remote-allow-origins=*',
  `--user-data-dir=${tmpDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--disable-translate',
  '--window-size=1440,900',
  'http://127.0.0.1:3030/'
];

console.log('Starting headless Chrome for DevTools MCP on port 9222...');
const p = spawn(chromePath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
p.on('exit', (code, sig) => {
  console.log(`Headless Chrome exited with code ${code}, signal ${sig}`);
  process.exit(code || 0);
});
p.on('error', (err) => {
  console.error('Failed to spawn Chrome:', err);
  process.exit(1);
});

// Keep process running
process.on('SIGINT', () => p.kill('SIGINT'));
process.on('SIGTERM', () => p.kill('SIGTERM'));
