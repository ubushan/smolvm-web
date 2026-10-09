# smolvm-web: запуск и развёртывание

## 1. Запуск (macOS / Linux)

Нужны: Node.js ≥ 18 и `smolvm` в `PATH`.

```bash
cd smolvm-web
./start.sh                  # = node server.js --autostart
```

Откройте <http://127.0.0.1:7777>. `--autostart` сам поднимает `smolvm serve`, если он не запущен.

Остановка — `Ctrl+C`. Машины при этом **продолжают работать**; остановите их в интерфейсе заранее, если нужно.

---

## 2. Перенос кода на Windows

### Что переносить

Только код: `server.js`, `lib\`, `public\`, `package.json`, `start.cmd`, `start.sh`, `README.md`, `INSTALL.md`, `documentation.md`. Зависимостей нет — `npm install` не нужен.

**Не переносить:**

| Что | Почему |
|---|---|
| `~/.config/smolvm-web/` (settings, state, `vault.enc.json`) | Хранилище секретов зашифровано ключом из Keychain macOS — на Windows его не расшифровать. Секреты введите заново. |
| Машины smolvm | Они живут в данных smolvm хоста. Образы ARM (Mac) на Windows x64 не запустятся. |
| `.claude/` | Локальная конфигурация разработки. |

### Способ А: архив (проще всего)

На Mac:

```bash
cd smolvm-web
npm pack                     # → smolvm-web-0.4.0.tgz (только нужные файлы)
```

Скопируйте `.tgz` на Windows (флешка, общая папка, `scp`) и распакуйте в PowerShell:

```powershell
mkdir C:\smolvm-web; cd C:\smolvm-web
tar -xzf $HOME\Downloads\smolvm-web-0.4.0.tgz --strip-components=1
Get-ChildItem -Recurse | Unblock-File     # снять метку «загружено из интернета»
```

### Способ Б: git

В репозитории уже есть `.gitattributes`: `start.cmd` получит CRLF, остальное — LF, независимо от `core.autocrlf`. Локальные настройки и хранилище в `.gitignore`.

```powershell
git clone <ваш-репозиторий> C:\smolvm-web
```

> Путь лучше короткий и без кириллицы/пробелов: `C:\smolvm-web`.

---

## 3. Развёртывание на Windows

### 3.1. Требования

- Windows 11 (или 10) **x64**. ARM-Windows smolvm не поддерживает.
- PowerShell **от имени администратора** для всех шагов: smolvm на Windows проверен только в такой сессии.

### 3.2. Windows Hypervisor Platform (один раз, нужна перезагрузка)

```powershell
Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform | Select State
Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform   # если Disabled
Restart-Computer
```

Также включите **Режим разработчика** (Параметры → Система → Для разработчиков): без права на symlink машина не загрузится (`boot process exited (code 127)`).

### 3.3. Node.js и smolvm

```powershell
winget install OpenJS.NodeJS.LTS           # Node 22+: нужен для сертификатов из хранилища Windows

$v = '1.23.7'                                # актуальная версия: github.com/smol-machines/smolvm/releases
Invoke-WebRequest "https://github.com/smol-machines/smolvm/releases/download/v$v/smolvm-$v-windows-x86_64.zip" -OutFile $env:TEMP\smolvm.zip
Expand-Archive $env:TEMP\smolvm.zip C:\smolvm
# exe лежит во вложенной папке:
[Environment]::SetEnvironmentVariable('Path', $env:Path + ";C:\smolvm\smolvm-$v-windows-x86_64", 'Machine')
```

Откройте **новое** окно PowerShell (администратор) и проверьте:

```powershell
node --version
smolvm --version
smolvm machine run --net --image alpine -- uname -srm     # должно напечатать Linux ... x86_64
```

За корпоративным прокси последняя команда без прокси не скачает образ — это нормально, прокси настраивается в веб-интерфейсе (шаг 3.5).

### 3.4. Запуск

```powershell
cd C:\smolvm-web
.\start.cmd
```

Браузер откроется на <http://127.0.0.1:7777>. На Windows `smolvm serve` слушает `127.0.0.1:18899` (Unix-сокетов нет), лог — `%APPDATA%\smolvm-web\smolvm-serve.log`.

Если брандмауэр спросит про Node.js (порт шлюза секретов 7790) — разрешите **только для частных сетей**. Шлюз в любом случае обслуживает лишь машины этого хоста.

### 3.5. Первичная настройка в интерфейсе

1. **⚙ → Сеть и прокси** → «Определить автоматически» (берёт прокси из настроек Windows) → «Проверить» → включить «Доверять корпоративным сертификатам» (сертификаты берутся из хранилища Windows) → Сохранить.
2. **🔑 Секреты** → добавить ключи заново (DeepSeek и т.д.), режим «Шлюз smolvm-web». Ключ шифрования хранилища сохраняется через DPAPI текущего пользователя.
3. Создать машину, отметить секреты.

### 3.6. Автозапуск при входе в систему (по желанию)

```powershell
schtasks /Create /TN "smolvm-web" /SC ONLOGON /RL HIGHEST /TR "C:\smolvm-web\start.cmd"
```

Задача запускается **под вашим пользователем**: это важно, потому что ключ хранилища (DPAPI) привязан к пользователю — под другой учётной записью секреты не откроются.

---

## Частые проблемы на Windows

| Симптом | Решение |
|---|---|
| `smolvm.exe not found in PATH` | Новое окно PowerShell после изменения PATH, или `set SMOLVM_BIN=C:\smolvm\smolvm-<v>-windows-x86_64\smolvm.exe` перед `start.cmd` |
| `boot process exited (code 127)` | Режим разработчика / запуск от администратора (symlink) |
| Машина не скачивает образ | Включите прокси в ⚙; машины за прокси стартуют через `smolvm machine start --proxy` |
| «Хранилище существует, но ключ не найден» | Хранилище перенесли с другого компьютера или запустили под другим пользователем — удалите `%APPDATA%\smolvm-web\vault.enc.json` и введите секреты заново |
| Место на диске | Данные smolvm — `%LOCALAPPDATA%\smolvm` (переместить нельзя), могут занимать десятки ГБ; удаляйте ненужные машины |
| Порт 7777 занят | `set PORT=7800` перед `start.cmd` |
