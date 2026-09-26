const http = require('http');
const fs = require('fs');
const path = require('path');

const port = process.env.PORT || 8137;
const rootDir = path.resolve(__dirname, '../public');

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml'
};

const { execSync } = require('child_process');

const server = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/save-frame') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { index, data } = JSON.parse(body);
        const base64Data = data.replace(/^data:image\/(jpeg|png);base64,/, '');
        const framesDir = path.join(rootDir, 'videos/frames_clay_plaza');
        if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });
        const filename = path.join(framesDir, `frame_${String(index).padStart(4, '0')}.jpg`);
        fs.writeFileSync(filename, Buffer.from(base64Data, 'base64'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, index }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/compile-clay-video') {
    try {
      const framesDir = path.join(rootDir, 'videos/frames_clay_plaza');
      const outClayVideo = path.join(rootDir, 'videos/plaza_hotel_clay_blockout_camera.mp4');
      const canonicalBlockout = path.join(rootDir, 'videos/plaza_hotel_blockout_camera.mp4');
      console.log('🎬 Compiling 361 clay frames to MP4...');
      execSync(`ffmpeg -y -framerate 24 -i "${path.join(framesDir, 'frame_%04d.jpg')}" -c:v libx264 -pix_fmt yuv420p -preset fast -crf 18 -movflags +faststart "${outClayVideo}"`);
      fs.copyFileSync(outClayVideo, canonicalBlockout);
      console.log('📸 Updating 25 keyframe snapshots...');
      execSync('node scripts/extract_dense_matchmove_keyframes.cjs', { cwd: path.resolve(__dirname, '..') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, video: 'videos/plaza_hotel_clay_blockout_camera.mp4' }));
    } catch (e) {
      console.error('Compile error:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  let reqPath = decodeURI(req.url.split('?')[0]);
  if (reqPath === '/' || reqPath === '') reqPath = '/plaza_matchmove_demo.html';
  const filePath = path.join(rootDir, reqPath);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`🚀 Plaza Hotel Matchmove Demo Server running at http://127.0.0.1:${port}/plaza_matchmove_demo.html`);
});
