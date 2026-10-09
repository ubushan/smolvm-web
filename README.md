# smolvm-web

Веб-интерфейс для [smolvm](https://github.com/smol-machines/smolvm), чтобы запускать ИИ-агентов в изолированных microVM и гибко управлять этой изоляцией. Работает поверх локального HTTP API (`smolvm serve`), без зависимостей и сборки.

**Инструкции по использованию и настройке — в [documentation.md](documentation.md).**

## Функционал

**Машины и агенты**
- Создание, запуск, пауза, остановка, ветки (copy-on-write клон) и удаление microVM; образ, ресурсы, порты, переменные, монтирования, restart policy.
- Создание по Smolfile (TOML) с командами `init` при первом запуске.
- Профили агентов: Claude Code, OpenCode, DeepSeek Harness ставятся одним кликом, открываются в новой вкладке браузера и умеют выполнять задачи без интерфейса.
- Консоль, логи, файловый менеджер (загрузка и скачивание), образы, загрузка хоста.

**Изоляция**
- **Доступ в сеть.** Allow list ресурсов интернета для каждой машины: фильтрующий прокси на хосте, списки правил с шаблонами (домены, поддомены, IP/CIDR, порты), режим обучения, жёсткая изоляция через egress-политику smolvm, защита сервисов хоста и внутренней сети.
- **Директории.** Реестр разрешённых папок хоста с максимумом прав и права «запись / чтение / нет доступа» для конкретных пользователей внутри машины, с проверкой фактических прав.
- **Секреты.** Зашифрованное хранилище API-ключей: агент пользуется ключом через шлюз на хосте, но не видит его значения.
- **Корпоративный прокси.** Автоопределение, корпоративные сертификаты (TLS-инспекция), настройка гостя (pip, npm, apt, git).

**Контроль и страховка**
- **Ревью изменений.** Агент работает с рабочей копией папки; изменения на хост попадают только после просмотра diff и подтверждения.
- **Снимки и откат.** Снимок машины перед запуском агента, откат одной кнопкой.
- **Журнал соединений.** Все обращения машин в сеть, разрешение заблокированного одной кнопкой.
- **Аудит.** Команды, изменения файлов и настроек; экспорт в JSONL, отправка в SIEM (syslog, HTTP), оповещения о всплесках блокировок.

## Требования

- `smolvm` в `PATH` ([установка](https://github.com/smol-machines/smolvm#install)).
- Node.js ≥ 18; для сертификатов из хранилища ОС — ≥ 22.15.
- Windows: x64, включённая Windows Hypervisor Platform, PowerShell от администратора (подробно — в [INSTALL.md](INSTALL.md)).

## Развёртывание

Установка smolvm:

```bash
brew install smol-machines/tap/smolvm                  # macOS (Homebrew)
curl -sSL https://smolmachines.com/install.sh | bash   # macOS + Linux
```

Windows — архив `windows-x86_64` со [страницы релизов](https://github.com/smol-machines/smolvm/releases), пошагово в [INSTALL.md](INSTALL.md).

Получение smolvm-web:

```bash
git clone https://github.com/ubushan/smolvm-web.git
cd smolvm-web
```

`npm install` не нужен. Перенос на другой компьютер архивом:

```bash
npm pack                                   # → smolvm-web-<версия>.tgz
mkdir smolvm-web && tar -xzf smolvm-web-*.tgz -C smolvm-web --strip-components=1
```

## Запуск

**macOS / Linux**

```bash
./start.sh                                 # = node server.js --autostart
```

**Windows** (cmd или PowerShell от администратора)

```bat
start.cmd
```

Откройте <http://127.0.0.1:7777>. `--autostart` сам поднимает `smolvm serve`, если он не запущен. Остановка — `Ctrl+C` (машины продолжают работать).

Другой порт или путь к smolvm:

```bash
PORT=7800 SMOLVM_BIN=/opt/smolvm/smolvm ./start.sh
```

```bat
set PORT=7800 && start.cmd
```

Без автозапуска `smolvm serve` (если он уже работает отдельно):

```bash
smolvm serve start --listen unix:///tmp/smolvm.sock    # Windows: --listen 127.0.0.1:18899
node server.js
```

Автозапуск при входе в Windows:

```powershell
schtasks /Create /TN "smolvm-web" /SC ONLOGON /RL HIGHEST /TR "C:\smolvm-web\start.cmd"
```

Все переменные окружения и настройки — в [documentation.md](documentation.md#параметры-запуска).
