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
NGINX=/etc/nginx/sites-available/arena
ENABLED=/etc/nginx/sites-enabled/arena

step() { echo; echo "=== $* ==="; }

step "бэкап текущего конфига nginx"
# Конфиг арены в первый раз ещё не существует — это не ошибка.
if [ -f "$NGINX" ]; then
    cp "$NGINX" "/root/arena-nginx-$STAMP"
    echo "сохранён /root/arena-nginx-$STAMP"
else
    echo "конфига арены ещё нет, это первый деплой"
fi

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
# Сниппет добавляется один раз и дальше только обновляется.
# Ключевая деталь — слэш на конце proxy_pass: он срезает префикс
# /arena/, и приложение получает запрос как будто стоит в корне.
cat > "$NGINX" <<'EOF'
# Арена на выталкивание. Живёт по пути /arena/ рядом с «Точками
# и квадратами», которая осталась в корне домена.
location = /arena {
    return 301 /arena/;
}

location /arena/ {
    proxy_pass http://127.0.0.1:8100/;
    proxy_http_version 1.1;

    # Сокет не работает без этих двух заголовков: без Upgrade
    # соединение остаётся обычным HTTP и таймаутится, а Connection
    # без upgrade ломает всё, что websocket-ом не является.
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_cache_bypass $http_upgrade;

    # Игра идёт в реальном времени, кэшировать нечего, а долгий
    # апдейт апстрима оборвал бы соединение минутелю.
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
EOF

ln -sf "$NGINX" "$ENABLED"

# Проверка обязательна. Если конфиг невалиден, nginx не перезагрузится
# и продолжит работать на прежнем — проверенном.
nginx -t
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
    -H 'Host: mypoddomenjm.mooo.com' \
    https://127.0.0.1/arena/

step "готово"
echo "арена: https://mypoddomenjm.mooo.com/arena/"
echo "откат: скопировать /root/arena-nginx-$STAMP на место и nginx -t && systemctl reload nginx"
