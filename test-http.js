const http = require('http');
function waitForHttp(url, timeoutMs = 3000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        function check() {
            const req = http.get(url, (res) => {
                console.log('Status:', res.statusCode);
                if (res.statusCode && res.statusCode < 500) {
                    resolve();
                } else {
                    retry();
                }
            });
            req.on('error', (err) => { console.log('Error:', err.message); retry(); });
            req.on('timeout', () => { console.log('Timeout emitted'); req.destroy(); retry(); });
            req.setTimeout(1000);
        }
        function retry() {
            if (Date.now() - start > timeoutMs) {
                reject(new Error(`Timeout waiting for ${url}`));
            } else {
                setTimeout(check, 250);
            }
        }
        check();
    });
}
waitForHttp('http://127.0.0.1:3001/').then(() => console.log('OK')).catch(console.error);
