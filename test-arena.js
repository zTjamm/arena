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
    T, createArena: createRaw, addPlayer: addRaw, spawnPoint, step, marginOf, snapshot
} = require('./game/arena');

/**
 * Арена для проверок механики.
 *
 * Звезда **выключена**. Это оказалось обязательным: игроки в проверках
 * стоят около центра, а звезда лежит именно там, и за семь секунд
 * счётчика её успевали подобрать — ступень уезжала за вторую, толчок
 * становился 450 вместо 300, и проверки базовых величин падали одна за
 * другой. Поведение при этом было правильным: звезда и должна браться
 * в счётчик.
 *
 * Значит прогрессию нужно проверять намеренно, а не получать в
 * подарок — см. блок «прогрессия» ближе к концу файла.
 */
function createArena(options = {}) {
    const arena = createRaw(options);
    arena.star.up = false;
    arena.star.again = Infinity;
    return arena;
}

/**
 * Игрок для проверок механики.
 *
 * Второй и третий скиллы открываются **ступенями прогрессии**, поэтому
 * голый игрок их не имеет: нажатие молча игнорируется, и проверка падала
 * бы, не объясняя почему.
 *
 * Выдаётся ступень **вторая**, а не максимальная, и это важно. Первые
 * две ступени только *открывают* скиллы и не меняют их числа. А вот
 * третья и выше уже меняют: толчок 450 вместо 300, откат прыжка 2.5
 * вместо 5, камень 450 вместо 300, замах 0.35 вместо 0.7. С максимумом
 * молча сломались бы все проверки базовых величин.
 */
function addPlayer(arena, id, options = {}) {
    addRaw(arena, id, options);
    for (const p of arena.players) p.grade = T.GRADE_STONE;
}

/**
 * Сколько тиков в `seconds`.
 *
 * Тесты крутят симуляцию тиками, а тик поменялся с 1/30 на 1/60. Любое
 * число тиков в проверке после этого означает вдвое меньше времени, и
 * проверка падает на ровном месте, хотя логика не менялась. Поэтому все
 * ожидания по времени считаются здесь, а не вписаны числами.
 */
function windupTicks(seconds) {
    return Math.ceil((seconds === undefined ? 1 : seconds) / T.TICK);
}

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
/**
 * Прожить первые SPAWN_GRACE секунд партии.
 *
 * Нужна всем проверкам удара: первые три секунды бить нельзя, и
 * сценарий, который жмёт кнопку с самого старта, просто не выстрелит
 * — проверка падала бы не потому, что удар сломался, а потому, что
 * его ещё не существует.
 */
function pastGrace(arena) {
    // Идём **до конца** счётчика, а не ровно ceil(7 / (1/60)) тиков.
    //
    // 1/60 не representable в двоичной, и 420 таких шагов дают 6.99999…
    // а не 7. Пока на счётчике было запрещено только бить, такая мелочь
    // была безобидна. Теперь на счётчике нельзя двигаться, и одно
    // лишнее деление решает, начал ли игрок ходить.
    let guard = Math.ceil(T.SPAWN_GRACE / T.TICK) + 5;
    while (arena.elapsed < T.SPAWN_GRACE && guard-- > 0) step(arena, {});
    if (arena.elapsed < T.SPAWN_GRACE) {
        throw new Error('pastGrace не довёл счётчик до конца: ' + arena.elapsed);
    }
}

function pastGraceOld(arena) {
    // Идемпotentно: если отсчёт уже прошёл, ничего не делаем.
    //
    // Раньше вызов всегда крутил ровно 90 тиков, и сценарий, который
    // сам вызвал pastGrace, а потом позвал charged (а тот звал
    // pastGrace ещё раз), получал лишние три секунды ходьбы впустую.
    // На камне это ломало проверку целиком: камень короче отсчёта
    // (1.3 с против трёх) и успевал истечь до начала замаха.
    if (arena.elapsed >= T.SPAWN_GRACE) return;
    const ticks = Math.ceil(T.SPAWN_GRACE / T.TICK);
    for (let i = 0; i < ticks; i++) step(arena, {});
}

/**
 * Замах и удар: нажать и **держать** до конца замаха.
 *
 * Раньше здесь копился заряд, а удар уходил на отпускании. Теперь
 * заряда нет: нажатие начинает замах на PUSH_WINDUP секунд, игрок на
 * это время стоит, и удар уходит сам. Помощник просто держит
 * кнопку и возвращает события тика, в который удар пришёл.
 *
 * Позиции запоминаются до замаха: игрок всё это время на месте,
 * а мерить отлёт надо оттуда, откуда били.
 */
function charged(arena, id) {
    pastGrace(arena);

    charged.positions = arena.players.map(p => [p.x, p.y]);

    const inputs = {};
    inputs[id] = { push: true };

    const windup = Math.ceil(T.PUSH_WINDUP / T.TICK) + 1;
    let events = [];
    for (let i = 0; i < windup; i++) {
        events = events.concat(step(arena, inputs));
    }
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
    // Отлёт всегда максимальный: 300 единиц, без ступеней.
    //
    // Раньше удар давал 100 / 200 / 300 в зависимости от того,
    // сколько продержали кнопку. Проверка показала, что первую
    // ступень почти не брали (150 попаданий из 3492), то есть
    // выбора силы не происходило — брали полную всегда. Значит
    // ступени были лишним решением, и их убрали.
    //
    // Отлёт задан расстоянием, а не импульсом, поэтому сходится
    // точно, а не «примерно как в прошлый раз».
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 70, y: 0 });
    arena.players[0].dirx = 1;

    charged(arena, 'a');
    const flew = flyOut(arena, 'b');

    check('толчок отбрасывает на 300',
        Math.abs(flew - T.PUSH_DIST) < 0.5,
        'отлетел ' + flew.toFixed(1));

{
    // Первые SPAWN_GRACE секунд удара нет.
    //
    // Проверяется в три приёма, потому что «удара нет» можно
    // понимать по-разному, и важно, чтобы работало именно то,
    // что обещано:
    //
    //   1) замах не начинается даже вплотную к сопернику;
    //   2) кнопка не тратится — иначе игрок потерял бы и секунду
    //      стояния, и откат, за то, что вообще не мог бить;
    //   3) счётчик отката остаётся нетронутым.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 70, y: 0 });
    arena.players[0].dirx = 1;

    for (let i = 0; i < Math.ceil(T.SPAWN_GRACE / T.TICK); i++) {
        step(arena, { a: { push: true } });
    }

    check('в первые секунды замах не берётся',
        arena.players[0].swing === 0,
        'замах ' + arena.players[0].swing.toFixed(2));
    check('в первые секунды удар не проходит', arena.players[1].fly === 0,
        'полёт ' + arena.players[1].fly.toFixed(0)
        + ' на ' + arena.elapsed.toFixed(2) + ' с');
    check('откат на отсчёте не тратится',
        arena.players[0].cooldowns.push === 0,
        'откат ' + arena.players[0].cooldowns.push.toFixed(2));
}
}

{
    // Отсчёт кончился — бить можно. Кнопку, зажатую на отсчёте, не
    // съедает ничего: ни замаха, ни отката. Иначе игрок, который
    // держал кнопку в ожидании, вышел бы с партии ещё и с потраченным
    // откатом, то есть за то, что не мог бить.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 70, y: 0 });
    arena.players[0].dirx = 1;

    const graceTicks = Math.ceil(T.SPAWN_GRACE / T.TICK);
    for (let i = 0; i < graceTicks; i++) step(arena, { a: { push: true } });

    check('на отсчёте удара нет', arena.players[1].fly === 0,
        'полёт ' + arena.players[1].fly);
    check('на отсчёте замах не тратится',
        arena.players[0].swing === 0 && arena.players[0].cooldowns.push === 0,
        'замах ' + arena.players[0].swing.toFixed(2)
        + ', откат ' + arena.players[0].cooldowns.push.toFixed(2));

    // Держим кнопку: первый же замах после отсчёта должен состояться.
    const events = charged(arena, 'a');
    check('после отсчёта первый удар проходит',
        events.some(e => e.type === 'push' && e.hits.length > 0),
        'события ' + events.map(e => e.type).join(','));
}

{
    // Оглушение в полёте: пока летишь, ты не можешь ни окаменеть, ни
    // прыгнуть, ни двигаться. Замах при этом тоже не берётся.
    //
    // Правило держится на двух проверках в `applySkills` и
    // `applyMovement`, и ничем не было закреплено — а значит, любой
    // сдвиг в них тихо ломал бы игру: выбитый мог бы на лету
    // превратиться в камень и отбиться, то есть удар, который его
    // выбил, оказывался бы бесполезным.
    const arena = createArena({ size: 800 });
    addPlayer(arena, 'att', { x: -80, y: 0 });
    addPlayer(arena, 'me', { x: 0, y: 0 });
    pastGrace(arena);
    arena.players[0].dirx = 1;

    // Выбиваем.
    charged(arena, 'att');
    const me = arena.players[1];
    check('жертва удара летит', me.fly > 0, 'полёт ' + me.fly.toFixed(0));

    // В полёте жмём всё и двигаемся.
    let inFlight = 0;
    while (me.fly > 0 && inFlight < 200) {
        step(arena, { me: { x: 1, y: 1, jump: true, stone: true, push: true } });
        inFlight++;
    }

    check('в полёте не окаменеть', me.stone === 0,
        'камень ' + me.stone.toFixed(2));
    check('в полёте не прыгнуть',
        me.jumpLeft === 0 && me.cooldowns.jump === 0,
        'прыжок ' + me.jumpLeft.toFixed(0) + ', откат '
        + me.cooldowns.jump.toFixed(2));
    check('в полёте не двигаться',
        Math.abs(me.vx) < 1e-6 && Math.abs(me.vy) < 1e-6,
        'скорость ' + me.vx.toFixed(2) + ',' + me.vy.toFixed(2));
    check('в полёте замах не берётся', me.swing === 0,
        'замах ' + me.swing.toFixed(2));
}

{
    // Сразу после полёта всё сразу доступно: и ход, и скиллы, без
    // ожидания и остаточного стана.
    const arena = createArena({ size: 800 });
    addPlayer(arena, 'att', { x: -80, y: 0 });
    addPlayer(arena, 'me', { x: 0, y: 0 });
    pastGrace(arena);
    arena.players[0].dirx = 1;

    charged(arena, 'att');
    const me = arena.players[1];

    // Циклы ожидания полёта и прыжка ограничены сверху. Без предела
    // такой цикл зависает навсегда, если состояние не доедет до нуля:
    // раньше это случалось из-за бага в ядре, где выбывший в полёте
    // сохранял fly > 0 навсегда. Ограничение превращает такое зависание
    // в падение проверки с понятным текстом, а не в молчание на
    // полчаса.
    let guard = windupTicks(30);
    while (me.fly > 0 && guard-- > 0) step(arena, {});
    check('полёт длится конечное время', me.fly === 0,
        'осталось ' + me.fly.toFixed(1));

    const x0 = me.x;
    for (let i = 0; i < 10; i++) step(arena, { me: { x: 1 } });
    check('после полёта сразу можно двигаться',
        Math.abs(me.x - x0) > 5,
        'сдвиг ' + (me.x - x0).toFixed(0));

    step(arena, { me: { x: 1, jump: true } });
    check('после полёта сразу можно прыгнуть', me.jumpLeft > 0,
        'прыжок ' + me.jumpLeft.toFixed(0));

    guard = windupTicks(30);
    while (me.jumpLeft > 0 && guard-- > 0) step(arena, {});
    step(arena, { me: { stone: true } });
    check('после полёта сразу можно окаменеть', me.stone > 0,
        'камень ' + me.stone.toFixed(2));
}

{
    // Замах длится ровно PUSH_WINDUP, а не «пока держишь».
    //
    // Это и было главным изменением: игрок платит секунду
    // неподвижности за удар, и секунда обязана быть известной —
    // иначе нельзя было бы ни просчитать, ни уклониться.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    pastGrace(arena);

    const swingTicks = Math.ceil(T.PUSH_WINDUP / T.TICK);
    step(arena, { a: { push: true } });
    const atPress = arena.players[0].swing;

    check('нажатие ставит полный замах',
        Math.abs(atPress - T.PUSH_WINDUP) < 1e-6,
        'замах ' + atPress.toFixed(3));

    // Секунда замаха — игрок стоит на месте.
    const x0 = arena.players[0].x;
    for (let i = 0; i < swingTicks - 1; i++) {
        step(arena, { a: { x: 1, push: true } });
    }
    check('за замах игрок стоит на месте',
        Math.abs(arena.players[0].x - x0) < 1e-6,
        'сдвиг ' + (arena.players[0].x - x0).toFixed(2));

    // И удар приходит на последнем тике замаха.
    let landed = false;
    for (let i = 0; i < 4; i++) {
        for (const e of step(arena, { a: { x: 1, push: true } })) {
            if (e.type === 'push') landed = true;
        }
    }
    check('удар приходит ровно через PUSH_WINDUP', landed,
        'удара не было');
}

{
    // Отпускание кнопки **не отменяет замах**.
    //
    // Раньше удар уходил на отпускании, и отпустить раньше означало
    // «выстрелить в пустоту». Теперь всё наоборот: замах начался —
    // он и дойдёт до конца, потому что игрок уже заплатил за него
    // секунду неподвижности. Иначе получается обман: отпустил на
    // середине, простоял зря, откат потрачен.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 70, y: 0 });
    arena.players[0].dirx = 1;
    pastGrace(arena);

    step(arena, { a: { push: true } });

    // Отпустили через 10 тиков и больше кнопку не трогаем.
    let landed = null;
    for (let i = 0; i < windupTicks(T.PUSH_WINDUP + 0.5); i++) {
        const inputs = i === 10 ? { a: { push: false } } : {};
        for (const e of step(arena, inputs)) {
            if (e.type === 'push') landed = e;
        }
    }

    check('отпускание не отменяет замах', !!landed, 'удар не вышел');
    check('удар после отпускания попадает',
        landed && landed.hits.indexOf('b') >= 0,
        landed ? 'попадал ' + (landed.hits.join(',') || 'никто') : 'удара не было');
}

{
    // Бьётся только ближайший в конусе: толкнуть толпу нельзя.
    //
    // Расставка под новый радиус: тела соприкасаются на 56, поэтому
    // «near» и «far» стоят в разных углах конуса, а не вдоль одной
    // оси — иначе они перекрывались и расходились сами, пока копится
    // заряд, и проверка мерила бы не удар, а разводку.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'near', { x: 60, y: 0 });
    addPlayer(arena, 'far', { x: 60, y: 80 });
    arena.players[0].dirx = 1;

    const hit = charged(arena, 'a').find(e => e.type === 'push');

    check('толчок бьёт одного', !!hit && hit.hits.length === 1,
        hit ? hit.hits.join(',') : 'нет события');
    check('толчок бьёт ближайшего', !!hit && hit.hits[0] === 'near',
        hit ? hit.hits.join(',') : 'нет события');
}

{
    // Цепочка: летящий влезает в следующего — тот отлетает на две трети
    // удара, а первый тормозит на месте.
    //
    // Две трети, а не половина: замер показал, что при половине сила
    // таяла слишком быстро и длинная цепочка ничего не значила
    // (второй и третий получали заметно меньше первого). Теперь
    // цепочка держит силу на любой длине.
    //
    // Полного отлёта (200) никто не пролетает: сила передаётся при
    // соприкосновении, а тела радиусом 28, то есть передача случается
    // за 56 единиц до конца полёта. Проверяется поэтому «заметно
    // далеко», а не «ровно 200».
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 70, y: 0 });
    addPlayer(arena, 'c', { x: 300, y: 0 });
    addPlayer(arena, 'd', { x: 520, y: 0 });
    arena.players[0].dirx = 1;

    const before = arena.players.map(p => p.x);
    let chain = null;
    charged(arena, 'a');
    for (let i = 0; i < 200; i++) {
        for (const e of step(arena, {})) {
            if (e.type === 'chain') chain = e;
        }
    }

    const flew = (id) => {
        const i = arena.players.findIndex(p => p.id === id);
        return arena.players[i].x - before[i];
    };
    check('второй получил две трети удара',
        flew('c') > 150,
        'c ' + flew('c').toFixed(0) + ', две трети удара 200');
    check('третий тоже получил две трети удара',
        flew('d') > 150,
        'd ' + flew('d').toFixed(0) + ', две трети удара 200');
    check('первый в цепочке не пролетел весь удар',
        flew('b') < 300,
        'b ' + flew('b').toFixed(0) + ' при полном ударе 300');

    // Цепочка сообщается, когда доиграла, и считает **разных** игроков.
    check('цепочка сообщилась', !!chain, 'события не было');
    check('цепочка посчитала троих',
        chain && chain.count === 3,
        chain ? 'цепочка ' + chain.count : 'нет');
    check('суммарная дальность 300+200+200',
        chain && Math.abs(chain.power - 700) < 1,
        chain ? 'сумма ' + chain.power : 'нет');
    check('незакрытых цепочек не осталось',
        arena.chains.size === 0,
        'в карте ' + arena.chains.size);
}

{
    // Камень: удар от него отскакивает, а не ломается о него.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 70, y: 0 });
    arena.players[0].dirx = 1;
    pastGrace(arena);

    // Камень включается уже после отсчёта: он держится 1.3 с, а отсчёт
    // длится три, и окаменение до него сгорело бы впустую.
    step(arena, { b: { stone: true } });
    charged(arena, 'a');

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

    charged(arena, 'a');

    check('позади толчок не достаёт', arena.players[1].fly === 0,
        'полёт ' + arena.players[1].fly);
}

{
    // Дальше радиуса тоже не достаёт: толчок — ближний бой.
    const arena = createArena({ size: 800 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: T.PUSH_RANGE + 20, y: 0 });

    charged(arena, 'a');

    check('вне радиуса толчок не достаёт', arena.players[1].fly === 0,
        'дистанция ' + (T.PUSH_RANGE + 20) + ' при радиусе ' + T.PUSH_RANGE);
}

{
    // На откате замах не берётся: кнопку держать можно, удар не выйдет.
    //
    // Откат считается от **нажатия**, поэтому к концу замаха (через
    // секунду) от него остаётся ровно PUSH_COOLDOWN − PUSH_WINDUP.
    // Проверяется именно поэтому, а не «откат полный»: держать кнопку
    // во время замаха естественно, и к моменту удара откат уже частью
    // истёк. Раньше здесь стояло «откат почти полный», что с новым
    // правилом было просто неверно.
    const arena = createArena({ size: 800 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 30, y: 0 });
    pastGrace(arena);

    step(arena, { a: { push: true } });
    check('нажатие включает полный откат',
        Math.abs(arena.players[0].cooldowns.push - T.PUSH_COOLDOWN) < 1e-6,
        'откат ' + arena.players[0].cooldowns.push.toFixed(3));

    // Дожидаемся конца замаха: с этого момента идёт чистый откат,
    // и вот тут кнопка обязана молчать.
    const windup = Math.ceil(T.PUSH_WINDUP / T.TICK) + 1;
    for (let i = 0; i < windup; i++) step(arena, { a: { push: true } });

    // Держим кнопку остаток отката — но не до конца, иначе замах
    // успел бы начаться снова законно.
    const rest = Math.ceil(arena.players[0].cooldowns.push / T.TICK) - 3;
    for (let i = 0; i < rest; i++) step(arena, { a: { push: true } });

    check('на откате замах не берётся', arena.players[0].swing === 0,
        'замах ' + arena.players[0].swing.toFixed(2)
        + ', откат ' + arena.players[0].cooldowns.push.toFixed(2));
    check('на откате кнопка не стреляет',
        arena.players[1].fly === 0,
        'полёт ' + arena.players[1].fly);
}

{
    // А откат толчка длится ровно PUSH_COOLDOWN от нажатия.
    //
    // Считается он от нажатия, а не от удара: цикл получается
    // «секунда замаха + секунда жизни», и секунда замаха не
    // съедает время на восстановление. Отсчёт от удара дал бы
    // три секунды вместо двух и треть партии — стояли бы.
    const arena = createArena({ size: 800 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 30, y: 0 });

    // Откат отсчитывается от нажатия: к моменту, когда замах доигрывает,
    // от него осталось ровно PUSH_COOLDOWN − PUSH_WINDUP.
    //
    // Считать его от удара нельзя: цикл стал бы «секунда замаха +
    // две секунды отката» — три секунды вместо двух, и треть партии
    // простоя. Отсчёт от нажатия даёт «секунда стою, удар, секунда
    // живу», где каждая секунда на своём месте.
    pastGrace(arena);

    step(arena, { a: { push: true } });

    const windup = Math.ceil(T.PUSH_WINDUP / T.TICK) + 1;
    for (let i = 0; i < windup; i++) step(arena, { a: { push: true } });

    const cdAfterHit = arena.players[0].cooldowns.push;
    const left = T.PUSH_COOLDOWN - T.PUSH_WINDUP;
    check('откат идёт и во время замаха',
        Math.abs(cdAfterHit - left) < 0.15,
        'осталось ' + cdAfterHit.toFixed(2) + ', ждали ' + left.toFixed(2));

    // Дожидаемся конца отката и жмём снова.
    const rest = Math.ceil((cdAfterHit + 0.05) / T.TICK);
    for (let i = 0; i < rest; i++) step(arena, { a: { push: true } });

    check('после отката замах снова берётся',
        arena.players[0].swing > 0,
        'замах ' + arena.players[0].swing.toFixed(2)
        + ', откат ' + arena.players[0].cooldowns.push.toFixed(2));
}

{
    // Толчок не двигает самого себя: он — передача отлёта, а не отдача.
    //
    // Но во время замаха игрок стоит — и это проверяется отдельно выше,
    // в блоке «замах длится ровно PUSH_WINDUP». Здесь проверяется, что
    // после удара игрок снова свободен.
    const arena = createArena({ size: 800 });
    addPlayer(arena, 'a', { x: -20, y: 0 });
    addPlayer(arena, 'b', { x: 10, y: 0 });

    // Проверка про скорость после удара, а не про счётчик: на счётчике
    // не двигается никто, и первый же шаг стоял бы на нулевой скорости.
    pastGrace(arena);

    // Замах целиком, потом удар, и только после этого меряем ход.
    //
    // Раньше проверка жала толчок и сразу мерила скорость, и это
    // работало только потому, что удар на счётчике не начинался вовсе:
    // замаха не было, значит и неподвижности за замахом не было. Теперь
    // счётчик кончился, замах идёт — а он означает полную неподвижность
    // сам по себе.
    const a = arena.players[0];
    let guard = Math.ceil(T.PUSH_WINDUP / T.TICK) + 10;
    while (guard-- > 0) {
        step(arena, { a: { x: 1, push: true } });
        if (a.swing === 0) break;
    }

    check('толкающий снова свободен после удара', a.swing === 0,
        'замах ' + a.swing.toFixed(2));

    // Больше ни шага: удар и движение происходят **в одном тике** —
    // сначала приземляется удар, потом в том же тике игрок уже свободен
    // и разгоняется. Лишний шаг дал бы 33.33 вместо одного разгона.
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
    charged(arena, 'a');
    check('прыгающего не толкнуть', arena.players[1].fly === 0,
        'полёт ' + arena.players[1].fly);

    // Приземлился — снова обычная цель. Прыжок унёс его на 300
    // единиц, поэтому возвращаем на исходное место вручную.
    arena.players[1].jumpLeft = 0;
    arena.players[1].x = 40;
    arena.players[1].vx = 0;
    arena.players[1].vy = 0;
    arena.players[0].cooldowns.push = 0;
    charged(arena, 'a');
    check('а уже приземлившегося толкнуть можно', arena.players[1].fly > 0,
        'полёт ' + arena.players[1].fly);
}


// --- Камень ---------------------------------------------------------------

{
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });

    step(arena, { a: { stone: true } });

    check('камень включился на 1.3 секунды',
        Math.abs(arena.players[0].stone - T.STONE_TIME) < 1e-6
        && Math.abs(T.STONE_TIME - 1.3) < 1e-9,
        'осталось ' + arena.players[0].stone.toFixed(2));
    check('откат камня считается от нажатия',
        Math.abs(arena.players[0].cooldowns.stone - T.STONE_COOLDOWN) < 1e-6,
        'откат ' + arena.players[0].cooldowns.stone.toFixed(2));
    check('откат камня — 7 секунд',
        Math.abs(T.STONE_COOLDOWN - 7) < 1e-9,
        String(T.STONE_COOLDOWN));
}

{
    // По истечении камня вокруг него происходит взрыв отталкивания.
    //
    // Вторая фаза, которой раньше не было вовсе: камень был только
    // щитом, и защита без наказания означала, что против каменного
    // можно было просто стоять и копить откат. Теперь камень ещё и
    // единственный способ выгнать толпу — задел всех сразу, а не
    // ближайшего в конусе.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'rock', { x: 0, y: 0 });
    addPlayer(arena, 'l', { x: -100, y: 0 });
    addPlayer(arena, 'r', { x: 100, y: 0 });
    pastGrace(arena);

    // Позиции меряются **до** нажатия: к моменту, когда взрыв найден,
    // отбрасывание уже отыграло, и «сдвинулся на» вышло бы нулём.
    const before = new Map(arena.players.map(p => [p.id, p.x]));

    step(arena, { rock: { stone: true } });

    let burst = null;
    for (let i = 0; i < 120 && !burst; i++) {
        for (const e of step(arena, {})) {
            if (e.type === 'burst') burst = e;
        }
    }

    check('взрыв происходит по истечении камня', !!burst,
        'взрыва не было');
    check('взрыв задевает всех в радиусе, а не только ближайшего',
        burst && burst.hits.length === 2,
        burst ? 'задело ' + burst.hits.join(',') : 'нет');
    check('взрыв летит от камня, а не по его взгляду',
        burst && burst.dist === T.STONE_BURST,
        burst ? 'отлёт ' + burst.dist : 'нет');

    // Долетить то, что взрыв разослал. В тик самого взрыва успевает
    // уйти только первый шаг полёта (20 единиц при скорости 600),
    // поэтому мерять «сдвинулся» имеет смысл лишь после того, как
    // оба дорисуют свой отлёт.
    for (let i = 0; i < 60; i++) {
        if (arena.players.every(p => p.fly === 0)) break;
        step(arena, {});
    }

    // И действительно отбрасывает — прочь от камня, а не в одну сторону.
    for (const id of ['l', 'r']) {
        const i = arena.players.findIndex(p => p.id === id);
        const p = arena.players[i];
        check(id + ' отброшен взрывом прочь от камня',
            Math.abs(p.x - before.get(id)) > 100
            && Math.sign(p.x - before.get(id)) === Math.sign(before.get(id)),
            'с ' + before.get(id).toFixed(0) + ' на ' + p.x.toFixed(0));
    }
}

{
    // Взрыв не трогает того, кто уже летит: он и так улетает, а второй
    // толчок в полёте просто сдвинул бы его с места вылета.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'rock', { x: 0, y: 0 });
    addPlayer(arena, 'other', { x: -100, y: 0 });
    addPlayer(arena, 'flyer', { x: 100, y: 0 });
    pastGrace(arena);

    step(arena, { rock: { stone: true } });

    // «flyer» весь камень держится в полёте: подбрасываем заново каждый
    // тик, иначе к моменту взрыва он давно приземлился (полёт 400
    // единиц при скорости 600 — это меньше двух секунд) и проверка
    // прошла бы совсем не то, что думалось.
    let burst = null;
    for (let i = 0; i < 120 && !burst; i++) {
        const f = arena.players[2];
        f.fly = 400;
        f.flyx = -1;
        f.flyy = 0;
        for (const e of step(arena, {})) {
            if (e.type === 'burst') burst = e;
        }
    }

    check('летящего взрыв не задевает',
        burst && burst.hits.indexOf('flyer') < 0,
        burst ? 'задело ' + burst.hits.join(',') : 'взрыва не было');
    check('при этом стоящего рядом задевает',
        burst && burst.hits.indexOf('other') >= 0,
        burst ? 'задело ' + burst.hits.join(',') : 'взрыва не было');
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
    // ещё полная, и если её не погасить, герой въедёт в камень на
    // полном ходу и будет скользить всё время, пока стоит камнем.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });

    // Разгоняемся, потом окаменяем на ходу.
    pastGrace(arena);
    for (let i = 0; i < 30; i++) step(arena, { a: { x: 1 } });
    const speed = arena.players[0].vx;
    step(arena, { a: { x: 1, stone: true } });
    const x0 = arena.players[0].x;

    // Прогон заведомо короче камня: всё это время игрок обязан стоять
    // ровно там, где окаменел.
    const shorter = windupTicks(T.STONE_TIME * 0.6);
    for (let i = 0; i < shorter; i++) step(arena, { a: { x: 1 } });
    check('окаменение на ходу останавливает сразу',
        Math.abs(arena.players[0].x - x0) < 1e-6,
        'скорость перед камнем ' + speed.toFixed(0) + ', сдвинулся на '
        + (arena.players[0].x - x0).toFixed(3));

    // И по истечении камня игрок снова свободен.
    const longer = windupTicks(T.STONE_TIME * 0.8);
    for (let i = 0; i < longer; i++) step(arena, { a: { x: 1 } });
    check('после камня снова можно двигаться',
        arena.players[0].x > x0 + 5,
        'сдвиг ' + (arena.players[0].x - x0).toFixed(0));
}

{
    // Камень кончился — игрок снова ходит.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    pastGrace(arena);

    step(arena, { a: { x: 1, stone: true } });
    for (let i = 0; i < windupTicks(T.STONE_TIME + 0.5); i++) step(arena, { a: { x: 1 } });

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
    for (let i = 0; i < windupTicks(T.STONE_TIME + 0.2); i++) step(arena, {});

    check('камень держится STONE_TIME', arena.players[0].stone === 0,
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
    // не заметил бы, что секунду стоял и ударил в пустоту.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 70, y: 0 });
    arena.players[0].dirx = 1;
    arena.players[0].diry = 0;

    const events = charged(arena, 'a');
    const swing = events.find(e => e.type === 'swing');
    const hit = events.find(e => e.type === 'push');

    check('замах отдаёт событие', !!swing, 'события нет');
    check('удар отдаёт событие', !!hit);
    check('событие помнит направление',
        !!hit && hit.dirx === 1 && hit.diry === 0,
        hit ? hit.dirx + ',' + hit.diry : 'нет события');
    check('событие помнит отлёт',
        !!hit && hit.dist === T.PUSH_DIST,
        hit ? 'отлёт ' + hit.dist : 'нет события');
    check('в событии перечислены задетые',
        !!hit && hit.hits.length === 1 && hit.hits[0] === 'b',
        hit ? hit.hits.join(',') : 'нет события');
}

{
    // Отскок от камня — это **попадание**, а не промах.
    //
    // Раньше strike возвращал пустой список при ударе в камень, и клиент
    // показывал пустоту вместо «врезался в камень»: игрок не понимал,
    // что произошло, хотя его только что откинуло. Событие обязано
    // называть отскок отдельно.
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'rock', { x: 70, y: 0 });
    arena.players[0].dirx = 1;
    pastGrace(arena);

    step(arena, { rock: { stone: true } });
    const hit = charged(arena, 'a').find(e => e.type === 'push');

    check('отскок назван в событии', !!hit && hit.bounce === 'rock',
        hit ? 'отскок ' + hit.bounce : 'нет события');
    check('при отскоке попаданий нет',
        !!hit && hit.hits.length === 0,
        hit ? 'попадания ' + hit.hits.join(',') : 'нет события');
}

{
    const arena = createArena({ size: 3000 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 300, y: 0 });
    arena.players[0].dirx = 1;

    const whiff = charged(arena, 'a').find(e => e.type === 'push');

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

    charged(arena, 'a');
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


// --- Прогрессия: звезда, ступени и потолок ---------------------------------

// Здесь арена настоящая: звезда включена, а ступень выставляется руками.
// В проверках механики звезда выключена, иначе игроки у центра подбирали
// бы её и ломали базовые величины.

{
    // Звезда лежит с самого начала партии, чтобы её можно было взять
    // в счётчик до первого удара.
    const arena = createRaw({ size: 3000 });
    addRaw(arena, 'a', { x: 0, y: 0 });
    addRaw(arena, 'b', { x: 300, y: 0 });

    check('звезда лежит с начала партии', arena.star.up === true,
        'up = ' + arena.star.up);

    step(arena, {});
    check('звезда даёт ступень подбором', arena.players[0].grade === 1,
        'ступень ' + arena.players[0].grade);
    check('после подбора звезды её нет', arena.star.up === false,
        'up = ' + arena.star.up);

    // Возврат считается от подбора, а не от появления.
    const half = windupTicks(T.STAR_RESPAWN / 2);
    for (let i = 0; i < half; i++) step(arena, {});
    check('звезда не вернулась сразу', arena.star.up === false,
        'через ' + (T.STAR_RESPAWN / 2) + ' с up = ' + arena.star.up);

    // Возврат проверяется по событию, а не по флагу: игрок стоит ровно
    // там, где звезда появится, и подбирает её в тот же тик — это
    // правильное поведение, но флаг `up` успевает погаснуть.
    let sawUp = false;
    for (let i = 0; i < half + 2; i++) {
        for (const e of step(arena, {})) {
            if (e.type === 'starUp') sawUp = true;
        }
    }
    check('звезда вернулась через ' + T.STAR_RESPAWN + ' с', sawUp,
        'событие появления: ' + (sawUp ? 'было' : 'не было'));
}

{
    // Потолок: седьмую ступень не дают, и звезда остаётся на поле.
    const arena = createRaw({ size: 3000 });
    addRaw(arena, 'a', { x: 0, y: 0 });
    arena.players[0].grade = T.FRAG_MAX;

    step(arena, {});
    check('потолок не превышается', arena.players[0].grade === T.FRAG_MAX,
        'ступень ' + arena.players[0].grade);
    check('на потолке звезда остаётся на поле', arena.star.up === true,
        'up = ' + arena.star.up);
}

{
    // Второй и третий скиллы закрыты, пока ступень не взята.
    const arena = createRaw({ size: 3000 });
    addRaw(arena, 'a', { x: -500, y: 0 });
    arena.star.up = false;
    arena.star.again = Infinity;
    arena.players[0].dirx = 1;
    for (let i = 0; i < windupTicks(T.SPAWN_GRACE + 1); i++) step(arena, {});

    step(arena, { a: { x: 1, jump: true, stone: true, push: true } });
    check('без ступени прыжок не работает', arena.players[0].jumpLeft === 0,
        'прыжок ' + arena.players[0].jumpLeft);
    check('без ступени камень не работает', arena.players[0].stone === 0,
        'камень ' + arena.players[0].stone);
    check('толчок работает без ступени', arena.players[0].cooldowns.push > 0,
        'откат ' + arena.players[0].cooldowns.push);
}

{
    // Первая ступень открывает прыжок, но не камень.
    const arena = createRaw({ size: 3000 });
    addRaw(arena, 'a', { x: -500, y: 0 });
    arena.star.up = false;
    arena.star.again = Infinity;
    arena.players[0].dirx = 1;
    arena.players[0].grade = T.GRADE_JUMP;
    for (let i = 0; i < windupTicks(T.SPAWN_GRACE + 1); i++) step(arena, {});

    step(arena, { a: { x: 1, jump: true, stone: true } });
    check('первая ступень открывает прыжок', arena.players[0].jumpLeft > 0,
        'прыжок ' + arena.players[0].jumpLeft);
    check('первая ступень не открывает камень', arena.players[0].stone === 0,
        'камень ' + arena.players[0].stone);
}

{
    // Вторая ступень открывает камень.
    const arena = createRaw({ size: 3000 });
    addRaw(arena, 'a', { x: -500, y: 0 });
    arena.star.up = false;
    arena.star.again = Infinity;
    arena.players[0].dirx = 1;
    arena.players[0].grade = T.GRADE_STONE;
    for (let i = 0; i < windupTicks(T.SPAWN_GRACE + 1); i++) step(arena, {});

    step(arena, { a: { x: 1, stone: true } });
    check('вторая ступень открывает камень', arena.players[0].stone > 0,
        'камень ' + arena.players[0].stone);
}

/**
 * Отмерить отлёт толчка при заданной ступени.
 *
 * Две арены строятся одинаково, различается только ступень бьющего —
 * так сравнение идёт по одному и тому же коду, а не по двум веткам.
 */
function pushFly(grade) {
    const arena = createRaw({ size: 3000 });
    addRaw(arena, 'a', { x: 0, y: 0 });
    addRaw(arena, 'b', { x: 70, y: 0 });
    arena.star.up = false;
    arena.star.again = Infinity;
    arena.players[0].dirx = 1;
    arena.players[0].grade = grade;
    for (let i = 0; i < windupTicks(T.SPAWN_GRACE + 1); i++) step(arena, {});

    const from = [arena.players[1].x, arena.players[1].y];
    for (let i = 0; i < Math.ceil(T.PUSH_WINDUP / T.TICK) + 1; i++) {
        step(arena, { a: { push: true } });
    }
    for (let i = 0; i < windupTicks(4); i++) step(arena, {});
    return Math.hypot(arena.players[1].x - from[0], arena.players[1].y - from[1]);
}

{
    const plain = pushFly(T.GRADE_JUMP);
    const powered = pushFly(T.GRADE_PUSH_POWER);

    check('без третьей ступени толчок около 300',
        Math.abs(plain - T.PUSH_DIST) < 25,
        'отлетел ' + plain.toFixed(0));
    check('третья ступень усиливает толчок',
        powered > plain * 1.3 && powered < plain * 1.7,
        plain.toFixed(0) + ' -> ' + powered.toFixed(0));
}

{
    // Четвёртая ступень: откат прыжка вдвое короче.
    const arena = createRaw({ size: 3000 });
    addRaw(arena, 'a', { x: -500, y: 0 });
    arena.star.up = false;
    arena.star.again = Infinity;
    arena.players[0].dirx = 1;
    arena.players[0].grade = T.GRADE_JUMP_COOLDOWN;
    for (let i = 0; i < windupTicks(T.SPAWN_GRACE + 1); i++) step(arena, {});

    step(arena, { a: { x: 1, jump: true } });
    const cd = arena.players[0].cooldowns.jump;
    check('четвёртая ступень режет откат прыжка вдвое',
        Math.abs(cd - T.JUMP_COOLDOWN / T.STAR_COOLDOWN_HALF) < 0.05,
        'откат ' + cd.toFixed(2) + ', ожидалось '
        + (T.JUMP_COOLDOWN / T.STAR_COOLDOWN_HALF).toFixed(2));
}

{
    // Пятая ступень: камень отбрасывает в полтора раза дальше.
    const arena = createRaw({ size: 3000 });
    addRaw(arena, 'a', { x: 0, y: 0 });
    addRaw(arena, 'b', { x: 100, y: 0 });
    arena.star.up = false;
    arena.star.again = Infinity;
    arena.players[0].grade = T.GRADE_STONE_POWER;
    const from = arena.players[1].x;
    step(arena, { a: { stone: true } });
    for (let i = 0; i < windupTicks(T.STONE_TIME + 0.3); i++) step(arena, {});
    for (let i = 0; i < windupTicks(T.STONE_BURST * 2 + 1); i++) step(arena, {});
    const moved = arena.players[1].x - from;
    check('пятая ступень усиливает камень',
        moved > T.STONE_BURST * 1.3 && moved < T.STONE_BURST * 1.7,
        'сдвинули на ' + moved.toFixed(0) + ', база ' + T.STONE_BURST);
}

{
    // Шестая ступень: замах вдвое короче. Не «без замаха»: замах здесь не
    // анимация, а всё обязательство удара, и обнулять его нельзя.
    const arena = createRaw({ size: 3000 });
    addRaw(arena, 'a', { x: -500, y: 0 });
    arena.star.up = false;
    arena.star.again = Infinity;
    arena.players[0].dirx = 1;
    arena.players[0].grade = T.GRADE_PUSH_WINDUP;
    for (let i = 0; i < windupTicks(T.SPAWN_GRACE + 1); i++) step(arena, {});

    step(arena, { a: { push: true } });
    const swing = arena.players[0].swing;
    check('шестая ступень режет замах вдвое',
        Math.abs(swing - T.PUSH_WINDUP / T.STAR_WINDUP_HALF) < 0.02,
        'замах ' + swing.toFixed(3) + ', ожидалось '
        + (T.PUSH_WINDUP / T.STAR_WINDUP_HALF).toFixed(3));
    check('замах не обнуляется совсем', swing > 0.1,
        'замах ' + swing.toFixed(3));
}

{
    // Вылет даёт ступень тому, кто выбил.
    const arena = createRaw({ size: 200 });
    addRaw(arena, 'a', { x: 0, y: 0 });
    addRaw(arena, 'b', { x: 60, y: 0 });
    arena.star.up = false;
    arena.star.again = Infinity;
    arena.players[0].dirx = 1;
    arena.players[0].grade = T.GRADE_PUSH_POWER;
    for (let i = 0; i < windupTicks(T.SPAWN_GRACE + 1); i++) step(arena, {});

    for (let i = 0; i < Math.ceil(T.PUSH_WINDUP / T.TICK) + 1; i++) {
        step(arena, { a: { push: true } });
    }
    for (let i = 0; i < windupTicks(4); i++) step(arena, {});

    check('вылет дал ступень убийце',
        arena.players[1].alive === false
        && arena.players[0].grade === T.GRADE_PUSH_POWER + 1,
        'жив ' + arena.players[1].alive + ', ступень ' + arena.players[0].grade);
}

{
    // Снимок несёт ступень и состояние звезды: без них клиент не нарисует
    // ни звёздочек над игроком, ни саму звезду.
    const arena = createRaw({ size: 3000 });
    addRaw(arena, 'a', { x: 0, y: 0 });
    const snap = snapshot(arena);
    check('в снимке есть ступень', snap.players[0].grade === 0,
        'grade = ' + snap.players[0].grade);
    check('в снимке есть звезда',
        snap.star && snap.star.up === true && snap.star.x === 0,
        JSON.stringify(snap.star));
}


// --- На счётчике не двигается никто ---------------------------------------

{
    // Счётчик запрещает не только удар, но и ходьбу.
    //
    // Проверка важна ещё и потому, что звезда лежит в центре, а игроки
    // стоят по краям: запрет на семь секунд делает звезду недоступной до
    // конца отсчёта. Замер на 60 партиях показал, что это не ломает
    // прогрессию — звёзд за партию столько же, ступени те же, — но
    // сам запрет должен быть зафиксирован проверкой, а не памятью.
    // Арена настоящая: звезда включена. В проверках механики она
    // выключена, и проверка «звезда не взята» увидела бы не взятую, а
    // изначально погашенную — и прошла бы вранью.
const arena = createRaw({ size: 3000 });
    addPlayer(arena, 'a', { x: -800, y: 0 });

    const x0 = arena.players[0].x;
    const mid = { x: x0 };

    // Идём строго внутри счётчика, а не «до конца». Шаг, который
    // пересекает отметку 7 секунд, уже разрешает движение — и это
    // правильно: ход возвращается в ту же секунду, когда кончается
    // запрет. Если считать «пока elapsed меньше семи», такой шаг
    // попадает внутрь цикла и проверка видит сдвиг 0.278 — то есть
    // ровно один шаг разгона.
    let guard = Math.ceil(T.SPAWN_GRACE / T.TICK) + 5;
    while (arena.elapsed + T.TICK < T.SPAWN_GRACE && guard-- > 0) {
        step(arena, { a: { x: 1 } });
    }
    mid.x = arena.players[0].x;

    check('на счётчике игрок не двигается', Math.abs(mid.x - x0) < 1e-6,
        'сдвинулся на ' + (mid.x - x0).toFixed(3));
    check('на счётчике скорость не растёт', arena.players[0].vx === 0,
        'скорость ' + arena.players[0].vx.toFixed(2));
    check('звезда на счётчике не взята', arena.star.up === true,
        'up = ' + arena.star.up);

    // И сразу после счётчика ход возвращается.
    for (let i = 0; i < 30; i++) step(arena, { a: { x: 1 } });
    check('после счётчика движение возвращается',
        arena.players[0].x > mid.x + 5,
        'сдвиг ' + (arena.players[0].x - mid.x).toFixed(0));
}


// --- Итог -----------------------------------------------------------------

console.log(`ядро арены: ${passed} проверок пройдено, ${failed} провалено`);
if (failed > 0) {
    for (const f of failures) console.log(`  ПРОВАЛ: ${f}`);
    process.exit(1);
}
