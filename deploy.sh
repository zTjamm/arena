#!/bin/bash
# Деплой «Арены на выталкивание» на 89.125.54.41.
#
#     ssh root@89.125.54.41 '/root/arena/deploy.sh'
#
# Арена живёт по пути /arena/ на том же домене, что и «Точки и квадраты».
# Существующая игра не трогается: её корень `/` остаётся за ней, а сюда
# добавляется только один location. Если конфиг nginx не проходит
# проверку — перезагрузки не происходит, и старая игра продолжает
# работать как ни в чём не бывало.

set -euo pipefail

APP=/root/arena
STAMP=$(date +%Y%m%d-%H%M%S)
SITE=/etc/nginx/sites-available/tic-tac-toe

step() { echo; echo "=== $* ==="; }

step "чистим то, что помешает pull"
cd "$APP"
for f in $(git ls-files --others --exclude-standard); do
    echo "удаляю лишний untracked: $f"
    rm -f "$f"
done
git status --short || true

step "pull"
git pull --ff-only origin master

step "зависимости"
npm ci --no-audit --no-fund

step "сборка фронтенда"
# Правки ядра и рисовальщика обязаны доехать до бандла, иначе браузер
# продолжит показывать старую механику.
node tools/bundle.js

step "проверки сборки"
grep -q 'drawHand' public/bundle.js || { echo "В БАНДЛЕ НЕТ ВЫЛЕТА РУКИ - не деплою"; exit 1; }
echo "вылет руки на месте"
grep -q 'btnStone' public/index.html || { echo "НЕТ КНОПКИ КАМНЯ - не деплою"; exit 1; }
echo "кнопка камня на месте"
grep -q 'drawStars' public/bundle.js || { echo "В БАНДЛЕ НЕТ ЗВЁЗД ПЕРЕЗАРЯДКИ - не деплою"; exit 1; }
echo "звёзды перезарядки на месте"

step "тесты"
# Свой DATA_DIR, чтобы прогон не тронул настоящие аккаунты.
TESTDATA=/tmp/arena-test-$STAMP
mkdir -p "$TESTDATA"
DATA_DIR="$TESTDATA" npm test

step "nginx"
# Арена живёт по пути /arena/ внутри того же доменного блока, где уже
# стоят «Точки и квадраты». Отдельным файлом это сделать нельзя:
# директива location не допускается на верхнем уровне, nginx -t падает.
#
# Первая попытка ровно так и выглядела: отдельный sites-enabled/arena
# с блоками location, и проверка его отклонила. Проверка — не формальность,
# а предохранитель: перезагрузки не произошло, старая игра продолжила
# работать. Поэтому правим существующий файл и всегда бэкапим его.
#
# Слэш на конце proxy_pass решает всё: он срезает префикс /arena/, и
# приложение получает запрос так, будто стоит в корне.
cat > /tmp/arena-locations.$$ <<'EOF'

    # АРЕНА: НАЧАЛО — правка deploy.sh, вручную не трогать
    location = /arena {
        return 301 /arena/;
    }

    location /arena/ {
        proxy_pass http://127.0.0.1:8100/;
        proxy_http_version 1.1;

        # Сокет не работает без этих двух заголовков: без Upgrade
        # соединение остаётся обычным HTTP и таймаутится.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;

        # Игра идёт в реальном времени: кэшировать нечего, а долгий
        # апдейт апстрима обрывал бы соединение на минуте.
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
    # АРЕНА: КОНЕЦ
EOF

cp "$SITE" "/root/tic-tac-toe-nginx-$STAMP"
echo "бэкап: /root/tic-tac-toe-nginx-$STAMP"

python3 - "$SITE" /tmp/arena-locations.$$ <<'PY'
import sys

site, patch_file = sys.argv[1], sys.argv[2]
BEGIN = '# АРЕНА: НАЧАЛО'
END = '# АРЕНА: КОНЕЦ'

with open(site, encoding='utf-8') as f:
    lines = f.readlines()

with open(patch_file, encoding='utf-8') as f:
    patch = f.readlines()

# Прежний блок вырезаем, чтобы повторный деплой не копировал его
# второй раз. Без этого nginx -t упал бы на дублирующем location
# уже на втором прогоне.
clean = []
inside = False
for ln in lines:
    if BEGIN in ln:
        inside = True
        continue
    if inside:
        if END in ln:
            inside = False
        continue
    clean.append(ln)

# Последняя закрывающая скобка файла закрывает https-блок, и вставка
# перед ней кладёт арену именно туда, а не в http-редирект.
for i in range(len(clean) - 1, -1, -1):
    if clean[i].strip() == '}':
        break
else:
    raise SystemExit('в конфиге нет закрывающей скобки server-блока')

clean[i:i] = patch

with open(site, 'w', encoding='utf-8') as f:
    f.writelines(clean)

print(f'вставлено {len(patch)} строк в {site}')
PY

rm -f /tmp/arena-locations.$$

# Проверка обязательна и не обходится. Если конфиг невалиден, nginx не
# перезагрузится и продолжит работать на прежнем — а мы откатим файл.
if ! nginx -t; then
    echo "КОНФИГ НЕВАЛИДЕН - ОТКАТЫВАЮ"
    cp "/root/tic-tac-toe-nginx-$STAMP" "$SITE"
    nginx -t
    exit 1
fi

systemctl reload nginx
echo "nginx перезагружен"

step "pm2"
# Имя процесса новое: «tic-tac-toe» не перезапускается и не меняется.
pm2 describe arena > /dev/null 2>&1 \
    && pm2 restart arena --update-env \
    || pm2 start server.js --name arena \
        --cwd "$APP" \
        --env PORT=8100 \
        --env SOCKET_PATH=/arena/socket.io \
        --time

pm2 save

step "проверка на живом порту"
sleep 2
curl -fsS http://127.0.0.1:8100/ > /dev/null || {
    echo "АРЕНА НЕ ОТВЕЧАЕТ НА 8100 - деплой не удался"
    exit 1
}
echo "арена отвечает"

curl -fsS -o /dev/null -w 'через nginx: %{http_code}\n' \
    -k --resolve mypoddomenjm.mooo.com:443:127.0.0.1 \
    https://mypoddomenjm.mooo.com/arena/

# Существующая игра не должна пострадать: проверяем её корень в том же
# прогоне. Молчание об успехе тут обманчиво — арена может подняться,
# а крестики лечь.
curl -fsS -o /dev/null -w 'крестики на месте: %{http_code}\n' \
    -k --resolve mypoddomenjm.mooo.com:443:127.0.0.1 \
    https://mypoddomenjm.mooo.com/

step "готово"
echo "арена:     https://mypoddomenjm.mooo.com/arena/"
echo "крестики:  https://mypoddomenjm.mooo.com/"
echo "откат:     cp /root/tic-tac-toe-nginx-$STAMP $SITE && nginx -t && systemctl reload nginx"
