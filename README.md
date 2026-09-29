# Haze Monitor

Мониторинг инфраструктуры VPN-сервиса. Главный вопрос, на который он отвечает:
**«Работает ли этот endpoint для пользователя из России — а если нет, то где проблема?»**

Telegram-бот (только для админов) + backend + лёгкие **probe-агенты** на VPS в разных странах.
Всё в Docker: на чистом VPS нужны только Docker и Docker Compose.

```
                 ┌──────────────── Monitoring Backend (один контейнер) ───────────────┐
Telegram  ◄────► │ Bot · Scheduler · State/Incident engine · Notifier · Probe API     │──► PostgreSQL
                 └────────────────────────────▲──────────────────▲───────────────────┘
                              HMAC-signed, только исходящие       │
                 ┌────────────────────────────┴───┐   ┌──────────┴─────────────────┐
                 │ Russia Probe (VPS в РФ)        │   │ External Probe (EU VPS)    │
                 └───────────────┬────────────────┘   └───────────────┬────────────┘
                                 ▼  DNS → TCP → TLS → HTTP            ▼
                            Origin / CDN / Panel / Subscription (любые hostname из БД)
```

## Быстрый старт

### 1. Центральный сервер

```bash
git clone <repository> haze-monitor && cd haze-monitor
cp .env.example .env
nano .env            # 5 обязательных значений, см. ниже
docker compose up -d
docker compose ps    # все сервисы должны быть healthy
```

| Переменная | Что это |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен от @BotFather |
| `TELEGRAM_ADMIN_IDS` | ваш Telegram ID (через запятую — несколько админов) |
| `DATABASE_PASSWORD` | пароль PostgreSQL, только буквы/цифры: `openssl rand -hex 16` |
| `PROBE_SIGNING_SECRET` | мастер-секрет подписи probe: `openssl rand -hex 32` |
| `PUBLIC_URL` | адрес, по которому probes видят backend: `https://monitor.example.com` или `http://IP:3000` |

`docker compose up -d` сам: собирает/скачивает образы → поднимает PostgreSQL → ждёт `healthy` →
применяет миграции (`prisma migrate deploy` в отдельном init-контейнере `migrate`) → запускает backend
(API для probes, scheduler, движок состояний, бот). Все контейнеры `restart: unless-stopped`,
данные лежат в volume `pgdata`, после перезагрузки VPS всё поднимается само.
Откройте бота и отправьте `/start` — вы уже админ. Демо-данных нет.

**HTTPS (рекомендуется):** в `.env` добавьте `COMPOSE_PROFILES=tls`, `DOMAIN=monitor.example.com`,
`BACKEND_BIND=127.0.0.1`, `PUBLIC_URL=https://monitor.example.com` (A-запись домена → на сервер) и
`docker compose up -d` — Caddy сам получит сертификат. Запросы probe и так подписаны HMAC, но TLS
скрывает список ваших targets.

### 2. RU Probe (и любой другой probe)

1. В боте: **⚙️ Настройки → Probes → ➕ Добавить probe** → имя `RU-Moscow-1`, регион `RU`, страна `RU`.
2. Бот пришлёт готовую команду. На VPS в России (только Docker):

```bash
curl -fsSL https://monitor.example.com/install.sh | PROBE_TOKEN=<токен из бота> bash
```

Скрипт проверит Docker, создаст `/opt/haze-probe`, скачает образ, запустит контейнер и дождётся
`healthy` (то есть успешного heartbeat). Токен в репозитории/скрипте не хранится.

Альтернатива без registry: `git clone …; cd <repo>/probe; cp .env.example .env; nano .env` (`BACKEND_URL`,
`PROBE_TOKEN`), `docker compose up -d` — образ соберётся локально.

### 3. EU Probe

То же самое, регион **`EU`**, VPS в Германии/Нидерландах/Финляндии и т.п. Probe можно добавить сколько
угодно (`RU-Moscow-2`, `DE-Frankfurt-1`, …): новый probe автоматически подключается ко всем targets
его региона. Регионы — произвольные строки; `RU` считается «источником истины» для пользователей из РФ.

> Образ probe для `install.sh` берётся из `PROBE_IMAGE` (в `.env` backend). Workflow
> `.github/workflows/docker.yml` публикует `ghcr.io/<owner>/haze-monitor` и `…-probe`; укажите свой
> `PROBE_IMAGE=ghcr.io/<owner>/haze-monitor-probe:latest` (пакет должен быть публичным).
> Для backend предсобранные образы включаются `BACKEND_IMAGE=…` и `PREBUILT=1` в `.env`.

### 4. Добавление targets

**⚙️ Настройки → Targets → ➕** — мастер спрашивает: имя, тип (ORIGIN/CDN/PANEL/SUBSCRIPTION/API/CUSTOM),
hostname (можно вставить URL), протокол, порт, path, группу (нода, например «Germany LTE» с origin + CDN #1/#2),
регионы (`RU`+`EU`), интервал, timeout. После «Создать» target сразу проверяется — код менять не надо.
В карточке target → **✏️ Изменить**: имя, hostname, порт, path, протокол, тип, группа, интервал, timeout,
пороги падения/восстановления, допустимые HTTP-коды (для CDN нормальны 403/404), предупреждение о сертификате,
регионы, точечное назначение probes. Там же ⏸ пауза и 🗑 удаление.
Схема ORIGIN vs CDN одной ноды: заведите два target (`de-origin.example.com`, `de-cdn.example.com`) в одну группу —
тогда «Origin UP / CDN DOWN» видно сразу на дашборде.

### Эксплуатация

```bash
docker compose ps          # статус и health
docker compose logs -f     # или ./logs.sh backend
./update.sh                # git pull → build/pull → up -d → миграции → проверка health
./backup.sh                # ./backups/monitoring-YYYY-MM-DD-HHMMSS.sql.gz (через docker, pg_dump на хосте не нужен)
./restore.sh backups/monitoring-….sql.gz   # восстановление (стирает текущие данные, спрашивает подтверждение)
```

Данные переживают `docker compose down`/reboot. **Не используйте `down -v`** — это удалит volume с БД.
Логи — структурированный JSON (`event`: `CHECK_STARTED/COMPLETED/FAILED`, `STATE_CHANGED`, `INCIDENT_CREATED/RESOLVED`,
`PROBE_CONNECTED/DISCONNECTED`, `ALERT_SENT/FAILED`), у каждой проверки сквозной `checkId`; хранятся docker-ом с ротацией.

---

## Архитектура

Modular monolith + отдельно разворачиваемый probe. Отдельные процессы worker/bot/API не нужны: нагрузка
крошечная, а один процесс проще и надёжнее. Redis/BullMQ **не используются** сознательно: очередь заданий
живёт в PostgreSQL (`FOR UPDATE SKIP LOCKED`), что даёт те же гарантии (dedup, retry, concurrency) без ещё
одного stateful-компонента. Если понадобится масштабирование — код разнесён по модулям:

| Модуль | Назначение |
|---|---|
| `src/backend/engine/jobs.ts` | scheduler, выдача заданий (long-poll), ручные проверки, истечение заданий |
| `src/backend/engine/state.ts` | **чистая** state machine и региональная классификация |
| `src/backend/engine/evaluator.ts` | запись результата → состояние пары probe×target → агрегат target |
| `src/backend/engine/incidents.ts` | Incident Manager (идемпотентный reconcile) |
| `src/backend/notify/*` | Notification Service (outbox) + адаптеры; Telegram — один из адаптеров |
| `src/backend/http/server.ts`, `probeAuth.ts` | Probe API, HMAC, replay-защита |
| `src/backend/engine/retention.ts` | агрегация и очистка |
| `src/probe/checks/*` | `CheckStrategy` → `NetworkCheck` (стадии DNS/TCP/TLS/HTTP), `XrayE2ECheck` (заглушка) |
| `src/shared/*` | контракт API, подпись, SSRF-защита, логгер |

Поток данных:
`Scheduler → CheckJob(PENDING) → Probe (long-poll claim) → Target → POST /results → CheckResult → state per (probe,target) → aggregate + classification → Incident → Alert (outbox) → Notifier → Telegram`.

**Почему probe *забирает* задания сам (pull).** Probe делает только исходящие HTTPS-запросы: ему не нужен открытый
порт, он не может быть использован как SSRF-прокси и работает за NAT. Backend не отдаёт произвольные URL —
только hostname/порт/path из БД своих targets.

### Что проверяется (NetworkCheck)

1. **DNS** — резолв, IP, латентность. Именно *этот* IP проверяется SSRF-фильтром и именно к нему идёт соединение
   (защита от DNS rebinding).
2. **TCP** — connect к IP:port: латентность, `TCP_TIMEOUT` / `TCP_REFUSED` / `TCP_RESET` / `TCP_UNREACHABLE`.
3. **TLS** (https) — handshake, цепочка, hostname, срок: `TLS_CERT_EXPIRED` / `TLS_HOSTNAME_MISMATCH` / `TLS_CERT_INVALID` / `TLS_TIMEOUT`.
   Сертификат ≤ `certWarnDays` (по умолчанию 7) → отдельный алерт раз в сутки.
4. **HTTP** — `GET path` по уже установленному соединению; успех, если код входит в `expectedStatusCodes`
   (редиректы не следуем). Латентность = время до заголовков ответа.

Проверка останавливается на первой упавшей стадии — вы видите *где именно* сбой (DNS/TCP/TLS/HTTP), а не просто «timeout».

### Модель данных (Prisma, `prisma/schema.prisma`)

`MonitoringTarget`, `InfraGroup`, `Probe`, `ProbeTarget` (назначение + state machine пары), `CheckJob` (очередь),
`CheckResult`, `CheckAggregate` (hour/day), `TargetState` (агрегат), `Incident`, `Alert` (outbox).
Отличия от минимального списка ТЗ: добавлены `CheckJob` (вместо Redis), `InfraGroup`, `CheckAggregate`;
состояние пары probe×target хранится в `ProbeTarget`, агрегат — в `TargetState`. Частичный уникальный индекс
`CheckJob_active_scheduled_uniq` физически исключает наложение проверок одной пары.
Удаление target каскадно удаляет его историю и инциденты.

### State machine

Для каждой пары probe×target (пороги настраиваются на target: `failureThreshold`=3, `recoveryThreshold`=2):

```
UNKNOWN ─ok→ UP ─fail→ DEGRADED ─(failStreak ≥ failureThreshold)→ DOWN
DOWN ─ok→ DEGRADED ─(okStreak ≥ recoveryThreshold)→ UP
```

Одна неудача → только `DEGRADED`, алерта нет. Ручные проверки («Проверить сейчас») состояние не меняют.

Агрегация по регионам (offline-probes **не учитываются** — регион становится `UNKNOWN`):

| RU | EU | Классификация | Статус |
|---|---|---|---|
| DOWN | UP | `RU_UNAVAILABLE` | DOWN |
| DOWN | DOWN | `GLOBAL_OUTAGE` | DOWN |
| UP | UP | `HEALTHY` | UP |
| UP | DOWN | `REGIONAL_OUTAGE` | DOWN |
| DOWN | probe offline | `RU_UNAVAILABLE` + пометка «не подтверждено» | DOWN |
| **probe offline** | UP | `PROBE_UNAVAILABLE` | **UNKNOWN** (не «DOWN в РФ») |

Incident открывается при переходе в `DOWN` (один алерт) и закрывается при возврате в `UP` (один алерт
«восстановлен» с длительностью). Пока target `DEGRADED` после аварии, инцидент открыт и тих. Напоминания
о долгой аварии — `REMINDER_MINUTES` (по умолчанию выключено). Алерты пишутся в БД с уникальным
`dedupeKey`, отправляются с повтором (backoff до 15 мин) — недоступный Telegram ничего не теряет.

### Heartbeat

Probe шлёт heartbeat каждые 15 с. Нет heartbeat > `PROBE_OFFLINE_AFTER` (90 с) → probe `OFFLINE`, админам
приходит «Probe … недоступен», его задания отменяются, targets региона → `UNKNOWN`. Возврат → «снова на связи»
и немедленная перепроверка.

### API Backend ↔ Probe

Все вызовы `POST {PUBLIC_URL}/api/probe/<endpoint>`, JSON. Токен probe = `<probeId>.<keyVersion>.<secret>`,
где `secret = HMAC(PROBE_SIGNING_SECRET, "probe:<id>:<version>")` (backend секреты не хранит; «♻️ Новый токен»
в боте мгновенно инвалидирует старый). Заголовки: `X-Probe-Id`, `X-Probe-Key-Version`, `X-Timestamp` (ms),
`X-Nonce`, `X-Signature = HMAC-SHA256(secret, ts \n nonce \n METHOD \n path \n sha256(body))`.
Backend отвергает сдвиг времени > 60 с и повтор nonce (replay), одинаково отвечает на «нет probe» и «неверная
подпись». Ответ подписан (`X-Signature`, привязан к nonce запроса) — probe не выполнит подделанное задание.
Контракт типов: `src/shared/contracts.ts`.

| Endpoint | Запрос | Ответ |
|---|---|---|
| `/heartbeat` | `{version, hostname, uptimeSec, activeJobs}` | `{probe:{id,name,region,…}}` |
| `/poll` | `{maxJobs}` (long-poll до 20 с) | `{jobs:[{id, kind, expiresAt, target:{hostname, protocol, port, path, expectedStatusCodes, timeoutMs, certWarnDays, allowPrivate, checkType}}]}` |
| `/results` | `{jobId, success, failedStage, dns*/tcp*/tls*/http* …, resolvedIp, tlsCertExpiresAt, errorType, errorMessage}` | `{ok:true}` (`409` — задание уже неактивно) |

### Безопасность

* Бот отвечает только `TELEGRAM_ADMIN_IDS`, остальным — «Доступ запрещён» (попытки логируются).
* SSRF: запрещены `localhost`, `*.internal/.local`, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 (metadata),
  100.64/10, IPv6 loopback/ULA/link-local, IPv4-mapped; проверка hostname при создании *и* IP после DNS на probe.
  Внутренний адрес можно разрешить явно для конкретного target («Внутренние адреса» в редактировании).
* Секреты (`token`, `secret`, `password`, `signature`, `nonce`) редактируются в логах; контейнеры probe:
  read-only FS, `cap_drop: ALL`, `no-new-privileges`, без node_modules.
* Ограничение частоты неудачных аутентификаций по IP. Токен probe показывается в боте — удаляйте сообщение (кнопка есть).

### Хранение данных

| Данные | Срок |
|---|---|
| сырые `CheckResult` | 7 дней (`RAW_RETENTION_DAYS`) |
| почасовые агрегаты | 90 дней (`HOURLY_RETENTION_DAYS`) |
| посуточные агрегаты | бессрочно (байты на target×probe×день) |
| инциденты | бессрочно |

Агрегация и очистка — раз в час, идемпотентно.

### XRAY_E2E (этап 2)

Тип `CheckType.XRAY_E2E` уже есть в схеме и контракте, `XrayE2ECheck` зарегистрирован как заглушка
(`NOT_IMPLEMENTED`). Реализация = запуск временного Xray-клиента на probe с monitoring-подпиской и запрос к
контрольному endpoint через туннель, возвращающий тот же `ResultPayload`. Scheduler, state machine, алерты
и бот менять не нужно; в мастере бота тип пока не предлагается.

### Telegram

Дашборд (группы → targets со статусами, probes), 🌐 Серверы / ☁️ CDN, карточка target (по каждому probe:
DNS/TCP/TLS/HTTP, IP, время последней проверки, uptime 24ч, срок сертификата, классификация),
**🔄 Проверить сейчас** (внеочередные задания на все online probes, сообщение обновляется по готовности),
📡 Probes (добавление, токен, ротация, вкл/выкл, удаление), 🚨 Инциденты, 📊 Статистика (uptime 24ч/7д и средний
ответ по регионам), ⚙️ Настройки (targets, группы). Часовой пояс сообщений — `TZ` в `.env`.

## Разработка

```bash
npm install && npm run build && npm test     # юнит-тесты state machine / SSRF / подписей
```
