'use strict';

/**
 * Партия: клавиатура и виртуальный джойстик сюда, картинка —
 * из общего render.js, ядро не тянется в браузер вовсе.
 *
 * Экраны и сокет живут в app.js: оттуда сюда приходят три события —
 * «начали», «снимок», «очки», — а обратно уходят два действия,
 * «играть ещё» и «в чат». Здесь только поле и то, что на нём.
 *
 * Ключевое здесь — отставание. Снимки приходят 30 раз в секунду,
 * кадры рисуются под частоту экрана, и чтобы картинка не дёргалась,
 * рисуется не последний снимок, а тот, что был DELAY мс назад, с
 * позициями, interpolated между двумя соседними снимками. Из-за
 * этого клиент опаздывает на пару кадров — это и называется «считает
 * сервер, клиент рисует с отставанием».
 */

(function () {
    const { require: req } = window.ArenaBundle;
    const { T } = req('game/arena');
    const Render = req('public/render');

    const App = window.App;
    const socket = App.socket;
    const esc = App.esc;

    const DELAY = 120;          // мс отставания картинки от сервера
    const MAX_FRAMES = 12;      // сколько снимков держим в буфере

    /** Недавние удары: [{ by, dirx, diry, hits, at }] для анимации.
         Держим чуть дольше, чем живёт сама анимация, — на случай
         пропущенного кадра, вычерпывает их кадр ниже. */
    const effects = [];

    // --- состояние --------------------------------------------------------

    let you = null;             // мой ид в текущей партии
    let active = false;         // партия началась (я в ней или смотрю конец)
    let finished = false;       // последняя партия доиграна
    let score = null;           // { place, points, rating } после партии
    let connected = true;
    let lastSnap = null;
    const feed = [];            // кто и кем вылетел

    const IDLE = {
        size: T.FIELD_SIZE,
        tick: 0,
        elapsed: 0,
        finished: false,
        winner: null,
        players: [],
        events: [],
    };

    // --- снимки и отставание ---------------------------------------------

    /** { snap, at } в порядке прихода; at — время по шкале requestAnimationFrame. */
    const frames = [];

    function lerpSnap(a, b, k) {
        return {
            ...b,
            players: b.players.map(p => {
                const prev = a.players.find(q => q.id === p.id);
                if (!prev) return p;
                return {
                    ...p,
                    x: prev.x + (p.x - prev.x) * k,
                    y: prev.y + (p.y - prev.y) * k,
                    vx: prev.vx + (p.vx - prev.vx) * k,
                    vy: prev.vy + (p.vy - prev.vy) * k,
                };
            }),
        };
    }

    function sample(now) {
        if (frames.length === 0) return null;

        const t = now - DELAY;
        if (t <= frames[0].at) return frames[0].snap;

        const last = frames[frames.length - 1];
        if (t >= last.at) return last.snap;

        let a = frames[0];
        let b = last;
        for (let i = 0; i < frames.length - 1; i++) {
            if (frames[i].at <= t && t <= frames[i + 1].at) {
                a = frames[i];
                b = frames[i + 1];
                break;
            }
        }

        const span = b.at - a.at;
        // Между партиями тик начинается заново: интерполировать
        // перескок позиций через всю карту нельзя.
        if (span <= 0 || b.snap.tick <= a.snap.tick) return b.snap;
        return lerpSnap(a.snap, b.snap, (t - a.at) / span);
    }

    // --- ввод: клавиатура -------------------------------------------------

    const input = { x: 0, y: 0, jump: false, push: false, stone: false };
    const keys = new Set();

    /** Пишем в поле ввода — клавиши принадлежат ему, а не партии.
        Без этой проверки Space в чате не проставился бы, а стрелки
        не двигали бы каретку: браузер перехватил бы их как игровые. */
    function typing(e) {
        const t = e.target;
        return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    }

    window.addEventListener('keydown', (e) => {
        if (typing(e)) return;
        keys.add(e.code);
        // Пробел иначе прокрутит страницу или нажмёт кнопку под фокусом,
        // стрелки — прокрутят. В партии это недопустимо.
        if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => keys.delete(e.code));
    window.addEventListener('blur', () => keys.clear());

    // --- ввод: виртуальный джойстик --------------------------------------

    const stickEl = document.getElementById('stick');
    const knobEl = document.getElementById('knob');
    const stick = { id: null, x: 0, y: 0 };
    const STICK_R = 46;

    function stickMove(e) {
        const box = stickEl.getBoundingClientRect();
        const dx = e.clientX - (box.left + box.width / 2);
        const dy = e.clientY - (box.top + box.height / 2);
        const dist = Math.hypot(dx, dy);
        const k = dist > STICK_R ? STICK_R / dist : 1;
        const px = dx * k;
        const py = dy * k;
        knobEl.style.transform = `translate(${px}px, ${py}px)`;
        stick.x = px / STICK_R;
        stick.y = py / STICK_R;
    }

    function stickReset() {
        stick.id = null;
        stick.x = 0;
        stick.y = 0;
        knobEl.style.transform = 'translate(0px, 0px)';
    }

    stickEl.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        // Захват нужен, чтобы палец не терялся за границей кружка, но
        // полагаться на него нельзя: если браузер откажет, исключение
        // оборвёт обработчик раньше, чем установится stick.id, и
        // джойстик умрёт целиком вместо того, чтобы просто стать строже.
        try { stickEl.setPointerCapture(e.pointerId); } catch (_) { /* best effort */ }
        stick.id = e.pointerId;
        stickMove(e);
    });
    stickEl.addEventListener('pointermove', (e) => {
        if (e.pointerId === stick.id) stickMove(e);
    });
    stickEl.addEventListener('pointerup', (e) => {
        if (e.pointerId === stick.id) stickReset();
    });
    stickEl.addEventListener('pointercancel', stickReset);

    // --- ввод: кнопки скиллов --------------------------------------------

    let btnPush = false;
    let btnJump = false;
    let btnStone = false;

    function bindSkill(id, set) {
        const el = document.getElementById(id);
        const on = (e) => {
            e.preventDefault();
            // Как и у джойстика: захват указателя — удобство, а не
            // условие. Отказ браузера не должен лишить кнопки скилла.
            try { el.setPointerCapture(e.pointerId); } catch (_) { /* best effort */ }
            el.classList.add('held');
            set(true);
        };
        const off = () => {
            el.classList.remove('held');
            set(false);
        };
        el.addEventListener('pointerdown', on);
        el.addEventListener('pointerup', off);
        el.addEventListener('pointercancel', off);
        el.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    bindSkill('btnPush', (v) => { btnPush = v; });
    bindSkill('btnJump', (v) => { btnJump = v; });
    bindSkill('btnStone', (v) => { btnStone = v; });

    // --- режим управления -------------------------------------------------

    let touchMode = window.matchMedia('(pointer: coarse)').matches;
    // Сенсорный ноутбук может не попасть в coarse: первое касание
    // всё равно включает джойстик, клавиатура при этом остаётся.
    window.addEventListener('touchstart', () => {
        if (!touchMode) {
            touchMode = true;
            applyControlMode();
        }
    }, { passive: true });

    function applyControlMode() {
        document.body.classList.toggle('touch', touchMode);
    }
    applyControlMode();

    function readInput() {
        let x = 0;
        let y = 0;

        if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
        if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
        if (keys.has('KeyW') || keys.has('ArrowUp')) y -= 1;
        if (keys.has('KeyS') || keys.has('ArrowDown')) y += 1;

        x += stick.x;
        y += stick.y;

        const mag = Math.hypot(x, y);
        if (mag > 1) {
            x /= mag;
            y /= mag;
        }

        input.x = x;
        input.y = y;

        // Толчок **держится**: пока кнопка нажата, копится заряд,
        // и удар уходит в момент отпускания. Отсюда важность
        // keyup — без него заряд никогда не выстрелит.
        input.push = btnPush || keys.has('Space');

        // Прыжок и камень — обычные кнопки: зажал, откат кончился —
        // сработает само. Но и отпустить надо, иначе повторится.
        input.jump = btnJump || keys.has('ShiftLeft') || keys.has('ShiftRight');
        input.stone = btnStone || keys.has('KeyQ');
    }

    socket.on('connect', () => { connected = true; });
    socket.on('disconnect', () => { connected = false; });

    setInterval(() => {
        if (active && !finished && connected) socket.emit('arena:input', input);
    }, 1000 / 30);

    // --- холст ------------------------------------------------------------

    const canvas = document.getElementById('field');
    const ctx = canvas.getContext('2d');
    let viewW = 0;
    let viewH = 0;

    function resize() {
        const dpr = window.devicePixelRatio || 1;
        viewW = window.innerWidth;
        viewH = window.innerHeight;
        canvas.width = Math.round(viewW * dpr);
        canvas.height = Math.round(viewH * dpr);
        canvas.style.width = `${viewW}px`;
        canvas.style.height = `${viewH}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
    resize();

    // --- экран результата --------------------------------------------------

    const panel = document.getElementById('panel');
    const panelTitle = document.getElementById('panelTitle');
    const panelSub = document.getElementById('panelSub');
    const scoreEl = document.getElementById('score');
    const feedEl = document.getElementById('feed');
    const hudMe = document.getElementById('hudMe');
    const hudStatus = document.getElementById('hudStatus');

    document.getElementById('againBtn').addEventListener('click', () => App.play());
    document.getElementById('chatBtn').addEventListener('click', () => App.toChat());

    function findMe(snap) {
        if (!snap || !you) return null;
        return snap.players.find(p => p.id === you) || null;
    }

    function feedHtml() {
        return feed.map(f => {
            const who = `<b>${esc(f.id)}</b>`;
            return f.by
                ? `${who} вылетел от <b>${esc(f.by)}</b>`
                : `${who} покинул поле`;
        }).map(line => `<li>${line}</li>`).join('');
    }

    const shown = {};

    function resetShown() {
        for (const key of Object.keys(shown)) delete shown[key];
    }

    function set(key, node, value, html) {
        if (shown[key] === value) return;
        shown[key] = value;
        if (html) node.innerHTML = value;
        else node.textContent = value;
    }

    function scoreLine() {
        if (!score) return '';
        const pts = Number(score.points) || 0;
        const tail = score.rating === undefined ? '' : ` → ${score.rating}`;
        return `${pts > 0 ? '+' : ''}${pts} очков${tail}`;
    }

    function updatePanel() {
        // Панель — только результат: живую партию ничем не закрывают.
        if (!active || !finished) {
            panel.style.display = 'none';
        } else {
            panel.style.display = '';
        }

        const mine = findMe(lastSnap);
        let title;
        let sub;

        if (!connected) {
            title = 'Подключение…';
            sub = '';
        } else if (lastSnap && lastSnap.winner) {
            title = lastSnap.winner === you ? 'Вы победили' : `Победил ${lastSnap.winner}`;
            sub = title === 'Вы победили'
                ? 'Вы остались на поле одни'
                : (mine && mine.place ? `Ваше место: ${mine.place}-е` : '');
        } else if (lastSnap) {
            title = 'Партия окончена';
            sub = mine && mine.place ? `Ваше место: ${mine.place}-е` : '';
        } else {
            title = 'Партия окончена';
            sub = '';
        }

        set('title', panelTitle, title);
        set('sub', panelSub, sub, true);

        const line = scoreLine();
        scoreEl.classList.toggle('hidden', !line);
        set('score', scoreEl, line);

        const html = feedHtml();
        set('feed', feedEl, html, true);

        let hud;
        if (lastSnap) {
            const alive = lastSnap.players.filter(p => p.alive).length;
            hud = `${lastSnap.players.length} игроков · ${alive} в живых`;
        } else {
            hud = you ? `Вы: ${you}` : '';
        }
        set('hud', hudMe, hud);

        let status;
        if (!connected) {
            status = 'нет связи';
        } else if (!lastSnap) {
            status = '';
        } else if (finished) {
            status = 'конец';
        } else if (mine && !mine.alive) {
            status = 'вы выбыли · ждём победителя';
        } else {
            status = `${Math.round(lastSnap.elapsed)} с`;
        }
        set('status', hudStatus, status);
    }

    // Отладочная ручка: снимок, очередь и текущий ввод видны из консоли.
    // Без неё проверить «доходит ли ввод» можно только на глаз, а на глаз
    // неподвижное тело и вылетевшее тело выглядят одинаково.
    window.__arena = {
        get snap() { return lastSnap; },
        get lobby() { return App.lobby; },
        get you() { return you; },
        get input() { return { ...input }; },
        get frames() { return frames.length; },
        get effects() { return effects.length; },
        get finished() { return finished; },
        get score() { return score; },
    };

    // --- петля кадров -----------------------------------------------------

    function frame(now) {
        readInput();

        while (effects.length && now - effects[0].at > Render.PUSH_FX_MS * 2) {
            effects.shift();
        }

        if (document.getElementById('gameScreen').classList.contains('on')) {
            const snap = sample(now) || (active ? IDLE : null);
            if (snap) {
                const bottom = touchMode ? 176 : 44;
                const view = Render.fit(viewW, viewH, snap.size, { top: 44, bottom });
                Render.draw(ctx, snap, view, {
                    labels: true,
                    pulse: (now / 1000) % 1,
                    spin: now / 1000,
                    me: you,
                    effects,
                });
            }
            updatePanel();
        }

        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);

    // --- мост к app.js ----------------------------------------------------

    window.Game = {
        begin(msg) {
            you = msg && msg.you;
            active = true;
            finished = false;
            score = null;
            frames.length = 0;
            feed.length = 0;
            effects.length = 0;
            lastSnap = null;
            resetShown();
        },

        snapshot(snap) {
            if (!snap) return;
            frames.push({ snap, at: performance.now() });
            while (frames.length > MAX_FRAMES) frames.shift();
            lastSnap = snap;

            for (const e of snap.events || []) {
                if (e.type === 'push') {
                    effects.push({
                        by: e.by,
                        dirx: e.dirx,
                        diry: e.diry,
                        hits: e.hits || [],
                        at: performance.now(),
                    });
                    continue;
                }
                if (e.type !== 'eliminated') continue;
                feed.push({ id: e.id, by: e.by });
                while (feed.length > 6) feed.shift();
            }

            if (snap.finished) finished = true;
        },

        setScore(value) {
            score = value || null;
        },
    };
})();
