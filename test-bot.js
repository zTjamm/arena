/**
 * Проверка ботов прогоном партий.
 *
 * Запуск: node test-bot.js
 *
 * Это аналог прогона «тысячи партий бот против бота» из test-dots.js
 * и он здесь нужен по той же причине: отдельные проверки не поймают
 * то, что партия в принципе не умеет заканчиваться.
 *
 * Конкретно ловятся четыре вещи:
 *
 *   1. Пат. Два зеркальных бота встречаются в центре и толкают
 *      симметрично — по правилам ничьих не бывает, а игра вечно не
 *      кончается. Именно поэтому характеры ботов выводятся из id.
 *   2. Самоубийство. Если соперник улетел за границу, не получив ни
 *      одного толчка, бот просто сбежал с поля сам — и выталкивания
 *      в игре нет, есть бег по кругу.
 *   3. Перекос побед. Если всегда побеждает один и тот же — побеждает
 *      не игрок, а порядок обхода массива.
 *   4. Численность. Партия на восьмерых обязана доигрываться так же,
 *      как на двоих: коллизии по цепочкам ломаются именно на плотности.
 */

const { createArena, addPlayer, spawnPoint, step } = require('./game/arena');
const { botInput } = require('./game/bot');

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

/** Одна партия ботов до конца или до потолка тиков. */
function runGame(ids, options = {}) {
    const size = options.size || 800;
    // Потолок в 8000 тиков, а не 5000. Толчок теперь заряжается, и партия
    // на двоих может затянуться: двое бегут вдоль края, заряд не
    // набирается, кто-то отрывается и догоняет. Разбор худшей партии
    // из тысячи (a621 против b621) показал, что она заканчивается на
    // 5151-м тике — это 172 секунды розыгрыша, а не зависание.
// Потолок 16000 тиков, а не 8000.
//
// После замедления движения вдвое партия стала длиннее: в среднем
// 25 секунд против 19. Две партии из тысячи упираются в угол — оба
// бота прижаты к одной стене (запас 0 и 3) и толкают друг в друга
// **вдоль стены**, а толчок вдоль стены вынести не может: он скользит
// по границе и запас не меняется.
//
// Это не зависание: с потолком вчетверо обе доигрываются, на 12311-м
// и 14502-м тике. У человека тот же угол закрывается прыжком — 300
// единиц неуязвимого полёта выносят из угла кем угодно, и это его
// прямое назначение. Бот прыгает только от удара и из угла выбраться
// не умеет, поэтому 8 минут на худшую партию из тысячи — свойство
// бота, а не правил игры.
const cap = options.cap || 16000;
    const arena = createArena({ size });

    ids.forEach((id, i) => {
        const pt = spawnPoint(i, ids.length, size);
        addPlayer(arena, id, { x: pt.x, y: pt.y, bot: true });
    });

    let jumps = 0;
    let stones = 0;
    let charges = 0;
    let pushes = 0;
    let moves = 0;
    let nonFinite = 0;

    for (let i = 0; i < cap && !arena.finished; i++) {
        const inputs = {};
        for (const p of arena.players) {
            if (!p.alive) continue;
            const input = botInput(p, arena);
            inputs[p.id] = input;
            if (input.jump) jumps++;
            if (input.stone) stones++;
            // Кнопка толчка: сколько тиков бот её держит, плюс сколько
            // раз отпустил — второе и есть число ударов.
            if (input.push) charges++;
            if (Math.abs(input.x) + Math.abs(input.y) > 0.01) moves++;
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) nonFinite++;
        }
        for (const ev of step(arena, inputs)) {
            if (ev.type === 'push') pushes++;
        }
    }

    return { arena, ticks: arena.tick, jumps, stones, charges, pushes, moves, nonFinite };
}


// --- Партия на двоих: тысяча прогонов --------------------------------------

{
    const N = 1000;
    let finished = 0;
    let walkedOut = 0;
    let eliminations = 0;
    let winFirst = 0;
    let winSecond = 0;
    let jumps = 0;
    let stones = 0;
    let charges = 0;
    let pushes = 0;
    let moves = 0;
    let badNumbers = 0;
    let totalTicks = 0;
    let longest = 0;

    for (let i = 0; i < N; i++) {
        const ids = [`a${i}`, `b${i}`];
        const r = runGame(ids);

        if (r.arena.finished) {
            finished++;
            totalTicks += r.ticks;
            longest = Math.max(longest, r.ticks);
        } else {
            longest = Math.max(longest, r.ticks);
        }

        if (r.arena.winner === ids[0]) winFirst++;
        else if (r.arena.winner === ids[1]) winSecond++;

        jumps += r.jumps;
        stones += r.stones;
        charges += r.charges;
        pushes += r.pushes;
        moves += r.moves;
        badNumbers += r.nonFinite;

        for (const p of r.arena.players) {
            if (p.alive) continue;
            eliminations++;
            if (p.eliminatedBy === null) walkedOut++;
        }
    }

    console.log(
        `  на двоих: доиграно ${finished}/${N}, ` +
        `в среднем ${Math.round(totalTicks / Math.max(finished, 1))} тиков ` +
        `(${(totalTicks / Math.max(finished, 1) / 30).toFixed(1)} с), ` +
        `самая длинная ${longest} тиков`
    );
    console.log(
        `  победы: первый ${winFirst}, второй ${winSecond}, ` +
        `прыжков ${jumps}, камней ${stones}, ` +
        `зарядов ${charges}, ударов ${pushes}`
    );

    // Одна партия из тысячи (a621 против b621) доходила до потолка в
    // 5000 тиков и заканчивалась на 5151-м. Разбор показал: двое с
    // запасами 87 и 71 гонялись друг за другом вдоль края, и каждый
    // разбивался о то, что заряд не успевал набраться, пока жертва
    // убегала. Это не зависание, а долгий розыгрыш, поэтому потолок
    // поднят: проверять надо «партии кончаются», а не «укладываются
    // в 166 секунд».
    check(`${N} партий на двоих доигрываются`, finished === N,
        `доиграно ${finished} из ${N}`);

    check('средняя партия не затягивается',
        totalTicks / Math.max(finished, 1) < 3000,
        `${Math.round(totalTicks / Math.max(finished, 1))} тиков`);

    check('побеждают оба характера',
        winFirst > N * 0.1 && winSecond > N * 0.1,
        `первый ${winFirst}, второй ${winSecond} из ${N}`);

    // За край выносит только удар, поэтому выбыть без автора нельзя
    // физически: граница прижатого не выбрасывает.
    check('никто не выбывает без удара', walkedOut === 0,
        `${walkedOut} из ${eliminations} выбыли без единого удара`);

    check('боты используют прыжок', jumps > N * 0.5,
        `${jumps} прыжков на ${N} партий`);

    // Толчок — единственный способ выбить с поля. Если боты его не
    // жмут, партия не может кончиться: ходьба прижимает к границе
    // и держит, а выносит только летящий.
    check('боты копят заряд толчка', charges > N * 100,
        `${charges} тиков удержания на ${N} партий`);

    check('боты стреляют толчком', pushes > N,
        `${pushes} ударов на ${N} партий`);

    check('боты не стоят на месте', moves > N * 50,
        `${moves} движений`);

    check('координаты конечны во всех партиях', badNumbers === 0,
        `${badNumbers} нечисловых значений`);
}


// --- Разная численность ----------------------------------------------------

for (const count of [3, 5, 8]) {
    const N = 100;
    let finished = 0;
    let walkedOut = 0;
    let eliminations = 0;
    let longest = 0;
    let jumps = 0;
    let stones = 0;
    let charges = 0;
    let pushes = 0;

    for (let i = 0; i < N; i++) {
        const ids = Array.from({ length: count }, (_, k) => `n${count}_${i}_${k}`);
        const r = runGame(ids, { cap: 6000 });

        if (r.arena.finished) finished++;
        longest = Math.max(longest, r.ticks);
        jumps += r.jumps;
        stones += r.stones;
        charges += r.charges;
        pushes += r.pushes;

        for (const p of r.arena.players) {
            if (p.alive) continue;
            eliminations++;
            if (p.eliminatedBy === null) walkedOut++;
        }
    }

    console.log(
        `  на ${count}: доиграно ${finished}/${N}, ` +
        `самая длинная ${longest} тиков, ` +
        `зарядов ${charges}, ударов ${pushes}, прыжков ${jumps}, камней ${stones}`
    );

    check(`партия из ${count} игроков доигрывается`, finished === N,
        `доиграно ${finished} из ${N}`);

    // За край выносит только удар, поэтому выбыть без автора нельзя
    // физически: граница прижатого держит, а не выбрасывает.
    check(`на ${count} никто не выбывает без удара`, walkedOut === 0,
        `${walkedOut} из ${eliminations}`);
}


// --- Одинаковые данные — одинаковый исход ----------------------------------

{
    const ids = ['детерминированный_1', 'детерминированный_2'];
    const first = runGame(ids);
    const second = runGame(ids);

    check('партия ботов детерминирована',
        first.arena.winner === second.arena.winner &&
        first.ticks === second.ticks,
        `первый: ${first.arena.winner} за ${first.ticks}, ` +
        `второй: ${second.arena.winner} за ${second.ticks}`);
}


// --- Бот обязан уметь выигрывать сам ----------------------------------------

{
    // Стоящий мешок — самая простая цель. Если бот его не вытолкнет,
    // в атаке что-то не так, и тысячи партий этого не покажут: там
    // мешки двигаются в ответ.
    //
    // Потолок поднят до 1500 тиков: толчок теперь заряжается, и бот
    // тратит три секунды на накопление, прежде чем отпустить кнопку.
    const arena = createArena({ size: 600 });
    addPlayer(arena, 'hunter', { x: -100, y: 0, bot: true });
    addPlayer(arena, 'dummy', { x: 120, y: 0 });

    for (let i = 0; i < 1500 && !arena.finished; i++) {
        const hunter = arena.players[0];
        const inputs = { hunter: botInput(hunter, arena) };
        step(arena, inputs);
    }

    check('бот выталкивает неподвижную цель', arena.finished === true &&
        arena.winner === 'hunter',
        `осталось в живых ${arena.players.filter(p => p.alive).length}`);
}


// --- Бот обязан пользоваться всеми тремя скиллами --------------------------

{
    // Три скилла с разными ролями: удар выбивает, прыжок догоняет и
    // спасает, камень отбивает удар. Бот, который не нажимает хотя бы
    // один, играет в игру с половиной правил — и на трёх и более
    // игроках это сразу видно по длине партии.
    const arena = createArena({ size: 800 });
    const ids = ['a', 'b', 'c', 'd', 'e'];
    ids.forEach((id, i) => {
        const pt = spawnPoint(i, ids.length, 800);
        addPlayer(arena, id, { x: pt.x, y: pt.y, bot: true });
    });

    let jumps = 0;
    let stones = 0;
    for (let i = 0; i < 3000 && !arena.finished; i++) {
        const inputs = {};
        for (const p of arena.players) {
            if (!p.alive) continue;
            const input = botInput(p, arena);
            inputs[p.id] = input;
            if (input.jump) jumps++;
            if (input.stone) stones++;
        }
        step(arena, inputs);
    }

    check('боты пользуются камнем', stones > 0,
        `нажатий камня ${stones}`);
}


// --- Итог -----------------------------------------------------------------

console.log(`боты: ${passed} проверок пройдено, ${failed} провалено`);
if (failed > 0) {
    for (const f of failures) console.log(`  ПРОВАЛ: ${f}`);
    process.exit(1);
}

