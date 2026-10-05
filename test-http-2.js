const http = require('http');
http.get('http://127.0.0.1:3030/', (res) => {
    console.log('3030 Status:', res.statusCode);
}).on('error', (err) => {
    console.error('3030 Error:', err);
});
http.get('http://127.0.0.1:3001/', (res) => {
    console.log('3001 Status:', res.statusCode);
}).on('error', (err) => {
    console.error('3001 Error:', err);
});
