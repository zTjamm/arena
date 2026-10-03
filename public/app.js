'use strict';

/**
 * Внешние экраны: авторизация, чат, рейтинг, правила, друзья и комната.
 *
 * Порядок один — пока нет вошедшего аккаунта, есть только форма входа.
 * После входа сервер присылает всё разом (историю, рейтинг, состояние
 * комнаты) и только потом «вы вошли», поэтому к моменту переключения
 * экрана у клиента уже есть что показывать.
 *
 * Партия живёт отдельно, в client.js. Сюда она попадает только как три
 * события — «начали», «снимок», «очки» — и обратно двумя действиями:
 * «играть ещё» и «в чат».
 */

(function () {
    const esc = s => String(s).replace(/[&<>"]/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));

    const el = id => document.getElementById(id);

    /**
     * Куда подключаться к сокету.
     *
     * По умолчанию socket.io ждёт `/socket.io` от корня домена. Но под
     * ареной может быть общий сайт с несколькими играми, и тогда она
     * лежит не в корне, а по своему пути — `/arena/`. Тогда и сокет
     * обязан быть там же, иначе запрос уйдёт на `/socket.io` и попадёт
     * в чужую игру или в никуда.
     *
     * Префикс берётся прямо из адреса страницы: всё до последнего
     * слэша. На корне это пустая строка, то есть обычный `/socket.io`,
     * и локальный запуск не меняется ни на байт.
     */
    const BASE = window.location.pathname
        .replace(/[^/]*$/, '');
    const socket = io({ path: BASE + 'socket.io' });

    const TOKEN_KEY = 'arena.token';
    const CHAT_KEEP = 100;
    const panes = {
        chat: el('tabChat'),
        rating: el('tabRating'),
        rules: el('tabRules'),
        friends: el('tabFriends'),
    };

    let me = null;                 // { nick, rating, games, wins }
    let lobby = { waiting: [], startsIn: null, running: false, players: null };
    let friends = { friends: [], requestsIn: [], requestsOut: [] };
    let rating = [];
    const messages = [];           // общий чат
    const roomMessages = [];       // чат комнаты
    const SLOTS = 8;               // размер состава: восемь мест всегда

    /** Какой канал чата открыт. Вне комнаты переключать нечего,
        и туда возвращают принудительно. */
    let channel = 'global';
    let roomUnread = 0;            // сообщения комнаты, пока смотришь общий

    let roomDeadline = null;       // локальный отсчёт, чтобы секунды не дёргались
    let wantsRoom = false;         // был в комнате — вернуться после обрыва
    let resuming = false;          // этот вход — автоматический, по токену
    let shownRoom = null;

    // --- экраны -----------------------------------------------------------

    function show(name) {
        for (const key of ['auth', 'chat', 'game']) {
            el(`${key}Screen`).classList.toggle('on', key === name);
        }
    }

    function selectTab(name) {
        document.querySelectorAll('[data-tab]').forEach(b => {
            b.classList.toggle('on', b.dataset.tab === name);
        });
        for (const key of Object.keys(panes)) panes[key].classList.toggle('on', key === name);
    }

    document.querySelectorAll('[data-tab]').forEach(b => {
        b.addEventListener('click', () => selectTab(b.dataset.tab));
    });

    // --- авторизация ------------------------------------------------------

    const authError = el('authError');

    document.querySelectorAll('[data-auth]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-auth]').forEach(b => b.classList.toggle('on', b === btn));
            el('loginForm').classList.toggle('hidden', btn.dataset.auth !== 'login');
            el('registerForm').classList.toggle('hidden', btn.dataset.auth !== 'register');
            authError.textContent = '';
        });
    });

    el('loginForm').addEventListener('submit', (e) => {
        e.preventDefault();
        authError.textContent = '';
        socket.emit('auth:login', { nick: el('loginNick').value, pass: el('loginPass').value });
    });

    el('registerForm').addEventListener('submit', (e) => {
        e.preventDefault();
        authError.textContent = '';
        socket.emit('auth:register', {
            nick: el('regNick').value,
            pass: el('regPass').value,
            pass2: el('regPass2').value,
        });
    });

    el('logoutBtn').addEventListener('click', () => {
        wantsRoom = false;
        socket.emit('auth:logout');
    });

    function saveToken(token) {
        // sessionStorage, а не localStorage: одна вкладка — одна сессия.
        // Иначе вторая вкладка того же браузера возродилась бы под тем же
        // аккаунтом, а у аккаунта одно подключение — кто-то бы вытеснился.
        // Токен переживает перезапуск страницы, но не новую вкладку:
        // там вход делают заново.
        try { sessionStorage.setItem(TOKEN_KEY, token); } catch (_) { /* приватный режим */ }
    }

    function readToken() {
        try { return sessionStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
    }

    function clearToken() {
        try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) { /* приватный режим */ }
    }

    /** Нас вытеснили: вошли с того же аккаунта в другом месте. */
    socket.on('auth:ended', (msg) => {
        me = null;
        wantsRoom = false;
        resuming = false;
        clearToken();
        authError.textContent = (msg && msg.reason) || '';
        show('auth');
    });

    socket.on('connect', () => {
        const token = readToken();
        if (!token) {
            show('auth');
            return;
        }
        // Вернулись после обрыва: аккаунт поднимется по токену,
        // а комната — по флагу, который пережил только переподключение.
        resuming = true;
        socket.emit('auth:resume', { token });
    });

    socket.on('disconnect', () => {
        toast({ text: 'Пропала связь, переподключаемся…' });
    });

    socket.on('auth:done', (msg) => {
        const wasResuming = resuming;
        resuming = false;

        if (msg.ok) {
            me = msg.me;
            saveToken(msg.token);
            authError.textContent = '';
            shownRoom = null;
            renderMe();
            selectTab('chat');
            show('chat');
            // Обрыв случился, пока я стоял в очереди, — возвращаемся в неё.
            if (wasResuming && wantsRoom) socket.emit('arena:play');
            return;
        }

        if (msg.loggedOut) {
            me = null;
            clearToken();
            show('auth');
            return;
        }

        if (msg.silent) clearToken();
        else authError.textContent = msg.error || '';
    });

    // --- профиль ----------------------------------------------------------

    function renderMe() {
        if (!me) return;
        el('meNick').textContent = me.nick;
        el('meMeta').textContent = `${me.rating} очков · ${me.games} партий · ${me.wins} побед`;
        renderMessages();
        renderRating();
        renderRoom();
    }

    // --- чат --------------------------------------------------------------

    socket.on('chat:history', (list) => {
        messages.length = 0;
        for (const m of Array.isArray(list) ? list : []) messages.push(m);
        renderMessages(true);
    });

    socket.on('chat:message', (m) => {
        if (!m || !m.from) return;
        messages.push(m);
        while (messages.length > CHAT_KEEP) messages.shift();
        renderMessages();
    });

    // В комнате свой чат: сервер отдаёт всю историю тому, кто встал,
    // и дальше присылает только новые. Зашедшему позже не нужно
    // догадываться, о чём болтали до него.
    socket.on('room:history', (list) => {
        roomMessages.length = 0;
        for (const m of Array.isArray(list) ? list : []) roomMessages.push(m);
        roomUnread = 0;
        // Встали в комнату — сразу показываем её чат, а не общий.
        channel = 'room';
        renderMessages(true);
        renderChan();
    });

    socket.on('room:message', (m) => {
        if (!m || !m.from) return;
        roomMessages.push(m);
        while (roomMessages.length > CHAT_KEEP) roomMessages.shift();
        if (channel === 'room') {
            renderMessages();
        } else {
            // Читаем общий чат, а в комнате тем временем написали:
            // молча пропустить нельзя, но и выкидывать на чужой
            // канал посреди разговора тоже неудобно — отмечаем.
            roomUnread++;
            renderChan();
        }
    });

    el('chatForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = el('chatInput');
        const text = input.value.trim();
        if (!text) return;
        socket.emit('chat:send', { text, channel });
        input.value = '';
    });

    document.querySelectorAll('[data-chan]').forEach(b => {
        b.addEventListener('click', () => {
            channel = b.dataset.chan;
            roomUnread = 0;
            renderChan();
            renderMessages(true);
        });
    });

    function inRoom() {
        return !!me && lobby.waiting.includes(me.nick);
    }

    /** Показывается ли канал комнаты и где мы сейчас находимся. */
    function renderChan() {
        // Вне комнаты переключаться не на что: чата комнаты не видно.
        if (!inRoom() && channel !== 'global') channel = 'global';

        const open = inRoom();
        el('chanBar').classList.toggle('hidden', !open);
        document.querySelectorAll('[data-chan]').forEach(b => {
            b.classList.toggle('on', b.dataset.chan === channel);
        });

        el('chatInput').placeholder = channel === 'room'
            ? 'Сообщение в комнату' : 'Сообщение';

        const showRoom = open && channel === 'room';
        el('roomSlots').classList.toggle('hidden', !showRoom);
        el('roomBadge').textContent = roomUnread;
        el('roomBadge').classList.toggle('hidden', roomUnread <= 0 || channel === 'room');

        if (showRoom) renderSlots();
    }

    /** Состав комнаты: кто встал и сколько мест достанется ботам. */
    function renderSlots() {
        const free = Math.max(0, SLOTS - lobby.waiting.length);
        const chips = lobby.waiting.map(n =>
            `<span class="chip${n === me.nick ? ' me' : ''}">${esc(n)}</span>`).join('');
        const filler = free > 0 ? `<span class="chip free">свободно ${free}</span>` : '';
        el('roomSlots').innerHTML = chips + filler;
    }

    function renderMessages(forceBottom) {
        const box = el('messages');
        const list = channel === 'room' ? roomMessages : messages;
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
        box.innerHTML = list.map(m => {
            const at = new Date(m.at || 0);
            const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
            const mine = me && m.from === me.nick;
            return `<div class="msg${mine ? ' me' : ''}"><b>${esc(m.from)}</b>: ${esc(m.text)}<time>${time}</time></div>`;
        }).join('');
        if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
    }

    // --- рейтинг ----------------------------------------------------------

    socket.on('rating:list', (list) => {
        rating = Array.isArray(list) ? list : [];
        if (!me) {
            // Ещё не вошли: таблица приходит раньше «вы вошли».
            renderRating();
            return;
        }
        // Шапка показывает те же числа, что и таблица, — иначе после
        // партии профиль останется с прежним счётом.
        const mine = rating.find(r => r.nick === me.nick);
        if (mine) me = { ...me, rating: mine.rating, games: mine.games, wins: mine.wins };
        renderMe();
    });

    function renderRating() {
        const box = el('ratingList');
        if (rating.length === 0) {
            box.innerHTML = '<div class="empty">Пока никого. Зарегистрируйтесь — и вы первые.</div>';
            return;
        }
        box.innerHTML = rating.map((r, i) => {
            const mine = me && r.nick === me.nick ? '<span class="tag"> — это вы</span>' : '';
            const pts = Number(r.rating) || 0;
            return `<div class="rowline">
                <span class="pos">${i + 1}</span>
                <span class="who">${esc(r.nick)}${mine}</span>
                <span class="pts${pts < 0 ? ' neg' : ''}">${pts}</span>
                <span class="meta">${r.games} партий · ${r.wins} побед</span>
            </div>`;
        }).join('');
    }

    // --- друзья -----------------------------------------------------------

    const STATUS = {
        offline: 'не в сети',
        chat: 'в чате',
        room: 'ждёт партии',
        game: 'играет',
    };

    function friendLine(item, actions) {
        return `<div class="fr">
            <span class="who"><span class="dot ${esc(item.status || 'offline')}"></span>${esc(item.nick)}
                <span class="status">· ${STATUS[item.status] || ''}</span></span>
            ${actions}
        </div>`;
    }

    socket.on('friends:state', (state) => {
        if (state && typeof state === 'object') {
            friends = {
                friends: state.friends || [],
                requestsIn: state.requestsIn || [],
                requestsOut: state.requestsOut || [],
            };
        }
        renderFriends();
    });

    function renderFriends() {
        el('requestsIn').innerHTML = friends.requestsIn.length
            ? '<h3>Заявки</h3>' + friends.requestsIn.map(r => friendLine(r,
                `<button class="sm" data-accept="${esc(r.nick)}">Принять</button>
                 <button class="sm ghost" data-reject="${esc(r.nick)}">Отклонить</button>`)).join('')
            : '';

        el('requestsOut').innerHTML = friends.requestsOut.length
            ? '<h3>Отправлены</h3>' + friends.requestsOut.map(r => friendLine(r,
                '<span class="status">ждёт ответа</span>')).join('')
            : '';

        el('friendList').innerHTML = friends.friends.length
            ? '<h3>В друзьях</h3>' + friends.friends.map(f => friendLine(f,
                `<button class="sm" data-invite="${esc(f.nick)}"${f.status === 'offline' ? ' disabled' : ''}>Позвать</button>
                 <button class="sm ghost" data-remove="${esc(f.nick)}" title="Удалить">✕</button>`)).join('')
            : '<div class="empty">Список друзей пуст. Введите ник выше.</div>';

        const n = friends.requestsIn.length;
        el('friendsBadge').textContent = n;
        el('friendsBadge').classList.toggle('hidden', n === 0);
    }

    el('friendForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = el('friendNick');
        const nick = input.value.trim();
        if (!nick) return;
        socket.emit('friends:request', { nick });
        input.value = '';
    });

    el('tabFriends').addEventListener('click', (e) => {
        const b = e.target.closest && e.target.closest('button');
        if (!b) return;
        if (b.dataset.accept) socket.emit('friends:accept', { nick: b.dataset.accept });
        else if (b.dataset.reject) socket.emit('friends:reject', { nick: b.dataset.reject });
        else if (b.dataset.invite) socket.emit('friends:invite', { nick: b.dataset.invite });
        else if (b.dataset.remove) socket.emit('friends:remove', { nick: b.dataset.remove });
    });

    // --- комната ----------------------------------------------------------

    socket.on('arena:lobby', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        lobby = msg;
        // Сервер шлёт отсчёт раз в четверть секунды, но между его
        // пакетами секунда обязана идти сама — иначе цифра залипает.
        roomDeadline = msg.startsIn != null ? Date.now() + msg.startsIn : null;
        renderRoom();
    });

    el('playBtn').addEventListener('click', () => {
        wantsRoom = true;
        socket.emit('arena:play');
    });

    el('roomLeave').addEventListener('click', () => {
        wantsRoom = false;
        socket.emit('arena:leave');
    });

    el('roomStart').addEventListener('click', () => socket.emit('arena:start'));

    function renderRoom() {
        if (!me) return;

        const inIt = inRoom();
        let text = '';
        let playLabel = 'Играть';
        let startDisabled = false;

        if (inIt) {
            const secs = roomDeadline == null
                ? null
                : Math.max(0, Math.ceil((roomDeadline - Date.now()) / 1000));
            if (lobby.running) {
                text = 'Партия идёт — вы в очереди на следующую';
            } else {
                text = `Комната: ${lobby.waiting.length} из ${SLOTS}`
                    + (secs == null ? '' : ` · старт через ${secs} с`);
            }
            startDisabled = !!lobby.running;
        } else if (lobby.running) {
            playLabel = 'Играть — партия идёт';
        } else if (lobby.startsIn != null) {
            playLabel = `Играть · набор ${lobby.waiting.length} из ${SLOTS}`;
        }

        const key = `${inIt}|${text}|${playLabel}|${startDisabled}`;
        if (key === shownRoom) {
            // Состав комнаты меняется и без смены этих строк, а список
            // игроков перерисовывать надо на каждом пакете.
            renderChan();
            return;
        }
        shownRoom = key;

        el('roomBar').classList.toggle('hidden', !inIt);
        el('playBtn').classList.toggle('hidden', inIt);
        el('roomText').innerHTML = text;
        el('roomStart').disabled = startDisabled;
        el('playBtn').textContent = playLabel;
        renderChan();
    }

    // Отсчёт идёт между пакетами сервера: без него секунда залипает.
    setInterval(renderRoom, 250);

    // --- уведомления ------------------------------------------------------

    function toast(msg) {
        const node = document.createElement('div');
        node.className = 'toast';

        const grow = document.createElement('div');
        grow.className = 'grow';
        grow.textContent = msg.text || '';
        node.appendChild(grow);

        if (msg.kind === 'invite') {
            const join = document.createElement('button');
            join.textContent = 'Играть';
            join.addEventListener('click', () => {
                wantsRoom = true;
                socket.emit('arena:play');
                node.remove();
            });
            node.appendChild(join);
        }

        if (msg.kind === 'friend') {
            const open = document.createElement('button');
            open.textContent = 'Открыть';
            open.addEventListener('click', () => {
                selectTab('friends');
                node.remove();
            });
            node.appendChild(open);
        }

        const close = document.createElement('button');
        close.className = 'ghost';
        close.textContent = '✕';
        close.addEventListener('click', () => node.remove());
        node.appendChild(close);

        el('toasts').appendChild(node);
        setTimeout(() => node.remove(), 9000);
    }

    socket.on('notice', (msg) => { if (msg && msg.text) toast(msg); });

    // --- мост к партии ----------------------------------------------------

    socket.on('arena:you', (msg) => {
        show('game');
        if (window.Game) window.Game.begin(msg);
    });

    socket.on('arena:snapshot', (snap) => {
        if (window.Game) window.Game.snapshot(snap);
    });

    socket.on('arena:score', (score) => {
        if (window.Game) window.Game.setScore(score);
    });

    // --- старт ------------------------------------------------------------

    show('auth');
    renderFriends();
    renderRating();

    // client.js зовёт отсюда: он знает про партию, но не про экраны.
    window.App = {
        socket,
        esc,
        show,
        selectTab,
        toast,
        get me() { return me; },
        get lobby() { return lobby; },
        get channel() { return channel; },
        get roomMessages() { return roomMessages.length; },
        /** «Играть ещё» с экрана результата: комната открывается сразу. */
        play() {
            wantsRoom = true;
            socket.emit('arena:play');
            show('chat');
        },
        toChat() { show('chat'); },
    };
})();
