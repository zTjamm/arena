'use strict';

/**
 * Запуск всех проверок на свежей базе.
 *
 *     npm test
 *
 * Зачем обёртка, а не цепочка `node test-*.js && ...`:
 *
 * Проверки аккаунтов пишут в базу, и **оставляют её в том виде, в каком
 * оставили**. Второй прогон в той же базе падал на
 * `test-accounts.js:79` — `r.user` оказывался неопределённым, потому что
 * ник уже был занят. Проверено: три запуска подряд изолированно проходят,
 * два подряд в одной базе — второй падает. То есть тест был не
 * герметичен, и это выглядело как «тесты мигают».
 *
 * На сервере спасало только то, что `deploy.sh` подставлял перед `npm
 * test` свежую временную папку через `DATA_DIR`. Локально её не было, и
 * тесты ходили по **настоящему** `data/users.json` — рядом с работающим
 * сервером. Кто-то другой такой прогон на середине мог оставить боевых
 * пользователей без базы.
 *
 * Теперь папка создаётся здесь и удаляется после, независимо от того,
 * откуда запустили.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const FILES = [
    'test-arena.js',
    'test-play.js',
    'test-bot.js',
    'test-lobby.js',
    'test-accounts.js',
    'test-lerp.js',
];

function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-test-'));
    process.env.DATA_DIR = dir;

    let failed = 0;
    try {
        for (const file of FILES) {
            const res = spawnSync(process.execPath, [file], {
                cwd: ROOT,
                stdio: 'inherit',
                env: process.env,
            });
            if (res.status !== 0) failed++;
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    process.exit(failed ? 1 : 0);
}

main();