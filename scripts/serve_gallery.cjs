const path = require('path');
const express = require(path.resolve(__dirname, '../desktop-app/node_modules/express'));

const app = express();
const port = 5173;
const publicDir = path.resolve(__dirname, '../public');

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

app.use(express.static(publicDir, {
  acceptRanges: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
    } else if (filePath.endsWith('.webm')) {
      res.setHeader('Content-Type', 'video/webm');
    }
  }
}));

app.listen(port, '127.0.0.1', () => {
  console.log(`Gallery server running at http://127.0.0.1:${port}/s4d_multi_gallery.html`);
});
