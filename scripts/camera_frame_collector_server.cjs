const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 8097;
const TOTAL_FRAMES = 72;
const STORYBOARD_BEATS = 8;
const FRAMES_DIR = path.resolve('public/videos/frames_clay');
const STORYBOARDS_DIR = path.resolve('public/storyboards_clay');
const VIDEOS_DIR = path.resolve('public/videos');

fs.mkdirSync(FRAMES_DIR, { recursive: true });
fs.mkdirSync(STORYBOARDS_DIR, { recursive: true });
fs.mkdirSync(VIDEOS_DIR, { recursive: true });

let receivedFrames = 0;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  if (req.method === 'POST' && req.url === '/upload-frame') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const base64Data = payload.dataUrl.replace(/^data:image\/jpeg;base64,/, '');
        const filename = `frame_${String(payload.index).padStart(4, '0')}.jpg`;
        const filepath = path.join(FRAMES_DIR, filename);
        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(filepath, buffer);

        if (payload.index === 0) {
          fs.writeFileSync('public/models/blockout_first_frame.jpg', buffer);
          console.log('📸 Stage 1 Viewport Still saved: public/models/blockout_first_frame.jpg');
        }

        const beatStep = Math.floor(TOTAL_FRAMES / STORYBOARD_BEATS);
        if (payload.index % beatStep === 0 && Math.floor(payload.index / beatStep) < STORYBOARD_BEATS) {
          const beatIdx = Math.floor(payload.index / beatStep);
          const beatFilename = `beat_${String(beatIdx).padStart(2, '0')}.jpg`;
          fs.writeFileSync(path.join(STORYBOARDS_DIR, beatFilename), buffer);
          console.log(`📸 Storyboard Beat ${beatIdx + 1}/${STORYBOARD_BEATS} saved: ${beatFilename}`);
        }

        receivedFrames++;
        if (receivedFrames % 12 === 0 || receivedFrames === TOTAL_FRAMES) {
          console.log(`🎬 Captured Frame ${receivedFrames}/${TOTAL_FRAMES} (${Math.round(receivedFrames / TOTAL_FRAMES * 100)}%)`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', received: receivedFrames }));
      } catch (err) {
        res.writeHead(500);
        res.end(err.message);
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/done') {
    console.log('🎉 All frames collected! Compiling MP4 via ffmpeg...');
    const outMp4 = path.join(VIDEOS_DIR, 'google_tiles_clay_blockout_camera.mp4');
    const cmd = `ffmpeg -y -framerate 24 -i "${FRAMES_DIR}/frame_%04d.jpg" -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart "${outMp4}"`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error('ffmpeg compilation failed:', err);
        res.writeHead(500);
        return res.end(err.message);
      }
      const stats = fs.statSync(outMp4);
      console.log(`✅ Watertight blockout camera MP4 compiled: ${outMp4} (${(stats.size / 1024).toFixed(1)} KB)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'complete', sizeBytes: stats.size }));
      setTimeout(() => process.exit(0), 1000);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`📡 Frame Collector Server listening on http://127.0.0.1:${PORT}`);
});
