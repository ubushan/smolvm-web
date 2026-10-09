# smolvm-web

Веб-интерфейс для [smolvm](https://github.com/smol-machines/smolvm), чтобы запускать ИИ-агентов в изолированных microVM и гибко управлять этой изоляцией. Работает поверх локального HTTP API (`smolvm serve`), без зависимостей и сборки.

**Инструкции по использованию и настройке — в [documentation.md](documentation.md).**

## Функционал

**Машины и агенты**
- Создание, запуск, пауза, остановка, ветки (copy-on-write клон) и удаление microVM; образ, ресурсы, порты, переменные, монтирования, restart policy.
- Создание по Smolfile (TOML) с командами `init` при первом запуске.
- Профили агентов: Claude Code, OpenCode, DeepSeek Harness, Codex, Pi и Hermes ставятся одним кликом, открываются в новой вкладке браузера и умеют выполнять задачи без интерфейса. Серверы вендоров (API, вход по подписке) разрешены по умолчанию, любой из них можно отозвать.
- Консоль, логи, файловый менеджер (загрузка и скачивание), образы, загрузка хоста.

**Изоляция**
- **Доступ в сеть.** Allow list ресурсов интернета для каждой машины: фильтрующий прокси на хосте, списки правил с шаблонами (домены, поддомены, IP/CIDR, порты), режим обучения, жёсткая изоляция через egress-политику smolvm, защита сервисов хоста и внутренней сети.
- **Директории.** Реестр разрешённых папок хоста с максимумом прав и права «запись / чтение / нет доступа» для конкретных пользователей внутри машины, с проверкой фактических прав.
- **Секреты.** Зашифрованное хранилище API-ключей: агент пользуется ключом через шлюз на хосте, но не видит его значения. Локальные модели (Ollama, vLLM, LM Studio) — OpenCode, Pi и Hermes настраиваются на них автоматически.
- **Корпоративный прокси.** Автоопределение, системный прокси Windows с PAC и входом под учётной записью Windows (Kerberos/NTLM, без px/proxydetox), корпоративные сертификаты (TLS-инспекция), настройка гостя (pip, npm, apt, git).
- **Корпоративные репозитории.** JFrog Artifactory, Nexus, Harbor: образы Docker Hub через корпоративный реестр с логином, зеркала pip, npm, apt и Go внутри машин.

**Контроль и страховка**
- **Ревью изменений.** Агент работает с рабочей копией папки; изменения на хост попадают только после просмотра diff и подтверждения.
- **Снимки и откат.** Снимок машины перед запуском агента, откат одной кнопкой.
- **Журнал соединений.** Все обращения машин в сеть, разрешение заблокированного одной кнопкой.
- **Аудит.** Команды, изменения файлов и настроек; экспорт в JSONL, отправка в SIEM (syslog, HTTP), оповещения о всплесках блокировок.

## Требования

| Платформа | Что нужно |
|---|---|
| macOS | Apple Silicon (M1 и новее), macOS 11+. На Intel-Mac smolvm не работает. |
| Linux | x86_64 или aarch64, аппаратная виртуализация (KVM, `/dev/kvm`); в виртуалке или облаке — вложенная виртуализация. |
| Windows | Windows 10/11 x64 с Windows Hypervisor Platform, PowerShell от администратора. ARM-Windows не поддерживается. |

Плюс Node.js ≥ 18 (для сертификатов из хранилища ОС — ≥ 22.15). По умолчанию машине выделяется 8 ГиБ памяти (память эластичная, хост отдаёт только то, что гость использует); на слабом хосте задавайте меньше.

## Установка smolvm

### macOS

```bash
brew install smol-machines/tap/smolvm
# или официальный установщик (ставит в ~/.smolvm, запуск — из ~/.local/bin):
curl -sSL https://smolmachines.com/install.sh | bash
```

Два предупреждения установщика про notarization — норма.

### Linux

Официальный установщик (без root, всё в `$HOME`):

```bash
curl -sSL https://smolmachines.com/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"     # установщик добавит это в профиль shell сам
```

Или пакетом (обновляется вместе с системой):

```bash
# Debian / Ubuntu (Debian 12+, Ubuntu 22.04+)
echo 'deb [trusted=yes] https://smol-machines.github.io/smolvm/apt ./' | sudo tee /etc/apt/sources.list.d/smolvm.list
sudo apt-get update && sudo apt-get install smolvm

# Fedora / RHEL
sudo tee /etc/yum.repos.d/smolvm.repo >/dev/null <<'EOF2'
[smolvm]
name=smolvm
baseurl=https://smol-machines.github.io/smolvm/yum
enabled=1
gpgcheck=0
EOF2
sudo dnf install smolvm

# Arch Linux: добавьте в /etc/pacman.conf
#   [smol-machines]
#   SigLevel = Optional TrustAll
#   Server = https://smol-machines.github.io/smolvm/pacman/$arch
sudo pacman -Sy smolvm

# Nix / NixOS
nix profile install github:smol-machines/smolvm
```

Доступ к KVM (один раз). Без него установка проходит, но ни одна машина не запустится (`KVM_DENIED`):

```bash
ls -l /dev/kvm                       # устройство должно существовать
sudo usermod -aG kvm "$USER"         # затем перелогиньтесь или используйте: sg kvm -c '<команда>'
```

### Windows

PowerShell от администратора:

```powershell
# Windows Hypervisor Platform (нужна перезагрузка)
Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform
Restart-Computer

# smolvm: актуальная версия — https://github.com/smol-machines/smolvm/releases
$v = '1.23.7'
Invoke-WebRequest "https://github.com/smol-machines/smolvm/releases/download/v$v/smolvm-$v-windows-x86_64.zip" -OutFile $env:TEMP\smolvm.zip
Expand-Archive $env:TEMP\smolvm.zip C:\smolvm
[Environment]::SetEnvironmentVariable('Path', $env:Path + ";C:\smolvm\smolvm-$v-windows-x86_64", 'Machine')
```

Также включите «Режим разработчика» (Параметры → Система → Для разработчиков). Подробности и частые ошибки — в [INSTALL.md](INSTALL.md).

### За корпоративным прокси

Установщику и пакетным менеджерам нужен прокси в окружении:

```bash
export HTTPS_PROXY=http://proxy.corp.local:3128 HTTP_PROXY=http://proxy.corp.local:3128
curl -sSL https://smolmachines.com/install.sh | bash
```

Для `sudo apt-get`/`dnf` настройте прокси самого пакетного менеджера (`Acquire::https::Proxy` / `proxy=` в `dnf.conf`). Прокси для машин настраивается позже в интерфейсе smolvm-web.

### Проверка

```bash
smolvm --version
smolvm machine run --mem 2048 --net --image alpine -- uname -srm   # должно напечатать Linux …
```

Если Docker Hub отвечает `TOOMANYREQUESTS`, возьмите образ из зеркала: `--image mirror.gcr.io/library/alpine`. За корпоративным прокси эта проверка может не скачать образ — тогда достаточно `smolvm --version`, а прокси для машин включается в интерфейсе.

| Ошибка | Причина |
|---|---|
| `KVM_DENIED` (Linux) | пользователь не в группе `kvm` |
| `krun_start_enter returned: -22` (macOS) | слишком длинный путь к домашней директории (ограничение сокета ~100 байт) |
| `agent did not become ready within 30 seconds` | нехватка памяти или нагрузка на хост; попробуйте `--mem 2048` |
| `boot process exited (code 127)` (Windows) | не включён «Режим разработчика» или PowerShell не от администратора |

Обновление: `brew upgrade smolvm`, `apt-get upgrade` / `dnf upgrade` / `pacman -Syu`, или повторный запуск установщика. Подробная документация smolvm — [docs/install](https://github.com/smol-machines/smolvm/tree/main/docs/install).

## Развёртывание smolvm-web

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

Другой порт или путь к smolvm (путь можно задать и в интерфейсе: «Настройки» → «smolvm»):

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
