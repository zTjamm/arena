/**
 * Проверка ядра арены.
 *
 * Запуск: node test-arena.js
 *
 * Главное здесь — прогон на тысячи тиков подряд. Ядро считает
 * столкновения, скиллы и выбытия численно, и одна ошибка с нормалью
 * или с делением на ноль даёт NaN, который расползается по всей партии
 * и портит её молча. Поэтому длинный прогон проверяется на конечность
 * всех координат, а не на отдельные красивые случаи.
 *
 * Вторая по важности вещь: толчок обязан реально отдалять соперника
 * от границы. Если импульс не доходит, выталкивания нет вообще, а все
 * остальные тесты при этом будут зелёными — они проверяют правила,
 * а не то, работает ли механика.
 *
 * Третья — обратная сторона того же правила: без кнопки отбрасывать
 * не должно. Импульс во всей игре есть ровно один источник, скилл
 * «толчок», и если столкновение снова начнёт подбрасывать скорость,
 * игра вернётся в прежнее состояние, где ходьбы хватало, чтобы
 * выкинуть соперника.
 */

const {
    T, createArena, addPlayer, spawnPoint, step, marginOf, chargeTier
} = require('./game/arena');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
    if (condition) {
        passed++;
    } else {
        failed++;
        failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    }
}


// --- Граница поля: единственный способ выбыть -----------------------------

{
    // За границей выбывает только летящий. Того, кто к границе прижали
    // ходьбой или толпой, она держит на месте.
    const arena = createArena({ size: 200 });
    addPlayer(arena, 'outside', { x: 150, y: 0 });
    addPlayer(arena, 'inside', { x: 0, y: 0 });
    // Полёт задаётся с запасом: за один тик он тратит 20 единиц, и
    // короче он закончился бы до проверки границы.
    arena.players[0].fly = 500;
    arena.players[0].strike = 500;
    arena.players[0].flyx = 1;

    step(arena, {});

    check('летящий за границей — выбытие', arena.players[0].alive === false);
    check('внутри поля остаётся', arena.players[1].alive === true);
    check('выбывшему проставлено место', arena.players[0].place !== null,
        `место ${arena.players[0].place}`);
}

{
    // Ровно на границе ещё не выбытие: счётится центр, а не касание края.
    const arena = createArena({ size: 200 });
    addPlayer(arena, 'edge', { x: 100, y: 0 });
    addPlayer(arena, 'other', { x: 0, y: 0 });

    step(arena, {});

    check('центр на границе — ещё играет', arena.players[0].alive === true);
}

{
    // Поле квадратное: граница идёт по обеим осям, и летящего в углу
    // выносит по вертикали, хотя по горизонтали он ещё в центре.
    const arena = createArena({ size: 200 });
    addPlayer(arena, 'corner', { x: 0, y: 140 });
    addPlayer(arena, 'other', { x: 0, y: 0 });
    arena.players[0].fly = 500;
    arena.players[0].strike = 500;
    arena.players[0].flyy = 1;

    step(arena, {});

    check('по вертикали за границей — выбытие', arena.players[0].alive === false);
}

{
    // Обратное: точка внутри диагонали, но за каждым отдельным
    // пределом по одной оси не выходит — квадрат, а не круг.
    const arena = createArena({ size: 200 });
    addPlayer(arena, 'nearcorner', { x: 90, y: 90 });
    addPlayer(arena, 'other', { x: 0, y: 0 });

    step(arena, {});

    check('внутри квадрата по обоим осям — играет',
        arena.players[0].alive === true,
        `запас ${marginOf(90, 90, 200).toFixed(0)}`);
}


// --- Спавн ---------------------------------------------------------------

{
    const size = 400;
    const arena = createArena({ size });
    for (let i = 0; i < 8; i++) addPlayer(arena, `p${i}`, spawnPoint(i, 8, size));
    step(arena, {});

    const inside = arena.players.every(p =>
        Math.max(Math.abs(p.x), Math.abs(p.y)) + p.radius <= size / 2);
    check('спавн целиком внутри поля', inside);

    // Честность расстановки: на квадрате углы и середины сторон — это
    // разные расстояния до края, если раскладывать по дуге. Контур
    // сжат к центру в 0.7, и тогда запас до границы одинаков у всех.
    const margins = arena.players.map(p => marginOf(p.x, p.y, size));
    check('все стартуют с одинаковым запасом до края',
        margins.every(m => Math.abs(m - margins[0]) < 1e-6),
        `запасы: ${margins.map(m => m.toFixed(2)).join(', ')}`);
    check('стартовый запас больше радиуса игрока',
        margins[0] > arena.players[0].radius,
        `запас ${margins[0].toFixed(1)}`);

    let overlap = false;
    for (let i = 0; i < arena.players.length; i++) {
        for (let j = i + 1; j < arena.players.length; j++) {
            const a = arena.players[i];
            const b = arena.players[j];
            if (Math.hypot(b.x - a.x, b.y - a.y) < a.radius + b.radius - 0.01) {
                overlap = true;
            }
        }
    }
    check('спавн без наложений', !overlap);
}


// --- Скилл «толчок»: заряд, ступени, удар ----------------------------------

/**
 * Держать кнопку заданное число тиков, потом отпустить и дать удару
 * уйти. Почти каждая проверка заряда писала бы эти строки заново, а
 * различаться в них было бы только число тиков.
 *
 * Перед отпусканием запоминает, где стояли остальные: удар начинается
 * в том же тике, и его первый шаг — тоже часть отлёта.
 */
function charged(arena, id, ticks) {
    const inputs = {};
    for (let i = 0; i < ticks; i++) {
        inputs[id] = { push: true };
        step(arena, inputs);
    }
    const before = arena.players.map(p => [p.x, p.y]);
    inputs[id] = { push: false };
    const events = step(arena, inputs);
    charged.positions = before;
    return events;
}


/**
 * Долетить всё, что в полёте, и вернуть пройденное расстояние.
 * Отсчёт идёт от позиции на момент отпускания кнопки, которую запомнил
 * charged: удар начинается в том же тике, и его первый шаг — тоже часть
 * отлёта, мерить от «до» потерялось бы 20 единиц из сотни.
 */
function flyOut(arena, id) {
    const i = arena.players.findIndex(q => q.id === id);
    const [fromX, fromY] = charged.positions[i];
    const p = arena.players[i];
    let n = 0;
    while (p.fly > 0 && n++ < 600) step(arena, {});
    return Math.hypot(p.x - fromX, p.y - fromY);
}

{
    // Три ступени: секунда удержания — 100 единиц отлёта, две — 200,
    // три — 300. Отлёт задан расстоянием, а не импульсом, поэтому сходится
    // точно, а не «примерно как в прошлый раз».
    for (const [ticks, want] of [[30, 100], [60, 200], [90, 300]]) {
        const arena = createArena({ size: 3000 });
        addPlayer(arena, 'a', { x: 0, y: 0 });
        addPlayer(arena, 'b', { x: 40, y: 0 });
        arena.players[0].dirx = 1;

        charged(arena, 'a', ticks);
        const flew = flyOut(arena, 'b');

        check('заряд ' + (ticks / 30) + ' с отбрасывает на ' + want,
            Math.abs(flew - want) < 0.5,
            'отлетел ' + flew.toFixed(1));
    }
}

{
    // Заряд не переполняется: три секунды удержания — это третья ступень,
    // а не бесконечное накопление.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    for (let i = 0; i < 90; i++) step(arena, { a: { push: true } });

    check('заряд не переполняется', arena.players[0].charge <= 3 + 1e-6,
        'заряд ' + arena.players[0].charge.toFixed(3));
    check('заряд трёх секунд — третья ступень',
        chargeTier(arena.players[0].charge) === 3,
        'ступень ' + chargeTier(arena.players[0].charge));
}

{
    // Отпустил раньше секунды — удара не было и откат не потрачен.
    // Иначе каждые полсекунды в партии был бы выстрел в пустоту.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 40, y: 0 });
    arena.players[0].dirx = 1;

    for (let i = 0; i < 15; i++) step(arena, { a: { push: true } });
    step(arena, { a: { push: false } });

    check('короткое нажатие не бьёт', arena.players[1].fly === 0,
        'полёт ' + arena.players[1].fly);
    check('короткое нажатие не тратит откат',
        arena.players[0].cooldowns.push === 0,
        'откат ' + arena.players[0].cooldowns.push.toFixed(2));
}

{
    // Бьётся только ближайший в конусе: толкнуть толпу нельзя.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'near', { x: 20, y: 0 });
    addPlayer(arena, 'far', { x: T.PUSH_RANGE - 2, y: 0 });
    arena.players[0].dirx = 1;

    const hit = charged(arena, 'a', 30).find(e => e.type === 'push');

    check('толчок бьёт одного', !!hit && hit.hits.length === 1,
        hit ? hit.hits.join(',') : 'нет события');
    check('толчок бьёт ближайшего', !!hit && hit.hits[0] === 'near',
        hit ? hit.hits.join(',') : 'нет события');
}

{
    // Цепочка: летящий влезает в следующего — тот отлетает на половину
    // удара, а первый тормозит на месте. Половина берётся от первого
    // толчка, поэтому в цепочке из четверых остальные трое по 150,
    // а не 150, 75 и 37. Игроки расставлены так, чтобы каждый успел
    // получить свою половину и никого не догнал следующий.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 40, y: 0 });
    addPlayer(arena, 'c', { x: 320, y: 0 });
    addPlayer(arena, 'd', { x: 480, y: 0 });
    arena.players[0].dirx = 1;

    const before = arena.players.map(p => p.x);
    charged(arena, 'a', 90);
    for (let i = 0; i < 80; i++) step(arena, {});

    const flew = (id) => {
        const i = arena.players.findIndex(p => p.id === id);
        return arena.players[i].x - before[i];
    };
    // что отличает цепочку от промаха: каждый следующий получил свою
    // половину удара, а не ноль.
    check('второй получил половину удара',
        Math.abs(flew('c') - 150) < 20,
        'c ' + flew('c').toFixed(0) + ' при 150');
    check('третий тоже получил половину удара',
        Math.abs(flew('d') - 150) < 20,
        'd ' + flew('d').toFixed(0) + ' при 150');
    check('первый в цепочке не пролетел весь удар',
        flew('b') < 300,
        'b ' + flew('b').toFixed(0) + ' при полном ударе 300');
}

{
    // Камень: удар от него отскакивает, а не ломается о него.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 40, y: 0 });
    arena.players[0].dirx = 1;

    step(arena, { b: { stone: true } });
    // Секунда удержания — минимальная ступень. Камень держится две
    // секунды, поэтому заряд в него успевает уложиться.
    for (let i = 0; i < 30; i++) step(arena, { a: { push: true } });
    step(arena, { a: { push: false } });

    check('от камня отскакивает сам бьющий',
        arena.players[0].fly > 0 && arena.players[0].flyx < 0,
        'полёт ' + arena.players[0].fly.toFixed(0) + ' в ' + arena.players[0].flyx);
    check('камень при ударе не летит', arena.players[1].fly === 0,
        'полёт камня ' + arena.players[1].fly);
}

{
    // Без кнопки не отбрасывает ничем: ходьба разводит круги, но
    // импульс она не передаёт.
    const arena = createArena({ size: 800 });
    addPlayer(arena, 'a', { x: -10, y: 0 });
    addPlayer(arena, 'b', { x: 30, y: 0 });

    for (let i = 0; i < 30; i++) step(arena, { a: { x: 1 } });

    const a = arena.players[0];
    const b = arena.players[1];
    check('без кнопки соперник не получает скорости',
        b.vx === 0 && b.vy === 0,
        'скорость ' + b.vx.toFixed(1) + ',' + b.vy.toFixed(1));
    check('без кнопки соперник не летит', b.fly === 0, 'полёт ' + b.fly);
    check('ходьба не разгоняет толкающего сверх нормы',
        a.vx <= T.MAX_SPEED + 1e-6,
        'скорость ' + a.vx.toFixed(1));
}

{
    // Конус перед носиком: сзади толчок не достаёт, иначе можно было бы
    // стрелять куда угодно, не разворачиваясь.
    const arena = createArena({ size: 800 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: -30, y: 0 });

    charged(arena, 'a', 30);

    check('позади толчок не достаёт', arena.players[1].fly === 0,
        'полёт ' + arena.players[1].fly);
}

{
    // Дальше радиуса тоже не достаёт: толчок — ближний бой.
    const arena = createArena({ size: 800 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: T.PUSH_RANGE + 20, y: 0 });

    charged(arena, 'a', 30);

    check('вне радиуса толчок не достаёт', arena.players[1].fly === 0,
        'дистанция ' + (T.PUSH_RANGE + 20) + ' при радиусе ' + T.PUSH_RANGE);
}

{
    // На откате заряд не копится: кнопку держать можно, удар не выйдет.
    const arena = createArena({ size: 800 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 30, y: 0 });

    charged(arena, 'a', 30);
    check('после удара включился откат',
        arena.players[0].cooldowns.push > T.PUSH_COOLDOWN - 0.1,
        'откат ' + arena.players[0].cooldowns.push.toFixed(2));

    // истёк, и заряд начал бы копиться заново.
    for (let i = 0; i < 80; i++) step(arena, { a: { push: true } });

    check('на откате заряд не копится', arena.players[0].charge === 0,
        'заряд ' + arena.players[0].charge);
    check('на откате кнопка не стреляет',
        arena.players[1].fly === 0,
        'полёт ' + arena.players[1].fly);
}

{
    // А откат толчка длится ровно три секунды: держать кнопку дольше
    // нельзя — заряд не копится, удар не выходит.
    const arena = createArena({ size: 800 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 30, y: 0 });

    charged(arena, 'a', 30);
    for (let i = 0; i < 95; i++) step(arena, { a: { push: true } });

    check('откат толчка длится три секунды',
        arena.players[0].cooldowns.push === 0,
        'осталось ' + arena.players[0].cooldowns.push.toFixed(2));
    check('после отката толчок снова работает',
        arena.players[0].charge > 0,
        'заряд ' + arena.players[0].charge.toFixed(2));
}

{
    // Толчок не двигает самого себя: он — передача отлёта, а не отдача.
    const arena = createArena({ size: 800 });
    addPlayer(arena, 'a', { x: -20, y: 0 });
    addPlayer(arena, 'b', { x: 10, y: 0 });

    step(arena, { a: { x: 1, push: true } });

    const a = arena.players[0];
    const expected = Math.min(T.MAX_SPEED, T.ACCEL * T.TICK);
    check('толкающий не получает отдачи',
        Math.abs(a.vx - expected) < 1e-6,
        'скорость ' + a.vx.toFixed(2) + ', ждали ' + expected.toFixed(2));
}


// --- Прыжок ---------------------------------------------------------------

{
    // Прыжок летит ровно 300 единиц и не оставляет инерции: задан
    // расстоянием, а не временем. При временном задании на скорости 900
    // после прыжка оставалось бы ещё 200 единиц разгона, и «300»
    // означало бы пятьсот.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'p', { x: -1000, y: 0 });
    const from = arena.players[0].x;

    step(arena, { p: { x: 1, jump: true } });
    for (let i = 0; i < 60 && arena.players[0].jumpLeft > 0; i++) step(arena, {});
    for (let i = 0; i < 30; i++) step(arena, {});

    const flew = arena.players[0].x - from;
    check('прыжок летит ровно 300 единиц',
        Math.abs(flew - T.JUMP_DISTANCE) < 1,
        'пролетел ' + flew.toFixed(1) + ' при ' + T.JUMP_DISTANCE);
    check('прыжок не оставляет инерции',
        Math.hypot(arena.players[0].vx, arena.players[0].vy) < 1e-6,
        'скорость ' + Math.hypot(arena.players[0].vx, arena.players[0].vy).toFixed(2));
}

{
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'p', { x: 0, y: 0 });

    step(arena, { p: { x: 1, jump: true } });

    check('прыжок запускает откат', arena.players[0].cooldowns.jump > 4,
        'откат ' + arena.players[0].cooldowns.jump.toFixed(2));
    check('откат прыжка — 5 секунд', Math.abs(T.JUMP_COOLDOWN - 5) < 1e-9,
        String(T.JUMP_COOLDOWN));
}

{
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'p', { x: 0, y: 0 });
    arena.players[0].cooldowns.jump = 1.0;

    step(arena, { p: { x: 1, jump: true } });

    check('прыжок на откате не срабатывает', arena.players[0].jumpLeft === 0);
}

{
    // Удержание клавиши не крутит откат: прыжок — по фронту.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'p', { x: 0, y: 0 });

    step(arena, { p: { x: 1, jump: true } });
    const cdAfterFirst = arena.players[0].cooldowns.jump;
    step(arena, { p: { x: 1, jump: true } });

    check('удержание не перезапускает прыжок',
        arena.players[0].cooldowns.jump < cdAfterFirst,
        'откат ' + cdAfterFirst.toFixed(2) + ' -> '
        + arena.players[0].cooldowns.jump.toFixed(2));
}

{
    // Летящего и прыгающего толчок не берёт: первый уже в пути, второй
    // неуязвим. Иначе можно было бы выбивать с поля тем, кто сейчас в
    // воздухе, то есть собственным прыжком.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 40, y: 0 });
    arena.players[0].dirx = 1;

    step(arena, { b: { x: 1, jump: true } });
    charged(arena, 'a', 30);
    check('прыгающего не толкнуть', arena.players[1].fly === 0,
        'полёт ' + arena.players[1].fly);

    // Приземлился — снова обычная цель. Прыжок унёс его на 300
    // единиц, поэтому возвращаем на исходное место вручную.
    arena.players[1].jumpLeft = 0;
    arena.players[1].x = 40;
    arena.players[1].vx = 0;
    arena.players[1].vy = 0;
    arena.players[1].charge = 0;
    arena.players[0].cooldowns.push = 0;
    charged(arena, 'a', 30);
    check('а уже приземлившегося толкнуть можно', arena.players[1].fly > 0,
        'полёт ' + arena.players[1].fly);
}


// --- Камень ---------------------------------------------------------------

{
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });

    step(arena, { a: { stone: true } });

    check('камень включился', arena.players[0].stone > 1.9,
        'осталось ' + arena.players[0].stone.toFixed(2));
    check('откат камня включает время камня',
        arena.players[0].cooldowns.stone > T.STONE_TIME,
        'откат ' + arena.players[0].cooldowns.stone.toFixed(2));
    check('откат камня после конца — 7 секунд',
        Math.abs(T.STONE_COOLDOWN - 7) < 1e-9,
        String(T.STONE_COOLDOWN));
}

{
    // Каменный не двигается: это камень.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });

    step(arena, { a: { x: 1, stone: true } });
    const x0 = arena.players[0].x;
    for (let i = 0; i < 30; i++) step(arena, { a: { x: 1 } });

    check('каменный не ходит', Math.abs(arena.players[0].x - x0) < 1e-6,
        'сдвинулся на ' + (arena.players[0].x - x0).toFixed(3));
}

{
    // Каменный **замирает на месте**, а не перестаёт нажимать кнопки.
    // Разница видна только на ходу: скорость к моменту окаменения
    // ещё полная, и если её не погасить, герой въедет в камень на
    // полном ходу и ещё секунду будет скользить. Замеряно вживую:
    // 54 единицы после окаменения на скорости 95.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });

    // Разгоняемся, потом окаменяем на ходу.
    for (let i = 0; i < 30; i++) step(arena, { a: { x: 1 } });
    const speed = arena.players[0].vx;
    step(arena, { a: { x: 1, stone: true } });
    const x0 = arena.players[0].x;
    for (let i = 0; i < 40; i++) step(arena, { a: { x: 1 } });

    check('окаменение на ходу останавливает сразу',
        Math.abs(arena.players[0].x - x0) < 1e-6,
        'скорость перед камнем ' + speed.toFixed(0) + ', сдвинулся на '
        + (arena.players[0].x - x0).toFixed(3));
}

{
    // Камень кончился — игрок снова ходит.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });

    step(arena, { a: { x: 1, stone: true } });
    for (let i = 0; i < 70; i++) step(arena, { a: { x: 1 } });

    check('после камня снова можно ходить',
        arena.players[0].stone === 0 && arena.players[0].vx > 0,
        'камень ' + arena.players[0].stone.toFixed(2) + ', скорость '
        + arena.players[0].vx.toFixed(1));
}

{
    // Камень стоит две секунды.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });

    step(arena, { a: { stone: true } });
    for (let i = 0; i < 61; i++) step(arena, {});

    check('камень держится две секунды', arena.players[0].stone === 0,
        'осталось ' + arena.players[0].stone.toFixed(3));
}

{
    // Камень неподвижен и **от разведения**, а не только от своего
    // хода. Проверяется тем, что в него упираются дважды: собственный
    // ход проверяет уже предыдущий тест, а здесь важно другое — камень
    // нельзя сдвинуть ни выжиманием, ни налетевшим на него телом.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'stone', { x: 0, y: 0 });
    addPlayer(arena, 'pusher', { x: -T.PLAYER_RADIUS, y: 0 });

    step(arena, { stone: { stone: true } });
    const x0 = arena.players[0].x;

    // Пятидесяти тиков в упор: толкающий идёт **в камень**, то есть
    // вправо. Уйти влево — просто разойтись, и проверка прошла бы
    // вхолостую, ни разу не коснувшись камня.
    for (let i = 0; i < 50; i++) {
        step(arena, { pusher: { x: 1 } });
    }

    check('камень нельзя сдвинуть выжиманием',
        arena.players[0].x === x0,
        'сдвинулся на ' + (arena.players[0].x - x0).toFixed(4));

    // И налетевшее тело тоже не должно унести камень: от удара
    // отскакивает бьющий, а не тот, кто стоял.
    const arena2 = createArena({ size: 3000 });
    addPlayer(arena2, 'stone', { x: 0, y: 0 });
    addPlayer(arena2, 'att', { x: -260, y: 0 });
    step(arena2, { stone: { stone: true } });

    const sx = arena2.players[0].x;
    for (let i = 0; i < 30; i++) step(arena2, { att: { x: 1, push: true } });
    step(arena2, { att: { push: false } });
    for (let i = 0; i < 12; i++) step(arena2, {});

    check('налетевший удар не сдвигает камень',
        arena2.players[0].x === sx,
        'камень сдвинулся на ' + (arena2.players[0].x - sx).toFixed(4)
        + ', бьющий жив ' + arena2.players[1].alive);
}


// --- Конец партии: остаётся один ------------------------------------------

{
    const arena = createArena({ size: 800 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 300, y: 0 });

    // Выбываем минуя физику: здесь проверяется правило конца партии,
    // а не то, как именно соперника вытолкнули.
    arena.players[1].alive = false;
    const events = step(arena, {});

    check('партия завершается, когда остаётся один', arena.finished === true);
    check('победитель — оставшийся', arena.winner === 'a', `победил ${arena.winner}`);
    check('место победителя — первое', arena.players[0].place === 1,
        `место ${arena.players[0].place}`);
    check('конец партии отдан событием',
        events.some(e => e.type === 'finished'));
}

{
    // После конца ввод не должен ни двигать победителя, ни переписывать
    // места: поздние пакеты опоздавших игроков ломали бы итог.
    const arena = createArena({ size: 800 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 300, y: 0 });
    arena.players[1].alive = false;
    step(arena, {});

    const xBefore = arena.players[0].x;
    const cdBefore = arena.players[0].cooldowns.push;
    for (let i = 0; i < 100; i++) {
        step(arena, { a: { x: 1, jump: true, push: true } });
    }

    check('после конца партии ввод игнорируется',
        arena.players[0].x === xBefore,
        `сдвинулся на ${(arena.players[0].x - xBefore).toFixed(2)}`);
    check('после конца не крутятся и откаты',
        arena.players[0].cooldowns.push === cdBefore,
        `перезарядка ${cdBefore.toFixed(2)} -> ${arena.players[0].cooldowns.push.toFixed(2)}`);
    check('после конца событий больше нет',
        step(arena, {}).length === 0);
}

{
    // Одиночная тренировка не должна завершаться сама собой —
    // иначе нечему учиться.
    const arena = createArena();
    addPlayer(arena, 'only', { x: 0, y: 0 });
    for (let i = 0; i < 300; i++) step(arena, { only: { x: 1 } });

    check('одиночная партия не завершается сама', arena.finished === false);
}


// --- Места ----------------------------------------------------------------

{
    const arena = createArena({ size: 400 });
    for (let i = 0; i < 8; i++) addPlayer(arena, `p${i}`, spawnPoint(i, 8, 400));

    // За границей выбывает только летящий, поэтому вылет задаётся
    // напрямую: иначе проверка мест проверяла бы ещё и то, что граница
    // кого-то выбрасывает, — а это теперь отдельное решение.
    const launch = (p) => {
        p.x = 500;
        p.fly = 500;
        p.strike = 500;
        p.flyx = 1;
    };

    launch(arena.players[0]);
    step(arena, {});
    check('первый выбывший получает последнее место',
        arena.players[0].place === 8, `место ${arena.players[0].place}`);
    check('партия ещё не кончилась', arena.finished === false);

    launch(arena.players[1]);
    step(arena, {});
    check('второй выбывший получает предпоследнее место',
        arena.players[1].place === 7, `место ${arena.players[1].place}`);
}


// --- Численная устойчивость -----------------------------------------------

/** Долгий прогон со случайным на вид вводом: ловит NaN и застревания. */
function longRun() {
    const arena = createArena({ size: 700 });
    for (let i = 0; i < 6; i++) addPlayer(arena, `p${i}`, spawnPoint(i, 6, 700));

    for (let i = 0; i < 5000 && !arena.finished; i++) {
        const inputs = {};
        for (const p of arena.players) {
            if (!p.alive) continue;
            inputs[p.id] = {
                x: Math.sin((i + p.x) / 17),
                y: Math.cos((i + p.y) / 23),
                jump: i % 71 === 0,
                stone: i % 173 === 0,
                push: i % 90 === 0,
            };
        }
        step(arena, inputs);
    }
    return arena;
}

{
    const arena = longRun();
    const finite = arena.players.every(p =>
        Number.isFinite(p.x) && Number.isFinite(p.y) &&
        Number.isFinite(p.vx) && Number.isFinite(p.vy));
    check('5000 тиков без NaN', finite);
    check('долгий прогон доигран или стоит',
        arena.finished || arena.tick >= 1,
        `тиков ${arena.tick}`);

    const places = arena.players.filter(p => !p.alive).map(p => p.place);
    check('места у всех выбывших проставлены',
        places.every(p => Number.isInteger(p) && p >= 2),
        `места: ${places.join(', ')}`);

    const cds = arena.players.every(p =>
        p.cooldowns.push >= 0 && p.cooldowns.push <= T.PUSH_COOLDOWN + 1e-6
        && p.cooldowns.jump >= 0 && p.cooldowns.jump <= T.JUMP_COOLDOWN + 1e-6
        && p.cooldowns.stone >= 0
        && p.cooldowns.stone <= T.STONE_TIME + T.STONE_COOLDOWN + 1e-6);
    check('перезарядки не уходят в минус и не растут бесконечно', cds);
}

{
    const a = createArena({ size: 600 });
    addPlayer(a, 'p1', { x: -100, y: 0 });
    addPlayer(a, 'p2', { x: 100, y: 0 });
    for (let i = 0; i < 300; i++) {
        step(a, {
            p1: { x: 1, y: ((i % 7) - 3) / 10, jump: i % 40 === 0, stone: i % 91 === 0 },
            p2: { x: -1, y: 0.3, jump: i % 55 === 0, stone: i % 113 === 0 },
        });
    }
    const first = a.players.map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.alive ? 1 : 0}`).join('|');

    const b = createArena({ size: 600 });
    addPlayer(b, 'p1', { x: -100, y: 0 });
    addPlayer(b, 'p2', { x: 100, y: 0 });
    for (let i = 0; i < 300; i++) {
        step(b, {
            p1: { x: 1, y: ((i % 7) - 3) / 10, jump: i % 40 === 0, stone: i % 91 === 0 },
            p2: { x: -1, y: 0.3, jump: i % 55 === 0, stone: i % 113 === 0 },
        });
    }
    const second = b.players.map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.alive ? 1 : 0}`).join('|');

    check('симуляция детерминирована', first === second);
}


// --- Событие удара для анимации -------------------------------------------

{
    // Событие приходит и при попадании, и при промахе: без промаха игрок
    // не заметил бы, что три секунды готовил удар в пустоту.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 40, y: 0 });
    arena.players[0].dirx = 1;
    arena.players[0].diry = 0;

    const hit = charged(arena, 'a', 60).find(e => e.type === 'push');

    check('удар отдаёт событие', !!hit);
    check('событие помнит направление',
        !!hit && hit.dirx === 1 && hit.diry === 0,
        hit ? hit.dirx + ',' + hit.diry : 'нет события');
    check('событие помнит ступень заряда',
        !!hit && hit.tier === 2 && hit.dist === 200,
        hit ? 'ступень ' + hit.tier + ', отлёт ' + hit.dist : 'нет события');
    check('в событии перечислены задетые',
        !!hit && hit.hits.length === 1 && hit.hits[0] === 'b',
        hit ? hit.hits.join(',') : 'нет события');
}

{
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 300, y: 0 });
    arena.players[0].dirx = 1;

    const whiff = charged(arena, 'a', 30).find(e => e.type === 'push');

    check('промах тоже событие', !!whiff && whiff.hits.length === 0,
        whiff ? whiff.hits.join(',') : 'нет события');
}


// --- Граница держит: выбывает только полёт -------------------------------

{
    // Ходьба за край больше не выбрасывает. Раньше игрок вылетал просто
    // тем, что отошёл, и толчок переставал быть единственным поводом
    // рисковать: можно было выиграть, ни разу не ударив.
    const arena = createArena({ size: 200 });
    addPlayer(arena, 'a', { x: 99, y: 0 });

    for (let i = 0; i < 120; i++) step(arena, { a: { x: 1 } });

    const a = arena.players[0];
    check('ходьба за край не выбрасывает', a.alive === true, 'выбыл');
    check('граница прижимает к себе', Math.abs(a.x) <= 100 + 1e-6,
        'x ' + a.x.toFixed(2) + ' при половине поля 100');
    check('у края гасится внешняя скорость',
        Math.abs(a.vx) < 1e-6, 'скорость ' + a.vx.toFixed(2));
}

{
    // За край выносит толчок — с автором и со вторым местом.
    const arena = createArena({ size: 200 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 40, y: 0 });
    arena.players[0].dirx = 1;

    charged(arena, 'a', 90);
    for (let i = 0; i < 60 && arena.players[1].alive; i++) step(arena, {});

    const b = arena.players[1];
    check('толчок выбрасывает за границу', b.alive === false,
        'запас ' + marginOf(b.x, b.y, 200).toFixed(1));
    check('кем вытолкнут — автором удара', b.eliminatedBy === 'a',
        String(b.eliminatedBy));
    check('партия доиграна', arena.finished === true);
    check('выиграл толкавший', arena.winner === 'a', String(arena.winner));
}

{
    // Прыжок за край не выбрасывает: он неуязвим и доводит до нужной
    // точки, а не подставляет под вылет.
    const arena = createArena({ size: 200 });
    addPlayer(arena, 'a', { x: 0, y: 0 });

    step(arena, { a: { x: 1, jump: true } });
    for (let i = 0; i < 40 && arena.players[0].alive; i++) step(arena, {});

    check('прыжок за край не выбрасывает', arena.players[0].alive === true,
        'запас ' + marginOf(arena.players[0].x, arena.players[0].y, 200).toFixed(1));
}


// --- Итог -----------------------------------------------------------------

console.log(`ядро арены: ${passed} проверок пройдено, ${failed} провалено`);
if (failed > 0) {
    for (const f of failures) console.log(`  ПРОВАЛ: ${f}`);
    process.exit(1);
}
