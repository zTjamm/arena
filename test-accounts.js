/**
 * Проверка аккаунтов: регистрация, вход, рейтинг, друзья.
 *
 * Запуск: node test-accounts.js
 *
 * Здесь проверяются правила из обсуждения, а не реализация:
 *
 *   1. Ник регистронезависим: «Игрок» и «игрок» — один ник, второй
 *      не может зарегистрироваться.
 *   2. Регистрация принимает ник, пароль и повтор пароля и отвергает
 *      всё, что им не соответствует.
 *   3. Вход под чужим паролем не проходит, а текст ошибки не выдаёт,
 *      существует ли ник.
 *   4. Всё переживает перезапуск: файл — единственная правда.
 *   5. Очки за место ровно по таблице: 5 / 3 / 1 / 0 / 0 / 0 / -2 / -2.
 *   6. Друзья симметричны, а взаимная заявка дружит без второго шага.
 *
 * Каждый прогон пишет свой временный файл, чтобы тесты не мешали
 * настоящим аккаунтам и друг другу.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Accounts, nickKey, pointsForPlace } = require('./accounts');

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

let seq = 0;
function tempFile() {
    seq++;
    return path.join(os.tmpdir(), `arena-test-users-${process.pid}-${seq}.json`);
}

function open(file) {
    // Свежий экземпляр = свежее чтение с диска: только так видно,
    // что данные действительно лежат в файле, а не в памяти.
    return new Accounts(file);
}

// --- ключ ника и таблица очков ------------------------------------------

check('«Игрок» и «игрок» дают один ключ', nickKey('Игрок') === nickKey('игрок'));
check('пробелы по краям не мешают', nickKey('  Игрок  ') === nickKey('игрок'));
check('разные ники дают разные ключи', nickKey('игрок') !== nickKey('игрок2'));

check('очки за места ровно по таблице',
    [pointsForPlace(1), pointsForPlace(2), pointsForPlace(3),
        pointsForPlace(4), pointsForPlace(5), pointsForPlace(6),
        pointsForPlace(7), pointsForPlace(8)].join(',') === '5,3,1,0,0,0,-2,-2',
    [pointsForPlace(1), pointsForPlace(2), pointsForPlace(3),
        pointsForPlace(4), pointsForPlace(5), pointsForPlace(6),
        pointsForPlace(7), pointsForPlace(8)].join(','));
check('девятое место не даёт очков', pointsForPlace(9) === 0);
check('отсутствие места не даёт очков', pointsForPlace(null) === 0);
check('отрицательное место не даёт очков', pointsForPlace(-1) === 0);

// --- регистрация ---------------------------------------------------------

{
    const file = tempFile();
    const a = open(file);
    check('пустой файл — вход невозможен', a.login('Игрок', '1234').ok === false);

    const r = a.register('Игрок', '1234', '1234');
    check('регистрация проходит', r.ok === true, r.error);
    check('в записи виден ник с исходным регистром', r.user.nick === 'Игрок');
    check('новичок начинает с нуля', r.user.rating === 0 && r.user.games === 0);

    const dup = a.register('игрок', '9999', '9999');
    check('дубликат без учёта регистра отвергается', dup.ok === false, dup.error);
    check('и текст про занятый ник', dup.error === 'Такой ник уже занят', dup.error);

    const dup2 = a.register('ИГРОК', '9999', '9999');
    check('дубликат в другом регистре тоже отвергается', dup2.ok === false);

    check('короткий ник отвергается', a.register('И', '1234', '1234').ok === false);
    check('пустой ник отвергается', a.register('   ', '1234', '1234').ok === false);
    check('слишком длинный ник отвергается', a.register('И'.repeat(17), '1234', '1234').ok === false);
    check('ник без контрольных символов',
        a.register('Иг\nрок', '1234', '1234').ok === false);
    check('короткий пароль отвергается', a.register('Новый', '12', '12').ok === false);
    check('неповторённый пароль отвергается',
        a.register('Новый', '1234', '1235').error === 'Пароли не совпадают');

    const ok = a.register('Новый', '1234', '1234');
    check('второй ник свободен', ok.ok === true, ok.error);
    check('в записи нет ни пароля, ни соли',
        !('pass' in ok.user) && !('salt' in ok.user) && !('hash' in ok.user),
        Object.keys(ok.user).join(','));
}

// --- вход ----------------------------------------------------------------

{
    const file = tempFile();
    const a = open(file);
    a.register('Игрок', '1234', '1234');

    check('верный пароль проходит', a.login('Игрок', '1234').ok === true);
    check('регистр в логине не важен', a.login('игрок', '1234').ok === true);
    check('пробелы не важны', a.login('  ИГРОК ', '1234').ok === true);

    const bad = a.login('Игрок', '0000');
    check('чужой пароль не проходит', bad.ok === false);

    const nope = a.login('Незнакомец', '1234');
    check('несуществующий ник не проходит', nope.ok === false);
    check('текст ошибки одинаков для чужого пароля и чужого ника',
        bad.error === nope.error, `${bad.error} / ${nope.error}`);
}

// --- перезапуск ----------------------------------------------------------

{
    const file = tempFile();
    open(file).register('Игрок', '1234', '1234');

    const again = open(file);
    check('аккаунт пережил перезапуск', again.byNick('игрок') !== null);
    check('и вход после перезапуска работает', again.login('Игрок', '1234').ok === true);
    check('дубликат после перезапуска всё ещё занят',
        again.register('ИГРОК', '4321', '4321').ok === false);

    fs.unlinkSync(file);
}

// --- сессия --------------------------------------------------------------

{
    const file = tempFile();
    const a = open(file);
    a.register('Игрок', '1234', '1234');

    const token = a.issueToken('Игрок');
    check('токен выдаётся', typeof token === 'string' && token.length > 20);
    check('токен находит пользователя', (a.byToken(token) || {}).nick === 'Игрок');
    check('чужой токен не находит никого', a.byToken('deadbeef') === null);

    const again = open(file);
    check('токен пережил перезапуск', (again.byToken(token) || {}).nick === 'Игрок');
    check('в файле лежит хеш, а не сам токен',
        !fs.readFileSync(file, 'utf8').includes(token));

    again.dropToken('Игрок');
    check('после выхода токен мёртв', again.byToken(token) === null);
    check('и перезапуск его не вернёт', open(file).byToken(token) === null);

    fs.unlinkSync(file);
}

// --- рейтинг -------------------------------------------------------------

{
    const file = tempFile();
    const a = open(file);
    a.register('Первый', '1234', '1234');
    a.register('Второй', '1234', '1234');
    a.register('Третий', '1234', '1234');

    check('боту не начисляется ничего', a.award('bot1', 1) === 0);

    check('первая победа даёт пять', a.award('Первый', 1) === 5);
    check('вторая победа даёт ещё пять', a.award('Первый', 1) === 5);
    check('восьмое место даёт минус два', a.award('Второй', 8) === -2);
    check('пятое место даёт ноль', a.award('Третий', 5) === 0);

    const table = a.rating();
    check('рейтинг отсортирован по убыванию',
        table[0].nick === 'Первый' && table[0].rating === 10, JSON.stringify(table));
    check('порядок мест сошёлся',
        table[1].nick === 'Третий' && table[2].nick === 'Второй',
        table.map(t => `${t.nick}:${t.rating}`).join(','));
    check('сыграно по одной партии', table[1].games === 1);
    check('победы посчитаны', table[0].wins === 2);

    const again = open(file);
    check('рейтинг пережил перезапуск', again.byNick('первый').rating === 10);

    fs.unlinkSync(file);
}

// --- друзья --------------------------------------------------------------

{
    const file = tempFile();
    const a = open(file);
    a.register('Вася', '1234', '1234');
    a.register('Петя', '1234', '1234');
    a.register('Маша', '1234', '1234');

    const nope = a.friendRequest('Вася', 'Незнакомец');
    check('заявка несуществующему отвергается', nope.ok === false, nope.error);
    check('себе отправить нельзя',
        a.friendRequest('Вася', 'вася').error === 'Нельзя добавить себя');

    const ask = a.friendRequest('Вася', 'Петя');
    check('заявка уходит', ask.ok === true, ask.error);
    check('и попадает в заявки получателя',
        a.friendsState('Петя').requestsIn.some(r => r.nick === 'Вася'));
    check('и в исходящие отправителя',
        a.friendsState('Вася').requestsOut.some(r => r.nick === 'Петя'));
    check('до принятия друзьями не стали',
        a.friendsState('Петя').friends.length === 0);

    const again = a.friendRequest('ВАСЯ', 'Петя');
    check('повторная заявка не дублируется', again.ok === false, again.error);

    const acc = a.friendAccept('Вася', 'Петя');
    check('заявку принимают', acc.ok === true, acc.error);
    const fPetya = a.friendsState('Петя').friends.map(f => f.nick);
    const fVasya = a.friendsState('Вася').friends.map(f => f.nick);
    check('дружба симметрична', fPetya.includes('Вася') && fVasya.includes('Петя'),
        `${fVasya} / ${fPetya}`);
    check('исходящая заявка закрыта',
        a.friendsState('Вася').requestsOut.length === 0);

    const dup = a.friendRequest('Петя', 'Вася');
    check('повторная дружба невозможна', dup.ok === false, dup.error);

    // Взаимная заявка дружит сразу, без второго подтверждения.
    a.friendRequest('Маша', 'Вася');
    const mutual = a.friendRequest('Вася', 'Маша');
    check('взаимная заявка дружит сразу', mutual.ok === true, mutual.error);
    check('и у Маши в друзьях Вася',
        a.friendsState('Маша').friends.some(f => f.nick === 'Вася'));
    check('и у Васи в друзьях Маша',
        a.friendsState('Вася').friends.some(f => f.nick === 'Маша'));

    const rej = a.friendReject('Петя', 'Вася');
    check('ненужную заявку отклоняют', rej.ok === false, rej.error);

    const rem = a.friendRemove('Петя', 'Вася');
    check('друга можно удалить', rem.ok === true, rem.error);
    check('дружба распалась с двух сторон',
        !a.friendsState('Вася').friends.some(f => f.nick === 'Петя') &&
        !a.friendsState('Петя').friends.some(f => f.nick === 'Вася'));

    const restart = open(file);
    check('друзья пережили перезапуск',
        restart.friendsState('Вася').friends.some(f => f.nick === 'Маша'));

    fs.unlinkSync(file);
}

// --- статус --------------------------------------------------------------

{
    const file = tempFile();
    const a = open(file);
    a.register('Вася', '1234', '1234');
    a.register('Петя', '1234', '1234');
    a.friendRequest('Вася', 'Петя');
    a.friendAccept('Вася', 'Петя');

    const state = a.friendsState('Вася', n => (n === 'Петя' ? 'game' : 'offline'));
    check('статус приходит от наружу',
        state.friends[0].status === 'game', JSON.stringify(state));
    check('пустой ник не роняет список', a.friendsState('').friends.length === 0);

    fs.unlinkSync(file);
}

console.log(`аккаунты: ${passed} проверок пройдено, ${failed} провалено`);
if (failed > 0) {
    for (const f of failures) console.log(`  ПРОВАЛ: ${f}`);
    process.exit(1);
}
