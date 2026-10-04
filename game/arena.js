/**
 * Ядро арены: симуляция без сети, без графики, без таймеров.
 *
 * Здесь считается всё, что имеет значение для игры: движение, скиллы,
 * выбытие за границу и конец партии. Сервер вызывает step() по своему
 * тику, тесты — просто зовут step() подряд, поэтому одно и то же ядро
 * работает и в партии, и в прогоне на тысячи партий.
 *
 * Четыре правила, ради которых написано всё остальное:
 *
 *   1. Поле — квадрат. Выбывает только тот, чей центр вышел за границу.
 *      Ровно на границе — ещё играет.
 *   2. Столкновение только разводит круги: сквозь игрока не пройти и
 *      его не занести на себя. Импульса и стана оно не даёт — ходьбой
 *      толкнуть нельзя.
 *   3. Толчок — скилл по кнопке с перезарядкой в 3 секунды. Он и есть
 *      единственный способ передать сопернику импульс и стан.
 *   4. Толкнутый коротко теряет управление. Без стана он останавливался
 *      бы на месте, и вытолкнуть его было бы нечем: импульс гасился бы
 *      собственным вводом на следующем же тике.
 *
 * Скиллов будет больше, поэтому они устроены однотипно: перезарядка
 * лежит в p.cooldowns по имени скилла, запрос — флаг в input, а
 * срабатывание — отдельная функция в step(). Новый скилл добавляется
 * тремя строчками и не трогает остальные.
 */

'use strict';

/** Все числа здесь — параметры баланса, а не аксиомы. Меняются в одном месте. */
const T = {
    // Поле: квадрат со стороной FIELD_SIZE, центр в (0, 0).
    FIELD_SIZE: 800,

    // Игрок
    PLAYER_RADIUS: 14,

    // Скорость и разгон уменьшены вдвое. Прежние 190 единиц в секунду
    // проходили поле насквозь за четыре с небольшим, и управлять было
    // невозможно: цель убегала быстрее, чем наводится взгляд, а первая
    // ступень толчка (100 единиц) не отрывала её ни на секунду. Теперь
    // 95 — это примерно три ширины героя в секунду: видно, куда идёшь,
    // и толчок первой ступени уже догоняет.
    //
    // Разгон уменьшен вдвое же, иначе набор скорости занял бы 0.05 с
    // и движение стало бы резким: ощущение «разгоняется», а не
    // «переключается», важнее самой цифры.
    MAX_SPEED: 95,
    ACCEL: 1000,           // на набор полной скорости уходит ~0.1 с

    // Скилл «толчок». Кнопку надо ДЕРЖАТЬ: пока держишь — копится
    // заряд, отпустил — удар. Ступени по секунде на каждую: чтобы
    // оттолкнуть на 100 / 200 / 300, держать надо 1 / 2 / 3 секунды.
    PUSH_COOLDOWN: 3,       // откат одинаков для всех трёх ступеней
    // Досягаемость удара: расстояние от центра бьющего до центра цели.
    //
    // Было 54 — тела соприкасаются на 28 (два радиуса), то есть бить
    // можно было, по сути, вплотную: зазор в 26 единиц это меньше
    // двух героев в ширину, и на деле попасть удавалось только упираясь
    // в соперника вплотную. Просили поднять: толкнуть было трудно.
    //
    // Стало 100. Теперь между вами и целью может быть 72 единицы
    // зазора — два с половиной героя, и удар больше не требует
    // сближения вплотную, но по-прежнему требует попасть в конус и
    // удержать взгляд.
    //
    // Считается от центра героя, а не от его края — так же считает
    // проверка попадания, иначе прицел рисовался бы с запасом и
    // обещал бы то, чего не случится.
    PUSH_RANGE: 100,        // центр цели в этом радиусе от центра бьющего

    // Половина конуса оставлена как была: досягаемость расширили
    // намеренно, и сужать веер, чтобы «сохранить сложность», было бы
    // отменой просьбы. Если ударить станет слишком легко — вторая
    // ручка, рядом с этой.
    PUSH_COS: 0.4,          // косинус половины конуса: 0.4 ≈ 66° перед носиком
    PUSH_CHARGE_STEP: 1,    // секунда на одну ступень заряда
    PUSH_TIERS: [100, 200, 300],
    PUSH_FLIGHT_SPEED: 600, // как быстро летит выбитый — на длину не влияет
    // Столько уходит следующему в цепочке столкновений. Толкнуть
    // толпу нельзя: ударивший тормозит, а силу отдаёт половиной.
    PUSH_HANDOFF: 0.5,

    // Скилл «прыжок»: ровно 300 единиц по прямой, всё это время
    // неуязвим. Прыжок задан расстоянием, а не временем: на большой
    // скорости остаточная инерция после прыжка улетела бы ещё на
    // две сотни единиц, и «300» перестало бы означать 300.
    JUMP_DISTANCE: 300,
    JUMP_SPEED: 900,
    JUMP_COOLDOWN: 5,

    // Скилл «камень»: 2 с неподвижности, удар от него отскакивает
    // на половину удара. Откат считается после конца камня.
    STONE_TIME: 2,
    STONE_COOLDOWN: 7,
    STONE_BOUNCE: 0.5,

    ITERATIONS: 4,         // проходов разводки за тик: цепочки выдавливания
    TICK: 1 / 30,
};

const EPS = 1e-9;

function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

function approach(current, target, maxDelta) {
    const d = target - current;
    if (d > maxDelta) return current + maxDelta;
    if (d < -maxDelta) return current - maxDelta;
    return target;
}

/**
 * Запас до ближайшей границы. Именно он, а не расстояние до центра,
 * решает, жив ли игрок: на квадрате угловой игрок ближе к краю, чем
 * центральный, хотя до центра ему дальше.
 */
function marginOf(x, y, size) {
    return size / 2 - Math.max(Math.abs(x), Math.abs(y));
}

/** Единица в направлении, в котором запас убывает быстрее всего. */
function outwardOf(x, y) {
    if (Math.abs(x) >= Math.abs(y)) return { x: x < 0 ? -1 : 1, y: 0 };
    return { x: 0, y: y < 0 ? -1 : 1 };
}

/**
 * Точка спавна. Игроки раскладываются по периметру квадрата на
 * равном промежутке, а затем весь контур сжимается к центру в 0.7.
 *
 * Сжатие нужно ради честности: у любого периметрового отрезка сжатый
 * в 0.7 контур даёт одинаковый запас до края — ровно 0.3 от половины
 * стороны. Никто не начинает ближе к границе, чем кто-либо другой, ни
 * в углу, ни посреди стороны.
 */
function spawnPoint(index, count, size = T.FIELD_SIZE) {
    if (count <= 1) return { x: 0, y: 0 };

    const h = size / 2;
    const side = h * 2;                // длина одной стороны
    const dist = ((index % count) / count) * side * 4;
    const edge = Math.floor(dist / side);
    const within = dist - edge * side;

    let x;
    let y;
    if (edge === 0) { x = -h + within; y = -h; }        // верх, слева направо
    else if (edge === 1) { x = h; y = -h + within; }    // право, сверху вниз
    else if (edge === 2) { x = h - within; y = h; }     // низ, справа налево
    else { x = -h; y = h - within; }                    // лево, снизу вверх

    return { x: x * 0.7, y: y * 0.7 };
}

function createArena(options = {}) {
    return {
        size: options.size || T.FIELD_SIZE,
        players: [],
        tick: 0,
        elapsed: 0,
        finished: false,
        winner: null,
        events: [],
    };
}

function addPlayer(arena, id, options = {}) {
    const player = {
        id,
        x: options.x || 0,
        y: options.y || 0,
        vx: 0,
        vy: 0,
        radius: T.PLAYER_RADIUS,
        alive: true,
        bot: !!options.bot,

        // Последнее направление — по нему стреляют рывок и толчок,
        // поэтому его можно держать и без нажатой клавиши.
        dirx: 0,
        diry: 0,

        // Перезарядки скиллов — по имени, чтобы новый скилл просто
        // добавил сюда ещё одно число. Откат камня стартует вместе
        // с нажатием и включает время самого камня: иначе звездочка
        // мигала бы ровно тогда, когда камень стоит.
        cooldowns: { push: 0, jump: 0, stone: 0 },

        // Прыжок: сколько единиц осталось пролететь. Ноль — не прыгает.
        jumpLeft: 0,
        jumpx: 0,
        jumpy: 0,

        // Толчок. Заряд — сколько секунд кнопка удерживается, полёт —
        // сколько единиц осталось пролететь. Полёт задан расстоянием,
        // а не импульсом: оттолкнуть на 300 и на 100 — разные вещи,
        // и оба числа задаются одним зарядом.
        charge: 0,
        fly: 0,
        // Сила удара, который запустил полёт, и она же половина для
        // следующего в цепочке. Именно она, а не остаток полёта:
        // сила удара по цепочке не тает, иначе «первый толкает второго,
        // второй третьего» превратилось бы в затухание в геометрической
        // прогрессии, и третий получил бы 37 единиц вместо 150.
        strike: 0,
        flyx: 0,
        flyy: 0,

        // Камень: сколько секунд ещё стоять.
        stone: 0,

        // Автор последнего толчка — по нему считается, кем вытолкнут.
        // По цепочке столкновений автор не меняется: вытолкнул первый.
        lastHitBy: null,

        // Заполняется при выбытии
        place: null,
        eliminatedBy: null,
        eliminatedAt: null,
    };
    arena.players.push(player);
    return player;
}

function byId(arena, id) {
    return arena.players.find(p => p.id === id) || null;
}

function alivePlayers(arena) {
    return arena.players.filter(p => p.alive);
}

/** Откаты, прыжок и камень. Вызывается до чтения ввода. */
function tickTimers(player, dt) {
    player.cooldowns.push = Math.max(0, player.cooldowns.push - dt);
    player.cooldowns.jump = Math.max(0, player.cooldowns.jump - dt);
    player.cooldowns.stone = Math.max(0, player.cooldowns.stone - dt);
    player.stone = Math.max(0, player.stone - dt);
}

/**
 * Номер ступени заряда толчка по накопленным секундам: 0, 1, 2 или 3.
 *
 * Слагается из dt по 1/30, и сумма тридцати таких шагов даёт не
 * ровно 1, а чуть меньше — без запаса ступень набиралась бы на
 * тридцать первом тике, и цифра заряда мигала бы в такт с тиками.
 */
function chargeTier(charge) {
    return Math.min(
        T.PUSH_TIERS.length,
        Math.floor(charge / T.PUSH_CHARGE_STEP + 1e-6)
    );
}

/**
 * Направление, куда игрок смотрит. Читается отдельно и раньше движения:
 * толчок стреляет по направлению, и если бы оно обновлялось внутри
 * движения, скилл успевал бы выстрелить в направление прошлого тика.
 *
 * Ход и взгляд — не одно и то же. Стоя на самой границе и отступая к
 * центру, игрок всё равно должен бить наружу, по тому, кто дальше за
 * границей; то же самое делает человек, который пятится и швыряет
 * соперника перед собой. Поэтому input.face переопределяет взгляд, не
 * трогая движение, а без face всё работает как раньше — взгляд берётся
 * из направления хода.
 */
function updateFacing(player, input) {
    if (input.face) {
        const fx = input.face.x || 0;
        const fy = input.face.y || 0;
        const fm = Math.hypot(fx, fy);
        if (fm > 1e-3) {
            player.dirx = fx / fm;
            player.diry = fy / fm;
        }
        return;
    }

    const ix = clamp(input.x || 0, -1, 1);
    const iy = clamp(input.y || 0, -1, 1);
    const mag = Math.hypot(ix, iy);
    if (mag > 1e-3) {
        player.dirx = ix / mag;
        player.diry = iy / mag;
    }
}

/**
 * Скилл «толчок»: заряд и удар.
 *
 * Кнопку надо **держать**. Пока держишь и скилл готов, копится
 * заряд — по секунде на ступень: 1 / 2 / 3 секунды держать, чтобы
 * оттолкнуть на 100 / 200 / 300. Удар уходит в момент отпускания,
 * поэтому удержание не выстреливает само: выбрать момент — это и
 * есть решение, а сила задаётся тем, сколько успел накопить.
 *
 * Откат один на все ступени (3 с), иначе сильный удар ещё и стоил
 * бы дороже — тогда заряд выгодно копить до потолка всегда.
 * Отпустил раньше секунды — удара не было, откат не тратится.
 *
 * Стоит до движения: у цели полёт начинается в этот же тик, и её
 * собственный ввод уже не может его погасить.
 */
function applyPushes(arena, inputs, dt) {
    const actors = alivePlayers(arena);

    for (const p of actors) {
        const input = inputs[p.id] || {};

        // Летящий и каменный не бьют и не копят заряд.
        if (p.fly > 0 || p.stone > 0) {
            p.charge = 0;
            continue;
        }

        if (input.push) {
            if (p.cooldowns.push > 0) continue;   // держим на откате — ждём
            const cap = T.PUSH_CHARGE_STEP * T.PUSH_TIERS.length;
            p.charge = Math.min(cap, p.charge + dt);
            continue;
        }

        if (p.charge <= 0) continue;

        const tier = chargeTier(p.charge);
        p.charge = 0;
        if (tier === 0) continue;               // не дождался даже секунды

        p.cooldowns.push = T.PUSH_COOLDOWN;
        const dist = T.PUSH_TIERS[tier - 1];
        const hits = strike(arena, p, dist);

        // Событие нужно и при промахе: иначе игрок не заметит, что
        // три секунды готовил удар в пустоту. Направление замораживается
        // здесь — за 120 мс отставания картинки бьющий успевает
        // повернуться, а веер обязан остаться там, куда действительно били.
        arena.events.push({
            type: 'push',
            by: p.id,
            dirx: Math.round(p.dirx * 1000) / 1000,
            diry: Math.round(p.diry * 1000) / 1000,
            tier,
            dist,
            hits,
        });
    }
}

/**
 * Кого бьёт толчок.
 *
 * В конусе и в радиусе берётся **только ближайший**: толкнуть
 * толпу нельзя, иначе один удар выносил бы с поля сразу всех,
 * кто случайно стоял рядом. Дальше по цепочке столкновений сила
 * разойдётся сама, но по одному и всё слабее.
 *
 * Летящего и прыгающего пропускаем: первый уже в пути, второй
 * неуязвим — оба всё равно не должны отреагировать. Камень, наоборот,
 * цель: попадание в него отскакивает от бьющего.
 */
function strike(arena, pusher, dist) {
    if (!pusher.dirx && !pusher.diry) return [];   // направления нет — бить некуда

    let target = null;
    let nearest = Infinity;

    for (const o of arena.players) {
        if (o.id === pusher.id || !o.alive) continue;
        if (o.fly > 0 || o.jumpLeft > 0) continue;

        const ox = o.x - pusher.x;
        const oy = o.y - pusher.y;
        const d = Math.hypot(ox, oy);
        if (d > T.PUSH_RANGE) continue;
        if (d > EPS && (ox * pusher.dirx + oy * pusher.diry) / d < T.PUSH_COS) continue;

        if (d < nearest) {
            nearest = d;
            target = o;
        }
    }

    if (!target) return [];

    if (target.stone > 0) {
        // Ударил камень — отскакивает сам бьющий, на половину своего
        // удара: защита стоит ровно столько же, сколько атака.
        // Бьющий остаётся автором отскока, а не жертвой: выбить
        // с поля должен уметь и каменный.
        send(pusher, dist * T.STONE_BOUNCE, -pusher.dirx, -pusher.diry,
            target.id, dist);
        return [];
    }

    send(target, dist, pusher.dirx, pusher.diry, pusher.id, dist);
    return [target.id];
}

/** Запустить игрока в полёт на dist единиц по направлению. */
function send(target, dist, dirx, diry, by, strike) {
    target.fly = dist;
    target.strike = strike;
    target.flyx = dirx;
    target.flyy = diry;
    target.charge = 0;
    target.lastHitBy = by;
}

/**
 * Включение скиллов по кнопке: прыжок и камень.
 *
 * Идёт **до** толчка, и это не порядок ради порядка. Камень и толчок
 * в одном тике должны решаться так, будто камень нажали первым: иначе
 * игрок, нажавший обе кнопки, успевал бы получить удар, которого не
 * было бы, стоило ему нажать на полсекунды раньше.
 *
 * Скиллы level-based: пока кнопка зажата и откат кончился, скилл
 * срабатывает снова — но уже без человеческого решения о моменте.
 */
function applySkills(arena, inputs) {
    for (const p of alivePlayers(arena)) {
        const input = inputs[p.id] || {};
        if (p.fly > 0) continue;

        if (input.stone && p.cooldowns.stone <= 0 && p.jumpLeft <= 0) {
            p.stone = T.STONE_TIME;
            p.cooldowns.stone = T.STONE_TIME + T.STONE_COOLDOWN;
            p.charge = 0;
            // Скорость гасится сразу, а не только запретом движения:
            // когда камень кончится, игрок должен начать разгон с
            // нуля, а не с того ходу, которым вкатился в камень.
            p.vx = 0;
            p.vy = 0;
            continue;
        }

        if (input.jump && p.cooldowns.jump <= 0 && p.jumpLeft <= 0 && p.stone <= 0
            && (p.dirx || p.diry)) {
            p.jumpLeft = T.JUMP_DISTANCE;
            p.cooldowns.jump = T.JUMP_COOLDOWN;
            p.jumpx = p.dirx;
            p.jumpy = p.diry;
        }
    }
}

/**
 * Движение одного игрока на тик: разгон к целевой скорости.
 *
 * Летящий, прыгающий и каменный не управляют собой: первый уже в пути,
 * второй неуязвим и летит по своему вектору, третий — камень.
 */
function applyMovement(player, input, dt) {
    if (player.fly > 0 || player.stone > 0 || player.jumpLeft > 0) return;

    const ix = clamp(input.x || 0, -1, 1);
    const iy = clamp(input.y || 0, -1, 1);
    const hasInput = Math.hypot(ix, iy) > 1e-3;

    const speed = hasInput ? T.MAX_SPEED : 0;
    const tx = hasInput ? player.dirx * speed : 0;
    const ty = hasInput ? player.diry * speed : 0;
    player.vx = approach(player.vx, tx, T.ACCEL * dt);
    player.vy = approach(player.vy, ty, T.ACCEL * dt);
}

/**
 * Может ли тело двигаться при разводке столкновений.
 *
 * Камень не может — **совсем**. Он и сам не идёт (это делает
 * `applyMovement`), и разводить его нельзя: упирающийся в него должен
 * отскакивать сам, а не расталкивать камень пополам.
 *
 * Летящий здесь «движимым» остаётся намеренно. Его разведение с
 * неподвижным — часть полёта, а не отдельное правило, и запирать его
 * здесь означало бы, что выбитый замер бы на том месте, куда влетел,
 * вместо того чтобы долететь.
 */
function movable(p) {
    return p.stone <= 0;
}

/**
 * Разводка пересекшихся кругов. Только позиции: сквозь игрока не
 * пройти, но и отбросить его это не может — импульс даёт лишь скилл.
 *
 * Побочный, но важный эффект: выжимание. Кто-то упирается в тебя и
 * продавливает половину наложения — то есть медленно выносит тебя
 * к границе. Вынести за край при этом нельзя: граница держит.
 *
 * Кого именно выдавило, решается не по нормали, а по запасу до края:
 * на квадрате нормаль в углу смотрит в сторону, а вылетать всё равно
 * можно только наружу. Тот, чей запас уменьшился больше, тот и
 * вытолкнут — и по нему записывается автор.
 */
function resolveCollisions(arena) {
    const ps = alivePlayers(arena);

    // Удар проходит по цепочке только один раз за тик. Без этого
    // он ping-pongится внутри одного тика: получивший удар стоит
    // вплотную к тому, кто его передал, и следующий же проход
    // разводки отдаёт силу обратно — двое стоят на месте, а сила
    // ходит между ними, пока не кончится тик.
    const moved = new Set();

    for (let it = 0; it < T.ITERATIONS; it++) {
        let touched = false;

        for (let i = 0; i < ps.length; i++) {
            for (let j = i + 1; j < ps.length; j++) {
                const a = ps[i];
                const b = ps[j];

                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const d2 = dx * dx + dy * dy;
                const rr = a.radius + b.radius;
                if (d2 >= rr * rr) continue;

                touched = true;

                let d = Math.sqrt(d2);
                let nx;
                let ny;
                if (d < EPS) {
                    // Центры совпали. Без выдуманной нормали деление
                    // пошло бы в ноль и игроки застряли бы друг в друге.
                    nx = 1;
                    ny = 0;
                    d = 0;
                } else {
                    nx = dx / d;
                    ny = dy / d;
                }

                // Летящий в кого-то влетел: сила уходит дальше, а он
                // сам тормозит на месте. Разбирается до разведения
                // позиций, иначе разведение успело бы разбросать их
                // раньше, чем удар перешёл.
                if (a.fly > 0 && b.fly <= 0 && !moved.has(a.id) && !moved.has(b.id)) {
                    handoff(a, b);
                    moved.add(a.id);
                    moved.add(b.id);
                } else if (b.fly > 0 && a.fly <= 0 && !moved.has(a.id) && !moved.has(b.id)) {
                    handoff(b, a);
                    moved.add(a.id);
                    moved.add(b.id);
                }

                const overlap = rr - d;
                const beforeA = marginOf(a.x, a.y, arena.size);
                const beforeB = marginOf(b.x, b.y, arena.size);

                // Камень **не двигается вообще**: ни сам, ни от
                // разведения, ни от выжимания.
                //
                // Раньше он получал свою половину наложения наравне со
                // всеми и потому катился по полю, когда в него
                // упирались. Камень, который ползёт, — не защита: за две
                // секунды он успевал уехать с линии удара и всё равно
                // был выбит. Теперь разводится только тот, кто может
                // двигаться, и весь нахлёст достаётся ему — камень стоит
                // как стена.
                //
                // Два камня подряд не разойдутся: оба неподвижны, и
                // нахлёст просто останется. Это безвредно — через пару
                // секунд оба снова станут обычными и разойдутся при
                // первом же движении.
                const lockA = !movable(a);
                const lockB = !movable(b);
                if (!lockA && !lockB) {
                    a.x -= nx * overlap * 0.5;
                    a.y -= ny * overlap * 0.5;
                    b.x += nx * overlap * 0.5;
                    b.y += ny * overlap * 0.5;
                } else if (lockA) {
                    b.x += nx * overlap;
                    b.y += ny * overlap;
                } else {
                    a.x -= nx * overlap;
                    a.y -= ny * overlap;
                }

                const outA = beforeA - marginOf(a.x, a.y, arena.size);
                const outB = beforeB - marginOf(b.x, b.y, arena.size);
                if (Math.max(outA, outB) > 1e-6) {
                    if (outB >= outA) b.lastHitBy = a.id;
                    else a.lastHitBy = b.id;
                }
            }
        }

        if (!touched) break;
    }
}

/**
 * Летящий влетел в кого-то. Правил три, и все три про то, что
 * толкнуть толпу нельзя:
 *
 *   1. Влетел в камень — отскакивает сам, на половину своего удара.
 *   2. Влетел в обычного игрока — останавливается на месте, а силу
 *      отдаёт ему, но уже половиной.
 *   3. Камень ни при каких условиях не летит.
 *
 * Цепочка работает сама: получивший удар становится летящим и на
 * следующем столкновении отдаёт дальше. **Сила удара при этом не
 * меняется** — она лежит в `strike` и передаётся по цепочке как есть.
 * Считать её от остатка полёта нельзя: тогда цепочка из четверых
 * дала бы 300 / 150 / 75 / 37 вместо 300 / 150 / 150 / 150, и
 * затухание съедало бы удар задолго до конца поля.
 *
 * Автор тоже не меняется: вытолкнул первый, и по нему записывается
 * место, даже если до границы долетел второй.
 */
function handoff(flyer, other) {
    // Неуязвимого не цепляет и цепочка: сквозь прыгающего просто
    // разводят позиции, удар уходит дальше по своей дороге.
    if (other.jumpLeft > 0) return;

    if (other.stone > 0) {
        const back = flyer.strike * T.STONE_BOUNCE;
        flyer.flyx = -flyer.flyx;
        flyer.flyy = -flyer.flyy;
        flyer.fly = back;
        flyer.lastHitBy = other.id;
        flyer.charge = 0;
        return;
    }

    const hand = flyer.strike * T.PUSH_HANDOFF;
    flyer.fly = 0;
    flyer.vx = 0;
    flyer.vy = 0;
    flyer.charge = 0;
    if (hand <= 0) return;

    // Сила удара передаётся дальше та же самая: следующий в цепочке
    // получит свою половину от неё, а не от того, что осталось лететь.
    send(other, hand, flyer.flyx, flyer.flyy, flyer.lastHitBy, flyer.strike);
}

/**
 * Выбрасывает за границу. Место считается так: первый выбывший из восьми
 * — восьмой, последний проигравший — второй, победитель — первый.
 * Два вылета в один тик получают места по убыванию, а не одно и то же.
 *
 * **За край выносит только толчок.** Ходьба, прыжок и расталкивание
 * толпой упираются в границу: игрока прижимает к ней и гасит внешнюю
 * составляющую скорости, чтобы он мог скользить вдоль края, но не
 * пересечь его. Иначе вылететь можно было бы «просто» отойдя на шаг,
 * и толчок перестал бы быть единственным способом выбыть — а
 * вместе с ним и единственным поводом рисковать.
 *
 * Прыжок сюда тоже не попадает: он неуязвим и должен доводить игрока
 * до нужной точки, а не подставлять его под вылет.
 */
function applyBounds(arena) {
    const aliveBefore = alivePlayers(arena).length;
    const half = arena.size / 2;
    let place = aliveBefore;

    for (const p of arena.players) {
        if (!p.alive) continue;
        if (Math.abs(p.x) <= half && Math.abs(p.y) <= half) continue;

        if (p.fly <= 0) {
            p.x = clamp(p.x, -half, half);
            p.y = clamp(p.y, -half, half);

            // Гасим только внешнюю составляющую: вдоль края скользить
            // можно, вылететь — нет.
            const out = outwardOf(p.x, p.y);
            const vOut = p.vx * out.x + p.vy * out.y;
            if (vOut > 0) {
                p.vx -= out.x * vOut;
                p.vy -= out.y * vOut;
            }
            continue;
        }

        p.alive = false;
        p.place = place;
        p.eliminatedBy = p.lastHitBy;
        p.eliminatedAt = arena.elapsed;
        place--;

        arena.events.push({
            type: 'eliminated',
            id: p.id,
            by: p.lastHitBy,
            place: p.place,
        });
    }
}

/**
 * Партия кончается, когда живых осталось один или ноль. С одним игроком
 * на поле этого не происходит: одиночная тренировка не должна завершаться
 * сама себя, иначе нечему учиться.
 */
function checkFinish(arena) {
    if (arena.finished) return;

    const alive = alivePlayers(arena);
    if (arena.players.length < 2 || alive.length > 1) return;

    arena.finished = true;
    arena.winner = alive.length === 1 ? alive[0].id : null;
    if (alive.length === 1) alive[0].place = 1;

    arena.events.push({ type: 'finished', winner: arena.winner });
}

/**
 * One tick of simulation. inputs — карта
 * { [playerId]: { x, y, jump, push, stone, face } }, где x и y от -1 до 1,
 * jump, push и stone — запросы скиллов (push держится, а не нажимается),
 * а face — необязательное направление взгляда, когда оно должно отличаться
 * от направления хода. Возвращает события этого тика: кто вылетел,
 * кто кого толкнул и закончилась ли партия.
 */
function step(arena, inputs = {}, dt = T.TICK) {
    arena.events = [];

    // Доигрывать законченную партию бессмысленно — поздние вводы
    // не должны ни сдвигать победителя, ни переписывать места.
    if (arena.finished) return arena.events;

    arena.elapsed += dt;
    arena.tick++;

    const actors = alivePlayers(arena);

    for (const p of actors) tickTimers(p, dt);
    for (const p of actors) updateFacing(p, inputs[p.id] || {});

    // Камень и прыжок включаются раньше толчка, движение — после.
    applySkills(arena, inputs);
    applyPushes(arena, inputs, dt);

    for (const p of actors) applyMovement(p, inputs[p.id] || {}, dt);
    for (const p of actors) integrate(p, dt);

    resolveCollisions(arena);
    applyBounds(arena);
    checkFinish(arena);

    return arena.events;
}

/**
 * Перенос игрока на dt.
 *
 * Летящий двигается по своему вектору и ровно на столько, сколько ему
 * осталось лететь: заряд обещал 100 / 200 / 300 единиц, и пролететь
 * на 320 было бы незаметно, а на 280 — обидно. Движение считается
 * расстоянием, а не скоростью с трением именно поэтому.
 */
function integrate(p, dt) {
    if (p.fly > 0) {
        stepAlong(p, p.flyx, p.flyy, T.PUSH_FLIGHT_SPEED, dt, 'fly');
        return;
    }

    // Прыжок летит по своему вектору, а не по текущей скорости: задан
    // он расстоянием, иначе после него оставалась бы инерция на 900,
    // с которой игрок уезжал бы ещё на две сотни единиц.
    if (p.jumpLeft > 0) {
        stepAlong(p, p.jumpx, p.jumpy, T.JUMP_SPEED, dt, 'jumpLeft');
        return;
    }

    // Каменный не переносится вообще. Не «медленно», а совсем: пока камень
    // жив, тело стоит. Раньше сюда попадал остаток скорости от
    // последнего шага — `applyMovement` для камня выходит сразу и
    // скорость не гасит, — и герой въезжал в камень на полном ходу и
    // ещё полсекунды скользил. Проверено вживую: 54 единицы после
    // окаменения на скорости 95.
    if (p.stone > 0) {
        p.vx = 0;
        p.vy = 0;
        return;
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;
}

/** Полёт на расстояние: сдвиг по вектору с точным остатком. */
function stepAlong(p, ux, uy, speed, dt, field) {
    const stepLen = Math.min(speed * dt, p[field]);
    p.x += ux * stepLen;
    p.y += uy * stepLen;
    p[field] -= stepLen;

    if (p[field] <= 1e-9) {
        p[field] = 0;
        p.vx = 0;
        p.vy = 0;
    } else {
        p.vx = ux * speed;
        p.vy = uy * speed;
    }
}

/** Снимок для отправки клиенту: только то, что ему нужно рисовать. */
function snapshot(arena) {
    return {
        tick: arena.tick,
        elapsed: Math.round(arena.elapsed * 10) / 10,
        size: arena.size,
        finished: arena.finished,
        winner: arena.winner,

        // События последнего тика. Локальный просмотрщик читает их прямо
        // из арены, а клиенту через сеть их надо присылать — иначе он не
        // узнает, кто именно и кем вылетел.
        events: arena.events.map(e => ({ ...e })),

        players: arena.players.map(p => ({
            id: p.id,
            x: Math.round(p.x * 100) / 100,
            y: Math.round(p.y * 100) / 100,

            // Скорость и последнее направление — по ним клиент рисует
            // носик игрока, шлейф рывка и предсказывает позицию между
            // двумя снимками. Без них картинка получается мёртвой.
            vx: Math.round(p.vx * 10) / 10,
            vy: Math.round(p.vy * 10) / 10,
            dirx: Math.round(p.dirx * 1000) / 1000,
            diry: Math.round(p.diry * 1000) / 1000,

            alive: p.alive,
            bot: p.bot,
            eliminatedBy: p.eliminatedBy,
            cooldowns: {
                push: Math.round(p.cooldowns.push * 100) / 100,
                jump: Math.round(p.cooldowns.jump * 100) / 100,
                stone: Math.round(p.cooldowns.stone * 100) / 100,
            },

            // Заряд толчка в секундах: клиент сам переводит его в
            // ступень и рисует цифру, а дальний край прицела ставит
            // по PUSH_TIERS — одна и та же таблица у сервера и у
            // рисовальщика.
            charge: Math.round(p.charge * 100) / 100,

            // Полёт — остаток в единицах. Ноль означает «не летит».
            fly: Math.round(p.fly),
            jumpLeft: Math.round(p.jumpLeft),
            stone: Math.round(p.stone * 100) / 100,
            place: p.place,
        })),
    };
}

module.exports = {
    T,
    createArena,
    addPlayer,
    byId,
    alivePlayers,
    spawnPoint,
    step,
    snapshot,
    marginOf,
    outwardOf,
    chargeTier,
};
