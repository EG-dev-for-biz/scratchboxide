const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function main() {
    // 1. Static server
    const server = http.createServer((req, res) => {
        let filePath = path.join(__dirname, '..', 'public', req.url.split('?')[0]);
        if (req.url === '/' || req.url.startsWith('/?')) filePath = path.join(__dirname, '..', 'public', 'spatial_photoreal_3dgs_demo.html');
        if (!fs.existsSync(filePath)) {
            res.writeHead(404);
            return res.end('Not found');
        }
        const ext = path.extname(filePath);
        const mimeTypes = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.cjs': 'application/javascript',
            '.css': 'text/css',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.glb': 'model/gltf-binary',
            '.spz': 'application/octet-stream',
            '.json': 'application/json'
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
    });

    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;

    const os = require('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-inspect-'));
    const cdpPort = 9299;

    // 2. Headless Chrome
    const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
        '--headless=new',
        '--remote-debugging-port=' + cdpPort,
        '--user-data-dir=' + tmpDir,
        '--disable-gpu-watchdog',
        '--no-sandbox',
        `http://127.0.0.1:${port}/spatial_photoreal_3dgs_demo.html?model=colosseum_pbr&mode=clay&cam=135,38,45&target=-15,22,20`
    ]);

    const httpGet = (url) => new Promise((resolve, reject) => {
        http.get(url, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });

    // Retry connect CDP
    let targets = null;
    for (let i = 0; i < 20; ++i) {
        await new Promise(r => setTimeout(r, 500));
        try {
            targets = await httpGet(`http://127.0.0.1:${cdpPort}/json`);
            if (targets && targets.length > 0) break;
        } catch {}
    }
    if (!targets || !targets[0]) throw new Error('Failed to connect to Chrome CDP');
    const wsUrl = targets[0].webSocketDebuggerUrl;
    const WebSocket = require('ws');
    const ws = new WebSocket(wsUrl);
    await new Promise(r => ws.on('open', r));

    let msgId = 1;
    function send(method, params = {}) {
        return new Promise((resolve) => {
            const id = msgId++;
            const handler = (data) => {
                const res = JSON.parse(data);
                if (res.id === id) {
                    ws.off('message', handler);
                    resolve(res.result);
                }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.method === 'Runtime.consoleAPICalled') {
            console.log('[BROWSER CONSOLE]', msg.params.type, msg.params.args.map(a => a.value || a.description).join(' '));
        } else if (msg.method === 'Network.loadingFailed') {
            console.log('[NETWORK FAIL]', msg.params.errorText, msg.params.requestId);
        }
    });

    await send('Runtime.enable');
    await send('Network.enable');

    // Wait 5s for model load
    await new Promise(r => setTimeout(r, 6000));

    // Evaluate
    const evalRes = await send('Runtime.evaluate', {
        expression: `
            (() => {
                const mesh = window.scene && window.scene.getObjectByName('SurveyClayMesh');
                let info = [];
                if (mesh) {
                    mesh.traverse(o => {
                        if (o.isMesh && o.material && o.material.userData && o.material.userData.delightUniforms) {
                            const u = o.material.userData.delightUniforms;
                            const tex = u.uStoneDetailMap ? u.uStoneDetailMap.value : null;
                            info.push({
                                name: o.name,
                                matType: o.material.type,
                                delightEnabled: u.uDelightEnabled ? u.uDelightEnabled.value : null,
                                detailStrength: u.uStoneDetailStrength ? u.uStoneDetailStrength.value : null,
                                detailScale: u.uStoneDetailScale ? u.uStoneDetailScale.value : null,
                                texLoaded: tex ? !!tex.image : false,
                                texWidth: (tex && tex.image) ? tex.image.width : 0,
                                texHeight: (tex && tex.image) ? tex.image.height : 0
                            });
                        }
                    });
                }
                return JSON.stringify({
                    info,
                    sharedTexLoaded: !!(window.sharedStoneDetailTex && window.sharedStoneDetailTex.image),
                    sharedTexSize: (window.sharedStoneDetailTex && window.sharedStoneDetailTex.image) ? [window.sharedStoneDetailTex.image.width, window.sharedStoneDetailTex.image.height] : null
                });
            })()
        `,
        returnByValue: true
    });

    console.log('UNIFORMS INSPECTION:', JSON.stringify(evalRes, null, 2));

    ws.close();
    chromeProc.kill();
    server.close();
}

main().catch(console.error);
