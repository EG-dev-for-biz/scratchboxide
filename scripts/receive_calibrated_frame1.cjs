const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8199;
const artifactDir = '/Users/eligreen/.gemini/antigravity/brain/9cd6845c-841b-493a-8c62-35af56cd0f4d';
const publicImagesDir = path.resolve(__dirname, '../public/images');

const savedFiles = [];

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { name, data } = JSON.parse(body);
        const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        if (name === 'blockout') {
          const p1 = path.join(publicImagesDir, 'dense_plaza_blockout_kf01_f1.png');
          const p2 = path.join(artifactDir, 'dense_plaza_blockout_kf01_f1.png');
          fs.writeFileSync(p1, buffer);
          fs.writeFileSync(p2, buffer);
          savedFiles.push(p1, p2);
          console.log(`Saved blockout: ${p1} (${buffer.length} bytes)`);
        } else if (name === 'split') {
          const p1 = path.join(publicImagesDir, 'dense_plaza_comparison_kf01_f1.png');
          const p2 = path.join(artifactDir, 'plaza_matchmove_frame1_split.png');
          fs.writeFileSync(p1, buffer);
          fs.writeFileSync(p2, buffer);
          savedFiles.push(p1, p2);
          console.log(`Saved split: ${p1} (${buffer.length} bytes)`);
        } else if (name === 'edge') {
          const p1 = path.join(artifactDir, 'plaza_matchmove_frame1_edge_overlay.png');
          fs.writeFileSync(p1, buffer);
          savedFiles.push(p1);
          console.log(`Saved edge overlay: ${p1} (${buffer.length} bytes)`);
        } else if (name === 'alpha') {
          const p1 = path.join(artifactDir, 'plaza_matchmove_frame1_alpha_overlay.png');
          fs.writeFileSync(p1, buffer);
          savedFiles.push(p1);
          console.log(`Saved alpha overlay: ${p1} (${buffer.length} bytes)`);
        } else if (name === 'diff') {
          const p1 = path.join(artifactDir, 'plaza_matchmove_frame1_diff_overlay.png');
          fs.writeFileSync(p1, buffer);
          savedFiles.push(p1);
          console.log(`Saved diff overlay: ${p1} (${buffer.length} bytes)`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, name, size: buffer.length }));
      } catch (err) {
        console.error('Error saving image:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Frame 1 Asset Receiver running on http://127.0.0.1:${PORT}`);
});
