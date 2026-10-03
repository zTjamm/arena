'use strict';

/**
 * Рисование героев и вылетающей руки.
 *
 * Вынесено из render.js отдельным файлом не ради порядка, а ради
 * размера: восемь героев с ушками, хвостами и мордами занимают больше
 * половины рисовальщика, и вперемешку с полем, прицелом и панелью
 * его уже невозможно читать.
 *
 * Все размеры — в долях радиуса игрока. Поэтому герой одинаково
 * выглядит и в окне на ноутбуке, и в маленьком поле на телефоне:
 * масштабируется вместе с игроком и остаётся резким.
 */

const { heroOf } = require('./heroes');

/**
 * Телосложение, голова и отличительные детали.
 *
 * Порядок важен: сначала тень, потом тело, потом хвост и ушки, и
 * только потом голова. Если наоборот — ушки уезжают под лицо, и пёс
 * становится неотличим от кошки.
 */
function drawHero(ctx, index, r, spin) {
    const hero = heroOf(index);

    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = Math.max(1.5, r * 0.1);

    // Призрак держится полупрозрачным: он должен читаться как
    // «не совсем тут», иначе восемь героев выглядят одинаково плотными.
    if (hero.ghost) ctx.globalAlpha = 0.72;

    drawBody(ctx, hero, r);
    drawTail(ctx, hero, r, spin);
    drawHead(ctx, hero, r);
    drawFace(ctx, hero, r);

    ctx.restore();
}

function drawBody(ctx, hero, r) {
    ctx.beginPath();
    ctx.fillStyle = hero.cloth;

    if (hero.id === 'robot') {
        // Робот — угловатый корпус, единственный прямой угол в игре.
        ctx.rect(-r * 0.72, -r * 0.12, r * 1.44, r * 0.98);
    } else if (hero.ghost) {
        // Призрак — волнистый подол вместо ног.
        ctx.moveTo(-r * 0.72, -r * 0.12);
        ctx.lineTo(r * 0.72, -r * 0.12);
        ctx.lineTo(r * 0.72, r * 0.48);
        ctx.quadraticCurveTo(r * 0.36, r * 0.26, 0, r * 0.56);
        ctx.quadraticCurveTo(-r * 0.36, r * 0.86, -r * 0.72, r * 0.48);
        ctx.closePath();
    } else {
        ctx.arc(0, r * 0.42, r * 0.78, 0, Math.PI * 2);
    }

    ctx.fill();
    ctx.stroke();
}

function drawHead(ctx, hero, r) {
    const hy = -r * 0.28;

    ctx.beginPath();
    if (hero.id === 'robot') {
        ctx.rect(-r * 0.62, hy - r * 0.58, r * 1.24, r * 1.1);
    } else if (hero.id === 'alien') {
        ctx.ellipse(0, hy, r * 0.76, r * 0.62, 0, 0, Math.PI * 2);
    } else if (hero.id === 'knight') {
        // Шлем: полукруг сверху и прямые щёки.
        ctx.arc(0, hy, r * 0.72, Math.PI, 0);
        ctx.lineTo(r * 0.72, hy + r * 0.32);
        ctx.lineTo(-r * 0.72, hy + r * 0.32);
        ctx.closePath();
    } else {
        ctx.arc(0, hy, r * 0.68, 0, Math.PI * 2);
    }

    ctx.fillStyle = hero.id === 'knight' ? hero.cloth : hero.skin;
    ctx.fill();
    ctx.stroke();

    // Причёска: шапка поверх круглой головы. У рыцаря и робота её нет.
    if (hero.hair && hero.id !== 'knight' && hero.id !== 'robot') {
        ctx.beginPath();
        ctx.arc(0, hy - r * 0.08, r * 0.66, Math.PI * 1.06, Math.PI * 1.94);
        ctx.fillStyle = hero.hair;
        ctx.fill();
    }
}

function drawTail(ctx, hero, r, spin) {
    if (hero.ears) {
        ctx.fillStyle = hero.dark;

        if (hero.ears === 'floppy') {
            // Пёс: уши висят вдоль головы, овалы с наклоном.
            for (const s of [-1, 1]) {
                ctx.beginPath();
                ctx.ellipse(s * r * 0.66, -r * 0.14, r * 0.19, r * 0.42,
                    s * 0.3, 0, Math.PI * 2);
                ctx.fill();
            }
        } else {
            // Кошка: уши торчком треугольниками.
            for (const s of [-1, 1]) {
                ctx.beginPath();
                ctx.moveTo(s * r * 0.46, -r * 0.58);
                ctx.lineTo(s * r * 0.82, -r * 1.1);
                ctx.lineTo(s * r * 0.9, -r * 0.42);
                ctx.closePath();
                ctx.fill();
            }
        }
    }

    if (hero.tail === 'ponytail') {
        ctx.strokeStyle = hero.hair;
        ctx.lineWidth = Math.max(2, r * 0.2);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.5);
        ctx.quadraticCurveTo(-r * 0.7, -r * 0.9, -r * 0.5, -r * 0.25);
        ctx.stroke();
        ctx.lineCap = 'butt';
        return;
    }

    if (hero.tail === 'wag' || hero.tail === 'long') {
        const dog = hero.id === 'dog';
        // Хвост качается: у пса короткий и быстрый, у кошки длинный
        // и медленный. Частота тоже разная, иначе оба выглядели бы
        // одним и тем же маятником.
        const wag = Math.sin(spin * (dog ? 11 : 6)) * r * (dog ? 0.26 : 0.4);
        const len = dog ? r * 0.75 : r * 1.2;

        ctx.strokeStyle = dog ? hero.dark : hero.cloth;
        ctx.lineWidth = Math.max(2, r * (dog ? 0.22 : 0.15));
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-r * 0.52, r * 0.28);
        ctx.quadraticCurveTo(
            -r * 0.52 - len * 0.6, r * 0.08 + wag,
            -r * 0.52 - len, r * 0.42 + wag * 0.5
        );
        ctx.stroke();
        ctx.lineCap = 'butt';
    }
}

function drawFace(ctx, hero, r) {
    const hy = -r * 0.28;

    switch (hero.id) {
        case 'dog': {
            // Морда: вытянутый нос и круглый нос сверху.
            ctx.fillStyle = hero.dark;
            ctx.beginPath();
            ctx.ellipse(0, hy + r * 0.36, r * 0.28, r * 0.2, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(0, hy + r * 0.2, r * 0.11, 0, Math.PI * 2);
            ctx.fill();
            dots(ctx, hy, r);
            break;
        }

        case 'cat': {
            // Усы в обе стороны плюс узкие глаза-щели.
            dots(ctx, hy, r, r * 0.1);
            ctx.strokeStyle = hero.dark;
            ctx.lineWidth = Math.max(1, r * 0.055);
            for (const s of [-1, 1]) {
                for (let i = -1; i <= 1; i++) {
                    ctx.beginPath();
                    ctx.moveTo(s * r * 0.18, hy + r * 0.24);
                    ctx.lineTo(s * r * 0.62, hy + r * 0.24 + i * r * 0.13);
                    ctx.stroke();
                }
            }
            break;
        }

        case 'robot': {
            // Антенна с лампочкой и два светящихся глаза.
            ctx.strokeStyle = hero.dark;
            ctx.lineWidth = Math.max(1, r * 0.09);
            ctx.beginPath();
            ctx.moveTo(0, hy - r * 0.58);
            ctx.lineTo(0, hy - r * 1.02);
            ctx.stroke();

            ctx.fillStyle = '#ff5d7a';
            ctx.beginPath();
            ctx.arc(0, hy - r * 1.06, r * 0.13, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#0c111c';
            for (const s of [-1, 1]) {
                ctx.beginPath();
                ctx.fillRect(s * r * 0.36 - r * 0.14, hy - r * 0.12,
                    r * 0.28, r * 0.2);
            }
            break;
        }

        case 'alien': {
            // Два больших овала и маленькая дуга-рот.
            ctx.fillStyle = '#101820';
            for (const s of [-1, 1]) {
                ctx.beginPath();
                ctx.ellipse(s * r * 0.28, hy - r * 0.02,
                    r * 0.23, r * 0.29, 0, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.strokeStyle = hero.dark;
            ctx.lineWidth = Math.max(1, r * 0.07);
            ctx.beginPath();
            ctx.arc(0, hy + r * 0.3, r * 0.15, 0.2 * Math.PI, 0.8 * Math.PI);
            ctx.stroke();
            break;
        }

        case 'knight': {
            // Щель шлема и гребень — вертикаль, которой нет у остальных.
            ctx.strokeStyle = hero.dark;
            ctx.lineWidth = Math.max(1, r * 0.1);
            ctx.beginPath();
            ctx.moveTo(-r * 0.5, hy + r * 0.04);
            ctx.lineTo(r * 0.5, hy + r * 0.04);
            ctx.stroke();

            ctx.fillStyle = hero.dark;
            ctx.beginPath();
            ctx.rect(-r * 0.09, hy - r * 1.12, r * 0.18, r * 0.5);
            ctx.fill();
            break;
        }

        default:
            // Мальчик, девочка и призрак — просто глаза. У призрака
            // их нет вовсе, и это ещё один его признак.
            if (!hero.ghost) dots(ctx, hy, r);
    }
}

function dots(ctx, hy, r, size) {
    ctx.fillStyle = '#101820';
    for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(s * r * 0.24, hy, size || r * 0.11, 0, Math.PI * 2);
        ctx.fill();
    }
}

/**
 * Вылет руки при толчке.
 *
 * Раньше удар рисовался расходящимся клином, и это читалось как
 * взрыв. Но толчок бьют **рукой**, и рука должна вылететь вперёд,
 * упереться в соперника и вернуться.
 *
 * Три фазы по времени k: 0–0.4 разгон от тела, 0.4–0.7 рука впереди,
 * дальше возврат. Движение сглажено через smoothstep — разгон в начале
 * заметно быстрее отмаха рукой, чем равномерное хождение туда-обратно.
 *
 * Ладонь — круг, пальцы — четыре линии, большой палец — сбоку: без него
 * кисть читается как варежка.
 */
function drawHand(ctx, sx, sy, fx, fy, r, k, color) {
    let travel;
    if (k < 0.4) travel = k / 0.4;
    else if (k < 0.7) travel = 1;
    else travel = 1 - (k - 0.7) / 0.3;

    const reach = travel * travel * (3 - 2 * travel);
    const dist = r * 0.4 + reach * r * 2.6;

    ctx.save();

    // След отмаха: три угасающие линии позади руки. Без них удар
    // выглядит как просто появившийся рядом кулак, а не как удар.
    const ux = -fy;
    const uy = fx;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineCap = 'round';
    for (let i = 1; i <= 3; i++) {
        const back = reach * r * i * 0.7;
        ctx.globalAlpha = (1 - k) * 0.35 / i;
        ctx.lineWidth = Math.max(1.5, r * 0.16);
        ctx.beginPath();
        ctx.moveTo(sx + fx * (dist - back) + ux * r * 0.1,
            sy + fy * (dist - back) + uy * r * 0.1);
        ctx.lineTo(sx + fx * (dist - back) - ux * r * 0.1,
            sy + fy * (dist - back) - uy * r * 0.1);
        ctx.stroke();
    }
    ctx.lineCap = 'butt';

    ctx.translate(sx + fx * dist, sy + fy * dist);
    ctx.rotate(Math.atan2(fy, fx));
    ctx.globalAlpha = Math.max(0, 1 - k * 0.75);

    // Тёмный контур под рукой: без него на тёмном поле ладонь того же
    // тона, что и герой, сливается с ним.
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.56, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(12,17,28,0.75)';
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, r * 0.52, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, r * 0.19);
    ctx.lineCap = 'round';
    for (let i = -1; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(r * 0.26, i * r * 0.2);
        ctx.lineTo(r * 0.78, i * r * 0.23);
        ctx.stroke();
    }
    // Большой палец.
    ctx.beginPath();
    ctx.moveTo(-r * 0.12, r * 0.32);
    ctx.lineTo(-r * 0.44, r * 0.54);
    ctx.stroke();
    ctx.lineCap = 'butt';

    ctx.restore();
}

module.exports = { drawHero, drawHand };