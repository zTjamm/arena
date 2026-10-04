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

const { T, marginOf } = require('../game/arena');
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

function colorOf(index) {
    const n = PALETTE.length;
    return PALETTE[((index % n) + n) % n];
}

/**
 * Вписывает поле в холст.
 *
 * Поле — квадрат, и это ограничивает всё остальное. На широком
 * экране в альбомной ориентации «занять всю ширину» невозможно:
 * квадрат, равный ширине, был бы шире экрана по высоте, и верхний и
 * нижний край поля уехали бы за экран вместе с игроками. Поэтому поле
 * занимает **меньшую** из сторон — высоту на альбомном экране,
 * ширину на вертикальном.
 *
 * Делитель — 1.08, а не 1.25, как было. Старое значение оставляло
 * 20% высоты впустую: на компьютере поле занимало 688 точек при
 * доступных 992, и широкая полоса пустоты по бокам выглядела как
 * «игра не растянулась». Теперь поле занимает 93% и разница уже не
 * бросается в глаза.
 *
 * Оставшиеся 7% — не запас «на всякий случай», а место под внешний
 * контур: он рисуется на `OUTSIDE` единиц за границей, и без этого
 * запаса он обрезался бы краем экрана ровно там, где игрока выносят.
 *
 * inset.top и inset.bottom — полосы интерфейса поверх холста. Без них
 * поле центрируется по всему холсту и на низком окне наезжает на
 * панель кнопок внизу.
 */
const OUTSIDE = 32;   // ширина внешнего контура за границей поля

function fit(width, height, size, inset = {}) {
    const top = inset.top || 0;
    const bottom = inset.bottom || 0;
    const availH = Math.max(1, height - top - bottom);
    const scale = Math.min(width, availH) / (size + OUTSIDE * 2);
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
    const out = side + OUTSIDE * scale;
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
function drawAim(ctx, view, sx, sy, p, ready, lock) {
    const { fx, fy } = facing(p);
    const angle = Math.atan2(fy, fx);
    const half = Math.acos(T.PUSH_COS);        // половина конуса удара
    const s = view.scale;
    const reach = T.PUSH_RANGE * s;
    // Отлёт всегда один и тот же — PUSH_DIST. Ступеней больше нет, и
    // дуга за краем конуса больше не меняется: показывать там можно
    // ровно одно расстояние, а значит и рисовать незачем.
    const flight = T.PUSH_DIST * s;

    // Цвет досягаемости отвечает на вопрос «попаду или нет», и во
    // время замаха это единственный честный источник ответа: стоя на
    // месте целую секунду, игрок иначе гадает, успел он навестись или
    // нет.
    //
    //   * можно бить, но цели нет — синий, обычный вид;
    //   * замах и кто-то под ударом — зелёный, веер горит;
    //   * замах и под ударом камень — янтарный: попадёт, но отскочит;
    //   * замах и никого — тускло-красный: секунда стоит впустую.
    const swinging = (p.swing || 0) > 0;
    let edge = '#7fd0ff';
    let alpha = ready ? 1 : 0.35;

    if (swinging) {
        if (!lock) {
            edge = '#ff8080';
            alpha = 0.75;
        } else if (lock.stone) {
            edge = '#ffc46b';
            alpha = 1;
        } else {
            edge = '#7bff9e';
            alpha = 1;
        }
    }

    ctx.save();
    ctx.globalAlpha = alpha;

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
    ctx.lineWidth = swinging ? 3.5 : 2.5;
    ctx.strokeStyle = edge;
    ctx.beginPath();
    ctx.arc(sx, sy, reach, angle - half, angle + half);
    ctx.stroke();

    // Под замахом веер заливается: сплошной конус читается как
    // «сюда придётся удар», а не как «сюда можно достать».
    if (swinging) {
        ctx.globalAlpha = alpha * 0.16;
        ctx.fillStyle = edge;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.arc(sx, sy, reach, angle - half, angle + half);
        ctx.closePath();
        ctx.fill();
    }

    ctx.restore();
}

/**
 * Кто попал бы под удар, если бы он вышел **сейчас**.
 *
 * Повторяет выбор цели из ядра: ближайший в конусе на расстоянии
 * `PUSH_RANGE`, кроме летящих, прыгающих и мёртвых. Считается на
 * клиенте из снимка, а не приходит с сервера, — потому что должно
 * обновляться каждый кадр: нос доворачивается, соперник уходит, и
 * ответ меняется на глазах.
 *
 * Это предсказание, а не обещание: за оставшуюся секунду замаха
 * соперник сдвинется. Показывается оно именно поэтому — видно, куда
 * вести нос прямо сейчас.
 *
 * Камень не пропускается: удар в него отскакивает, и это тоже надо
 * показать, причём другим цветом.
 */
function hitScan(snap, p) {
    const angle = Math.atan2(p.diry || 0, p.dirx || 0);
    if (!p.dirx && !p.diry) return null;

    const half = Math.acos(T.PUSH_COS);
    let target = null;
    let nearest = Infinity;

    for (const o of snap.players) {
        if (o.id === p.id || !o.alive) continue;
        if (o.fly > 0 || o.jumpLeft > 0) continue;

        const dx = o.x - p.x;
        const dy = o.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d > T.PUSH_RANGE || d >= nearest) continue;

        // Совпавшие центры: направление не определено, но удар
        // достаёт — столько же считает и ядро.
        if (d > 1e-9) {
            let diff = Math.atan2(dy, dx) - angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            if (Math.abs(diff) > half) continue;
        }

        nearest = d;
        target = o;
    }

    if (!target) return null;
    return { id: target.id, stone: target.stone > 0 };
}

/**
 * Метка на цели, которую замах накроет.
 *
 * Четыре угловые скобки, сходящиеся к цели, и перекрестье. Нарисовано
 * поверх всех героев: важно, чтобы метка не пряталась под свалкой.
 */
function drawLockMark(ctx, view, snap, lock, now) {
    const p = snap.players.find(q => q.id === lock.id);
    if (!p) return;

    const x = view.cx + p.x * view.scale;
    const y = view.cy + p.y * view.scale;
    const r = T.PLAYER_RADIUS * view.scale;

    // Скобки дышат: метка не должна выглядеть частью героя, но и
    // мигать не должна — спокойное пульсирование в полтора раза.
    const k = 1 + 0.14 * Math.sin(now / 140);
    const gap = Math.max(6, r * 0.55 * k);
    const arm = Math.max(4, r * 0.45 * k);
    const d = r * 1.5 * k;

    ctx.save();
    ctx.strokeStyle = lock.stone ? '#ffc46b' : '#7bff9e';
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.lineCap = 'round';

    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.beginPath();
        ctx.moveTo(x + sx * d, y + sy * (d - gap));
        ctx.lineTo(x + sx * d, y + sy * d);
        ctx.lineTo(x + sx * (d - gap), y + sy * d);
        ctx.stroke();
    }

    // Перекрестье в центре: видно, что прицел сведён именно на этого.
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.beginPath();
    ctx.moveTo(x - arm * 0.7, y);
    ctx.lineTo(x + arm * 0.7, y);
    ctx.moveTo(x, y - arm * 0.7);
    ctx.lineTo(x, y + arm * 0.7);
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
 *   * **замахивается** — сжимающееся кольцо и веер, подсвеченный
 *     по тому, есть кто под ударом.
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
    const swinging = p.swing > 0;

    if (opts.me != null && p.id === opts.me) {
        // На отсчёте прицел гаснет: бить всё равно нельзя, и обещать
        // досягаемость, которой сейчас нет, было бы враньём.
        const grace = snap.elapsed < T.SPAWN_GRACE;
        drawAim(ctx, view, sx, sy, p,
            p.cooldowns.push <= 0 && !flying && !stoned && !swinging && !grace,
            swinging ? (opts.lock || null) : null);
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

        // Свой герой подсвечивается ярче остальных.
        //
        // Восемь героев на поле, и телефон меньше: без подсветки
        // «который тут мой» приходилось угадывать, особенно когда
        // вокруг толпа и герои наезжают друг на друга. Три приёма
        // вместе, ни один из них не меняет цвет самого героя —
        // иначе перестаёшь отличать его от соседей:
        //
        //   * мягкое свечение наружу — виден даже в свалке;
        //   * ровный белый контур по самому герою;
        //   * подпись ником под героем, а не только у всех сразу.
        if (opts.me != null && p.id === opts.me) {
            const glow = ctx.createRadialGradient(0, 0, r * 0.7, 0, 0, r * 2.2);
            glow.addColorStop(0, 'rgba(255,255,255,0.22)');
            glow.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.beginPath();
            ctx.arc(0, 0, r * 2.2, 0, Math.PI * 2);
            ctx.fillStyle = glow;
            ctx.fill();

            ctx.beginPath();
            ctx.arc(0, 0, r + 3, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.lineWidth = Math.max(2, r * 0.09);
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

    // Замах толчка — рисуется после звёзд, чтобы он был поверх героя,
    // а не спорил с ними за место над головой.
    if (!flying && !stoned) {
        drawSwing(ctx, sx, sy, r, p.swing || 0);
    }

/**
 * Замах толчка: сколько осталось до удара.
 *
 * Раньше здесь стояло кольцо заряда — со ступенями, засечками и
 * цифрой над головой. Теперь замах один, длится целую секунду и
 * рисуется **наоборот**: не сколько накопилось, а сколько осталось.
 * Причина в том, что секунду стоишь на месте и не знаешь, когда
 * придёт удар, — с обратным отсчётом это видно сразу.
 *
 * Кольцо сжимается к герою и в последнюю четверть секунды
 * становится ярче: удар вот-вот. Рисуется у всех, а не только у
 * себя: по чужому замаху надо уйти с линии, и для этого его надо
 * видеть.
 */
function drawSwing(ctx, sx, sy, r, swing) {
    if (!(swing > 0)) return;

    // Сколько секунд ещё стоять: полный круг — это полная секунда,
    // и пустое место в начале — уже накопленная часть замаха.
    const frac = Math.max(0, Math.min(1, swing / T.PUSH_WINDUP));
    const ring = r + 6 + (1 - frac) * r * 0.9;

    // Последняя четверть секунды: удар сейчас будет.
    const soon = frac < 0.25 ? 1 - frac / 0.25 : 0;

    ctx.save();

    // Замах целиком — тонким кругом: видно, что игрок стоит и
    // собирается бить.
    ctx.beginPath();
    ctx.arc(sx, sy, ring, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(127,208,255,' + (0.30 + soon * 0.5).toFixed(3) + ')';
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.stroke();

    // Остаток замаха — плотным кругом: пустое место в начале и есть
    // «уже прошло». Считается сверху, чтобы совпадало с началом,
    // откуда бьющий смотрит на цель.
    ctx.beginPath();
    ctx.arc(sx, sy, ring, -Math.PI / 2, -Math.PI / 2 + (1 - frac) * Math.PI * 2);
    ctx.strokeStyle = '#7fd0ff';
    ctx.lineWidth = Math.max(3, r * 0.22);
    ctx.stroke();

    // Вспышка перед самым ударом: короткий выброс наружу.
    if (soon > 0) {
        ctx.beginPath();
        ctx.arc(sx, sy, ring + soon * r * 0.7, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(200,240,255,' + (soon * 0.6).toFixed(3) + ')';
        ctx.lineWidth = Math.max(1, r * 0.12 * soon);
        ctx.stroke();
    }

    ctx.restore();
}

    if (opts.labels) {
        // Подпись под героем. Свой — заметно ярче и крупнее: на
        // телефоне в свалке из восьми героев подписи одинакового
        // размера сливаются, и «мой» не находится глазом.
        const mine = opts.me != null && p.id === opts.me;
        ctx.font = (mine ? '800 13px' : '600 11px')
            + ' system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        if (mine) {
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(12,17,28,0.9)';
            ctx.strokeText(p.id, sx, sy + r + 9);
            ctx.fillStyle = '#ffffff';
        } else {
            ctx.fillStyle = 'rgba(232,240,255,0.55)';
        }
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

/** Сколько живёт поплывшая подпись цепочки. */
const CHAIN_FX_MS = 1100;

/**
 * Подпись цепочки: «×3» у того, кого выбили последним.
 *
 * Показывается **только толкавшему** — это его достижение, и чужие
 * очки ему не нужны. Но число считается только когда цепочка доиграла,
 * то есть когда последний её участник встал на землю: в момент удара
 * цепочка ещё только начинается, и показывать там всегда было бы
 * «×1».
 *
 * Само число едет вверх и гаснет. Никаких полосок и стрелок: цепочка
 * — это разовый счёт, а не состояние, и держать его на экране дольше
 * двух секунд незачем.
 */
function drawChainFx(ctx, view, snap, fx, now) {
    const k = (now - fx.at) / CHAIN_FX_MS;
    if (!(k >= 0) || k >= 1) return;
    if (!fx.mine) return;

    const p = snap.players.find(q => q.id === fx.last);
    if (!p) return;

    const x = view.cx + p.x * view.scale;
    const y = view.cy + p.y * view.scale - T.PLAYER_RADIUS * view.scale * 2.4;
    const r = T.PLAYER_RADIUS * view.scale;

    // В начале — резко, потом плавно: счёт должен успеть прочитаться,
    // а не улететь вместе с ударом.
    const pop = k < 0.15 ? 1 + (0.15 - k) * 2.4 : 1;
    const alpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '900 ' + Math.round(r * 1.15 * pop) +
        'px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const text = '×' + fx.count;
    ctx.lineWidth = Math.max(3, r * 0.2);
    ctx.strokeStyle = 'rgba(12,17,28,0.92)';
    ctx.strokeText(text, x, y - k * r * 1.4);
    ctx.fillStyle = '#ffd23d';
    ctx.fillText(text, x, y - k * r * 1.4);

    // Суммарная дальность под числом — мелким шрифтом: «×3» говорит,
    // сколько людей, а сколько единиц суммарно сдвинуто — уже деталь,
    // но именно она показывает, что цепочка стоила усилий.
    ctx.font = '700 ' + Math.round(r * 0.52) +
        'px system-ui, -apple-system, sans-serif';
    ctx.lineWidth = Math.max(2, r * 0.12);
    ctx.strokeStyle = 'rgba(12,17,28,0.9)';
    const sub = Math.round(fx.power) + '';
    ctx.strokeText(sub, x, y - k * r * 1.4 + r * 0.85);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(sub, x, y - k * r * 1.4 + r * 0.85);
    ctx.restore();
}

/** Сколько живёт анимация взрыва камня. */
const BURST_FX_MS = 520;

/** Сколько живёт удар по одной цели — он короче кольца. */
const BURST_ARM_MS = 300;

/**
 * Взрыв по истечении камня.
 *
 * Три слоя, и каждый отвечает на свой вопрос:
 *
 *   1. **Вспышка в точке взрыва** — камень только что лопнул. Без неё
 *      кольцо появляется из ниоткуда.
 *   2. **Расходящееся кольцо** — граница ударной волны, то есть ответ
 *      на «кого вообще задело». По ней видно, ради чего стоило
 *      встать в камень.
 *   3. **Удар по каждой цели** — тот же язык, что и у толчка (рука
 *      вылетает, упирается, возвращается), только каменного цвета.
 *
 * Третий слой — это то, чего не хватало. Раньше было одно кольцо, и
 * жертва просто улетала: не было видно, что её ударил камень, а не
 * что она сама отскочила от взрыва. Задело четверых — и видно, что
 * четверых.
 */
function drawBurstFx(ctx, view, snap, fx, now) {
    const k = (now - fx.at) / BURST_FX_MS;
    if (!(k >= 0) || k >= 1) return;

    const x = view.cx + fx.x * view.scale;
    const y = view.cy + fx.y * view.scale;
    const full = fx.radius * view.scale;
    const r = T.PLAYER_RADIUS * view.scale;

    ctx.save();

    // 1. Вспышка: короткий выброс наружу в самом начале.
    if (k < 0.3) {
        const f = 1 - k / 0.3;
        const rad = r * (0.8 + f * 1.6);
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, 'rgba(255,240,210,' + (f * 0.75).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(255,240,210,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
    }

    // 3. Удар по каждой цели — рисуется первым, чтобы кольцо легло
    // поверх и связало всё в одну волну.
    const ka = Math.min(1, (now - fx.at) / BURST_ARM_MS);
    if (ka < 1) {
        for (const id of fx.hits || []) {
            const p = snap.players.find(q => q.id === id);
            if (!p) continue;

            const dx = p.x - fx.x;
            const dy = p.y - fx.y;
            const d = Math.hypot(dx, dy);
            if (d < 1e-6) continue;

            drawHand(ctx, x, y, dx / d, dy / d, r, ka, '#d9b98a');
        }
    }

    // 2. Кольцо расходится наружу и одновременно гаснет: чем дальше,
    // тем бледнее — край волны читается, а середина уже отработала.
    ctx.globalAlpha = (1 - k) * 0.85;
    ctx.beginPath();
    ctx.arc(x, y, full * (0.25 + k * 0.85), 0, Math.PI * 2);
    ctx.strokeStyle = '#c9a06a';
    ctx.lineWidth = Math.max(2, 9 * (1 - k));
    ctx.stroke();

    ctx.globalAlpha = (1 - k) * 0.45;
    ctx.beginPath();
    ctx.arc(x, y, full * (0.25 + k * 0.85), 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, 3 * (1 - k));
    ctx.stroke();

    ctx.restore();
}

/**
 * Полный кадр: фон, поле, выбывшие, живые, метка цели, затем эффекты.
 *
 * opts.labels  — подписи имён под игроками;
 * opts.margin  — число остатка до края (диагностика);
 * opts.pulse   — фаза 0..1 для пульсации кольца победителя;
 * opts.me      — мой игрок: только ему рисуется прицел толчка;
 * opts.effects — список ударов [{ by, dirx, diry, hits, at }];
 * opts.chains  — цепочки [{ by, last, count, power, mine, at }];
 * opts.bursts  — взрывы камня [{ x, y, radius, at }];
 * opts.spin    — секунды для качания хвостов и мигания звёзд.
 */
function draw(ctx, snap, view, opts = {}) {
    ctx.save();
    ctx.fillStyle = opts.bg || BG;
    ctx.fillRect(0, 0, view.width, view.height);

    drawField(ctx, snap, view);

    // Кто под ударом — считается здесь, до рисования героев: и веер,
    // и метка на цели должны смотреться из одного и того же расчёта,
    // иначе метка укажет не на того, кого накрывает веер.
    //
    // Считается только пока идёт замах: вне замаха прицел и так
    // показывает досягаемость, а пересчитывать конус шестьдесят раз
    // в секунду ради картинки, которой никто не смотрит, незачем.
    let lock = null;
    if (opts.me != null) {
        const me = snap.players.find(p => p.id === opts.me);
        if (me && me.alive && me.swing > 0) lock = hitScan(snap, me);
    }

    snap.players.forEach((p, index) => {
        if (!p.alive) drawGhost(ctx, snap, view, p, index);
    });

    // Тот же расчёт уходит в drawPlayer: веер подсвечивается по
    // наличию цели, а не по чему-то отдельному.
    const pass = lock ? Object.assign({}, opts, { lock }) : opts;

    snap.players.forEach((p, index) => {
        if (p.alive) drawPlayer(ctx, snap, view, p, index, pass);
    });

    // Метка поверх всех героев: в свалке из восьми человек она иначе
    // уезжала бы под того, кто нарисован последним.
    if (lock) drawLockMark(ctx, view, snap, lock, performance.now());

    if (opts.effects && opts.effects.length) {
        const now = performance.now();
        for (const fx of opts.effects) drawPushFx(ctx, view, snap, fx, now);
        for (const fx of opts.chains || []) drawChainFx(ctx, view, snap, fx, now);
        for (const fx of opts.bursts || []) drawBurstFx(ctx, view, snap, fx, now);
    }

    drawGrace(ctx, view, snap);

    ctx.restore();
}

/**
 * Обратный отсчёт в начале партии: первые SPAWN_GRACE секунд удара
 * нет.
 *
 * Молчание было бы худшим вариантом: игрок держит кнопку, ждёт
 * полторы секунды, отпускает — и ничего не происходит. Выглядит как
 * сломанный толчок, а не как правило. Поэтому прямо на поле стоит
 * «БОЙ ЧЕРЕЗ 3», и всё видно.
 *
 * Считается из `snap.elapsed`, который и так есть в снимке, — значит
 * протокол менять не пришлось.
 */
function drawGrace(ctx, view, snap) {
    const left = T.SPAWN_GRACE - snap.elapsed;
    if (!(left > 0)) return;

    const cx = view.cx;
    const cy = view.cy;
    // Цифра целыми секундами: «2» держится вторую секунду, и глаз
    // успевает её прочитать, а не ловит мельтешение 2.98 → 1.02.
    const n = Math.ceil(left);
    const t = left - Math.floor(left);      // доля внутри текущей секунды

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Гаснет к концу счёта: счёт идёт 3 → 2 → 1 и уходит незаметно,
    // а не щёлкает и не мигает.
    ctx.globalAlpha = 0.35 + 0.65 * (1 - t);
    ctx.font = '800 ' + Math.max(40, Math.round(view.height * 0.16))
        + 'px system-ui, -apple-system, sans-serif';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(12,17,28,0.85)';
    ctx.fillStyle = '#ffffff';
    ctx.strokeText(String(n), cx, cy - 12);
    ctx.fillText(String(n), cx, cy - 12);

    ctx.font = '700 ' + Math.max(13, Math.round(view.height * 0.045))
        + 'px system-ui, -apple-system, sans-serif';
    ctx.globalAlpha = 0.7;
    ctx.fillText('УДАР ЧЕРЕЗ', cx, cy + view.height * 0.10);

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
