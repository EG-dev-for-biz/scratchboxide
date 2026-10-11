const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const DEMO_HTML = path.resolve(__dirname, '../public/hyperreal_map_tile_group_demo.html');
const OUT_FILE = '/tmp/electron_test_shot.png';

app.whenReady().then(async () => {
  try {
    console.log('[Electron Test] Creating hidden window...');
    const win = new BrowserWindow({
      width: 1920,
      height: 1080,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false,
        allowRunningInsecureContent: true
      }
    });

    console.log('[Electron Test] Loading file: ' + DEMO_HTML);
    await win.loadFile(DEMO_HTML);

    console.log('[Electron Test] Waiting 4s for Three.js & GLB to render...');
    await new Promise(r => setTimeout(r, 4000));

    console.log('[Electron Test] Capturing page...');
    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    fs.writeFileSync(OUT_FILE, png);
    console.log(`[Electron Test] Saved ${OUT_FILE} (${(png.length / 1024).toFixed(1)} KB)`);

    app.quit();
  } catch (err) {
    console.error('[Electron Test] Error:', err);
    app.exit(1);
  }
});
