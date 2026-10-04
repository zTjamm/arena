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
    const Sound = req('public/sound');

    const App = window.App;
    const socket = App.socket;
    const esc = App.esc;

    const DELAY = 120;          // мс отставания картинки от сервера
    const MAX_FRAMES = 12;      // сколько снимков держим в буфере

    /** Недавние удары: [{ by, dirx, diry, hits, at }] для анимации.
         Держим чуть дольше, чем живёт сама анимация, — на случай
         пропущенного кадра, вычерпывает их кадр ниже. */
    const effects = [];

    // Цепочки и взрывы камня живут отдельно от ударов: у них свой
    // срок жизни и своя картинка. Удары показываются 260 мс, подпись
    // цепочки едет вверх чуть больше секунды, кольцо взрыва гаснет за
    // полсекунды.
    const chains = [];
    const bursts = [];

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

    /**
     * Ход ручки берётся из размера джойстика, а не из константы.
     *
     * Джойстик меняется в размерах: 132 точек обычно и 104 на низком
     * экране. Константа от размера не зависила, и на низком экране
     * ручка ходила почти до края кружка, а её шарик в 56 точек
     * наполовину вылезал наружу.
     */
    function stickRadius(box) {
        return Math.min(box.width, box.height) * 0.35;
    }

    function stickMove(e) {
        const box = stickEl.getBoundingClientRect();
        const R = stickRadius(box);
        const dx = e.clientX - (box.left + box.width / 2);
        const dy = e.clientY - (box.top + box.height / 2);
        const dist = Math.hypot(dx, dy);
        const k = dist > R ? R / dist : 1;
        const px = dx * k;
        const py = dy * k;
        knobEl.style.transform = `translate(${px}px, ${py}px)`;
        stick.x = px / R;
        stick.y = py / R;
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

    // Страховка от залипания джойстика — та же, что и у кнопок: если
    // захват указателя не сработал, палец уйдёт с кружка, и джойстик
    // останется нажатым с направлением в сторону, а персонаж будет
    // вечно идти в стену. Отпускание ловится ещё и на окне.
    function stickRelease(e) {
        if (e && stick.id != null && e.pointerId !== stick.id) return;
        stickReset();
    }
    window.addEventListener('pointerup', stickRelease);
    window.addEventListener('pointercancel', stickRelease);

    // --- ввод: кнопки скиллов --------------------------------------------

    let btnPush = false;
    let btnJump = false;
    let btnStone = false;

    /**
     * Кнопка скилла на касании.
     *
     * Две тонкости, обе проверялись на телефоне и обе выглядят как
     * «глючит управление»:
     *
     * 1. **Залипание.** Отпускание ловится только на самой кнопке.
     *    Если `setPointerCapture` не сработал, палец может уйти с
     *    кнопки, и её `pointerup` не увидит: палец отпустится над
     *    другим элементом. Кнопка остаётся нажатой **навсегда** —
     *    заряд копится, выстрелить нельзя, кнопка горит. Поэтому
     *    отпускание ловится ещё и на окне: указатель, который держал
     *    кнопку, отпущен где угодно — значит кнопка отпущена.
     *
     * 2. **Два пальца на одной кнопке.** Кнопку можно зажать обеими
     *    руками. Отпускание одного пальца не должно её ронять, пока
     *    второй держит, поэтому пальцы считаются множеством.
     */
    function bindSkill(id, set) {
        const el = document.getElementById(id);
        const holding = new Set();

        const on = (e) => {
            e.preventDefault();
            // Захват — удобство, а не условие: отказ браузера не
            // должен лишить кнопки скилла. Страховка на окне ниже.
            try { el.setPointerCapture(e.pointerId); } catch (_) { /* best effort */ }
            holding.add(e.pointerId);
            el.classList.add('held');
            set(true);
        };

        const off = (e) => {
            if (e) {
                // Указатель чужой: нас он не касается.
                if (!holding.has(e.pointerId)) return;
                holding.delete(e.pointerId);
            } else {
                holding.clear();
            }
            if (holding.size) return;      // держит ещё один палец
            el.classList.remove('held');
            set(false);
        };

        el.addEventListener('pointerdown', on);
        el.addEventListener('pointerup', off);
        el.addEventListener('pointercancel', off);
        // Браузер сам снял захват — палец где-то отпустился.
        el.addEventListener('lostpointercapture', off);
        el.addEventListener('contextmenu', (e) => e.preventDefault());

        window.addEventListener('pointerup', off);
        window.addEventListener('pointercancel', off);
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

    // Звук разрешается только после жеста пользователя: браузеры
    // блокируют AudioContext, пока пользователь не коснулся страницы,
    // и без этого первый-же звук просто не прозвучит.
    //
    // Слушатель ставится один раз и снимается после первого срабатывания:
    // `once` надёжнее ручной отписки — забыть снять невозможно.
    const unlockSound = () => Sound.unlock();
    window.addEventListener('pointerdown', unlockSound, { once: true });
    window.addEventListener('keydown', unlockSound, { once: true });

    // --- поворот экрана ----------------------------------------------------

    /**
     * Заслонка «поверните устройство» и попытка повернуть сам экран.
     *
     * Поле квадратное, а портретный телефон — узкий. В портрете от
     * поля остаётся полоса в середине экрана, герои сливаются в
     * пятна, а джойстик с кнопками отнимают высоту, которой и так
     * в обрез. Играть приходится, отвернувшись от экрана.
     *
     * Силовой поворот просить нельзя: `screen.orientation.lock`
     * браузеры дают только из полноэкранного режима и только после
     * жеста пользователя. Поэтому тут два независимых способа:
     *
     *   1. попытка захвата — если сработала, экран повернётся сам;
     *   2. заслонка — если не сработала, игра прямо говорит, что
     *      надо повернуть устройство руками.
     *
     * Заслонка показывается только в партии и только на узком экране:
     * на компьютере её прятать незачем, а в чате и на форме входа
     * поворот не нужен вовсе.
     */
    const rotateEl = document.getElementById('rotate');
    const gameScreen = document.getElementById('gameScreen');

    /**
     * Экран размером с ладонь — телефон или планшет, а не окно
     * браузера на компьютере.
     *
     * Порог 1200, а не 700: планшет в портрете даёт 820 на 1180, а
     * крупный — 1024 на 1366, и при семисотниках оба считались бы
     * «широкими», то есть ровно на устройствах, которые просили
     * повернуть, заслонка бы не появилась.
     *
     * Второе условие — палец, и оно главное. Без него узкое окно на
     * компьютере сочлось бы телефоном, а это не то: окно можно
     * расширить, и человек не обязан его крутить. С пальцем порог
     * нужен только чтобы не ловить огромный монитор с сенсором.
     */
    function narrow() {
        if (Math.min(window.innerWidth, window.innerHeight) >= 1200) return false;
        return window.matchMedia('(pointer: coarse)').matches
            || navigator.maxTouchPoints > 0;
    }

    /**
     * Портрет ли **видимая область**.
     *
     * Именно окна, а не `screen.orientation`: ориентация экрана на
     * компьютере всегда «альбомная», и на узком окне планшета в
     * многооконном режиме она может говорить не то, что видит игрок.
     * Игроку важно, taller или шире то, что он видит, — про это и
     * спрашивает окно.
     *
     * Экранная ориентация остаётся запасным вариантом на случай, когда
     * размеры окна недоступны (в некоторых встроенных вьюерах бывает 0).
     */
    function portrait() {
        if (window.innerWidth > 0 && window.innerHeight > 0) {
            return window.innerHeight > window.innerWidth;
        }
        if (screen.orientation && typeof screen.orientation.type === 'string') {
            return screen.orientation.type.startsWith('portrait');
        }
        return false;
    }

    /** Показывать ли заслонку: только узкий экран и только портрет. */
    function shouldRotate(isNarrow, isPortrait) {
        return isNarrow && isPortrait;
    }

    function updateRotateGate() {
        const on = shouldRotate(narrow(), portrait());
        rotateEl.classList.toggle('on', on);
        // Пока портрет, поле не рисуется: незачем тратить кадр на
        // картинку, которую всё равно не видно под заслонкой.
        //
        // Холст берём здесь, а не из переменной `canvas`: объявлена
        // она ниже, и обращение отсюда было бы обращением к переменной
        // в мёртвой зоне — исключение, а не undefined.
        const field = document.getElementById('field');
        if (field) field.style.visibility = on ? 'hidden' : '';
    }

    // Уже пробовали захватить ориентацию в этой сессии? Повторные
    // попытки без жеста пользователя только сыпят отказами.
    let lockTried = false;

    /** Один раз, по жесту: вход в полный экран и захват ориентации. */
    function tryLockLandscape() {
        if (lockTried) return;
        lockTried = true;

        const target = screen.orientation;
        if (!target || typeof target.lock !== 'function') return;

        // Полный экран — обязательное условие: без него lock отклоняется
        // почти всегда. Запрос полного экрана тоже требует жеста,
        // поэтому он и делается прямо здесь, из обработчика нажатия.
        const go = () => {
            Promise.resolve(target.lock('landscape')).catch(() => {
                // Не вышло — ничего страшного, покажет заслонка.
            });
        };

        if (document.fullscreenElement) {
            go();
            return;
        }

        const el = document.documentElement;
        if (el.requestFullscreen) {
            Promise.resolve(el.requestFullscreen()).then(go).catch(go);
        } else {
            go();
        }
    }

    window.addEventListener('resize', updateRotateGate);
    window.addEventListener('orientationchange', updateRotateGate);
    if (screen.orientation) {
        screen.orientation.addEventListener('change', updateRotateGate);
    }
    // Заслонка поверх поля: нажатие на неё и есть тот самый жест.
    rotateEl.addEventListener('pointerdown', tryLockLandscape);
    updateRotateGate();

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

    // Ввод читается здесь, а не в кадре отрисовки.
//
// Раньше readInput() вызывался из функции frame(), которую крутит
// requestAnimationFrame. А rAF **не идёт в фоновой вкладке** —
// браузер её душит, чтобы не жечь батарею. В итоге игрок, свернувший
// вкладку или ушедший в другое приложение, переставал двигаться вовсе:
// партия на сервере шла, а тело стояло и подставлялось под удар.
//
// Ввод не зависит от частоты экрана, поэтому читать его надо там же,
// где отправляют, — на фиксированных 30 Гц. Тогда фоновый режим
// отличается от обычного только картинкой, но не управлением.
setInterval(() => {
        if (!active || finished || !connected) return;
        readInput();
        socket.emit('arena:input', input);
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

        // Заслонка поворота. Без неё нечем проверить решение «показывать
        // или нет»: окно у разработчика широкое, а телефон узкий.
        rotate: {
            get narrow() { return narrow(); },
            get portrait() { return portrait(); },
            get shown() { return rotateEl.classList.contains('on'); },
            refresh: updateRotateGate,
            lockLandscape: tryLockLandscape,
            shouldRotate,
        },
    };

    // --- петля кадров -----------------------------------------------------

    function frame(now) {
        while (effects.length && now - effects[0].at > Render.PUSH_FX_MS * 2) {
            effects.shift();
        }

        if (document.getElementById('gameScreen').classList.contains('on')) {
            const snap = sample(now) || (active ? IDLE : null);
            if (snap) {
                // Сколько экрана занимает поле по вертикали.
//
// Раньше здесь стояло `touchMode ? 176 : 44` — то есть на телефоне
                // всегда резервировалось 176 точек снизу под джойстик с
                // кнопками. В альбомной ориентации это неверно: джойстик
                // уходит влево, кнопки вправо, снизу ничего нет, и поле
                // рисуется квадратом по остатку высоты.
                //
                // А остаток на телефоне в альбомной ориентации крошечный:
                // высоты примерно 350 точек, из них 44 сверху и 176 снизу
                // оставалось 130 — поле сжималось до сотни точек посреди
                // широкого экрана, и игра выглядела сломанной.
                //
                // В альбомной ориентации резерв снизу — тонкая полоска:
                // поле квадратное и встаёт по центру, а джойстик с
                // кнопками занимают бока и в высоту не лезут.
                // Поле идёт **от верхнего края до нижнего**, без полей.
                //
                // Раньше сверху резервировалось 44 точки под строку
                // состояния, а внизу ещё 10, и в портрете 176 под
                // джойстик с кнопками. На телефоне в альбомной
                // ориентации высоты всего около 285 точек, и отступы
                // съедали пятую часть экрана: поле упиралось в 160
                // точек высотой при доступных 227.
                //
                // В альбомной ориентации отступы не нужны вовсе:
                // джойстик уходит влево, кнопки вправо, сверху и снизу
                // ничего нет. Строка состояния лежит поверх холста в
                // углах и поле не закрывает.
                //
                // В портрете резерв снизу остаётся: там джойстик с
                // кнопками правда внизу, и без резерва они наезжали бы
                // на поле.
                const bottom = touchMode && portrait() ? 176 : 0;
                const view = Render.fit(viewW, viewH, snap.size, { top: 0, bottom });
                Render.draw(ctx, snap, view, {
                    labels: true,
                    pulse: (now / 1000) % 1,
                    spin: now / 1000,
                    me: you,
                    effects,
                    chains,
                    bursts,
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
            chains.length = 0;
            bursts.length = 0;
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
                        bounce: e.bounce || null,
                        at: performance.now(),
                    });

                    // Звук удара различается тремя случаями: попал,
                    // влетел в камень, промахнулся. Раньше звука не
                    // было вовсе, и все три были одинаково безразличны
                    // — а это три совершенно разных исхода.
                    if (e.bounce) Sound.sfx.bounce();
                    else if (e.hits && e.hits.length) Sound.sfx.hit();
                    else Sound.sfx.whiff();
                    continue;
                }

                // Цепочка доиграла — показываем счёт толкавшему и
                // поднимаем тон на две ступени за звено.
                if (e.type === 'chain') {
                    const mine = e.by === you;
                    chains.push({
                        by: e.by,
                        last: e.last,
                        count: e.count,
                        power: e.power,
                        mine,
                        at: performance.now(),
                    });
                    while (chains.length && performance.now() - chains[0].at > 2000) {
                        chains.shift();
                    }
                    if (mine) Sound.sfx.chain(e.count);
                    continue;
                }

                if (e.type === 'burst') {
                    bursts.push({
                        x: e.x,
                        y: e.y,
                        radius: e.radius,
                        at: performance.now(),
                    });
                    while (bursts.length && performance.now() - bursts[0].at > 900) {
                        bursts.shift();
                    }
                    // Взрыв слышен всем: он и есть половина смысла
                    // камня, и пропускать его глухо нельзя.
                    Sound.sfx.burst();
                    continue;
                }

                if (e.type === 'swing') {
                    Sound.sfx.swing();
                    continue;
                }

                if (e.type !== 'eliminated') continue;
                feed.push({ id: e.id, by: e.by });
                while (feed.length > 6) feed.shift();
                Sound.sfx.out();
            }

            if (snap.finished) finished = true;
        },

        setScore(value) {
            score = value || null;
        },
    };
})();
