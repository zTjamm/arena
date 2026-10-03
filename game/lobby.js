'use strict';

/**
 * Подбор: кого, когда и во что собирать.
 *
 * Лобби — комната, открытая кнопкой «Играть». Пока старта нет, оно
 * собирает игроков graceMs и отдаёт их планом партии; недостающих
 * добирают боты, чтобы состав всегда был ровно maxPlayers. Так один
 * игрок не ждёт компанию вечно, а компания успевает зайти до начала.
 *
 * Комната открывается, когда в неё заходит первый, и закрывается
 * после старта — следующую открывает только новое нажатие. Между
 * партиями очередь не переиспользуется: иначе нажатие «Играть»
 * перестало бы быть тем, что создаёт комнату.
 *
 * Часы снаружи: все методы принимают now. Правила подбора проверяются
 * в тестах без реального ожидания, а сервер просто передаёт своё время.
 */

const DEFAULTS = {
    maxPlayers: 8,
    // Сколько ждать на сбор. Игрок, нажавший «Играть», получает полное
    // окно: опоздавшие успевают зайти, а кого так и не дождались,
    // добирают боты — пустых мест в партии не бывает.
    graceMs: 30000,
};

/** Ид ботов не должен наступать на чужой ник: иначе снимок двух разных
    игроков окажется под одним ключом. */
function freeBotId(used, n) {
    let id = `bot${n}`;
    let k = n;
    while (used.has(id)) {
        k++;
        id = `bot${k}`;
    }
    used.add(id);
    return id;
}

class Lobby {
    constructor(options = {}) {
        this.options = { ...DEFAULTS, ...options };
        this.ids = [];
        this.deadline = null;
    }

    get size() {
        return this.ids.length;
    }

    /** Кто ждёт, в порядке входа. */
    get waiting() {
        return this.ids.slice();
    }

    /**
     * Сколько миллисекунд осталось до старта. null — если сбор не идёт
     * (пока никто не зашёл или партия уже началась).
     */
    startsIn(now) {
        if (this.ids.length === 0) return null;
        if (this.isReady(now)) return 0;
        if (this.deadline === null) return null;
        return Math.max(0, this.deadline - now);
    }

    /**
     * Пора начинать: лобби непустое и либо набрался полный состав,
     * либо вышло время сбора. Полный состав не ждёт — ждать
     * некого, все уже здесь.
     */
    isReady(now) {
        if (this.ids.length === 0) return false;
        if (this.ids.length >= this.options.maxPlayers) return true;
        return this.deadline !== null && now >= this.deadline;
    }

    join(id, now) {
        if (id === null || id === undefined || this.ids.includes(id)) return false;
        this.ids.push(id);
        // Окно сбора открывается, когда комната из пустой стала непустой.
        // Просроченное окно не считается — иначе зашедший после чужого
        // старта стартовал бы мгновенно, не дождавшись никого.
        if (this.ids.length === 1 && (this.deadline === null || this.deadline <= now)) {
            this.deadline = now + this.options.graceMs;
        }
        return true;
    }

    leave(id) {
        const i = this.ids.indexOf(id);
        if (i < 0) return false;
        this.ids.splice(i, 1);
        // Ждать некого — окно закрывается, чтобы следующий зашедший
        // получил полный grace, а не остаток от предыдущего.
        if (this.ids.length === 0) this.deadline = null;
        return true;
    }

    /**
     * Начать сейчас, не дожидаясь окна. Ответ на кнопку «начать»:
     * одиночному игроку не хочется ждать полминуты каждую партию.
     * Возвращает false, если ждать некого.
     */
    force(now) {
        if (this.ids.length === 0) return false;
        this.deadline = now;
        return true;
    }

    /**
     * Забрать готовых игроков, если окно закрылось.
     * null — пока рано или ждать некого.
     */
    take(now) {
        if (!this.isReady(now)) return null;

        const humans = this.ids.slice(0, this.options.maxPlayers);
        const rest = this.ids.slice(this.options.maxPlayers);
        // Лишние ждут следующей партии со своим окном, а не выпадают.
        this.ids = rest;
        this.deadline = rest.length > 0 ? now + this.options.graceMs : null;

        const size = this.options.maxPlayers;
        const used = new Set(humans);
        const bots = [];
        for (let i = 1; bots.length < size - humans.length; i++) {
            bots.push(freeBotId(used, i));
        }

        return { humans, bots, size };
    }
}

module.exports = { Lobby, DEFAULTS };
