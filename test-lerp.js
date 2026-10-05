'use strict';

// Проверка настоящей функции lerpSnap из отдаваемого client.js.
//
// Функция вытаскивается из файла как есть и прогоняется на двух
// снимках: так тестируется именно тот код, который уедет в браузер.

const fs = require('fs');

const src = fs.readFileSync('public/client.js', 'utf8');

// Вырезаем тело функции целиком.
const start = src.indexOf('function lerpSnap');
if (start < 0) throw new Error('lerpSnap не найдена');
let depth = 0;
let i = src.indexOf('{', start);
const from = i;
for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
    }
}
const text = src.slice(start, i + 1);

// eslint-disable-next-line no-eval
const lerpSnap = eval('(' + text + ')');

const DEG = Math.PI / 180;
const ang = (p) => Math.round(Math.atan2(p.diry, p.dirx) / DEG * 100) / 100;
const len = (p) => Math.hypot(p.dirx, p.diry);

function snap(dirDeg, id) {
    const r = dirDeg * DEG;
    return {
        tick: 1,
        players: [{
            id: id || 'p',
            x: 0, y: 0, vx: 0, vy: 0,
            dirx: Math.round(Math.cos(r) * 1000) / 1000,
            diry: Math.round(Math.sin(r) * 1000) / 1000,
            stone: 0, swing: 0, alive: true,
        }],
    };
}

let fails = 0;
function check(name, ok, detail) {
    console.log((ok ? '  ок   ' : '  ФЕЙЛ ') + name + (detail ? '  — ' + detail : ''));
    if (!ok) fails++;
}

console.log('ТЕСТ lerpSnap (из public/client.js)');
console.log('');

// 1. Нос сглаживается.
{
    const a = snap(0);
    const b = snap(20);
    const mid = lerpSnap(a, b, 0.5).players[0];
    check('нос интерполируется: 0° и 20° -> середина',
        Math.abs(ang(mid) - 10) < 1.5, 'получилось ' + ang(mid) + '°');
}

// 2. Направление остаётся единичным.
{
    const mid = lerpSnap(snap(0), snap(37), 0.3).players[0];
    check('вектор остаётся единичным', Math.abs(len(mid) - 1) < 0.001,
        'длина ' + len(mid).toFixed(6));
}

// 3. Переход через ±180° идёт коротким путём, а не через 0.
{
    const a = snap(179);
    const b = snap(-179);
    const mid = lerpSnap(a, b, 0.5).players[0];
    // Верное направление — 180°, а не 0°.
    check('переход через ±180° идёт коротким путём',
        Math.abs(Math.abs(ang(mid)) - 180) < 3, 'получилось ' + ang(mid) + '°');
}

// 4. Начало и конец совпадают с исходными.
{
    const b = snap(50);
    check('при k=0 нос = первый снимок',
        Math.abs(ang(lerpSnap(snap(0), b, 0).players[0]) - 0) < 0.01);
    check('при k=1 нос = второй снимок',
        Math.abs(ang(lerpSnap(snap(0), b, 1).players[0]) - 50) < 0.01);
}

// 5. Координаты сглаживаются, как и раньше.
{
    const a = snap(0); a.players[0].x = 0;
    const b = snap(0); b.players[0].x = 100;
    const mid = lerpSnap(a, b, 0.25).players[0];
    check('координаты по-прежнему сглаживаются', Math.abs(mid.x - 25) < 0.01,
        'x = ' + mid.x);
}

// 6. Только что появившийся нос (нулевой вектор) не даёт ложного направления.
{
    const a = { tick: 1, players: [{ id: 'p', x: 0, y: 0, vx: 0, vy: 0,
        dirx: 0, diry: 0, stone: 0, swing: 0, alive: true }] };
    const b = snap(80);
    const mid = lerpSnap(a, b, 0.5).players[0];
    check('нулевой нос не превращается в выдуманный',
        Math.abs(len(mid) - 1) < 0.001, 'длина ' + len(mid).toFixed(6));
}

// 7. Игрок, которого не было в прошлом снимке, не ломает разбор.
{
    const a = snap(0);
    const b = snap(0); b.players.push({ id: 'new', x: 5, y: 5, vx: 0, vy: 0,
        dirx: 1, diry: 0, stone: 0, swing: 0, alive: true });
    const out = lerpSnap(a, b, 0.5);
    const nu = out.players.find(p => p.id === 'new');
    check('новый игрок проходит без изменений',
        out.players.length === 2 && nu && nu.x === 5);
}

// 8. Плавность: сколько разных углов за секунду поворота.
{
    // Снимки приходят на 30 Гц, экран 60 Гц — как в игре.
    let a = snap(0);
    let b = snap(315 / 30);       // нос крутится на 315°/с, как при 5.5 рад/с
    const shown = new Set();
    const shownNoLerp = new Set();
    for (let f = 0; f < 60; f++) {
        const t = f / 60;
        const i0 = Math.floor(t * 30);
        const k = t * 30 - i0;
        // с интерполяцией — между двумя снимками
        shown.add(Math.round(ang(lerpSnap(snap(i0 * 10.5), snap((i0 + 1) * 10.5), k).players[0]) * 100));
        // без интерполяции — последний пришедший
        shownNoLerp.add(Math.round(ang(snap(i0 * 10.5).players[0]) * 100));
    }
    check('без интерполяции углов вдвое меньше, чем кадров',
        shownNoLerp.size === 30 && shown.size === 60,
        'было ' + shownNoLerp.size + ', стало ' + shown.size);
}

console.log('');
console.log(fails === 0
    ? 'все проверки пройдены'
    : 'провалено: ' + fails);
process.exit(fails === 0 ? 0 : 1);