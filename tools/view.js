'use strict';

/**
 * Собирает бандл и поднимает статический сервер, чтобы страницу было
 * смотреть по адресу, а не через file:// (оттуда не грузятся модули).
 *
 *     npm run view              → http://127.0.0.1:8200/
 *     PORT=9000 npm run view    → свой порт
 *     node tools/bundle.js      → только пересобрать public/bundle.js
 *
 * Зависимостей нет нарочно: express и socket.io появятся вместе с
 * сервером самой игры, а для просмотра ботов нужен только node:http.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const { build } = require('./bundle');

const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 8200;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

/** Статика из public/. Запрос за его пределы отбрасывается. */
function serve() {
    const server = http.createServer((req, res) => {
        const raw = (req.url || '/').split('?')[0];

        let rel;
        try {
            rel = decodeURIComponent(raw);
        } catch (e) {
            res.writeHead(400);
            res.end('bad request');
            return;
        }
        if (rel === '/') rel = '/bots.html';
        if (!rel.startsWith('/')) rel = '/' + rel;

        const file = path.resolve(PUBLIC, '.' + rel);
        if (!file.startsWith(PUBLIC + path.sep)) {
            res.writeHead(403);
            res.end('forbidden');
            return;
        }

        fs.readFile(file, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('не найдено: ' + rel);
                return;
            }
            res.writeHead(200, {
                'Content-Type': TYPES[path.extname(file).toLowerCase()]
                    || 'application/octet-stream',
                'Cache-Control': 'no-store',
            });
            res.end(data);
        });
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error('Порт ' + PORT + ' занят. Запусти с другим: PORT=8201 npm run view');
            process.exit(1);
        }
        throw err;
    });

    server.listen(PORT, '127.0.0.1', () => {
        console.log('Арена — просмотрщик ботов');
        console.log('  http://127.0.0.1:' + PORT + '/');
        console.log('Ctrl+C — остановить');
    });
}

build();
serve();
