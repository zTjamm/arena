'use strict';

/**
 * Звук игры — собран на WebAudio из осцилляторов.
 *
 * Почему это нужно: игра решается одной кнопкой, и без звука не
 * слышно трёх вещей — что замах начался, что удар попал и что кого-то
 * вынесло. На телефоне смотрят на поле, а на звук не смотрят вовсе,
 * так что это половина обратной связи.
 *
 * Файлов нет и загрузки нет: короткий тон с быстрым затуханием
 * собирается из одного осциллятора.
 */

// --- громкость ----------------------------------------------------------

const MASTER = 0.22;      // общая, 0..1. Звук должен пережить игру,
                           // а не заменить её.
let muted = false;

let ctx = null;
let master = null;

function audio() {
    if (ctx) return ctx;
    if (typeof window === 'undefined') return null;

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;

    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER;
    master.connect(ctx.destination);
    return ctx;
}

/**
 * Браузеры не дают запускать звук без жеста пользователя: контекст
 * создаётся и оживает на первом касании. До этого звука нет — и это
 * нормально, а не ошибка.
 */
function unlock() {
    const a = audio();
    if (!a) return;
    if (a.state === 'suspended') a.resume().catch(() => { /* не вышло */ });
}

// --- кирпичики ----------------------------------------------------------

/**
 * Один тон с огибающей: резкий подъём и экспоненциальное затухание.
 * Так тон читается как удар, а не как гудок.
 */
function tone(freq, ms, type = 'sine', gain = 1, slideTo = 0) {
    const a = audio();
    if (!a || !master || a.state !== 'running') return;

    const now = a.currentTime;
    const osc = a.createOscillator();
    const env = a.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo) {
        osc.frequency.exponentialRampToValueAtTime(slideTo, now + ms / 1000);
    }

    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0001), now + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, now + ms / 1000);

    osc.connect(env);
    env.connect(master);
    osc.start(now);
    osc.stop(now + ms / 1000 + 0.02);
}

/** Шумовой всплеск — так звучит взрыв камня. */
function noise(ms, gain = 0.5) {
    const a = audio();
    if (!a || !master || a.state !== 'running') return;

    const now = a.currentTime;
    const frames = Math.max(1, Math.floor(a.sampleRate * ms / 1000));
    const buf = a.createBuffer(1, frames, a.sampleRate);
    const data = buf.getChannelData(0);

    // Падающий по кусочку белый шум: резкий, без тона.
    for (let i = 0; i < frames; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }

    const src = a.createBufferSource();
    src.buffer = buf;

    const lp = a.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;

    const env = a.createGain();
    env.gain.setValueAtTime(gain, now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + ms / 1000);

    src.connect(lp);
    lp.connect(env);
    env.connect(master);
    src.start(now);
}

// --- события игры --------------------------------------------------------

const sfx = {
    /** Замах начался. Короткий восходящий тон: он предупреждает
     *  соперника, потому что замах виден на экране, но звук слышен
     *  даже когда смотришь в другую сторону. */
    swing() { tone(320, 110, 'triangle', 0.5, 460); },

    /** Удар попал: глухой удар вниз. */
    hit() { tone(180, 150, 'square', 0.8, 90); },

    /** Удар в камень: отскок коротким писком вверх. */
    bounce() { tone(600, 120, 'triangle', 0.6, 900); },

    /** Промах: глухой воздух. */
    whiff() { tone(150, 90, 'sine', 0.25, 110); },

    /** Цепочка: чем длиннее, тем выше — счёт слышен раньше, чем виден. */
    chain(n) {
        const step = Math.max(0, Math.min(7, (n || 2) - 2));
        tone(520 * Math.pow(1.122, step), 200, 'triangle', 0.7);
    },

    /** Взрыв камня. */
    burst() { noise(320, 0.75); },

    /** Кого-то вынесло с поля. */
    out() { tone(440, 220, 'sine', 0.7, 880); },

    /** Прыжок. */
    jump() { tone(380, 130, 'sine', 0.35, 760); },

    /** Камень встал: глухой стук. */
    stone() { tone(120, 180, 'square', 0.4, 70); },

    /** Свою очередь отыграли. */
    win() { tone(660, 420, 'triangle', 0.7, 990); },
};

function setMuted(v) {
    muted = !!v;
    if (master) master.gain.value = muted ? 0 : MASTER;
}

function isMuted() {
    return muted;
}

module.exports = { sfx, unlock, setMuted, isMuted };
