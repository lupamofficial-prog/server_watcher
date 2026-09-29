# Техническое задание: Haze Infrastructure Monitoring System

## 1. Роль агента

Ты выступаешь как **Senior Backend / DevOps Engineer**.

Необходимо спроектировать и реализовать production-ready систему мониторинга инфраструктуры VPN-сервиса.

Основные технологии проекта:

- TypeScript;
- Node.js;
- Telegram Bot API;
- GrammyJS;
- PostgreSQL;
- Prisma ORM;
- Docker / Docker Compose.

Допускается использование Redis/BullMQ, если это действительно оправдано архитектурой.

Код должен быть модульным, расширяемым и рассчитанным на дальнейшее увеличение количества серверов, CDN-доменов и точек мониторинга.

---

# 2. Задача

Необходимо разработать закрытого Telegram-бота для мониторинга инфраструктуры VPN-сервиса.

Бот доступен **только администраторам**, Telegram ID которых задаются через конфигурацию/environment variables либо хранятся в БД.

Система должна в реальном времени отслеживать:

1. доступность VPN-серверов из России;
2. доступность CDN hostname из России;
3. доступность тех же ресурсов из зарубежной сети;
4. DNS;
5. TCP;
6. TLS;
7. HTTP/HTTPS;
8. задержку ответа;
9. изменение состояния инфраструктуры.

При возникновении проблемы администратор должен автоматически получить уведомление в Telegram.

После восстановления также обязательно отправляется уведомление.

---

# 3. Важный архитектурный принцип

Нельзя определять доступность из России только с сервера, на котором запущен основной monitoring backend.

Необходимо использовать архитектуру:

```text
                         ┌─────────────────────────┐
                         │   Monitoring Backend    │
                         │                         │
                         │ PostgreSQL / Scheduler  │
                         │ Telegram Bot / Alerts   │
                         └────────────┬────────────┘
                                      │
                         ┌────────────┴─────────────┐
                         │                          │
                         ▼                          ▼
              ┌───────────────────┐      ┌────────────────────┐
              │ Russia Probe      │      │ External Probe     │
              │                   │      │                    │
              │ VPS / РФ network  │      │ EU VPS             │
              └─────────┬─────────┘      └─────────┬──────────┘
                        │                          │
                        ▼                          ▼
                 Server / CDN                Server / CDN
```

### Russia Probe

Небольшой агент, физически находящийся на VPS в России.

Именно его результаты считаются источником истины для:

> Доступен ли ресурс пользователю из РФ?

### External Probe

Второй агент должен находиться за пределами РФ, например в Германии, Нидерландах, Финляндии, Польше и т.п.

Он нужен для определения характера аварии.

Например:

```text
Russia: FAIL
Europe: OK
```

означает:

```text
REGIONAL_OUTAGE / RU_UNAVAILABLE
```

То есть ресурс работает, но проблема наблюдается со стороны России.

Если:

```text
Russia: FAIL
Europe: FAIL
```

с высокой вероятностью проблема непосредственно с сервером, CDN, DNS или hostname.

---

# 4. Не использовать proxy как основной способ проверки РФ

Не строить основной мониторинг РФ на публичных/случайных proxy.

Proxy может сам:

- перестать работать;
- иметь плохую маршрутизацию;
- блокировать запросы;
- находиться фактически не там, где заявлено;
- вносить дополнительный timeout;
- иметь собственные DNS-проблемы.

Предпочтительная схема:

```text
Monitoring Backend
        ↓
Monitoring Agent
        ↓
реальная сеть российского VPS
        ↓
Target
```

Proxy допускаются только как дополнительные диагностические точки, но не как основной источник состояния.

---

# 5. Probe Agent

Необходимо разработать отдельный легковесный сервис:

```text
monitoring-agent
```

Он должен запускаться через Docker на любом VPS.

Например:

```text
REGION=RU
LOCATION=moscow
PROVIDER=example
AGENT_TOKEN=...
BACKEND_URL=...
```

Агент должен быть максимально stateless.

Monitoring Backend должен иметь возможность принимать результаты нескольких агентов:

```text
RU-Moscow-1
RU-Moscow-2
DE-Frankfurt-1
NL-Amsterdam-1
```

Архитектура изначально должна поддерживать N probe-агентов.

---

# 6. Что именно проверять

Не ограничиваться обычным:

```text
GET https://hostname
```

Необходимо реализовать несколько уровней проверки.

## Level 1 — DNS

Проверить разрешение hostname.

Сохранять:

```text
resolved IP
DNS latency
DNS error
```

Пример:

```text
cdn.example.com
↓
104.x.x.x
```

---

## Level 2 — TCP

Попытка TCP connection:

```text
hostname:443
```

Измерять:

```text
connection latency
timeout
connection refused
```

---

## Level 3 — TLS

Для HTTPS проверить TLS handshake.

Сохранять:

```text
TLS success
certificate expiration
certificate hostname validation
TLS handshake latency
```

При приближении срока окончания сертификата должна существовать возможность отдельного предупреждения.

Например:

```text
TLS certificate expires in 7 days
```

---

## Level 4 — HTTP

Выполнить запрос:

```text
GET /health-path
```

или configurable path.

Для каждого target необходимо задавать:

```text
hostname
protocol
port
path
expectedStatusCodes
timeout
```

Например:

```json
{
  "name": "RU CDN #1",
  "hostname": "cdn.example.com",
  "protocol": "https",
  "port": 443,
  "path": "/",
  "expectedStatusCodes": [200, 301, 302, 403, 404],
  "timeoutMs": 5000
}
```

Важно:

Для CDN/VPN endpoint наличие HTTP 403/404 **не обязательно означает проблему**.

Если:

- DNS работает;
- TCP connection установлен;
- TLS handshake успешен;
- CDN отвечает HTTP;

это уже может означать, что инфраструктура доступна.

Поэтому допустимые HTTP status codes должны конфигурироваться отдельно для каждого target.

---

# 7. XHTTP/CDN

Инфраструктура использует VPN через:

```text
VLESS
↓
XHTTP
↓
CDN
↓
origin
```

Поэтому CDN необходимо мониторить отдельно от origin.

Пример сущностей:

```text
Node: Germany #1

Origin:
de-origin.example.com

CDN:
de-cdn.example.com
```

Проверять:

```text
RU → Origin
RU → CDN

EU → Origin
EU → CDN
```

Это позволит диагностировать:

```text
Origin UP
CDN DOWN
```

или:

```text
Origin DOWN
CDN UP
```

или:

```text
RU CDN DOWN
EU CDN UP
```

---

# 8. Будущее расширение: VPN End-to-End Check

Архитектура должна предусматривать новый тип проверки:

```text
XRAY_E2E
```

На первом этапе его можно не реализовывать, если это существенно усложняет MVP.

В дальнейшем Russia Probe должен иметь возможность поднять тестовый Xray client с отдельной monitoring subscription/configuration и выполнить:

```text
RU Probe
   ↓
VPN configuration
   ↓
CDN
   ↓
XHTTP
   ↓
Xray Node
   ↓
Internet
```

После установления VPN соединения выполнить запрос к контрольному endpoint.

Это позволит отличить:

```text
CDN hostname открывается
```

от:

```text
VPN через этот CDN действительно работает
```

Архитектуру checks необходимо построить через интерфейсы/стратегии так, чтобы `XRAY_E2E` можно было добавить без переписывания существующей системы.

Например:

```text
CheckStrategy

DNSCheck
TCPCheck
TLSCheck
HTTPCheck
XRAYE2ECheck
```

---

# 9. Модель инфраструктуры

Не хардкодить hostname в исходном коде.

Все endpoints должны храниться в БД.

Предусмотреть примерно следующую структуру:

```text
MonitoringTarget
- id
- name
- type
- hostname
- protocol
- port
- path
- enabled
- intervalSeconds
- timeoutMs
- failureThreshold
- recoveryThreshold
- expectedStatusCodes
- createdAt
- updatedAt
```

Типы:

```text
ORIGIN
CDN
PANEL
SUBSCRIPTION
API
CUSTOM
```

Также предусмотреть связь target с VPN node / infrastructure group.

Например:

```text
InfrastructureGroup

Germany LTE
├── Origin
├── CDN #1
├── CDN #2
└── Subscription endpoint
```

---

# 10. Probe

Создать сущность:

```text
Probe
```

Пример:

```text
id
name
region
countryCode
provider
enabled
lastSeenAt
status
```

Например:

```text
Russia / Moscow
Russia / SPB
Germany / Frankfurt
```

Target должен иметь настройку:

```text
probeIds
```

либо правила:

```text
requiredRegions:
- RU
- EU
```

Продумать наиболее правильную реляционную модель самостоятельно.

---

# 11. Результаты проверки

Каждая проверка должна сохранять:

```text
CheckResult
```

Минимально:

```text
targetId
probeId
timestamp

dnsSuccess
dnsLatencyMs

tcpSuccess
tcpLatencyMs

tlsSuccess
tlsLatencyMs

httpSuccess
httpStatus
httpLatencyMs

totalLatencyMs

resolvedIp
errorType
errorMessage
```

Необходимо предусмотреть очистку/агрегацию старых данных, чтобы таблица бесконечно не росла.

Например:

```text
raw checks → 7 дней
hourly aggregates → 30/90 дней
daily aggregates → долгосрочно
```

Конкретную стратегию предложить самостоятельно.

---

# 12. State Machine

Один неудачный запрос не должен сразу создавать аварийное уведомление.

Использовать состояния:

```text
UP
DEGRADED
DOWN
UNKNOWN
```

Например:

```text
UP
↓
1 failed check
↓
DEGRADED
↓
3 consecutive failed checks
↓
DOWN
```

После восстановления:

```text
DOWN
↓
1 success
↓
DEGRADED
↓
2-3 consecutive successes
↓
UP
```

Порог должен конфигурироваться.

Например:

```text
failureThreshold = 3
recoveryThreshold = 2
```

---

# 13. Диагностика региональной недоступности

Backend должен сопоставлять результаты probe.

Пример:

```text
RU: DOWN
DE: UP
```

Classification:

```text
RU_UNAVAILABLE
```

---

```text
RU: DOWN
DE: DOWN
```

Classification:

```text
GLOBAL_OUTAGE
```

---

```text
RU: UP
DE: UP
```

Classification:

```text
HEALTHY
```

Необходимо продумать поведение при:

```text
RU Probe itself DOWN
```

В этом случае нельзя сообщать:

```text
Target DOWN in Russia
```

потому что неизвестно, упал target или сам probe.

Состояние должно быть:

```text
UNKNOWN
```

или:

```text
PROBE_UNAVAILABLE
```

---

# 14. Heartbeat Probe

Каждый probe должен регулярно отправлять heartbeat.

Например:

```text
каждые 10-30 секунд
```

Backend отслеживает:

```text
lastSeenAt
```

Если heartbeat отсутствует слишком долго:

```text
Probe RU-Moscow-1 unavailable
```

Администратор получает отдельное уведомление.

---

# 15. Telegram Bot

Telegram-бот доступен только whitelist администраторам.

Любой неизвестный Telegram ID должен получать отказ в доступе.

Необходимо реализовать dashboard.

Главный экран:

```text
🟢 Infrastructure

🇷🇺 Russia Probe
🟢 Online

🇩🇪 Germany #1
Origin     🟢
CDN        🟢

🇳🇱 Netherlands #1
Origin     🟢
CDN        🔴
```

Inline buttons:

```text
🔄 Обновить
🌐 Серверы
☁️ CDN
📡 Probes
🚨 Инциденты
📊 Статистика
⚙️ Настройки
```

---

# 16. Карточка Target

При выборе target показать:

```text
Germany CDN #1

Status: 🟢 UP

Russia:
🟢 Available
DNS: 31 ms
TCP: 48 ms
TLS: 92 ms
HTTP: 124 ms

Europe:
🟢 Available
DNS: 8 ms
TCP: 13 ms
TLS: 29 ms
HTTP: 41 ms

IP:
104.x.x.x

Last check:
12 sec ago

Uptime 24h:
99.98%
```

---

# 17. Real-time refresh

Кнопка:

```text
🔄 Проверить сейчас
```

должна запускать внеочередную проверку target через необходимые probes.

Не просто показывать последний сохраненный результат.

UI должен сообщить:

```text
⏳ Выполняется проверка...
```

и после получения результатов обновить сообщение.

---

# 18. Alerts

При переходе:

```text
UP → DOWN
```

отправить:

```text
🔴 Germany CDN #1 недоступен из России

Ошибка:
TLS timeout

RU Probe:
Moscow #1

Europe:
🟢 доступен

Предварительная классификация:
Недоступность со стороны РФ

Начало:
21:43:12
```

---

При восстановлении:

```text
🟢 Germany CDN #1 восстановлен

Недоступность:
4 мин 31 сек

Russia:
🟢 доступен

Europe:
🟢 доступен

Response:
132 ms
```

---

# 19. Защита от alert spam

Обязательно реализовать deduplication.

Нельзя отправлять:

```text
DOWN
DOWN
DOWN
DOWN
DOWN
```

Уведомление отправляется при **изменении состояния**.

Например:

```text
UP → DOWN
```

и затем:

```text
DOWN → UP
```

Для продолжительной аварии можно предусмотреть configurable reminder:

```text
still DOWN after 30 minutes
```

но по умолчанию не спамить.

---

# 20. Incident

При DOWN автоматически создавать:

```text
Incident
```

Хранить:

```text
startedAt
resolvedAt
duration
target
affectedRegions
reason
classification
```

После восстановления incident автоматически закрывается.

---

# 21. Масштабируемость

Добавление нового CDN не должно требовать изменения исходного кода.

Администратор должен иметь возможность добавить target через Telegram Bot:

```text
⚙️ Настройки
→ Targets
→ Добавить
```

Например:

```text
Name:
Germany CDN #2

Type:
CDN

Hostname:
cdn2.example.com

Port:
443

Protocol:
HTTPS

Path:
/

Regions:
RU + EU

Interval:
30 sec

Timeout:
5 sec
```

После сохранения endpoint автоматически включается в monitoring.

Также должна существовать возможность:

```text
редактировать target;
выключить monitoring;
удалить target;
изменить interval;
изменить timeout;
назначить probes;
изменить thresholds.
```

---

# 22. Scheduler

Нельзя делать архитектуру вида:

```ts
setInterval(() => {
  checkEverything();
}, 30000);
```

Продумать нормальную систему scheduling.

Необходимо исключить ситуацию, когда медленные проверки накладываются друг на друга.

Допускается использование:

```text
BullMQ
Redis
```

или другой подходящей архитектуры.

При использовании BullMQ:

```text
monitoring scheduler
        ↓
check jobs
        ↓
workers
        ↓
probe requests
        ↓
results
```

Обеспечить:

- concurrency control;
- timeout;
- retry;
- job deduplication;
- отсутствие overlapping checks.

---

# 23. Security

Probe API обязательно защитить.

Нельзя позволять произвольному пользователю использовать probes как SSRF proxy.

Probe должен принимать запросы только от Monitoring Backend.

Использовать:

```text
API token
```

или предпочтительно:

```text
HMAC signed requests
```

Продумать:

```text
timestamp;
nonce;
signature;
replay protection.
```

Target URL нельзя передавать probe как полностью произвольный URL без серверной валидации.

Backend должен контролировать разрешенные targets.

Не логировать секреты.

---

# 24. SSRF protection

Так как система фактически выполняет HTTP-запросы по команде backend, обязательно предусмотреть SSRF-защиту.

Запретить обращения к:

```text
127.0.0.0/8
localhost
169.254.169.254
private networks
metadata endpoints
```

за исключением явно разрешенных администратором инфраструктурных адресов.

После DNS resolution также проверять полученный IP, чтобы исключить DNS rebinding.

---

# 25. Observability

Сам monitoring также должен быть наблюдаемым.

Добавить structured logging.

Минимальные события:

```text
CHECK_STARTED
CHECK_COMPLETED
CHECK_FAILED

STATE_CHANGED

INCIDENT_CREATED
INCIDENT_RESOLVED

PROBE_CONNECTED
PROBE_DISCONNECTED

ALERT_SENT
ALERT_FAILED
```

Необходимо использовать correlation/check ID.

---

# 26. Graceful degradation

Если PostgreSQL временно недоступен, probe не должен падать навсегда.

Если Telegram API недоступен:

```text
alert
```

необходимо повторить позже.

Если один probe недоступен:

```text
остальные probes
```

должны продолжать работать.

---

# 27. Docker

Подготовить Docker Compose.

Пример:

```text
monitoring-backend
monitoring-worker
postgres
redis
```

Probe должен иметь отдельный compose:

```text
monitoring-agent
```

чтобы его можно было установить на новый VPS примерно следующим образом:

```bash
git clone ...
cp .env.example .env
docker compose up -d
```

---

# 28. Configuration

Подготовить:

```text
.env.example
```

Backend:

```text
DATABASE_URL=
REDIS_URL=

TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_IDS=

PROBE_SIGNING_SECRET=
```

Agent:

```text
PROBE_ID=
PROBE_NAME=
PROBE_REGION=
PROBE_COUNTRY=
BACKEND_URL=
PROBE_TOKEN=
```

Не использовать реальные secrets в repository.

---

# 29. Prisma

Создать production-ready Prisma schema.

Минимальные сущности:

```text
MonitoringTarget
Probe
ProbeTarget
CheckResult
TargetState
Incident
Alert
```

Если считаешь необходимой другую структуру — изменить её и объяснить решение.

Все migrations должны быть безопасными.

---

# 30. Предлагаемая структура проекта

Архитектура может выглядеть примерно так:

```text
apps/
  backend/
  worker/
  telegram-bot/
  probe/

packages/
  database/
  monitoring/
  contracts/
  logger/
```

Но сначала самостоятельно оценить, действительно ли нужны отдельные процессы.

Не создавать микросервисы только ради микросервисов.

Предпочтение:

> modular monolith + отдельно deployable Probe Agent

если этого достаточно для поставленной задачи.

---

# 31. Monitoring Engine

Monitoring Engine не должен зависеть от Telegram.

Правильное разделение:

```text
Monitoring Engine
        ↓
Events
        ↓
Incident Manager
        ↓
Notification Service
        ↓
Telegram
```

То есть Telegram является лишь одним из notification adapters.

В будущем должна существовать возможность добавить:

```text
Email
Webhook
Discord
Grafana
```

без изменения monitoring core.

---

# 32. MVP

Первый production MVP должен включать:

### Monitoring

- DNS;
- TCP;
- TLS;
- HTTP;
- latency;
- RU probe;
- EU probe;
- heartbeat;
- configurable intervals;
- configurable timeout.

### Detection

- UP;
- DEGRADED;
- DOWN;
- UNKNOWN;
- regional outage detection;
- consecutive failure threshold;
- recovery threshold.

### Telegram

- закрытый доступ;
- dashboard;
- target details;
- probes;
- incidents;
- manual check;
- alerts;
- recovery alerts.

### Administration

- создание target;
- редактирование;
- удаление;
- enable/disable;
- выбор probes.

---

# 33. Второй этап

Архитектурно подготовиться к:

```text
XRAY_E2E
```

чтобы проверять не просто доступность CDN hostname, а реальное прохождение:

```text
Russia
→ CDN
→ XHTTP
→ Xray
→ outbound
→ Internet
```

Это станет наиболее достоверным health-check непосредственно VPN-сервиса.

---

# 34. Что требуется от агента перед реализацией

Перед написанием кода:

1. Изучить требования.
2. Предложить итоговую архитектуру.
3. Определить компоненты системы.
4. Описать поток данных:

```text
Scheduler
→ Probe
→ Target
→ Result
→ State evaluation
→ Incident
→ Alert
→ Telegram
```

5. Определить Prisma schema.
6. Определить API contract между Backend и Probe.
7. Продумать state machine.
8. Продумать security.
9. Только после этого приступать к реализации.

Не усложнять систему без необходимости.

---

# 35. Критерий качества

Главный вопрос, на который должна отвечать система:

> Работает ли сейчас конкретный VPN endpoint для пользователя из России?

А если нет:

> Это проблема российского доступа, CDN, origin, DNS/TLS, самого сервера или monitoring probe?

Недостаточно просто сообщить:

```text
hostname timeout
```

Система должна собрать достаточно диагностических данных, чтобы администратор быстро понял, где находится проблема.

---

# 36. Финальный результат

По завершении необходимо предоставить:

```text
1. Полностью рабочий исходный код.
2. Prisma schema и migrations.
3. Docker Compose для backend.
4. Docker Compose для probe.
5. .env.example.
6. README.md.
7. Инструкцию установки RU Probe.
8. Инструкцию установки EU Probe.
9. Инструкцию добавления новых targets.
10. Описание Monitoring Engine.
11. Описание API Backend ↔ Probe.
12. Описание state machine.
13. Инструкцию production deployment.
```

README должен позволять развернуть систему с нуля без необходимости разбираться в исходном коде.

## Основной принцип реализации

Система должна проектироваться не как «Telegram-бот, который иногда делает curl», а как полноценный небольшой **Infrastructure Monitoring Service**, где Telegram-бот является интерфейсом администратора.

Приоритеты:

```text
reliability
→ correct regional detection
→ low false-positive rate
→ useful diagnostics
→ simple administration
→ scalability
```
# 37. Критически важное требование — Zero-Hassle Deployment

Система должна быть рассчитана на **максимально простой запуск с нуля**.

Главный принцип:

> На чистом VPS с установленными Docker и Docker Compose развертывание системы не должно требовать ручной настройки Node.js, PostgreSQL, Redis, Prisma, npm-пакетов или других зависимостей.

Все компоненты должны быть полностью контейнеризированы.

---

## Backend

Production-развертывание Monitoring Backend должно сводиться к:

```bash
git clone <repository>
cd <repository>
cp .env.example .env
nano .env
docker compose up -d
```

После заполнения `.env` пользователь выполняет:

```bash
docker compose up -d
```

И система должна самостоятельно:

1. скачать/build необходимые Docker images;
2. поднять PostgreSQL;
3. поднять Redis, если он используется;
4. дождаться готовности PostgreSQL;
5. автоматически применить Prisma migrations;
6. выполнить необходимый bootstrap;
7. поднять Monitoring Backend;
8. поднять worker/scheduler;
9. запустить Telegram Bot;
10. начать принимать подключения monitoring probes;
11. автоматически восстановиться после reboot VPS.

Не должно требоваться отдельно выполнять:

```bash
npm install
npm run build
npx prisma generate
npx prisma migrate deploy
node ...
```

Все это должно происходить внутри Docker lifecycle.

---

# 38. Probe — установка одной командой

Monitoring Probe является отдельным deployable компонентом.

Его установка на новый VPS должна быть максимально простой.

Минимально допустимый вариант:

```bash
git clone <repository>
cd probe
cp .env.example .env
nano .env
docker compose up -d
```

После этого Probe должен автоматически:

```text
запуститься
→ подключиться к Monitoring Backend
→ пройти авторизацию
→ зарегистрироваться / подтвердить существующую регистрацию
→ начать heartbeat
→ начать выполнять проверки
```

Никаких ручных:

```text
npm install
Node.js installation
Prisma
systemd
cron
PM2
ручного создания конфигураций
```

быть не должно.

---

# 39. Желательный вариант установки Probe

Предусмотреть возможность еще более простой установки нового Probe.

Например:

```bash
curl -fsSL https://monitor.example.com/install.sh | bash
```

или:

```bash
PROBE_TOKEN=xxx curl -fsSL https://monitor.example.com/install.sh | bash
```

Installation script должен:

```text
1. проверить наличие Docker;
2. при необходимости понятно сообщить, что необходимо установить;
3. создать директорию приложения;
4. скачать docker-compose.yml;
5. создать конфигурацию;
6. скачать Docker image;
7. выполнить docker compose up -d;
8. проверить healthcheck;
9. показать результат установки.
```

Пример результата:

```text
Haze Monitoring Probe

✓ Docker detected
✓ Configuration created
✓ Image downloaded
✓ Container started
✓ Backend connected
✓ Probe registered
✓ Heartbeat active

Probe:
RU-Moscow-1

Status:
ONLINE

Installation completed successfully.
```

При этом installation script не должен содержать секреты непосредственно в публичном repository.

---

# 40. Prebuilt Docker Images

Архитектура должна предусматривать публикацию готовых Docker images.

Например:

```text
ghcr.io/<organization>/haze-monitor:latest
ghcr.io/<organization>/haze-monitor-probe:latest
```

Production VPS желательно не заставлять самостоятельно компилировать TypeScript-приложение.

Предпочтительная схема:

```text
Git repository
      ↓
CI/CD
      ↓
Docker build
      ↓
Container Registry
      ↓
VPS
      ↓
docker compose pull
      ↓
docker compose up -d
```

При первоначальной разработке допустим локальный Docker build через Compose.

---

# 41. Обновление системы

Обновление должно быть таким же простым, как установка.

Целевой вариант:

```bash
docker compose pull
docker compose up -d
```

или:

```bash
./update.sh
```

`update.sh` должен самостоятельно:

```text
pull images
→ restart changed containers
→ execute safe database migrations
→ healthcheck
→ report result
```

Обновление не должно требовать ручной установки зависимостей.

---

# 42. Persistence

Все данные должны переживать:

```bash
docker compose down
docker compose up -d
```

и перезагрузку VPS.

Использовать Docker volumes для:

```text
PostgreSQL
Redis — если persistence действительно необходим
других persistent данных
```

Команда:

```bash
docker compose down
```

не должна удалять данные.

Не использовать `down -v` в installation/update scripts.

---

# 43. Docker Healthchecks

Для критических контейнеров определить Docker healthcheck.

Минимально:

```text
PostgreSQL
Monitoring Backend
Worker
Probe
```

Пример:

```bash
docker compose ps
```

должен давать понятную картину:

```text
monitor-backend     Up (healthy)
monitor-postgres    Up (healthy)
monitor-redis       Up (healthy)
monitor-worker      Up (healthy)
```

На Probe VPS:

```text
monitor-probe       Up (healthy)
```

---

# 44. Dependency startup

Не полагаться только на порядок запуска Docker Compose.

Например Backend не должен падать навсегда из-за того, что PostgreSQL стартует на 3 секунды позже.

Использовать:

```text
healthcheck
depends_on condition
retry/reconnect logic
```

Приложение должно корректно переживать временную недоступность:

```text
PostgreSQL
Redis
Monitoring Backend
Telegram API
```

---

# 45. Automatic migrations

Prisma migrations в production должны применяться автоматически и безопасно через:

```bash
prisma migrate deploy
```

Не использовать:

```bash
prisma migrate dev
```

в production.

Migration должна выполняться автоматически при deployment/update.

Необходимо исключить race condition, когда несколько replicas одновременно пытаются выполнять migration.

Предпочтительно использовать отдельный:

```text
migration/init container
```

например:

```text
postgres
   ↓ healthy

migration
   ↓ completed successfully

backend
worker
telegram
   ↓ start
```

---

# 46. Первый запуск

При первом запуске система должна автоматически определить отсутствие первоначальных данных и выполнить bootstrap.

Необходимо создать только системные значения.

Не создавать fake/demo targets в production.

Telegram administrator определяется через:

```env
TELEGRAM_ADMIN_IDS=123456789
```

После запуска бот должен сразу быть доступен указанному администратору.

---

# 47. Configuration simplicity

`.env.example` должен быть небольшим и понятным.

Не заставлять пользователя конфигурировать десятки внутренних параметров.

Пользователь должен указывать только действительно необходимые значения.

Например:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_IDS=

DATABASE_PASSWORD=

PUBLIC_URL=
PROBE_SIGNING_SECRET=
```

Все остальные настройки должны иметь безопасные значения по умолчанию.

Например:

```text
CHECK_INTERVAL=30
CHECK_TIMEOUT=5000
FAILURE_THRESHOLD=3
RECOVERY_THRESHOLD=2
```

Если параметр можно безопасно определить автоматически — не требовать его от пользователя.

---

# 48. Restart Policy

Все production containers должны иметь подходящую restart policy:

```yaml
restart: unless-stopped
```

После:

```bash
reboot
```

VPS система должна самостоятельно полностью восстановить работу.

Администратор не должен подключаться по SSH и запускать сервис вручную.

---

# 49. Логи

Просмотр логов должен быть максимально простым:

```bash
docker compose logs -f
```

Также желательно предоставить:

```bash
./logs.sh
```

или documented commands:

```bash
docker compose logs -f backend
docker compose logs -f worker
docker compose logs -f probe
```

Не хранить application logs только внутри ephemeral filesystem контейнера.

---

# 50. Backup

Предусмотреть простой backup PostgreSQL.

Например:

```bash
./backup.sh
```

Результат:

```text
./backups/
  monitoring-2026-09-29-234500.sql.gz
```

Backup script должен работать через Docker и не требовать установленного на host:

```text
psql
pg_dump
Node.js
```

Также предоставить инструкцию восстановления.

---

# 51. UX установки является частью продукта

Deployment считается частью реализации, а не дополнительной документацией.

Недопустим результат, при котором приложение технически работает, но для его запуска необходимо вручную:

```text
устанавливать Node.js;
устанавливать PostgreSQL;
устанавливать Redis;
создавать database;
запускать Prisma;
редактировать исходный код;
создавать systemd services;
запускать несколько npm scripts;
вручную регистрировать каждый Probe в БД.
```

Целевой UX:

### Центральный сервер

```bash
cp .env.example .env
nano .env
docker compose up -d
```

**Готово.**

### Новый Monitoring Probe

```bash
PROBE_TOKEN=xxx ./install.sh
```

**Готово.**

### Обновление

```bash
./update.sh
```

**Готово.**

### Проверка

```bash
docker compose ps
```

Все сервисы должны иметь статус:

```text
healthy
```

---

# 52. Acceptance Criteria для Deployment

Перед завершением разработки агент обязан проверить deployment на чистом окружении.

Сценарий:

```text
Clean Ubuntu VPS
↓
Docker + Docker Compose installed
↓
clone repository
↓
.env configuration
↓
docker compose up -d
```

После этого без каких-либо дополнительных действий:

```text
✓ PostgreSQL работает
✓ migrations применены
✓ backend работает
✓ scheduler работает
✓ Telegram Bot работает
✓ administrator авторизован
✓ monitoring запущен
✓ containers healthy
```

Для Probe:

```text
Clean Ubuntu VPS
↓
Docker + Docker Compose installed
↓
install Probe
```

После установки:

```text
✓ container running
✓ backend connected
✓ authentication successful
✓ heartbeat received
✓ Probe ONLINE
✓ monitoring checks available
```

Если для достижения этого состояния требуется выполнить недокументированную ручную команду — deployment считается незавершенным.

---

# 53. Итоговое требование

Проектировать deployment по принципу:

> **Install once, configure minimally, run everywhere.**

Администратор инфраструктуры должен заниматься серверами и VPN, а не ручным обслуживанием самого monitoring-сервиса.

В идеале после первоначального создания `.env` вся дальнейшая эксплуатация должна сводиться к:

```bash
docker compose up -d
docker compose ps
docker compose logs -f
./update.sh
./backup.sh
```

Все остальные технические детали должны быть инкапсулированы внутри Docker.