'use strict';

/**
 * Приёмник картинки с холста, чтобы рассмотреть её глазами.
 *
 *     node tools/shot.js            → http://127.0.0.1:8199
 *
 * Страница шлёт PNG методом POST, файл кладётся в tools/out-*.png.
 * Инструмент только для проверки отрисовки, в игре не участвует и
 * в репозиторий не должен попадать — отсюда и .gitignore на out-*.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8199;
const OUT = path.join(__dirname);

http.createServer((req, res) => {
    if (req.method !== 'POST') {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
        res.end('ok');
        return;
    }

    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        const b64 = raw.includes(',') ? raw.split(',')[1] : raw;
        const name = `out-${Date.now()}.png`;
        fs.writeFileSync(path.join(OUT, name), Buffer.from(b64, 'base64'));
        console.log('сохранено', name);
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
        res.end('ok');
    });
}).listen(PORT, '127.0.0.1', () => console.log('приёмник на ' + PORT));
