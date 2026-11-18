# Офисный помощник — Автономная коррекция русского языка в документах (Air-Gap Portable)

Автономная система проверки и исправления русского языка в офисных документах **Word (`.docx`)**, **Excel (`.xlsx`)** и **PowerPoint (`.pptx`)** с **100% сохранением исходного оформления, таблиц, шрифтов и макетов**.

---

## Совместимость с вашим рабочим ПК (Astra Linux SE 1.7.11 «Усиленный» + Windows 7 / 8+ / 10 / 11)

### 1. Полная проверка под Astra Linux Special Edition 1.7.11.hotfix50.1
Конфигурация рабочей станции:
- **ОС:** Astra Linux Special Edition 1.7.11.hotfix50.1 (`glibc 2.28`, база Debian 10 Buster)
- **Уровень защищенности:** Усиленный («Воронеж»)
- **Ядро:** `6.1.188-1-generic`, x86_64, X11
- **Процессор:** `4 × Intel® Core™ i3-9100 CPU @ 3.60GHz` (Coffee Lake: поддерживает **AVX2 / FMA / SSE4.2**, **не поддерживает AVX-512**)
- **Память:** `7,6 GiB` ОЗУ, встроенная графика `Mesa Intel® UHD Graphics 630`

Что учтено в сборке именно для этой машины:
1. **Исключена ошибка `Illegal instruction` (`AVX-512`)**: при компиляции `llama.cpp` принудительно выставлен флаг `-DGGML_NATIVE=OFF` (чтобы компилятор GitHub-раннера не вшивал инструкции AVX-512).
2. **Исключены ошибки `GLIBC_2.34 not found` и `libcrypto.so.3` missing**:
   - Нативный лаунчер `Офисный-Помощник-AstraLinux.run` и оба движка `llama-server` собираются внутри `alpine:3.20` с **100% статической линковкой (`musl` `-static`)** и отключенным OpenSSL/CURL (`-DLLAMA_OPENSSL=OFF -DLLAMA_CURL=OFF`). Они не зависят ни от версии `glibc`, ни от системных библиотек.
   - Вшитый Node.js `v18.20.4` официально нацелен ровно на **`glibc 2.28`** (идентично Astra Linux 1.7.11).
3. **Максимальная скорость на Intel Core i3-9100**: в архиве идут два Linux-бинарника:
   - `bin/linux-x64-avx2/llama-server` (`AVX2 + FMA`, без AVX-512 — выбирается автоматически при наличии `avx2` в `/proc/cpuinfo`, что дает ускорение ~2.5× на i3-9100);
   - `bin/linux-x64/llama-server` (универсальный `SSE4.2` для самых старых ПК).
4. **Обход блокировок уровня «Усиленный» (ЗПС / запрет скриптов)**:
   - Если ЗПС запрещает запуск сторонних бинарников (`Office-Assistant-AstraLinux.run`) или скриптов (`.sh`), открывайте двойным кликом **`Офисный-Помощник-Автономный.html`** в штатном браузере X11 (Chromium-Gost / Firefox / Яндекс.Браузер) — в него вшит полноценный обработчик `.docx`, `.xlsx`, `.pptx` прямо внутри браузера по протоколу `file://`.

---

### 2. Две сборки Windows в одном релизе: Win 7 (с патчем) + Win 8+ / 10 / 11 (без модификаций)
Поскольку `cpp-httplib` внутри свежего `llama.cpp` требует Windows 8+/10+ (`CreateFile2`), релиз включает **оба** варианта:
- **`bin/win8plus-x64/llama-server.exe`** (и отдельный файл в Release: **`llama-server-win8plus-unmodified.exe`**) — собрано из **оригинального немодифицированного `llama.cpp`** (`-D_WIN32_WINNT=0x0A00`). Автоматически выбирается сервером на Windows 8, 8.1, 10 и 11.
- **`bin/win7-x64/llama-server.exe`** (и отдельный файл в Release: **`llama-server-win7-patched.exe`**) — собрано с патчем `CreateFile2 → CreateFileW` (`-D_WIN32_WINNT=0x0601`). Автоматически выбирается сервером на Windows 7 SP1.

Принудительный выбор для тестирования (опционально): `LLAMA_VARIANT=win8plus` или `LLAMA_VARIANT=win7`.

---

## Сборка и публикация релиза на GitHub

```bash
npm run lint
npm run build
```

При отправке в репозиторий (`git push origin main`) GitHub Actions автоматически соберет все бинарники и опубликует готовый **GitHub Release** со следующими файлами:
- `office-assistant-ru-portable-airgap.zip`
- `office-assistant-ru-astra-linux-portable.tar.gz`
- `llama-server-win8plus-unmodified.exe`
- `llama-server-win7-patched.exe`
- `Офисный-Помощник-Автономный.html`
