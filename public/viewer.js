'use strict';

/**
 * Просмотрщик ботов: ни сети, ни игрока — только ядро симуляции,
 * боты и рисовальщик из render.js. Зачем он нужен, кроме «посмотреть,
 * как игра выглядит»: показать поведение ботов на глазах до того, как
 * появится сервер, и иметь под рукой быструю проверку после любой
 * правки баланса.
 *
 * Петля сделана такой же, какой будет на сервере: фиксированный тик
 * 30 Гц, накопленное время, ввод собирается до шага. Разница только в
 * том, что снимок не отправляется никуда, а рисуется сразу.
 */

(function () {
    const { require: req } = window.ArenaBundle;
    const { createArena, addPlayer, spawnPoint, step, snapshot, T } = req('game/arena');
    const { botInput } = req('game/bot');
    const Render = req('public/render');

    const canvas = document.getElementById('field');
    const ctx = canvas.getContext('2d');
    const line1 = document.getElementById('line1');
    const line2 = document.getElementById('line2');
    const feedList = document.getElementById('feedList');
    const pauseBtn = document.getElementById('pauseBtn');
    const restartBtn = document.getElementById('restartBtn');
    const marginCheck = document.getElementById('marginCheck');

    const state = {
        count: 5,
        speed: 1,
        paused: false,
        showMargin: false,
        arena: null,
        feed: [],
        colors: Object.create(null),
        effects: [],
        chains: [],
        bursts: [],
        finishAt: 0,
    };

    function start() {
        const arena = createArena({ size: T.FIELD_SIZE });
        for (let i = 0; i < state.count; i++) {
            const pt = spawnPoint(i, state.count, arena.size);
            addPlayer(arena, 'p' + (i + 1), { x: pt.x, y: pt.y, bot: true });
        }

        state.arena = arena;
        state.feed = [];
        state.finishAt = 0;
        state.colors = Object.create(null);
        state.effects = [];
        state.chains = [];
        state.bursts = [];
        arena.players.forEach((p, i) => {
            state.colors[p.id] = Render.colorOf(i);
        });

        renderFeed();
        syncButtons();
    }

    /** Один тик: ввод → шаг → события. Ровно то, что делает сервер. */
    function tickOnce() {
        const arena = state.arena;
        const inputs = Object.create(null);

        for (const p of arena.players) {
            if (p.alive) inputs[p.id] = botInput(p, arena);
        }

        const events = step(arena, inputs);
        if (!events.length) return;

        let changed = false;
        for (const ev of events) {
            if (ev.type === 'push') {
                state.effects.push({
                    by: ev.by,
                    dirx: ev.dirx,
                    diry: ev.diry,
                    hits: ev.hits || [],
                    at: performance.now(),
                });
            }

            // Цепочка и взрыв показываются всем зрителям: в зрительской
            // партии нет «моего» игрока, и счёт цепочки на экране —
            // единственное, по чему видно, кто кого перетолкнул.
            if (ev.type === 'chain') {
                state.chains.push({
                    by: ev.by,
                    last: ev.last,
                    count: ev.count,
                    power: ev.power,
                    mine: true,
                    at: performance.now(),
                });
            }
            if (ev.type === 'burst') {
                state.bursts.push({
                    x: ev.x,
                    y: ev.y,
                    radius: ev.radius,
                    at: performance.now(),
                });
            }

            if (ev.type === 'eliminated') {
                state.feed.unshift({ id: ev.id, by: ev.by, place: ev.place });
                changed = true;
            }
            if (ev.type === 'finished') {
                state.finishAt = performance.now() + 5000;
            }
        }
        if (state.feed.length > 7) state.feed.length = 7;
        if (changed) renderFeed();
    }

    function renderFeed() {
        feedList.innerHTML = state.feed.map(f => {
            const color = state.colors[f.id] || '#7a8699';
            const what = f.by
                ? `вылетел от <b>${f.by}</b>`
                : 'вылетел сам';
            return '<li>'
                + `<span class="dot" style="background:${color}"></span>`
                + `<span class="txt"><b>${f.id}</b> ${what}</span>`
                + `<span class="place">${f.place} место</span>`
                + '</li>';
        }).join('');
    }

    let acc = 0;
    let last = performance.now();

    function frame(now) {
        const dt = Math.min(0.25, (now - last) / 1000);
        last = now;

        if (!state.paused) {
            acc += dt * state.speed;

            // Ограничиваем число тиков за кадр: при 4× и долгом
            // переключении вкладки иначе петля провалится в лаг.
            let guard = 0;
            while (acc >= T.TICK && guard++ < 60) {
                acc -= T.TICK;
                tickOnce();
                if (state.arena.finished) break;
            }

            if (state.arena.finished && state.finishAt && now >= state.finishAt) {
                start();
            }
        } else {
            acc = 0;
        }

        render(now);
        requestAnimationFrame(frame);
    }

    let lastLine1 = '';
    let lastLine2 = '';

    function render(now) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const pw = Math.round(w * dpr);
        const ph = Math.round(h * dpr);
        if (canvas.width !== pw || canvas.height !== ph) {
            canvas.width = pw;
            canvas.height = ph;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const snap = snapshot(state.arena);
        const view = Render.fit(w, h, snap.size, { top: 74, bottom: 96 });

        while (state.effects.length && now - state.effects[0].at > Render.PUSH_FX_MS * 2) {
            state.effects.shift();
        }
        while (state.chains.length && now - state.chains[0].at > 2000) {
            state.chains.shift();
        }
        while (state.bursts.length && now - state.bursts[0].at > 900) {
            state.bursts.shift();
        }

        Render.draw(ctx, snap, view, {
            labels: true,
            margin: state.showMargin,
            pulse: now / 1000,
            spin: now / 1000,
            effects: state.effects,
            chains: state.chains,
            bursts: state.bursts,
        });

        const alive = snap.players.filter(p => p.alive).length;
        const l1 = `Ботов <b>${snap.players.length}</b>`
            + ` · живых <b>${alive}</b>`
            + ` · тик <b>${snap.tick}</b>`;
        const l2 = snap.finished
            ? `Победил <b>${snap.winner || 'никто'}</b>`
            : `прошло <b>${(snap.tick * T.TICK).toFixed(1)} с</b>`;

        if (l1 !== lastLine1) { line1.innerHTML = l1; lastLine1 = l1; }
        if (l2 !== lastLine2) { line2.innerHTML = l2; lastLine2 = l2; }
    }

    // ---- Управление -------------------------------------------------

    const countBtns = document.getElementById('countBtns');
    for (let n = 2; n <= 8; n++) {
        const b = document.createElement('button');
        b.textContent = String(n);
        b.dataset.count = n;
        b.onclick = () => {
            state.count = n;
            start();
        };
        countBtns.appendChild(b);
    }

    const speedBtns = document.getElementById('speedBtns');
    for (const s of [1, 2, 4]) {
        const b = document.createElement('button');
        b.textContent = `${s}×`;
        b.dataset.speed = s;
        b.onclick = () => {
            state.speed = s;
            syncButtons();
        };
        speedBtns.appendChild(b);
    }

    function syncButtons() {
        countBtns.querySelectorAll('button').forEach(b => {
            b.classList.toggle('on', Number(b.dataset.count) === state.count);
        });
        speedBtns.querySelectorAll('button').forEach(b => {
            b.classList.toggle('on', Number(b.dataset.speed) === state.speed);
        });
        pauseBtn.textContent = state.paused ? 'Пуск' : 'Пауза';
        pauseBtn.classList.toggle('on', state.paused);
    }

    pauseBtn.onclick = () => {
        state.paused = !state.paused;
        syncButtons();
    };
    restartBtn.onclick = start;
    marginCheck.onchange = () => {
        state.showMargin = marginCheck.checked;
    };

    window.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        if (e.code === 'Space') {
            e.preventDefault();
            state.paused = !state.paused;
            syncButtons();
        }
        if (e.code === 'KeyR') start();
    });

    start();
    requestAnimationFrame(frame);
})();
