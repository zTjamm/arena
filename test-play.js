/**
 * Проверка механики: выталкивается ли соперник на самом деле.
 *
 * Запуск: node test-play.js
 *
 * test-arena.js доказывает, что правила выполняются. Он не доказывает,
 * что игра существует. Если отлёт недостаточен, соперник будет
 * отъезжать на пару пикселей, возвращаться и партия никогда не
 * кончится — а все проверки правил при этом останутся зелёными,
 * потому что правило «выбывает тот, кого вытолкнули за границу»
 * формально выполняется просто никогда.
 *
 * Здесь проверяется сам факт: догнать соперника, замахнуться, дождаться
 * удара и увидеть, что он вылетел, партия кончилась, а толкающий жив.
 *
 * Сценарий написан как ход человека: идти вперёд, прыжком закрывать
 * дистанцию, и **нажать толчок**, когда жертва в радиусе. Дальше
 * отпускать кнопку незачем — замах идёт по нажатию, удар уходит сам.
 *
 * Кнопка держится **всегда, пока бой не кончился**: замах от отпускания
 * не отменяется, но нажатие на откате пропадает зря.
 */

const { T, createArena, addPlayer, step } = require('./game/arena');

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

/**
 * A идёт на B с одной стороны, B стоит без движения.
 *
 * opts.radius — расстояние от центра до стороны, то есть половина
 * квадрата.
 *
 * Возвращает { arena, ticks, maxReach, swings }.
 */
function chaseDown(opts) {
    const size = opts.radius * 2;
    const arena = createArena({ size });
    addPlayer(arena, 'a', { x: opts.ax, y: 0 });
    addPlayer(arena, 'b', { x: opts.bx, y: 0 });

    let jumpUsed = false;
    let maxReach = Math.abs(opts.bx);
    let swings = 0;

    for (let i = 0; i < 900 && !arena.finished; i++) {
        const a = arena.players[0];
        const b = arena.players[1];
        const flying = b.fly > 0;
        const gap = Math.abs(b.x - a.x);

        // Прыжок один раз и только по сопернику.
        const wantsJump = !flying && !jumpUsed && gap < 40;
        if (wantsJump) jumpUsed = true;

        // Взгляд задаётся **на жертву напрямую**, а не выводится из
        // хода. Раньше сценарий смотрел в ту сторону, куда шёл, и это
        // работало только потому, что при досягаемости 100 приходилось
        // подойти вплотную и развернуться. Стало 200, и «подойти»
        // больше не требовалось: сценарий отходил, чтобы развернуться,
        // разворачивался спиной к цели и **не бил никогда** — замах не
        // брался ни разу за партию.
        //
        // Так и играет человек: держишь нос на цели, а ноги решают
        // отдельно. То же самое делает `input.face` у ботов.
        const face = gap > 1e-6 ? { x: (b.x - a.x) / gap, y: 0 } : { x: 1, y: 0 };

        // В зоне удара стоим и бьём, вне — сближаемся. Запас в 20
        // единиц от радиуса: жертва за секунду замаха успевает отойти,
        // и бить ровно с границы досягаемости — бить в пустоту.
        const inReach = gap <= T.PUSH_RANGE - 20;

        const press = a.cooldowns.push <= 0 && inReach && !flying;
        if (press) swings++;

        // Ход. Пока жертва летит — **отходим**: иначе занимаем ровно то
        // место, откуда её вытолкнули, и она упирается в нас вместо
        // границы, а граница держит. Это вечный тупик.
        let walk = 0;
        if (flying) walk = -1;
        else if (!inReach) walk = 1;

        step(arena, {
            a: { x: walk, jump: wantsJump, push: press, face },
            b: {},
        });
        maxReach = Math.max(maxReach, Math.abs(b.x));
    }

    return { arena, ticks: arena.tick, maxReach, swings };
}

const CASES = [
    ['близко у края',     { radius: 200, ax: -50,  bx: 150 }],
    ['средняя дистанция', { radius: 400, ax: -100, bx: 300 }],
    ['далеко от края',    { radius: 400, ax: -200, bx: 100 }],
    ['почти на краю',     { radius: 400, ax: 0,    bx: 380 }],
    ['тесное поле',       { radius: 120, ax: -60,  bx: 80  }],
];

for (const [label, opts] of CASES) {
    const { arena, ticks, maxReach, swings } = chaseDown(opts);
    const a = arena.players[0];
    const b = arena.players[1];

    check(`${label}: соперник вылетает`, b.alive === false,
        `остался с запасом ${(opts.radius - Math.abs(b.x)).toFixed(0)}`);
    check(`${label}: партия доиграна`, arena.finished === true,
        `тиков ${ticks}`);
    check(`${label}: победил тот, кто толкал`, arena.winner === 'a',
        `победил ${arena.winner}`);
    check(`${label}: толкающий остался жив`, a.alive === true,
        `вылетел сам, на ${Math.abs(a.x).toFixed(0)}`);

    // Успех именно в том, что соперника отогнали за линию, а не
    // просто тронули: проверяется пройденное расстояние.
    check(`${label}: соперника отогнали за линию`, maxReach > opts.radius,
        `достиг ${maxReach.toFixed(0)}, надо больше ${opts.radius}`);

    check(`${label}: толчок вообще срабатывал`, swings > 0,
        `замахов ${swings}`);

    // Партия обязана кончиться быстро. Порог в 500 тиков (16 с) —
    // это несколько ударов с разворотами: ровно столько занимает
    // выталкивание человека с самого края поля.
    check(`${label}: быстро`, ticks <= 500, `${ticks} тиков`);
}


// --- Толчок обязан быть сильнее ходьбы --------------------------------------

{
    // Толчок против ходьбы — на **живом** сопернике, который уходит к
    // центру.
    //
    // Соперник, который стоит столбом, сравнивать бессмысленно: его
    // расталкивает сама ходьба. Но стоящий соперник — не соперник, а
    // мешок. Живой уходит от давления, и тогда сравнение честное.
    //
    // Считается один и тот же отрезок времени на обоих: A догоняет и
    // бьёт, вторая сценария даёт просто ходьбу без удара.
    const size = 800;

    // Соперник убегает **вправо**: он стоит справа от толкающего, и
    // «наружу» от толкающего — тоже вправо. Если гнать его влево, он
    // сам подойдёт вплотную и проверка превратится в толчок мешка.
    const away = { x: 1, y: 0 };

    // Сценарию хватает двадцати секунд тиков — десятка ударов подряд.
    //
    // Раньше здесь стояло 90 — три секунды. Этого хватало, когда удар
    // стоил нажатие: за три секунды успевали четыре. Теперь между
    // ударами проходит цикл «секунда замаха + секунда жизни», и за три
    // секунды успевает **один**, чего живой соперник переживает легко.
    // Время увеличено не потому, что механика стала медленнее, а
    // потому, что окно должно вмещать несколько ударов подряд.
    const TICKS = 600;

    const walk = createArena({ size });
    addPlayer(walk, 'a', { x: -20, y: 0 });
    addPlayer(walk, 'b', { x: 10, y: 0 });
    pastGrace(walk);
    for (let i = 0; i < TICKS; i++) step(walk, { a: { x: 1 }, b: away });

    // A догоняет и бьёт: замах занимает секунду, и за неё живой
    // отходит ещё на 95. Поэтому нажимать надо **не дожидаясь** полного
    // сближения — как только жертва в радиусе, а потом стоять.
    const pushed = createArena({ size });
    addPlayer(pushed, 'a', { x: -20, y: 0 });
    addPlayer(pushed, 'b', { x: 10, y: 0 });
    pastGrace(pushed);
    for (let i = 0; i < TICKS; i++) {
        const A = pushed.players[0];
        const B = pushed.players[1];
        const gap = B.x - A.x;
        // Догоняем, пока близко, и жмём, когда в радиусе.
        const press = A.cooldowns.push <= 0 && gap <= T.PUSH_RANGE && B.fly === 0;
        step(pushed, {
            a: {
                x: press ? 0 : 1,
                face: { x: 1, y: 0 },
                push: press,
            },
            b: away,
        });
    }
    for (let i = 0; i < 40; i++) step(pushed, { b: away });

    // Оба сценария упирают соперника в границу и там его держат, поэтому
    // сравнивать пройденное расстояние бессмысленно — упереться можно
    // и ходьбой. Сравнивается то, ради чего всё и затевалось: **кого
    // вообще можно выбить с поля**.
    //
    // Ходьба прижимает к границе и держит. Выбивает только удар: у
    // летящего граница не держит, и он уходит за неё.
    check('ходьба соперника не выбивает с поля',
        walk.players[1].alive === true,
        `выбит ходьбой, запас ${(400 - Math.abs(walk.players[1].x)).toFixed(0)}`);
    check('толчок выбивает соперника с поля',
        pushed.players[1].alive === false,
        `жив, запас ${(400 - Math.abs(pushed.players[1].x)).toFixed(0)}`);

    // У самого края одного удара хватает: важна не сила, а сколько
    // осталось до границы.
    const edge = createArena({ size: 200 });
    addPlayer(edge, 'a', { x: 0, y: 0 });
    addPlayer(edge, 'b', { x: 70, y: 0 });
    pastGrace(edge);
    step(edge, { a: { x: 1, push: true } });
    for (let i = 0; i < 40; i++) step(edge, { a: { x: 1, push: true } });

    check('одного удара у самого края хватает',
        edge.players[1].alive === false,
        `жив с запасом ${(100 - Math.abs(edge.players[1].x)).toFixed(0)}`);
}


/**
 * Прожить первые секунды партии, когда бить ещё нельзя.
 *
 * Первые SPAWN_GRACE секунд удара нет, и любой сценарий, который
 * бьёт сразу после расстановки, просто не выстрелит. Проверять
 * отсчёт — дело другого теста, здесь он просто пропускается.
 *
 * Идемпotentно: если отсчёт уже прошёл, ничего не крутим.
 */
function pastGrace(arena) {
    if (arena.elapsed >= T.SPAWN_GRACE) return;
    const ticks = Math.ceil(T.SPAWN_GRACE / T.TICK);
    for (let i = 0; i < ticks; i++) step(arena, {});
}


// --- Прыжок спасает от вылета -----------------------------------------------

{
    // Прыжок неуязвим и не выносит за край, но приземлиться можно уже
    // на границе. Проверяем именно это: дошёл, а не вылетел.
    const arena = createArena({ size: 200 });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 0, y: 0 });

    step(arena, { b: { x: 1, jump: true } });
    for (let i = 0; i < 30 && arena.players[1].jumpLeft > 0; i++) step(arena, {});

    check('прыжок доводит до точки, не выбрасывая',
        arena.players[1].alive === true && arena.players[1].x > 90,
        `x ${arena.players[1].x.toFixed(0)}, жив ${arena.players[1].alive}`);
}


// --- Камень спасает от толчка -----------------------------------------------

{
    // Каменный от удара отскакивает сам, а не улетает. Это и есть
    // весь смысл защиты: без неё толчок против камня — тот же удар,
    // только в другую сторону.
    //
    // Камень держится 1.3 с, а замах толчка — ровно секунда, поэтому
    // нажимать надо сразу: иначе камень истечёт до удара.
    const size = 800;
    const arena = createArena({ size });
    addPlayer(arena, 'a', { x: 0, y: 0 });
    addPlayer(arena, 'b', { x: 70, y: 0 });
    arena.players[0].dirx = 1;
    pastGrace(arena);

    step(arena, { b: { stone: true }, a: { push: true } });
    for (let i = 0; i < 40; i++) step(arena, { a: { push: true } });

    const b = arena.players[1];
    check('каменный не улетел', b.fly === 0 && Math.abs(b.x - 70) < 30,
        `x ${b.x.toFixed(0)}`);
    check('бьющий отскочил назад',
        arena.players[0].fly > 0 && arena.players[0].flyx < 0,
        `полёт ${arena.players[0].fly.toFixed(0)} в ${arena.players[0].flyx}`);
}


// --- Камень выгоняет толпу ---------------------------------------------------

{
    // Взрыв по истечении камня — единственный способ выгнать сразу
    // нескольких. Толчок бьёт только ближайшего в конусе, то есть
    // против двоих одновременно не работает вовсе.
    const arena = createArena({ size: 900 });
    addPlayer(arena, 'rock', { x: 0, y: 0 });
    addPlayer(arena, 'l', { x: -120, y: 0 });
    addPlayer(arena, 'r', { x: 120, y: 0 });
    pastGrace(arena);

    const before = new Map(arena.players.map(p => [p.id, p.x]));
    step(arena, { rock: { stone: true } });
    for (let i = 0; i < 120; i++) step(arena, {});
    for (let i = 0; i < 60; i++) step(arena, {});

    const l = arena.players.find(p => p.id === 'l');
    const r = arena.players.find(p => p.id === 'r');

    check('взрыв камня разнёс левого',
        Math.abs(l.x - before.get('l')) > 100,
        `с ${before.get('l').toFixed(0)} на ${l.x.toFixed(0)}`);
    check('взрыв камня разнёс правого',
        Math.abs(r.x - before.get('r')) > 100,
        `с ${before.get('r').toFixed(0)} на ${r.x.toFixed(0)}`);
    check('взрыв разнёс их в разные стороны',
        Math.sign(l.x - before.get('l')) !== Math.sign(r.x - before.get('r')),
        `l ${(l.x - before.get('l')).toFixed(0)}, r ${(r.x - before.get('r')).toFixed(0)}`);
}


// --- Итог -----------------------------------------------------------------

console.log(`механика: ${passed} проверок пройдено, ${failed} провалено`);
if (failed > 0) {
    for (const f of failures) console.log(`  ПРОВАЛ: ${f}`);
    process.exit(1);
}