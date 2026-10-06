'use strict';

/**
 * Партия: клавиатура и виртуальный джойстик сюда, картинка —
 * из общего render.js, ядро не тянется в браузер вовсе.
 *
 * Экраны и сокет живут в app.js: оттуда сюда приходят три события —
 * «начали», «снимок», «очки», — а обратно уходят два действия,
 * «играть ещё» и «в чат». Здесь только поле и то, что на нём.
 *
 * Ключевое здесь — отставание. Снимки приходят 60 раз в секунду,
 * кадры рисуются под частоту экрана, и чтобы картинка не дёргалась,
 * рисуется не последний снимок, а тот, что был frameDelay мс назад, с
 * позициями, интерполированными между двумя соседними снимками.
 *
 * Отставание не фиксированное, а считается по разрывам в потоке:
 * на ровной сети оно меньше, на сети с разрывами — подстраивается.
 * Из-за отставания клиент опаздывает на пару кадров — это и называется
 * «считает сервер, клиент рисует с отставанием».
 */

(function () {
    const { require: req } = window.ArenaBundle;
    const { T } = req('game/arena');
    const Render = req('public/render');
    const Sound = req('public/sound');

    const App = window.App;
    const socket = App.socket;
    const esc = App.esc;

    const DELAY_MIN = 100;      // мс отставания на ровной сети
    const DELAY_MAX = 300;      // больше не отстаём никогда
    const MAX_FRAMES = 26;      // сколько снимков держим в буфере

    /**
     * Отставание картинки подстраивается под сеть.
     *
     * Буфер нужен, чтобы разрывы в потоке не превращались в заморозку:
     * когда свежего снимка нет дольше отставания, `sample` возвращает
     * последний кадр и он рисуется дважды подряд — это и есть
     * подлагивание. Замер на проде: при отставании 120 мс заморозки не
     * было ни разу за 481 кадр, но максимальный разрыв между снимками
     * доходил до 100 мс. То есть запас был 20 мс — на ровной сети
     * хватает, на мобильной впритык.
     *
     * Фиксированное число здесь означало бы одно из двух: либо задержка
     * ввода на ровной сети (запас нужен на всякий случай), либо
     * заморозки на плохой. Отставание считается от фактических разрывов:
     * сеть ровная — отстаём меньше всех, сеть рвётся — отстаём ровно
     * настолько, сколько нужно, и не больше.
     */
    let frameDelay = 120;
    const gapWindow = [];

    /** Пересчитать отставание по последним разрывам между снимками. */
    function retuneDelay(gap) {
        if (gap <= 0 || gap > 1000) return;

        gapWindow.push(gap);
        if (gapWindow.length > 40) gapWindow.shift();

        // Пока окно не набралось, полную картину ещё не видно: первые
        // разрывы после старта партии включают разгон соединения и в
        // расчёт не годятся.
        if (gapWindow.length < 12) return;

        const worst = Math.max.apply(null, gapWindow);

        // Отставание считается от **худшего** разрыва в окне, а не от
        // девятого перцентиля. Перцентиль тут не годится: замер на
        // сети с разрывами показал, что всплески составляют около 6%
        // разрывов и в p90 просто не попадают — отставание вставало в
        // 100 мс при разрывах до 100 мс, то есть с запасом в 1 мс, и
        // заморозка всё равно случалась бы.
        //
        // Заморозка происходит именно на худшем разрыве, значит и
        // буфер надо sized по нему. Окно живёт около 0.7 с, так что
        // один всплеск раздувает отставание ненадолго.
        const want = worst * 1.5 + 40;
        frameDelay = Math.round(Math.max(DELAY_MIN, Math.min(DELAY_MAX, want)));
    }

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

                // Нос сглаживается **тоже**. Раньше здесь стояли только
                // x, y, vx, vy, а dirx/diry брались из последнего снимка
                // как есть. Последствие: тело двигалось плавно, на
                // частоте экрана, а нос прыгал кусками по 30 Гц — при
                // 5.5 рад/с это 10.5° за шаг. На 60-герцевом экране
                // герой ехал плавно, а нос дёргался, и это читалось
                // ровно как «задержка между поворотами», хотя задержки
                // в коде не было нигде.
                //
                // Сглаживается именно вектор, а не угол: так не нужно
                // отдельно распутывать переход через ±180°, где угол
                // прыгает с +179 на −179, а вектор идёт коротким путём.
                let dx = prev.dirx + (p.dirx - prev.dirx) * k;
                let dy = prev.diry + (p.diry - prev.diry) * k;
                const len = Math.hypot(dx, dy);
                if (len < 0.1) {
                    // Взгляда ещё нет (только что появился) — берём
                    // готовый, иначе на один кадр покажется ложный нос.
                    dx = p.dirx;
                    dy = p.diry;
                } else {
                    dx /= len;
                    dy /= len;
                }

                return {
                    ...p,
                    x: prev.x + (p.x - prev.x) * k,
                    y: prev.y + (p.y - prev.y) * k,
                    vx: prev.vx + (p.vx - prev.vx) * k,
                    vy: prev.vy + (p.vy - prev.vy) * k,
                    dirx: dx,
                    diry: dy,
                };
            }),
        };
    }

    function sample(now) {
        if (frames.length === 0) return null;

        const t = now - frameDelay;
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

    /**
     * Что отправляли в прошлый раз и когда.
     *
     * Нужны для отправки по изменению: пока подпись ввода не сменилась,
     * сообщение вверх не уходит. Отдельно хранится время, чтобы раз в
     * полсекунды всё равно переслать состояние — потерянный пакет тогда
     * восстанавливается сам.
     */
    let lastInputSig = null;
    let lastInputSentAt = 0;

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
     * Джойстик задан долей экрана (`50vh`), и ход обязан расти вместе
     * с ним: константа от размера не зависила бы, и на большом кружке
     * ручка ходила бы по его середине, не доставая до края.
     */
    function stickRadius(box) {
        // Ход — 35% радиуса, ручка — 30% кружка, то есть её радиус
        // 0.15. 0.35 + 0.15 = ровно 0.5: при полном отклонении ручка
        // упирается в край кружка и не вылезает наружу.
        //
        // Раньше ручка была 54% кружка при том же ходе, то есть
        // 0.35 + 0.27 = 0.62, и она вылезала за край на треть
        // диаметра. Это и было причиной, почему джойстиком управлять
        // было неудобно, а не сам размер кружка.
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
        stickHome();
    }

    // --- кружок догоняет палец -------------------------------------------

    // Домашняя позиция кружка в покое. Меряется со сброшенным
    // transform: `getBoundingClientRect` возвращает уже **сдвинутый**
    // прямоугольник, и после первого же переезда домой вернуться было бы
    // уже некуда.
    let homeCX = 0;
    let homeCY = 0;

    function measureHome() {
        stickEl.style.transform = '';
        const r = stickEl.getBoundingClientRect();
        homeCX = r.left + r.width / 2;
        homeCY = r.top + r.height / 2;
    }

    function stickHome() {
        stickEl.style.transform = '';
    }

    /**
     * Кружок переезжает под палец.
     *
     * Фиксированный кружок в углу удобен, пока палец ложится на него
     * сам. Но большой палец на телефоне в нижний левый угол не попадает
     * без усилия — приходится тянуться и при этом не смотреть, куда,
     * а в партии смотреть надо на поле. Поэтому кружок **догоняет палец**
     * в левой части экрана и возвращается на место при отпускании.
     *
     * Двигается он через `transform`, а не `left/top`: кружок — элемент
     * потока flex, и `position: absolute` выкинул бы его из вёрстки, а
     * кнопки уехали бы влево. `transform` двигает картинку, не трогая
     * раскладку.
     */
    function stickFollow(e) {
        stickEl.style.transform =
            'translate(' + (e.clientX - homeCX) + 'px, ' + (e.clientY - homeCY) + 'px)';
    }

    // Доля экрана слева, где кружок готов уехать под палец. Правее неё
    // стоят кнопки скиллов, и кружок под ними встал бы прямо на толчок.
    const GRAB_SIDE = 0.45;

    function maybeGrabStick(e) {
        if (stick.id != null) return;
        if (e.clientX > window.innerWidth * GRAB_SIDE) return;
        // Кнопка скилла важнее джойстика: под неё переезжать нельзя.
        if (e.target && e.target.closest && e.target.closest('#buttons')) return;

        e.preventDefault();
        stickFollow(e);
        try { stickEl.setPointerCapture(e.pointerId); } catch (_) { /* best effort */ }
        stick.id = e.pointerId;
        stickMove(e);
    }

    // Имя **обязательно** не `screen`: глобальный `screen` — это объект
    // Screen с `orientation`, и он нужен захвату ориентации. Своё
    // `const screen` затенило бы его на весь модуль, и `lockSupported()`
    // стал бы брать `orientation` у div-элемента, получать `undefined`
    // и молча уходить в 'unsupported' — то есть полный экран и поворот
    // переставали бы работать вообще, без всякой ошибки.
    const stickHost = document.getElementById('gameScreen');
    if (stickHost) stickHost.addEventListener('pointerdown', maybeGrabStick);

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

    // Домашняя позиция меряется после того, как браузер посчитал вёрстку,
    // и пересчитывается на каждом изменении размера окна: джойстик задан
    // долями экрана, и при повороте он меняет размер.
    measureHome();
    window.addEventListener('resize', () => {
        if (stick.id == null) measureHome();
    });

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

    /**
     * Свои скиллы: что открыто, что усилено, что закрыто.
     *
     * Без этой полосы вопрос «какие скиллы у меня» не на что ответить:
     * приглушённая кнопка одинаково выглядит и для закрытого скилла, и
     * для открытого, который сейчас на откате.
     */
    function applySkillLocks() {
        const me = findMe(lastSnap);
        const grade = me ? (me.grade || 0) : 0;

        const jump = document.getElementById('btnJump');
        const stone = document.getElementById('btnStone');
        if (jump) jump.classList.toggle('locked', grade < T.GRADE_JUMP);
        if (stone) stone.classList.toggle('locked', grade < T.GRADE_STONE);

        const rows = [
            { name: 'ТОЛЧОК', on: true, up: grade >= T.GRADE_PUSH_POWER },
            { name: 'ПРЫЖОК', on: grade >= T.GRADE_JUMP, up: grade >= T.GRADE_JUMP_COOLDOWN },
            { name: 'КАМЕНЬ', on: grade >= T.GRADE_STONE, up: grade >= T.GRADE_STONE_POWER },
        ];

        let html = '';
        for (const r of rows) {
            const cls = r.up ? 'up' : (r.on ? 'on' : '');
            const mark = r.up ? '★' : (r.on ? '✓' : '·');
            html += `<span class="${cls}">${mark} ${r.name}</span>`;
        }
        set('kit', kitEl, html, true);
    }

    /**
     * Таблица игроков: ступени, вылеты, место.
     *
     * Показывается **живьём**, а не только по итогам: кому сколько фрагов
     * и кто уже выбыл видно прямо во время боя, и это влияет на решения
     * — на поле осталось трое, и третий сейчас мой.
     *
     * Сортировка: живые выше выбывших, внутри — по ступеням и вылетам.
     */
    function boardHtml() {
        if (!lastSnap || !lastSnap.players) return '';
        const rows = lastSnap.players.slice().sort((a, b) => {
            if (a.alive !== b.alive) return a.alive ? -1 : 1;
            const g = (b.grade || 0) - (a.grade || 0);
            if (g) return g;
            return (b.kills || 0) - (a.kills || 0);
        });

        let html = '';
        for (const p of rows) {
            // Поле называется `kills` — снимок шлёт именно его. Раньше здесь было
            // `eliminatedByCount`, поля с таким именем в снимке нет вообще,
            // и столбец вылетов молча показывал ноль у всех, включая
            // того, кто кого-то выбил.
            const kills = p.kills || 0;
            const place = p.alive ? '—' : (p.place || '—');
            const cls = (p.id === you ? 'me' : '') + (p.alive ? '' : ' dead');
            html += `<div class="bdRow ${cls}">`
                + `<span class="bdNm">${p.alive ? '' : '✝ '}${esc(p.id)}</span>`
                + `<span class="bdFr">★${p.grade || 0}</span>`
                + `<span class="bdKl">${kills}</span>`
                + `<span class="bdPl">${place}</span>`
                + '</div>';
        }
        return html;
    }

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

        // Подпись под заголовком меняется по platforms: где захват
        // невозможен в принципе (iOS), обещать «повернём сами» было бы
        // враньём, и человек всё равно ждал бы, что экран повернётся.
        const note = rotateEl.querySelector('.rotateNote');
        if (note) {
            note.textContent = lockSupported()
                ? 'Играть удобнее боком'
                : 'Браузер не даёт повернуть сам — поверните устройство';
        }

        // Пока портрет, поле не рисуется: незачем тратить кадр на
        // картинку, которую всё равно не видно под заслонкой.
        //
        // Холст берём здесь, а не из переменной `canvas`: объявлена
        // она ниже, и обращение отсюда было бы обращением к переменной
        // в мёртвой зоне — исключение, а не undefined.
        const field = document.getElementById('field');
        if (field) field.style.visibility = on ? 'hidden' : '';
    }

    // Итог последней попытки: 'locked' | 'failed' | 'unsupported'.
    let lockResult = null;

    // Попытка уже идёт. Это защита от **гонки**, а не от повторов:
    // раньше здесь стоял постоянный `lockTried`, который запрещал
    // захват навсегда после первой попытки — и кнопка «на весь экран»
    // становилась мёртвой: она звала тот же `tryLockLandscape`, тот
    // видел флаг и молча выходил. Второй тап по заслонке не помогал по
    // той же причине.
    //
    // Повторять попытку надо: первый вызов отклоняется, если страница
    // была в фоне, жест не успел или устройство не дало, — а второй
    // тап уже идёт из чистого состояния и проходит.
    let lockBusy = false;
    let lockTimer = null;

    // Сколько ждать ответа браузера, прежде чем признать попытку
    // неудавшейся. Запас большой: полный экран на телефоне открывается
    // с заметной задержкой, и торопить тут нельзя — важно лишь
    // перестать ждать насовсем.
    const T_LOCK_TIMEOUT = 2500;

    /**
     * Браузер вообще умеет захват ориентации?
     *
     * На iOS и в iPadOS — **нет**: Safari не отдаёт `screen.orientation`
     * для страниц вовсе, и `lock()` там отсутствует как класс
     * функции. Никакой код это не обойдёт: единственный способ — самому
     * пользователю повернуть устройство. Поэтому дальше заслонка
     * говорит ровно об этом, а не обещает того, что не случится.
     */
    function lockSupported() {
        const target = typeof screen !== 'undefined' ? screen.orientation : null;
        return !!target && typeof target.lock === 'function';
    }

    /**
     * Захват альбомной ориентации. Возвращает обещание с итогом.
     *
     * Обязательно **синхронно из обработчика нажатия**: и полный
     * экран, и lock требуют жеста пользователя, и через await или
     * ответ сервера жест уже истёк — попытка молча провалится.
     *
     * Повторять можно: зовётся с кнопки «Играть», с кнопки «на весь
     * экран» и с заслонки, и все три вызова — настоящие жесты.
     */
    function tryLockLandscape() {
        if (lockBusy) return Promise.resolve(lockResult);
        lockBusy = true;

        // Страховка от залипания. `requestFullscreen` и `lock` обязаны
        // либо resolve, либо reject, но если промис всё-таки не
        // разрешится (браузер ждёт жест, которого не будет, или
        // страница уснула), `done()` не вызовется — и без этого
        // таймера `lockBusy` останется true навсегда. Залипший флаг
        // убивает полный экран так же надёжно, как убивал прежний
        // постоянный `lockTried`: кнопка перестаёт работать, и
        // разбудить её уже нечем.
        clearTimeout(lockTimer);
        lockTimer = setTimeout(() => {
            if (!lockBusy) return;
            lockBusy = false;
            lockResult = 'failed';
            updateFsBtn();
        }, T_LOCK_TIMEOUT);

        const done = (result) => {
            clearTimeout(lockTimer);
            lockResult = result;
            lockBusy = false;
            updateFsBtn();
            return result;
        };

        if (!lockSupported()) return Promise.resolve(done('unsupported'));

        const target = screen.orientation;

        // Полный экран — обязательное условие: без него lock
        // отклоняется почти всегда.
        const go = () => Promise.resolve(target.lock('landscape'))
            .then(() => done('locked'))
            .catch(() => done('failed'));

        if (inFullscreen()) return go();

        const el = document.documentElement;
        const req = el.requestFullscreen
            || el.webkitRequestFullscreen
            || el.msRequestFullscreen;
        if (req) {
            return Promise.resolve(req.call(el))
                .then(go)
                // Полный экран могли запретить — тогда хотя бы пробуем
                // lock как есть.
                .catch(go);
        }
        return go();
    }

    /**
     * Полноэкранный режим вообще доступен?
     *
     * **Не на iPhone.** Safari на айфоне разрешает полный экран только
     * видео, обычной странице — никогда, и ни `requestFullscreen`, ни
     * `webkitRequestFullscreen` там не помогают. На iPad работает. Проверка
     * по наличию метода, а не по имени устройства: так она честнее и не
     * обманывает на новых версиях iOS.
     */
    function fullscreenSupported() {
        const el = document.documentElement;
        return !!(el.requestFullscreen || el.webkitRequestFullscreen
            || el.msRequestFullscreen);
    }

    window.addEventListener('resize', updateRotateGate);
    window.addEventListener('orientationchange', updateRotateGate);
    if (screen.orientation) {
        screen.orientation.addEventListener('change', updateRotateGate);
    }
    // Заслонка поверх поля: нажатие на неё — запасной путь, если
    // захват на кнопке «Играть» не прошёл.
    rotateEl.addEventListener('pointerdown', tryLockLandscape);

    /**
     * Кнопка «на весь экран».
     *
     * Показывается только там, где полный экран возможен и ещё не
     * включён. Повторная попытка нужна потому, что браузер иногда
     * отклоняет первый вызов: жест успел истёть, страница была в
     * фоне или Safari просто не дал. На iPhone кнопки нет вовсе —
     * там она была бы обещанием, которое не выполняется.
     */
    const fsBtn = document.getElementById('fsBtn');

    function inFullscreen() {
        return !!(document.fullscreenElement
            || document.webkitFullscreenElement
            || document.msFullscreenElement);
    }

    function updateFsBtn() {
        if (!fsBtn) return;
        fsBtn.classList.toggle('hidden',
            !active || inFullscreen() || !fullscreenSupported());
    }

    /**
     * Выйти из полного экрана.
     *
     * Без этого уход в чат оставляет человека в полноэкранном режиме
     * посреди списка онлайна: панели браузера нет, а игры уже нет —
     * выглядит как сломавшаяся страница. Вызывается по жесту, потому
     * что `exitFullscreen` без жеста не проходит.
     */
    function exitFullscreen() {
        const doc = document;
        const exit = doc.exitFullscreen
            || doc.webkitExitFullscreen
            || doc.msExitFullscreen;
        if (!exit) return;
        try { Promise.resolve(exit.call(doc)).catch(() => { /* не даёт */ }); }
        catch (_) { /* не даёт — не страшно */ }
    }

    if (fsBtn) fsBtn.addEventListener('click', tryLockLandscape);
    document.addEventListener('fullscreenchange', updateFsBtn);
    document.addEventListener('webkitfullscreenchange', updateFsBtn);

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
// где отправляют, — на фиксированной частоте. Тогда фоновый режим
// отличается от обычного только картинкой, но не управлением.
//
// Частота поднята с 30 до 60 Гц. Задержка ввода была устроена так:
// в худшем случае палец ждёт конца текущего интервала (33 мс),
// потом сервер ждёт своего тика (ещё 33 мс) — итого ход начинается
// не позже чем через 66 мс. На 60 Гц это 33 мс.
//
// Почему именно ввод, а не вся партия: снимок на восемь игроков
// весит 2028 байт, и на 60 Гц это 119 КБ/с на клиента против
// 59 КБ/с сейчас — для мобильного интернета дорого. Ввод же —
// несколько байт, и его удвоение незаметно. Физику трогать незачем:
// интерполяция на клиенте уже снимает видимые ступеньки.
//
// Всё это верно и после того, как отправку сделали условной: проверка
// по-прежнему идёт 60 раз в секунду, и задержку ввода задаёт именно она,
// а не сама отправка.
setInterval(() => {
        if (!active || finished || !connected) return;
        readInput();

        // Отправляем **только когда ввод изменился**.
        //
        // Раньше сообщение уходило шестьдесят раз в секунду безусловно, и
        // большая часть из них несла ровно то же, что и предыдущее:
        // игрок держит направление, ничего не нажимает — а сеть всё
        // равно получает 60 пакетов вверх в секунду.
        //
        // Это не размен скорости на аккуратность, а удаление пустой
        // работы: задержка ввода определяется частотой **проверки**, а не
        // отправки, и остаётся теми же 33 мс. Сервер помнит последний
        // ввод игрока всю партию (`match.inputs`), так что молчание
        // ничего не меняет.
        //
        // Зачем это при подлагиваниях: когда вверх и вниз идут рядом,
        // исходящие пакеты застревают и тянут за собой входящие — отсюда
        // вместе и задержка ввода, и дёрганье картинки. Урезав пустые
        // сообщения, мы убираем половину давления на канал вверх.
        const sig = `${input.x}|${input.y}|${input.push ? 1 : 0}`
            + `|${input.jump ? 1 : 0}|${input.stone ? 1 : 0}`;
        const now = performance.now();

        // Пересплав раз в полсекунды: если пакет всё же потерялся или
        // сервер по какой-то причине забыл ввод, состояние само
        // восстановится, а не останется неверным до конца партии.
        if (sig !== lastInputSig || now - lastInputSentAt > 500) {
            lastInputSig = sig;
            lastInputSentAt = now;
            socket.emit('arena:input', input);
        }
    }, 1000 / 60);

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
    const kitEl = document.getElementById('kit');
    const boardEl = document.getElementById('board');
    const boardLiveEl = document.getElementById('boardLive');
    const hudMe = document.getElementById('hudMe');
    const hudStatus = document.getElementById('hudStatus');

    document.getElementById('againBtn').addEventListener('click', () => App.play());
    document.getElementById('chatBtn').addEventListener('click', () => {
        // Уход в чат — партия кончилась, и кнопка разворачивания на
        // весь экран тут же лишняя. Полный экран тоже отпускаем: в чате
        // он выглядит как сломавшаяся страница.
        active = false;
        updateFsBtn();
        exitFullscreen();
        App.toChat();
    });

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
    // Кнопки закрытых скиллов гаснут по ступени — и обновляются здесь
        // же, потому что это единственное место, которое уже вызывается
        // каждый кадр.
        applySkillLocks();

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

        // Таблица идёт **в две корзины**: на поле и в панель итогов.
        //
        // Одна не годится: панель во время партии скрыта, и таблица,
        // лежавшая только в ней, оказывалась невидимой ровно тогда, когда
        // она нужнее всего. На поле своя полоса, в панели своя копия,
        // обе — из одного boardHtml, чтобы числа не разошлись.
        const board = lastSnap && lastSnap.players ? boardHtml() : '';

        if (board && active && !finished) {
            boardLiveEl.classList.remove('hidden');
            set('boardLive', boardLiveEl, board, true);
        } else {
            boardLiveEl.classList.add('hidden');
        }

        if (board) {
            boardEl.classList.remove('hidden');
            set('board', boardEl, board, true);
        } else {
            boardEl.classList.add('hidden');
        }

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
            get supported() { return lockSupported(); },
            get result() { return lockResult; },
            get fullscreen() { return inFullscreen(); },
            get fullscreenSupported() { return fullscreenSupported(); },
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
        /**
         * Захват альбомной ориентации. Зовётся из app.js **синхронно**
         * из обработчика нажатия на «Играть»: и полный экран, и lock
         * требуют жеста, и после любого await он уже истёк.
         *
         * Без этого вызова экран поворачивался бы только после второго
         * тапа — по заслонке, — а на Android, где захват работает, он
         * и не нужен вовсе: одного нажатия на «Играть» достаточно.
         */
        lockLandscape: tryLockLandscape,

        /**
         * Замер сети: отставание и разрывы между снимками. `Game.net`.
         *
         * Открыто наружу специально. Отставание теперь считается по
         * разрывам, и чтобы проверить, что оно подстроилось, нужен
         * способ это увидеть. Без ручки пришлось бы судить по ощущениям,
         * а ощущения у сети и у игры одинаковые: «подлагивает».
         */
        get net() {
            const s = [...gapWindow].sort((a, b) => a - b);
            return {
                delay: frameDelay,
                gaps: s.length,
                median: s.length ? Math.round(s[Math.floor(s.length / 2)]) : null,
                p90: s.length ? Math.round(s[Math.floor(s.length * 0.9)]) : null,
                max: s.length ? Math.round(s[s.length - 1]) : null,
            };
        },

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
            // Подпись сбрасывается, иначе первое же нажатие в новой
            // партии сочлось бы тем же, что ушло в прошлой, и осталось бы
            // на сервере до первого пересплава.
            lastInputSig = null;
            lastInputSentAt = 0;
            // Окно разрывов тоже: с прошлой партии его нельзя тащить,
            // сеть могла быть другой.
            gapWindow.length = 0;
            frameDelay = 120;
            resetShown();
            updateFsBtn();
        },

        snapshot(snap) {
            if (!snap) return;
            const at = performance.now();

            // Разрыв между снимками — то, чем именно измеряется сеть.
            // Первый снимок партии разрывом не считается: до него
            // предыдущего нет, и получилась бы бесконечность.
            const prev = frames[frames.length - 1];
            if (prev) retuneDelay(at - prev.at);

            frames.push({ snap, at });
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

                    // Отдача — только за **свой** удар. Чужие удары в
                    // партии летят десятками, и вибрация на каждом
                    // превращалась бы в сплошной треск, который за
                    // свои попадания уже не слышно.
                    if (e.by === you) {
                        if (e.bounce) Sound.buzz(28);
                        else if (e.hits && e.hits.length) Sound.buzz(18);
                    }
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
                    if (mine) {
                        Sound.sfx.chain(e.count);
                        Sound.buzz(20 + e.count * 6);
                    }
                    continue;
                }

                if (e.type === 'burst') {
                    bursts.push({
                        x: e.x,
                        y: e.y,
                        radius: e.radius,
                        hits: e.hits || [],
                        at: performance.now(),
                    });
                    while (bursts.length && performance.now() - bursts[0].at > 900) {
                        bursts.shift();
                    }
                    // Взрыв слышен всем: он и есть половина смысла
                    // камня, и пропускать его глухо нельзя.
                    Sound.sfx.burst();
                    // Отдача — задело ли оно меня: если да, это самое
                    // важное событие партии, и почувствовать его надо
                    // спиной, а не только увидеть.
                    if (e.hits && e.hits.indexOf(you) >= 0) Sound.buzz(45);
                    continue;
                }

                // Звезда: поднятие даёт ступень. Событие приходит и за
                // подбором звезды, и за вылет — ядро шлёт одно и то же.
                if (e.type === 'star') {
                    if (e.by === you) {
                        Sound.sfx.star();
                        Sound.buzz(18);
                    }
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
                // Вынесли меня — самая длинная вибрация, какой есть.
                if (e.id === you) Sound.buzz([40, 60, 40]);
            }

            if (snap.finished) finished = true;
        },

        setScore(value) {
            score = value || null;
        },
    };
})();
