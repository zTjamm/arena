'use strict';

/**
 * Собирает ядро, ботов и рисовальщик в один файл для браузера.
 *
 *     node tools/bundle.js      пересобрать public/bundle.js
 *
 * Ядро и боты остаются обычным CommonJS и по-прежнему гоняются в
 * тестах как есть: сборщик ничего в них не меняет, а только оборачивает
 * каждый модуль в минимальный require, понятный браузеру. Так серверу
 * игры не придётся ждать, пока клиент догонит — public/bundle.js
 * просто отдаётся статикой.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(PUBLIC, 'bundle.js');

/**
 * Модули, которые нужны браузеру.
 *
 * Порядок не важен — сборщик сам разводит зависимости, а require
 * лежит на месте любого из них. Но читать список лучше по порядку
 * «откуда что берётся»: ядро, боты, потом герои, рисование и звук.
 *
 * Звук попал в список не по прихоти: без него клиент не может
 * включить его в bundle, а включить его нечем — файл отдаётся как
 * статика, и отдельным тегом его никто не подключает.
 */
const MODULES = [
    'game/arena.js',
    'game/bot.js',
    'public/heroes.js',
    'public/hero-draw.js',
    'public/render.js',
    'public/sound.js',
];

function moduleId(file) {
    return file.replace(/\.js$/, '');
}

function build() {
    const out = [];

    out.push('/* Собрано tools/bundle.js. Править надо game/ и public/. */');
    out.push('(function () {');
    out.push('    "use strict";');
    out.push('    const registry = Object.create(null);');
    out.push('    const cache = Object.create(null);');
    out.push('');
    out.push('    // Минимальный CommonJS для браузера. Модули лежат под');
    out.push('    // слэшем, относительные пути разводятся как в node.');
    out.push('    function resolve(dir, spec) {');
    out.push('        if (spec.charAt(0) !== ".") return spec;');
    out.push('        const parts = dir ? dir.split("/") : [];');
    out.push('        spec.split("/").forEach(function (seg) {');
    out.push('            if (seg === "" || seg === ".") return;');
    out.push('            if (seg === "..") parts.pop();');
    out.push('            else parts.push(seg);');
    out.push('        });');
    out.push('        return parts.join("/");');
    out.push('    }');
    out.push('');
    out.push('    function load(dir, spec) {');
    out.push('        const name = resolve(dir, spec);');
    out.push('        if (cache[name]) return cache[name].exports;');
    out.push('        const entry = registry[name];');
    out.push('        if (!entry) throw new Error("нет модуля " + name);');
    out.push('        const module = { exports: {} };');
    out.push('        cache[name] = module;');
    out.push('        const sub = name.indexOf("/") < 0');
    out.push('            ? ""');
    out.push('            : name.replace(/\\/[^/]*$/, "");');
    out.push('        entry(module, module.exports, function (s) {');
    out.push('            return load(sub, s);');
    out.push('        });');
    out.push('        return module.exports;');
    out.push('    }');
    out.push('');

    for (const file of MODULES) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        out.push(`    registry[${JSON.stringify(moduleId(file))}]`
            + ' = function (module, exports, require) {');
        out.push(src);
        out.push('    };');
        out.push('');
    }

    out.push('    window.ArenaBundle = {');
    out.push('        require: function (spec) { return load("", spec); },');
    out.push('    };');
    out.push('})();');
    out.push('');

    fs.writeFileSync(OUT, out.join('\n'));
    return fs.statSync(OUT).size;
}

/**
 * Проставляет в теги скриптов версию содержимого.
 *
 * Зачем. Скрипты подключены как `src="client.js"`, без вопроса. Node
 * отдаёт их с `Cache-Control: public, max-age=0` и ETag, то есть
 * браузер обязан ревалидировать — и по протоколу так и происходит. Но
 * на практике браузер всё равно отдаёт из кэша старую копию: проверено
 * дважды, обычная перезагрузка страницы приводила к тому, что в игре
 * работал код, которого в новой выкладке нет.
 *
 * Для игрока это выглядит очень неприятно: правка выкачена, а человек
 * её не видит и concludes, что правки не работают. Разбираться приходится
 * вручную, с очисткой кэша, а это ровно то, чего от него ждать нельзя.
 *
 * Вопрос в адресе решает это надёжно: при изменении содержимого
 * меняется и адрес, и старая копия просто не может прийти. Версия
 * считается из содержимого самих файлов, поэтому руками её
 * поднимать не нужно — пересобрал и забыл.
 *
 * Индекс правится только если версия изменилась, иначе пересборка
 * без правок не трогала бы файл впустую и не плодила бы коммиты.
 */
const SCRIPTS = ['bundle.js', 'app.js', 'client.js'];

function versionOf() {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha1');
    for (const name of SCRIPTS) {
        const file = path.join(PUBLIC, name);
        if (!fs.existsSync(file)) return null;
        hash.update(fs.readFileSync(file));
    }
    return hash.digest('hex').slice(0, 10);
}

function stampIndex(version) {
    const file = path.join(PUBLIC, 'index.html');
    let html = fs.readFileSync(file, 'utf8');
    const before = html;

    for (const name of SCRIPTS) {
        const re = new RegExp('(src=")' + name + '(\\?v=[0-9a-f]+)?(")');
        html = html.replace(re, '$1' + name + '?v=' + version + '$3');
    }

    if (html !== before) {
        fs.writeFileSync(file, html);
        return true;
    }
    return false;
}

function main() {
    const missing = MODULES.filter(f => !fs.existsSync(path.join(ROOT, f)));
    if (missing.length) {
        console.error('Не найдены исходники для сборки: ' + missing.join(', '));
        process.exit(1);
    }

    const size = build();
    console.log('Собран public/bundle.js — ' + MODULES.length
        + ' модулей, ' + Math.round(size / 1024) + ' КБ');

    // Версия считается по содержимому уже собранного бандла и двух
    // отдельных скриптов, поэтому порядок именно такой: сначала сборка.
    const version = versionOf();
    if (!version) {
        console.error('Не найден один из скриптов для версии: ' + SCRIPTS.join(', '));
        process.exit(1);
    }
    const changed = stampIndex(version);
    console.log('Версия скриптов ' + version
        + (changed ? ' — проставлена в index.html' : ' — index.html уже актуален'));
}

module.exports = { build, MODULES, OUT };

if (require.main === module) main();
