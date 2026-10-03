/**
 * Проверка подбора игроков.
 *
 * Запуск: node test-lobby.js
 *
 * Подбор — единственное место, где решается, кто во что собирается,
 * поэтому здесь проверяется не симуляция, а правило:
 *
 *   1. Комната открывается кнопкой «Играть» и ждёт graceMs. Один игрок
 *      не ждёт компанию вечно: через graceMs партия начинается,
 *      пустые места добирают боты — состав всегда ровно maxPlayers.
 *   2. Те, кто зашёл в одно окно сбора, попадают в одну партию —
 *      иначе живые никогда не встретятся.
 *   3. Полный состав не ждёт: восемь живых начинают сразу.
 *   4. Лишние сверх восьми не выпадают, а ждут следующей партии.
 *   5. После старта комната закрыта: следующая даёт полное окно,
 *      а не остаток от предыдущей — иначе зашедший позже всех
 *      стартовал бы мгновенно, никого не дождавшись.
 *   6. Ид ботов не может пересечься с ником человека: снимок двух
 *      разных игроков не должен жить под одним ключом.
 *
 * Часы везде передаются снаружи, поэтому тесты не ждут реального времени.
 */

const { Lobby, DEFAULTS } = require('./game/lobby');

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

/** Сколько ждать по умолчанию — это правило из обсуждения, не случайность. */
check('окно сбора по умолчанию 30 с', DEFAULTS.graceMs === 30000,
    `сейчас ${DEFAULTS.graceMs}`);
check('мест в партии по умолчанию 8', DEFAULTS.maxPlayers === 8,
    `сейчас ${DEFAULTS.maxPlayers}`);

{
    const l = new Lobby();
    l.join('solo', 0);

    check('до окна сбора партия не стартует', l.take(0) === null,
        `deadline=${l.startsIn(0)}`);
    check('через 29 с тоже не стартует', l.take(29999) === null);
    check('показывает обратный отсчёт', l.startsIn(0) === 30000,
        `startsIn=${l.startsIn(0)}`);

    const plan = l.take(30000);
    check('один игрок стартует через grace', plan !== null);
    if (plan) {
        check('состав добран до восьми', plan.size === 8, `size=${plan.size}`);
        check('один живой и семь ботов',
            plan.humans.length === 1 && plan.bots.length === 7,
            `humans=${plan.humans.length} bots=${plan.bots.length}`);
        check('все места заняты', plan.humans.length + plan.bots.length === plan.size);
        check('лобби опустело после старта', l.size === 0, `осталось ${l.size}`);
        check('после старта обратного отсчёта нет', l.startsIn(30000) === null);
    }
}

{
    const l = new Lobby();
    l.join('first', 0);
    l.join('second', 9000);

    const before = l.startsIn(0);
    const plan = l.take(30000);
    check('двое, зашедшие в одно окно, вместе', plan !== null &&
        plan.humans.includes('first') && plan.humans.includes('second'),
        plan ? plan.humans.join(',') : 'не стартовало');
    check('второй не отодвинул старт', before === 30000,
        `startsIn=${before}`);
    if (plan) {
        check('двоим хватает шести ботов', plan.bots.length === 6,
            `bots=${plan.bots.length}`);
    }
    check('после старта лобби пусто', l.take(30000) === null);
}

{
    const l = new Lobby();
    l.join('late', 0);
    const plan = l.take(30000);
    check('первый стартует', plan !== null);

    // Второй заходит уже во время идущей партии — у него своя комната.
    l.join('waiter', 40000);
    check('во время партии новый живой ждёт', l.take(40000) === null,
        `startsIn=${l.startsIn(40000)}`);
    check('и получает полное окно', l.startsIn(40000) === 30000,
        `startsIn=${l.startsIn(40000)}`);
    check('партия стартует по закрытии окна', l.take(70000) !== null);
    check('после старта лобби пусто', l.size === 0, `осталось ${l.size}`);
}

{
    const l = new Lobby();
    for (let i = 1; i <= 8; i++) l.join(`p${i}`, 0);

    check('набор полного состава не ждёт', l.startsIn(0) === 0,
        `startsIn=${l.startsIn(0)}`);
    const plan = l.take(0);
    check('восемь живых стартуют сразу', plan !== null,
        plan ? '—' : 'не стартовало');
    check('полный состав без ботов', plan !== null && plan.bots.length === 0,
        plan ? `bots=${plan.bots.length}` : 'не стартовало');
}

{
    const l = new Lobby();
    for (let i = 1; i <= 9; i++) l.join(`p${i}`, 0);

    const plan = l.take(0);
    check('девятый не влезает в партию', plan !== null && plan.humans.length === 8,
        plan ? `humans=${plan.humans.length}` : 'не стартовало');
    check('лишний остаётся ждать', l.size === 1 && l.waiting[0] === 'p9',
        l.waiting.join(','));
    check('лишнему открыто своё окно', l.startsIn(0) === 30000,
        `startsIn=${l.startsIn(0)}`);
    check('партия на восьмерых без ботов', plan !== null && plan.size === 8,
        plan ? `size=${plan.size}` : '—');
}

{
    const l = new Lobby();
    l.join('only', 0);
    l.leave('only');
    check('пустое лобби не считает время', l.startsIn(0) === null);
    check('пустое лобби не стартует', l.take(10 ** 9) === null);

    l.join('next', 1000);
    check('новый игрок получает полное окно', l.startsIn(1000) === 30000,
        `startsIn=${l.startsIn(1000)}`);
}

{
    const l = new Lobby();
    check('повторный вход не дублирует', l.join('a', 0) === true &&
        l.join('a', 1) === false && l.size === 1, `size=${l.size}`);
    check('выход чужого ничего не делает', l.leave('nobody') === false);
}

{
    // Человек с ником бота: ид обязаны разойтись.
    const l = new Lobby();
    l.join('bot1', 0);
    l.join('player', 1);
    const plan = l.take(30000);
    check('ник, совпавший с ид бота, не ломает подбор', plan !== null &&
        !plan.bots.includes('bot1') && !plan.bots.includes('player'),
        plan ? plan.bots.join(',') : 'не стартовало');
    if (plan) {
        check('все ид уникальны',
            new Set([...plan.humans, ...plan.bots]).size === plan.size,
            [...plan.humans, ...plan.bots].join(','));
    }
}

{
    // Пять живых — не повод начинать раньше: иначе живые из разных
    // наборов никогда не сыграют друг с другом.
    const l = new Lobby();
    for (let i = 1; i <= 5; i++) l.join(`p${i}`, 0);
    check('пять живых ждут остальных', l.take(0) === null &&
        l.startsIn(0) === 30000, `startsIn=${l.startsIn(0)}`);

    const plan = l.take(30000);
    check('пятёрка стартует через grace', plan !== null);
    check('и добирается до восьми', plan !== null && plan.size === 8 &&
        plan.bots.length === 3,
        plan ? `humans=${plan.humans.length} bots=${plan.bots.length}` : '—');
}

{
    const l = new Lobby();
    check('нечего начинать в пустом лобби', l.force(0) === false);

    l.join('ready', 0);
    check('кнопка начинает не дожидаясь окна', l.force(100) === true &&
        l.take(100) !== null, `startsIn=${l.startsIn(100)}`);
    check('после старта кнопка снова нечего', l.force(200) === false);
}

console.log(`подбор: ${passed} проверок пройдено, ${failed} провалено`);
if (failed > 0) {
    for (const f of failures) console.log(`  ПРОВАЛ: ${f}`);
    process.exit(1);
}
