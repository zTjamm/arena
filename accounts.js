'use strict';

/**
 * Аккаунты: регистрация, вход, рейтинг и друзья.
 *
 * Правила из обсуждения:
 *   - ник регистронезависим: «Игрок» и «игрок» — один ник, второй не зайти;
 *   - регистрация — ник, пароль и повтор пароля;
 *   - очки за место: 1-е +5, 2-е +3, 3-е +1, 4–6-е 0, 7–8-е −2;
 *   - друзья: список со статусом и приглашения поиграть.
 *
 * Хранение — один JSON-файл. Запись атомарная: сначала временный файл,
 * потом rename — дописанный рейтинг не превратится в мусор из-за обрыва
 * в середине. Если файл всё же повреждён, он откладывается в сторону
 * с датой, а не затирается молча: потерять аккаунты незаметно хуже,
 * чем поднять шум.
 *
 * Пароль не хранится — только соль и scrypt-хеш из стандартной
 * библиотеки Node, новых зависимостей не нужно. Сверка через
 * timingSafeEqual: неверный пароль нельзя подобрать по времени ответа.
 *
 * Сессия — токен. Клиент держит его в localStorage, сервер хранит
 * только его sha256: утечка файла не даёт войти, а переподключение
 * после обрыва не выкидывает из чата.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'data', 'users.json');

/** Очки за место: 1-е +5, 2-е +3, 3-е +1, 4–6-е 0, 7–8-е −2. */
const PLACE_POINTS = [5, 3, 1, 0, 0, 0, -2, -2];

const NICK_MIN = 2;
const NICK_MAX = 16;
const PASS_MIN = 4;
const PASS_MAX = 100;

/** Независимость от регистра: сравнение идёт по этому ключу. */
function nickKey(nick) {
    return String(nick === null || nick === undefined ? '' : nick).trim().toLowerCase();
}

/** Сколько очков даёт место. Неизвестное место — ноль, не минус. */
function pointsForPlace(place) {
    if (!Number.isInteger(place) || place < 1 || place > PLACE_POINTS.length) return 0;
    return PLACE_POINTS[place - 1];
}

function hashPass(pass, salt) {
    return crypto.scryptSync(String(pass), salt, 32).toString('hex');
}

function samePass(pass, user) {
    const got = Buffer.from(hashPass(pass, user.salt), 'hex');
    const want = Buffer.from(String(user.hash), 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function tokenHash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function drop(list, value) {
    const i = list.indexOf(value);
    if (i >= 0) list.splice(i, 1);
}

class Accounts {
    constructor(file = DATA_FILE) {
        this.file = file;
        /** Ключ нижнего регистра -> запись. Ключ — ник, а не случайный ид:
            он одинаков у всех и не ломается, если файл правят руками. */
        this.users = new Map();
        this.load();
    }

    // --- хранение --------------------------------------------------------

    load() {
        let raw;
        try {
            raw = fs.readFileSync(this.file, 'utf8');
        } catch (err) {
            if (err.code === 'ENOENT') return;   // ещё никто не регистрировался
            throw err;
        }

        let data;
        try {
            data = JSON.parse(raw);
        } catch (_) {
            const broken = `${this.file}.corrupt-${Date.now()}`;
            fs.renameSync(this.file, broken);
            console.error(`[accounts] ${path.basename(this.file)} повреждён, отложен в ${path.basename(broken)}`);
            return;
        }

        for (const u of Array.isArray(data.users) ? data.users : []) {
            const key = u.key || nickKey(u.nick);
            if (!key || this.users.has(key)) continue;
            this.users.set(key, u);
        }
    }

    save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        const payload = JSON.stringify({ users: [...this.users.values()] }, null, 2);
        fs.writeFileSync(tmp, payload, 'utf8');
        fs.renameSync(tmp, this.file);
    }

    byNick(nick) {
        return this.users.get(nickKey(nick)) || null;
    }

    /** Что видит клиент: без соли, хеша и токена. */
    public(user) {
        return {
            nick: user.nick,
            rating: user.rating,
            games: user.games,
            wins: user.wins,
        };
    }

    // --- регистрация и вход ----------------------------------------------

    register(nick, pass, pass2) {
        const clean = String(nick === null || nick === undefined ? '' : nick).trim();
        if (clean.length < NICK_MIN) return { ok: false, error: `Ник — минимум ${NICK_MIN} символа` };
        if (clean.length > NICK_MAX) return { ok: false, error: `Ник — не длиннее ${NICK_MAX} символов` };
        if (/[\u0000-\u001f\u007f]/.test(clean)) return { ok: false, error: 'В нике недопустимые символы' };

        const p1 = String(pass === null || pass === undefined ? '' : pass);
        const p2 = String(pass2 === null || pass2 === undefined ? '' : pass2);
        if (p1.length < PASS_MIN) return { ok: false, error: `Пароль — минимум ${PASS_MIN} символа` };
        if (p1.length > PASS_MAX) return { ok: false, error: `Пароль — не длиннее ${PASS_MAX} символов` };
        if (p1 !== p2) return { ok: false, error: 'Пароли не совпадают' };

        const key = nickKey(clean);
        if (this.users.has(key)) return { ok: false, error: 'Такой ник уже занят' };

        const salt = crypto.randomBytes(16).toString('hex');
        const user = {
            nick: clean,
            key,
            salt,
            hash: hashPass(p1, salt),
            token: null,
            rating: 0,
            games: 0,
            wins: 0,
            friends: [],
            requestsIn: [],
            requestsOut: [],
        };
        this.users.set(key, user);
        this.save();
        return { ok: true, user: this.public(user) };
    }

    login(nick, pass) {
        const user = this.byNick(nick);
        // Одинаковый текст на оба провала: нельзя проверить, занят ли ник.
        if (!user || !samePass(String(pass === null || pass === undefined ? '' : pass), user)) {
            return { ok: false, error: 'Неверный ник или пароль' };
        }
        return { ok: true, user: this.public(user) };
    }

    // --- сессия ----------------------------------------------------------

    /** Новый токен входа. Клиенту — сырой, в файле — только хеш. */
    issueToken(nick) {
        const user = this.byNick(nick);
        if (!user) return null;
        const token = crypto.randomBytes(24).toString('hex');
        user.token = tokenHash(token);
        this.save();
        return token;
    }

    byToken(token) {
        if (!token) return null;
        const hash = tokenHash(token);
        for (const user of this.users.values()) {
            if (user.token && user.token === hash) return user;
        }
        return null;
    }

    dropToken(nick) {
        const user = this.byNick(nick);
        if (!user || !user.token) return;
        user.token = null;
        this.save();
    }

    // --- рейтинг ---------------------------------------------------------

    /**
     * Начислить очки за занятое место. Боты сюда не попадают: их нет
     * в записях, и это верно — рейтинг должен отражать людей.
     */
    award(nick, place) {
        const user = this.byNick(nick);
        if (!user) return 0;
        const pts = pointsForPlace(place);
        user.rating += pts;
        user.games += 1;
        if (place === 1) user.wins += 1;
        this.save();
        return pts;
    }

    /** Таблица лидеров: по очкам вниз, при равенстве — кто раньше пришёл. */
    rating() {
        return [...this.users.values()]
            .map(u => ({ nick: u.nick, rating: u.rating, games: u.games, wins: u.wins }))
            .sort((a, b) => b.rating - a.rating);
    }

    // --- друзья ----------------------------------------------------------

    /**
     * Кто в друзьях и что висит в заявках, с онлайн-статусом каждого.
     * presence приходит снаружи: здесь нет ни сокетов, ни партии.
     */
    friendsState(nick, presence = () => 'offline') {
        const user = this.byNick(nick);
        if (!user) return { friends: [], requestsIn: [], requestsOut: [] };
        const withStatus = list => list.map(n => ({ nick: n, status: presence(n) }));
        return {
            friends: withStatus(user.friends),
            requestsIn: withStatus(user.requestsIn),
            requestsOut: withStatus(user.requestsOut),
        };
    }

    /** Добавить в друзья по нику. Взаимная заявка дружит сразу. */
    friendRequest(fromNick, toNick) {
        const from = this.byNick(fromNick);
        const to = this.byNick(toNick);
        if (!to) return { ok: false, error: 'Ник не найден', affected: [] };
        if (from.key === to.key) return { ok: false, error: 'Нельзя добавить себя', affected: [] };
        if (to.friends.includes(from.nick)) return { ok: false, error: 'Уже в друзьях', affected: [] };

        // Уже отправляли — повтор ничего не меняет.
        if (from.requestsOut.includes(to.nick)) {
            return { ok: false, error: 'Заявка уже отправлена', affected: [] };
        }
        // Он нас опередил: оба хотят дружить, сторона больше не важна.
        if (to.requestsOut.includes(from.nick)) {
            this.link(from, to);
            return { ok: true, affected: [from.nick, to.nick] };
        }

        to.requestsIn.push(from.nick);
        from.requestsOut.push(to.nick);
        this.save();
        return { ok: true, affected: [from.nick, to.nick] };
    }

    /** Связать двух в друзей и погасить висящие между ними заявки. */
    link(a, b) {
        drop(a.requestsIn, b.nick);
        drop(b.requestsIn, a.nick);
        drop(a.requestsOut, b.nick);
        drop(b.requestsOut, a.nick);
        if (!a.friends.includes(b.nick)) a.friends.push(b.nick);
        if (!b.friends.includes(a.nick)) b.friends.push(a.nick);
        this.save();
    }

    /** fromNick приглашал в друзья, meNick принимает. */
    friendAccept(fromNick, meNick) {
        const me = this.byNick(meNick);
        const from = this.byNick(fromNick);
        if (!me || !from) return { ok: false, error: 'Ник не найден', affected: [] };
        if (!me.requestsIn.includes(from.nick)) return { ok: false, error: 'Такой заявки нет', affected: [] };

        this.link(me, from);
        return { ok: true, affected: [me.nick, from.nick] };
    }

    friendReject(fromNick, meNick) {
        const me = this.byNick(meNick);
        const from = this.byNick(fromNick);
        if (!me || !from) return { ok: false, error: 'Ник не найден', affected: [] };
        if (!me.requestsIn.includes(from.nick)) return { ok: false, error: 'Такой заявки нет', affected: [] };

        drop(me.requestsIn, from.nick);
        drop(from.requestsOut, me.nick);
        this.save();
        return { ok: true, affected: [me.nick, from.nick] };
    }

    friendRemove(friendNick, meNick) {
        const me = this.byNick(meNick);
        const other = this.byNick(friendNick);
        if (!me || !other) return { ok: false, error: 'Ник не найден', affected: [] };
        if (!me.friends.includes(other.nick)) return { ok: false, error: 'Нет в друзьях', affected: [] };

        drop(me.friends, other.nick);
        drop(other.friends, me.nick);
        this.save();
        return { ok: true, affected: [me.nick, other.nick] };
    }
}

module.exports = { Accounts, nickKey, pointsForPlace, PLACE_POINTS, DATA_FILE };
