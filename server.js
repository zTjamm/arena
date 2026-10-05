'use strict';

/**
 * Сетевая обвязка арены: express для статики, socket.io для чата,
 * ввода и снимков, фиксированный тик 30 Гц для самой партии.
 *
 * Устройство страницы — три экрана: авторизация, чат и партия.
 * Сервер ведёт их в том же порядке: без вошедшего аккаунта ни чата,
 * ни комнаты, ни партии нет. Аккаунты — accounts.js, подбор —
 * game/lobby.js: оба проверяются тестами и от часов не завязаны.
 *
 * Принцип тот же, что и в одиночной игре: считает только сервер.
 * Клиент шлёт направление и нажатия скиллов, сервер шагает симуляцию
 * и рассылает снимки. Боты живут в том же цикле, что и живые, —
 * поэтому играть против них можно без каких-либо особых веток.
 *
 * Комната открывается кнопкой «Играть» и закрывается после старта:
 * между партиями очередь не переиспользуется, иначе нажатие перестало
 * бы быть тем, что создаёт комнату.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const { createArena, addPlayer, spawnPoint, step, snapshot } = require('./game/arena');
const { botInput } = require('./game/bot');
const { Lobby } = require('./game/lobby');
const { Accounts } = require('./accounts');

const PORT = Number(process.env.PORT) || 8100;

// Путь, по которому ходит socket.io. По умолчанию — корень домена,
// и это же значение по умолчанию подставляет клиент из адреса
// страницы. Менять нужно только когда арена лежит не в корне, а под
// общим сайтом с несколькими играми: тогда и сокет обязан быть там
// же, иначе запрос уйдёт в чужую игру.
const SOCKET_PATH = process.env.SOCKET_PATH || '/socket.io';

// Держится в паре с T.TICK из ядра: рассинхрон тут означает, что
// сервер шлёт снимки чаще, чем считает физику (или наоборот), и
// интерполяция на клиенте начинает тянуть пустые промежутки.
// Тик 60 Гц, а не 30: задержка ввода ~50 мс -> ~17 мс, квантование
// носа вдвое мельче. Платим трафиком — 119 КБ/с на клиента против
// 59, и это осознанный размен.
const TICK_MS = 1000 / 60;
const PACE_MS = 250;   // как часто проверять подбор и напоминать об отсчёте
const CHAT_MAX = 300;  // длина сообщения в символах
const CHAT_KEEP = 100; // сколько сообщений помним между перезапусками

// Пустой ввод: обрыв связи не должен оставлять зажатой клавишу —
// тело просто тормозит на месте, и его выталкивают остальные.
const EMPTY_INPUT = Object.freeze({
    x: 0, y: 0, jump: false, push: false, stone: false,
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { path: SOCKET_PATH });

app.use(express.static(path.join(__dirname, 'public')));

const accounts = new Accounts();
const lobby = new Lobby();

/** socketId -> ник. Живёт ровно столько, сколько подключение. */
const session = new Map();
/** Ник -> socketId. Аккаунт занят ровно одним подключением: иначе
    два экрана одного человека сражались бы одним телом. */
const byNick = new Map();

const chat = [];
/** Чат комнаты. Общий не задевает: сообщения из комнаты видят только
    те, кто сейчас в ней стоит. Чистится, когда комната открывается
    заново из пустой, — вместе со сбросом её состава. */
const roomChat = [];
/** Текущая партия или null. Одновременно — только одна. */
let match = null;
let matchSeq = 0;

// --- рассылка -------------------------------------------------------------

/** Только вошедшим: списки комнаты и статусы друзей не для всех подряд. */
function emitAll(event, data) {
    for (const id of session.keys()) io.to(id).emit(event, data);
}

function socketOf(nick) {
    const id = byNick.get(nick);
    return id ? io.sockets.sockets.get(id) : null;
}

/** Только тем, кто сейчас в комнате: её чат не должен попадать к лобби. */
function emitRoom(event, data) {
    for (const nick of lobby.waiting) {
        const sock = socketOf(nick);
        if (sock) sock.emit(event, data);
    }
}

/**
 * Встать в комнату. Комната из пустой стала непустой — значит это
 * новая комната, и её чат начинается с чистого листа: сообщения
 * прошлой партии никому тут не нужны.
 *
 * Сначала состав, потом история — не наоборот. Клиент решает, какой
 * канал показать, по составу: если история придёт первой, он ещё не
 * будет знать, что стоит в комнате, и сбросит канал на общий.
 */
function joinRoom(socket, nick, now) {
    const fresh = lobby.size === 0;
    lobby.join(nick, now);
    if (fresh && lobby.size > 0) roomChat.length = 0;
    broadcastLobby();
    broadcastOnline();
    socket.emit('room:history', roomChat);
}

function notice(nick, text, kind) {
    const sock = socketOf(nick);
    if (sock) sock.emit('notice', { text, kind });
}

// --- партия ---------------------------------------------------------------

function cleanInput(raw) {
    const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const box = raw && typeof raw === 'object' ? raw : {};
    return {
        x: Math.max(-1, Math.min(1, num(box.x))),
        y: Math.max(-1, Math.min(1, num(box.y))),
        // Скиллы: прыжок и камень level-based — зажал, откат кончился,
        // сработает снова. Толчок — исключение: он держится и стреляет
        // **на отпускании**, поэтому это просто флаг нажатия.
        jump: !!box.jump,
        push: !!box.push,
        stone: !!box.stone,
    };
}

function lobbyState(now) {
    return {
        waiting: lobby.waiting,
        startsIn: lobby.startsIn(now),
        running: match !== null,
        players: match ? match.arena.players.length : null,
    };
}

function broadcastLobby() {
    emitAll('arena:lobby', lobbyState(Date.now()));
}

/** Собрать партию из готовых живых и ботов. */
function startMatch(now) {
    const plan = lobby.take(now);
    if (!plan) return false;

    const arena = createArena();
    const bots = new Set(plan.bots);
    const all = [...plan.humans, ...plan.bots];
    all.forEach((id, i) => {
        const pt = spawnPoint(i, all.length, arena.size);
        addPlayer(arena, id, { x: pt.x, y: pt.y, bot: bots.has(id) });
    });

    const humans = new Map();
    for (const nick of plan.humans) {
        const id = byNick.get(nick);
        if (id) humans.set(id, nick);
    }

    match = {
        arena,
        room: `match-${++matchSeq}`,
        inputs: new Map(),
        humans,
        timer: setInterval(tick, TICK_MS),
    };

    for (const [socketId, playerId] of humans) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
            socket.join(match.room);
            socket.emit('arena:you', { you: playerId, size: plan.size });
        }
    }

    console.log(`[arena] партия ${matchSeq}: ${plan.humans.length} живых + `
        + `${plan.bots.length} ботов = ${plan.size}`);
    broadcastLobby();
    broadcastOnline();
    broadcastFriends();
    return true;
}

function tick() {
    if (!match) return;
    const { arena } = match;

    const inputs = {};
    for (const p of arena.players) {
        if (!p.alive) continue;
        if (p.bot) inputs[p.id] = botInput(p, arena);
        else inputs[p.id] = match.inputs.get(p.id) || EMPTY_INPUT;
    }

    step(arena, inputs);
    io.to(match.room).emit('arena:snapshot', snapshot(arena));

    if (arena.finished) endMatch(Date.now());
}

/**
 * Конец партии: очки по месту и экран результатов. Комната при этом
 * не переоткрывается — следующую откроет нажатие «Играть».
 */
function endMatch(now) {
    if (!match) return;
    const { room, humans, arena } = match;
    clearInterval(match.timer);
    match = null;

    // 1-е +5, 2-е +3, 3-е +1, 4–6-е 0, 7–8-е −2. Ботов в записях нет,
    // award для них вернёт ноль — рейтинг отражает только людей.
    for (const [socketId, nick] of humans) {
        const player = arena.players.find(p => p.id === nick);
        const place = player ? player.place : null;
        const points = accounts.award(nick, place);
        const user = accounts.byNick(nick);
        const sock = io.sockets.sockets.get(socketId);
        if (sock) sock.emit('arena:score', { place, points, rating: user ? user.rating : 0 });
    }

    io.in(room).socketsLeave(room);
    emitAll('rating:list', accounts.rating());
    broadcastFriends();
    broadcastLobby();
    broadcastOnline();
}

/** Снять подключение с партии: тело остаётся на поле и замирает. */
function detachFromMatch(socket) {
    if (!match) return;
    const playerId = match.humans.get(socket.id);
    if (!playerId) return;

    match.humans.delete(socket.id);
    match.inputs.delete(playerId);
    // Из комнаты выходим тоже: иначе бывший игрок продолжал бы
    // смотреть чужую партию и путался бы в её снимках.
    socket.leave(match.room);
    // Смотреть осталось некого — партия не должна жить впустую.
    if (match.humans.size === 0) endMatch(Date.now());
}

// --- друзья и статусы -----------------------------------------------------

/** 'game' — играет, 'room' — ждёт комнаты, 'chat' — в чате, 'offline'. */
function presence(nick) {
    if (match) {
        for (const value of match.humans.values()) if (value === nick) return 'game';
    }
    if (lobby.waiting.includes(nick)) return 'room';
    if (byNick.has(nick)) return 'chat';
    return 'offline';
}

function broadcastFriends() {
    for (const [id, nick] of session) {
        io.to(id).emit('friends:state', accounts.friendsState(nick, presence));
    }
}

/**
 * Кто сейчас онлайн: ник и его состояние.
 *
 * Список идёт всем вошедшим, а не друзьям: по требованию это постоянная
 * левая колонка в чате, и она должна быть одинаковой у всех, иначе
 * «кто онлайн» означало бы разное для разных людей и перестаёт быть
 * списком онлайна.
 *
 * Порядок — по занятости, а не по нику: играющие наверху, потому что
 * их ищут в первую очередь, ждущие комнату — следом, сидящие в чате —
 * внизу. Внутри группы по нику, чтобы список не прыгал при каждой
 * рассылке.
 */
function onlineState() {
    const rows = [];
    for (const nick of byNick.keys()) {
        rows.push({ nick, status: presence(nick) });
    }
    const rank = { game: 0, room: 1, chat: 2 };
    rows.sort((a, b) => {
        const d = (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
        if (d) return d;
        return a.nick.localeCompare(b.nick, 'ru');
    });
    return rows;
}

function broadcastOnline() {
    emitAll('arena:online', onlineState());
}

// --- сессия ---------------------------------------------------------------

/** Снять подключение со всем: сессия, комната, партия. Токен не трогает —
    он нужен, чтобы вернуться после обрыва. */
function detach(socket) {
    const nick = session.get(socket.id);
    if (!nick) return null;

    session.delete(socket.id);
    if (byNick.get(nick) === socket.id) byNick.delete(nick);
    lobby.leave(nick);
    detachFromMatch(socket);
    return nick;
}

/** Аккаунт занят одним подключением: второй экран вытесняет первый. */
function kickOld(nick) {
    const oldId = byNick.get(nick);
    if (!oldId) return;
    const old = io.sockets.sockets.get(oldId);
    if (old) detach(old);
    if (old) old.emit('auth:ended', { reason: 'Вы вошли с другого устройства' });
}

function enter(socket, user) {
    kickOld(user.nick);

    session.set(socket.id, user.nick);
    byNick.set(user.nick, socket.id);

    const token = accounts.issueToken(user.nick);

    // Порядок важен: данные приходят первыми, «вы вошли» — последним,
    // чтобы к моменту переключения экрана у клиента уже всё было.
    socket.emit('chat:history', chat);
    socket.emit('rating:list', accounts.rating());
    socket.emit('arena:lobby', lobbyState(Date.now()));
    socket.emit('arena:online', onlineState());
    socket.emit('auth:done', { ok: true, me: user, token });

    broadcastFriends();
    broadcastOnline();
}

/** Обработчик, требующий вошедшего аккаунта: чужие пакеты игнорируются. */
function onAuthed(handler) {
    return function (raw) {
        const nick = session.get(this.id);
        if (!nick) return;
        handler.call(this, nick, raw);
    };
}

function replyError(socket, res) {
    if (!res.ok) socket.emit('notice', { text: res.error });
}

// --- соединение -----------------------------------------------------------

io.on('connection', (socket) => {
    socket.on('auth:register', function (raw) {
        const box = raw && typeof raw === 'object' ? raw : {};
        const res = accounts.register(box.nick, box.pass, box.pass2);
        if (!res.ok) return socket.emit('auth:done', { ok: false, error: res.error });
        enter(socket, res.user);
    });

    socket.on('auth:login', function (raw) {
        const box = raw && typeof raw === 'object' ? raw : {};
        const res = accounts.login(box.nick, box.pass);
        if (!res.ok) return socket.emit('auth:done', { ok: false, error: res.error });
        enter(socket, res.user);
    });

    // Возврат после обрыва: токен в localStorage, в файле — только хеш.
    // Ошибку не показываем — форма входа просто остаётся на месте.
    socket.on('auth:resume', function (raw) {
        const user = accounts.byToken(raw && raw.token);
        if (!user) return socket.emit('auth:done', { ok: false, silent: true });
        enter(socket, accounts.public(user));
    });

    socket.on('auth:logout', function () {
        const nick = session.get(this.id);
        if (!nick) return;
        accounts.dropToken(nick);
        detach(socket);
        socket.emit('auth:done', { ok: false, loggedOut: true });
        broadcastFriends();
        broadcastLobby();
    broadcastOnline();
    });

    // У чата два канала. Общий видят все вошедшие, комнатный — только
    // те, кто сейчас стоит в комнате: переписываться с теми, с кем
    // через минуту играешь, и не с кем больше.
    socket.on('chat:send', onAuthed(function (nick, raw) {
        const text = String((raw && raw.text) || '').trim().slice(0, CHAT_MAX);
        if (!text) return;
        const msg = { from: nick, text, at: Date.now() };

        if (raw && raw.channel === 'room') {
            if (!lobby.waiting.includes(nick)) return;
            roomChat.push(msg);
            while (roomChat.length > CHAT_KEEP) roomChat.shift();
            emitRoom('room:message', msg);
            return;
        }

        chat.push(msg);
        while (chat.length > CHAT_KEEP) chat.shift();
        emitAll('chat:message', msg);
    }));

    // --- друзья -----------------------------------------------------------

    socket.on('friends:request', onAuthed(function (nick, raw) {
        const res = accounts.friendRequest(nick, raw && raw.nick);
        if (!res.ok) return replyError(this, res);
        notice(res.affected[1], `${nick} хочет добавить вас в друзья`, 'friend');
        broadcastFriends();
    }));

    socket.on('friends:accept', onAuthed(function (nick, raw) {
        const res = accounts.friendAccept(raw && raw.nick, nick);
        if (!res.ok) return replyError(this, res);
        notice(res.affected[1], `${nick} принял заявку в друзья`, 'friend');
        broadcastFriends();
    }));

    socket.on('friends:reject', onAuthed(function (nick, raw) {
        const res = accounts.friendReject(raw && raw.nick, nick);
        if (!res.ok) return replyError(this, res);
        broadcastFriends();
    }));

    socket.on('friends:remove', onAuthed(function (nick, raw) {
        const res = accounts.friendRemove(raw && raw.nick, nick);
        if (!res.ok) return replyError(this, res);
        broadcastFriends();
    }));

    // Приглашение. Комната открывается сразу: звать в неё, которой нет,
    // — пустое приглашение, а создать её кнопкой всё равно придётся.
    socket.on('friends:invite', onAuthed(function (nick, raw) {
        const target = accounts.byNick(raw && raw.nick);
        if (!target) return replyError(this, { ok: false, error: 'Ник не найден' });
        if (!accounts.byNick(nick).friends.includes(target.nick)) {
            return replyError(this, { ok: false, error: 'Сначала добавьте в друзья' });
        }
        if (!socketOf(target.nick)) {
            return replyError(this, { ok: false, error: `${target.nick} сейчас не в сети` });
        }

        if (!match) joinRoom(this, nick, Date.now());
        notice(target.nick, `${nick} зовёт поиграть`, 'invite');
        broadcastFriends();
    }));

    // --- комната и партия -------------------------------------------------

    socket.on('arena:play', onAuthed(function (nick) {
        if (match && match.humans.has(this.id)) return;   // уже в партии
        joinRoom(this, nick, Date.now());
        broadcastFriends();
    }));

    socket.on('arena:start', onAuthed(function () {
        if (match) return;                    // идущую партию не перебивают
        const now = Date.now();
        if (lobby.force(now)) startMatch(now);
        broadcastLobby();
    broadcastOnline();
    }));

    socket.on('arena:leave', onAuthed(function (nick) {
        lobby.leave(nick);
        detachFromMatch(this);
        broadcastLobby();
    broadcastOnline();
        broadcastFriends();
    }));

    socket.on('arena:input', (raw) => {
        if (!match) return;
        const playerId = match.humans.get(socket.id);
        if (!playerId) return;                // ввод принимаем только свой
        match.inputs.set(playerId, cleanInput(raw));
    });

    socket.on('disconnect', () => {
        detach(socket);
        broadcastFriends();
        broadcastLobby();
        broadcastOnline();
    });
});

setInterval(() => {
    const now = Date.now();
    if (!match && lobby.isReady(now)) startMatch(now);
    emitAll('arena:lobby', lobbyState(now));
}, PACE_MS);

server.listen(PORT, () => {
    console.log(`[arena] http://127.0.0.1:${PORT}`);
    console.log(`[arena] socket.io ждёт по пути ${SOCKET_PATH}`);
});
