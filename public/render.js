'use strict';

/**
 * Рисует один кадр по снимку симуляции.
 *
 * Общая часть просмотрщика ботов и сетевого клиента: снимок приходит
 * либо из локальной петли, либо по сокету, форма у них одна. Поэтому
 * здесь нет ничего, кроме картинки — ни сети, ни игровой логики, ни
 * знания о том, кто живой в реальном времени.
 *
 * Мир центрирован в (0, 0), единица измерения — одна единица поля.
 * Масштаб и центр холста считает вызывающий через fit(), чтобы
 * картинка одинаково вставала и в окно, и в маленький виджет.
 */

const { T, marginOf, chargeTier } = require('../game/arena');
const { drawHero, drawHand } = require('./hero-draw');

/** Цвета, от которых раньше зависел весь рисунок. Остались для поля. */
const PALETTE = [
    '#4da3ff', // синий
    '#ff8a3d', // оранжевый
    '#57d982', // зелёный
    '#ff5d7a', // розовый
    '#b98cff', // сиреневый
    '#ffd23d', // жёлтый
    '#3ddad7', // бирюзовый
    '#9be15d', // салатовый
];

const BG = '#0c111c';
const FIELD_FILL = '#151c2b';
const LINE = '#e8f0ff';

/** Сколько живёт анимация удара. Короткая намеренно: толчок — событие,
 *  а не состояние, и затянувшийся веер просто мешал бы видеть поле. */
const PUSH_FX_MS = 320;

/** Сколько живёт вылет руки. Длиннее удара: рука летит вперёд, потом
 *  возвращается, и на одном веере она читалась бы как пятно. */
const HAND_MS = 260;

/**
 * Отлёт толчка в единицах поля. У толчка три ступени, и игрок должен
 * видеть, сколько именно набрал: пока эта дуга стоит на 100, рывком
 * на 300, а полным зарядом на 300 — ждать имеет смысл только в
 * последнем случае.
 */
function pushRange(tier) {
    return T.PUSH_TIERS[Math.max(0, Math.min(T.PUSH_TIERS.length - 1, tier - 1))];
}

/** Номер ступени заряда по накопленным секундам: 0, 1, 2 или 3. */
function tierOf(charge) {
    return chargeTier(charge);
}

function colorOf(index) {
    const n = PALETTE.length;
    return PALETTE[((index % n) + n) % n];
}

/**
 * Вписывает поле в холст. Запас 1.25 нужен, чтобы то, что вынесли за
 * границу, всё ещё было видно: момент вылета — главное, что стоит
 * показать, а вылетают-то как раз за пределы квадрата.
 *
 * inset.top и inset.bottom — полосы интерфейса поверх холста. Без них
 * поле центрируется по всему холсту и на низком окне наезжает на
 * панель кнопок внизу.
 */
function fit(width, height, size, inset = {}) {
    const top = inset.top || 0;
    const bottom = inset.bottom || 0;
    const availH = Math.max(1, height - top - bottom);
    const scale = Math.min(width, availH) / (size * 1.25);
    return {
        width,
        height,
        cx: width / 2,
        cy: top + availH / 2,
        scale,
        size,
    };
}

function drawField(ctx, snap, view) {
    const { cx, cy, scale } = view;
    const side = snap.size * scale;
    const left = cx - side / 2;
    const top = cy - side / 2;

    ctx.fillStyle = FIELD_FILL;
    ctx.fillRect(left, top, side, side);

    // Стартовый контур: на нём раскладываются игроки, по нему же
    // видно, насколько поля никто не покинул.
    const inner = side * 0.7;
    ctx.strokeStyle = 'rgba(232,240,255,0.07)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - inner / 2, cy - inner / 2, inner, inner);

    // Граница. Толстая и светлая: пересечь её — и партия для тебя
    // кончилась, это единственная граница во всей игре.
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 3;
    ctx.strokeRect(left, top, side, side);

    // Тонкий контур снаружи — зона, в которую выносят толчком.
    const out = side + 32 * scale;
    ctx.strokeStyle = 'rgba(232,240,255,0.10)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - out / 2, cy - out / 2, out, out);

    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(232,240,255,0.22)';
    ctx.fill();
}

/**
 * Выбывший остаётся на том месте, где пересёк границу: так по кадру
 * видно, кого и откуда вынесло, а не только итоговый список мест.
 */
function drawGhost(ctx, snap, view, p, index) {
    const sx = view.cx + p.x * view.scale;
    const sy = view.cy + p.y * view.scale;
    const r = T.PLAYER_RADIUS * view.scale;

    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.strokeStyle = colorOf(index);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);

    if (p.place != null) {
        ctx.fillStyle = LINE;
        ctx.font = `700 ${Math.max(9, Math.round(r))}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(p.place), sx, sy);
    }
    ctx.restore();
}

function facing(p) {
    let fx = p.dirx;
    let fy = p.diry;
    if (Math.hypot(fx, fy) < 0.1) {
        const s = Math.hypot(p.vx, p.vy);
        if (s > 1) {
            fx = p.vx / s;
            fy = p.vy / s;
        } else {
            fx = 1;
            fy = 0;
        }
    }
    return { fx, fy };
}

/* Откаты теперь звёздами над головой, см. drawStars ниже. Раньше
 * это были дуги вокруг игрока, и на восьми героях они перекрывали
 * друг друга и носики. */

/**
 * Прицел толчка для своего игрока.
 *
 * Яркая сплошная дуга на PUSH_RANGE — досягаемость удара: цель, чей
 * центр дальше этой дуги, в конус не попадает вообще. Пунктирная дуга
 * дальше — куда отлетит соперник при **текущем заряде**. Заряд идёт от
 * одной до трёх, и дуга растёт вместе с ним: 100, потом 200, потом
 * 300 единиц. Это и есть ответ на «а стоит ли ждать ещё секунду».
 *
 * Показывается только своему игроку: восемь таких прицелов на поле
 * превратились бы в кашу, а учиться надо на своём.
 * На откате дуги гаснут — заодно видно, что бить пока нельзя.
 */
function drawAim(ctx, view, sx, sy, p, ready, tier) {
    const { fx, fy } = facing(p);
    const angle = Math.atan2(fy, fx);
    const half = Math.acos(T.PUSH_COS);        // половина конуса удара
    const s = view.scale;
    const reach = T.PUSH_RANGE * s;
    const flight = pushRange(tier) * s;

    ctx.save();
    ctx.globalAlpha = ready ? 1 : 0.35;

    // Дальний край полёта: пунктир и пожиже цветом — это не граница
    // удара, а точка, куда соперник в конце концов приземлится.
    ctx.setLineDash([5, 8]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(232,240,255,0.45)';
    ctx.beginPath();
    ctx.arc(sx, sy, reach + flight, angle - half, angle + half);
    ctx.stroke();
    ctx.setLineDash([]);

    // Ось полёта со стрелкой: от досягаемости до конца отскока,
    // туда же, куда смотрит носик.
    const tipX = sx + fx * (reach + flight);
    const tipY = sy + fy * (reach + flight);
    ctx.strokeStyle = 'rgba(232,240,255,0.40)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx + fx * (reach + 4 * s), sy + fy * (reach + 4 * s));
    ctx.lineTo(tipX - fx * 13, tipY - fy * 13);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - fx * 13 + fy * 6, tipY - fy * 13 - fx * 6);
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - fx * 13 - fy * 6, tipY - fy * 13 + fx * 6);
    ctx.stroke();

    // Досягаемость: главное, что нужно видеть перед ударом.
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#7fd0ff';
    ctx.beginPath();
    ctx.arc(sx, sy, reach, angle - half, angle + half);
    ctx.stroke();

    ctx.restore();
}

/* eslint-disable no-use-before-define */

/**
 * Три звезды перезарядок над игроком: толчок, прыжок, камень.
 *
 * Раньше откаты были кольцами вокруг игрока, и толчок с прыжком
 * рисовались двумя дугами рядом — на восьми игроках это было не
 * разобрать. Звезды стоят в ряд над головой и отличаются только
 * цветом: синяя — толчок, золотая — прыжок, коричневая — камень.
 * Анимация у всех одна и та же, чтобы правило читалось сразу.
 *
 * Зарядка идёт **снизу вверх**: заполненная часть растёт от низа
 * звезды к вершине. Готовый скилл мигает, а не светится ровно —
 * мигание и читается как «можно нажать».
 */
function drawStars(ctx, sx, sy, radius, cooldowns, opts) {
    const defs = [
        { frac: cooldowns.push / T.PUSH_COOLDOWN, color: '#7fd0ff' },
        { frac: cooldowns.jump / T.JUMP_COOLDOWN, color: '#ffd23d' },
        {
            frac: cooldowns.stone / (T.STONE_TIME + T.STONE_COOLDOWN),
            color: '#b07a4a',
        },
    ];

    const size = Math.max(3.2, radius * 0.42);
    const gap = size * 2.5;
    const baseY = sy - radius - size * 3.1;
    const spin = opts.spin || 0;

    ctx.save();
    ctx.lineWidth = Math.max(1, size * 0.28);

    for (let i = 0; i < defs.length; i++) {
        const d = defs[i];
        const cx = sx + (i - 1) * gap;
        const ready = !(d.frac > 0);

        // Мигание готового скилла. Частота одинаковая у всех трёх,
        // иначе цвет сам по себе ничего бы не значил.
        ctx.globalAlpha = ready ? 0.55 + 0.45 * Math.abs(Math.sin(spin * 3.2)) : 1;

        // Контур рисуется всегда: звезда видна и на откате, и готовая.
        starPath(ctx, cx, baseY, size, size * 0.45);
        ctx.strokeStyle = d.color;
        ctx.stroke();

        if (!ready) {
            // Заливка снизу вверх. Ставится отсечение по прямоугольнику
            // и рисуется та же звезда: край обрезается ровно по линии
            // заряда, без попытки повторить форму половиной звезды.
            const fill = 1 - Math.min(1, d.frac);
            const y1 = baseY + size * (1 - 2 * fill);
            ctx.save();
            ctx.beginPath();
            ctx.rect(cx - size * 1.3, y1, size * 2.6, size * 2.6);
            ctx.clip();
            starPath(ctx, cx, baseY, size, size * 0.45);
            ctx.fillStyle = d.color;
            ctx.fill();
            ctx.restore();
        }
    }

    ctx.restore();
}

/** Путь звезды: пять острых лучей вокруг центра. */
function starPath(ctx, cx, cy, r, inner) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
        const rad = i % 2 === 0 ? r : inner;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const x = cx + Math.cos(a) * rad;
        const y = cy + Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
}


/**
 * Игрок целиком: герой, состояния и перезарядки.
 *
 * Состояний четыре, и каждое видно с одного взгляда:
 *
 *   * **летит** — белое тело и пунктирное кольцо, управлять нельзя;
 *   * **прыгает** — шлейф и каменная неуязвимость, вынести нельзя;
 *   * **камень** — приземистый серый шар, от удара отскакивает;
 *   * **заряжает толчок** — цифра ступени над головой.
 */
function drawPlayer(ctx, snap, view, p, index, opts) {
    const color = colorOf(index);
    const sx = view.cx + p.x * view.scale;
    const sy = view.cy + p.y * view.scale;
    const r = T.PLAYER_RADIUS * view.scale;
    const spin = opts.spin || 0;
    const flying = p.fly > 0;
    const jumping = p.jumpLeft > 0;
    const stoned = p.stone > 0;
    const { fx, fy } = facing(p);
    const tier = tierOf(p.charge);

    if (opts.me != null && p.id === opts.me) {
        drawAim(ctx, view, sx, sy, p,
            p.cooldowns.push <= 0 && !flying && !stoned && tier > 0, tier);
    }

    // Шлейф прыжка — три затухающих пятна позади по вектору полёта.
    // Раньше это был шлейф рывка; смысл тот же, но сам прыжок длиннее
    // в три раза, и шлейф теперь заметно длиннее.
    if (jumping) {
        const s = Math.hypot(p.vx, p.vy) || 1;
        const ux = p.vx / s;
        const uy = p.vy / s;
        ctx.save();
        for (let i = 1; i <= 3; i++) {
            const d = i * r * 1.1;
            ctx.beginPath();
            ctx.arc(sx - ux * d, sy - uy * d, r * (1 - i * 0.2), 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.25 / i;
            ctx.fill();
        }
        ctx.restore();
    }

    // Тень — чтобы герой читался как объём, а не как метка.
    ctx.beginPath();
    ctx.ellipse(sx + r * 0.2, sy + r * 0.45, r * 0.95, r * 0.66, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();

    ctx.save();
    ctx.translate(sx, sy);

    if (stoned) {
        // Камень: приземистый серый шар. Отличается от всех героев
        // сразу — и по цвету, и по форме, и по неподвижности.
        ctx.beginPath();
        ctx.arc(0, r * 0.1, r * 0.95, 0, Math.PI * 2);
        ctx.fillStyle = '#8d8579';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = Math.max(2, r * 0.16);
        ctx.stroke();

        // Трещины: короткие линии от центра к краю. Делают камень
        // камен��м, а серым шариком он читался бы как выбитый игрок.
        ctx.strokeStyle = '#5f594f';
        ctx.lineWidth = Math.max(1, r * 0.08);
        for (let i = 0; i < 5; i++) {
            const a = (i / 5) * Math.PI * 2 + 0.4;
            ctx.beginPath();
            ctx.moveTo(Math.cos(a) * r * 0.2, r * 0.1 + Math.sin(a) * r * 0.2);
            ctx.lineTo(Math.cos(a) * r * 0.85, r * 0.1 + Math.sin(a) * r * 0.85);
            ctx.stroke();
        }
    } else if (flying) {
        // Летящий: белое тело и пунктирное кольцо. Управлять нельзя,
        // и по картинке это должно быть видно сразу.
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.65)';
        ctx.fill();

        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(0, 0, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
    } else {
        drawHero(ctx, index, r, spin);

        // Прыгающий подсвечивается контуром: неуязвимость — это
        // обещание, и оно должно быть видно, а не выводиться из
        // вилки в углу. Отдельный «щит» вокруг игрока.
        if (jumping) {
            ctx.beginPath();
            ctx.arc(0, 0, r + 4, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255,255,255,0.65)';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    }

    // Носик — куда игрок смотрит. Тонкий и светлый, чтобы не спорить
    // с силуэтом героя.
    if (!stoned && !flying) {
        const tipX = fx * (r + 7);
        const tipY = fy * (r + 7);
        const baseX = fx * (r - 2);
        const baseY = fy * (r - 2);
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(baseX - fy * 5, baseY + fx * 5);
        ctx.lineTo(baseX + fy * 5, baseY - fx * 5);
        ctx.closePath();
        ctx.fillStyle = LINE;
        ctx.fill();
    }

    ctx.restore();

    // Перезарядки — звездами над головой, и они всегда на месте,
    // в том числе у летящего и у камня: их скиллы тоже на откате.
    drawStars(ctx, sx, sy, r, p.cooldowns, { spin });

    // Кольцо заряда — рисуется после звёзд, чтобы кольцо было поверх
    // героя, а не спорило с ними за место над головой.
    if (!flying && !stoned) {
        drawCharge(ctx, sx, sy, r, p.charge || 0, p.cooldowns.push <= 0);
    }

    // Заряд толчка вокруг героя. Главное, чего не хватало: заряд копится
    // целую секунду, а цифра над головой появляется только на первой
    // ступени. Всё это время у игрока не было **никакого** признака,
// что кнопка нажата и что-то происходит — а смотреть на звёзды
    // отката бесполезно, они не меняются.
//
// Кольцо заполняется вокруг героя снизу по часовой стрелке и на
// границах ступеней у него засечки: видно, где «ещё чуть-чуть» до
// следующей цифры. В последней пятой доле ступени кольцо ярче —
// ступень вот-вот доберётся.
function drawCharge(ctx, sx, sy, r, charge, ready) {
    if (!(charge > 0)) return;

    const top = T.PUSH_TIERS.length;          // ступеней всего три
    const frac = Math.min(charge / top, 1); // 0..1 на весь заряд
    const ring = r + 6;
    const from = Math.PI / 2;                // низ круга
    const to = from - frac * Math.PI * 2;

    ctx.save();
    ctx.lineCap = 'round';

    // Подложка: полный круг серым, чтобы было видно, докуда набирать.
    ctx.beginPath();
    ctx.arc(sx, sy, ring, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(127,208,255,0.18)';
    ctx.lineWidth = Math.max(3, r * 0.22);
    ctx.stroke();

    // Засечки на границах ступеней: 1 и 2 секунды.
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(12,17,28,0.85)';
    ctx.lineWidth = Math.max(2, r * 0.14);
    for (let i = 1; i < top; i++) {
        const a = from - (i / top) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(sx + Math.cos(a) * (ring - r * 0.18),
            sy + Math.sin(a) * (ring - r * 0.18));
        ctx.lineTo(sx + Math.cos(a) * (ring + r * 0.18),
            sy + Math.sin(a) * (ring + r * 0.18));
        ctx.stroke();
    }

    // Набранное. Яркость зависит от того, насколько близко следующая
    // ступень, — так «ещё немного» читается, не глядя на цифру.
    const tier = chargeTier(charge);
    const nextAt = Math.min(top, tier + 1);
    const near = nextAt > 0 ? Math.min(1, (charge - tier) / (nextAt - tier)) : 1;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(sx, sy, ring, to, from);
    ctx.strokeStyle = ready ? '#7fd0ff' : 'rgba(127,208,255,0.45)';
    ctx.lineWidth = Math.max(3, r * 0.22 + near * r * 0.14);
    ctx.stroke();

    // Свечение на свежей ступени: короткий выброс яркости прямо в
    // момент, когда цифра перешагнула. Затухает за треть секунды.
    const sinceStep = (charge - tier) / T.PUSH_CHARGE_STEP;
    if (sinceStep < 0.35) {
        const glow = (1 - sinceStep / 0.35);
        ctx.beginPath();
        ctx.arc(sx, sy, ring + glow * r * 0.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(200,240,255,' + (glow * 0.7).toFixed(3) + ')';
        ctx.lineWidth = Math.max(1, r * 0.1 * glow);
        ctx.stroke();
    }

    ctx.restore();
}

// Цифра заряда толчка. Показывается у всех, а не только у себя:
    // видно, что соперник замахивается, и можно уйти с линии.
    if (!flying && !stoned && tier > 0) {
        ctx.save();
        ctx.font = '700 ' + Math.max(13, Math.round(r * 1.6)) +
            'px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(12,17,28,0.9)';
        ctx.fillStyle = '#7fd0ff';
        ctx.strokeText(String(tier), sx, sy - r * 2.1);
        ctx.fillText(String(tier), sx, sy - r * 2.1);
        ctx.restore();
    }

    if (opts.labels) {
        ctx.font = '600 12px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(232,240,255,0.9)';
        ctx.fillText(p.id, sx, sy + r + 9);
    }

    if (opts.margin) {
        const m = Math.round(marginOf(p.x, p.y, snap.size));
        ctx.font = '11px ui-monospace, SFMono-Regular, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = m < 60 ? '#ff8080' : 'rgba(232,240,255,0.55)';
        ctx.fillText(String(m), sx, sy + r + (opts.labels ? 23 : 9));
    }

    if (snap.finished && p.id === snap.winner) {
        const pulse = 1 + 0.15 * Math.sin((opts.pulse || 0) * Math.PI * 2);
        ctx.beginPath();
        ctx.arc(sx, sy, r * 2.1 * pulse, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffd23d';
        ctx.lineWidth = 3;
        ctx.stroke();
    }
}


/**
 * Анимация толчка по событию «push»: **вылет руки**.
 *
 * Клиент отстаёт от сервера на DELAY мс, поэтому эффект не берёт
 * позицию из события, а ищут толкающего в самом снимке: рука обязана
 * выйти ровно из того героя, который сейчас нарисован. Направление
 * наоборот берётся из события — за эти 120 мс игрок успевает
 * повернуться, а рука должна остаться там, куда били.
 *
 * Две фазы. Сначала сам вылет руки: она разгоняется, уп��рается в
 * соперника и возвращается. Потом, если кто-то задет, на цели
 * расходится кольцо — но тише, чем раньше: у цели и так белый корпус
 * и пунктир, и второе кольцо поверх первого только мешало.
 */
function drawPushFx(ctx, view, snap, fx, now) {
    const k = (now - fx.at) / PUSH_FX_MS;
    if (!(k >= 0) || k >= 1) return;

    const src = snap.players.find(p => p.id === fx.by);
    if (!src) return;

    const sx = view.cx + src.x * view.scale;
    const sy = view.cy + src.y * view.scale;
    const r = T.PLAYER_RADIUS * view.scale;

    // Рука летит весь отведённый ей срок.
    drawHand(ctx, sx, sy, fx.dirx, fx.diry, r, k, '#f2c9a0');

    for (const id of fx.hits || []) {
        const victim = snap.players.find(p => p.id === id);
        if (!victim) continue;
        const vx = view.cx + victim.x * view.scale;
        const vy = view.cy + victim.y * view.scale;
        const vr = T.PLAYER_RADIUS * view.scale;

        ctx.save();
        ctx.globalAlpha = (1 - k) * 0.7;
        ctx.beginPath();
        ctx.arc(vx, vy, vr * (1.3 + k * 2.2), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2.5 * (1 - k) + 1;
        ctx.stroke();
        ctx.restore();
    }
}

/**
 * Полный кадр: фон, поле, выбывшие, живые, затем эффекты поверх.
 *
 * opts.labels  — подписи имён под игроками;
 * opts.margin  — число остатка до края (диагностика);
 * opts.pulse   — фаза 0..1 для пульсации кольца победителя;
 * opts.me      — мой игрок: только ему рисуется прицел толчка;
 * opts.effects — список ударов [{ by, dirx, diry, hits, at }];
 * opts.spin    — секунды для качания хвостов и мигания звёзд.
 */
function draw(ctx, snap, view, opts = {}) {
    ctx.save();
    ctx.fillStyle = opts.bg || BG;
    ctx.fillRect(0, 0, view.width, view.height);

    drawField(ctx, snap, view);

    snap.players.forEach((p, index) => {
        if (!p.alive) drawGhost(ctx, snap, view, p, index);
    });
    snap.players.forEach((p, index) => {
        if (p.alive) drawPlayer(ctx, snap, view, p, index, opts);
    });

    if (opts.effects && opts.effects.length) {
        const now = performance.now();
        for (const fx of opts.effects) drawPushFx(ctx, view, snap, fx, now);
    }

    ctx.restore();
}

module.exports = {
    PALETTE,
    BG,
    PUSH_FX_MS,
    colorOf,
    fit,
    draw,
};
