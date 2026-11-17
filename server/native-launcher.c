/**
 * ==============================================================================
 * НАТИВНЫЙ ГРАФИЧЕСКИЙ И КОНСОЛЬНЫЙ ЛАУНЧЕР (БЕЗ ЗАВИСИМОСТИ ОТ .BAT И .SH)
 * ==============================================================================
 * Компилируется на GitHub Actions напрямую в нативный машинный код:
 *   - Windows 7 / 10 / 11: `Офисный-Помощник.exe` (PE32+ GUI/Console, Win32 API)
 *   - Astra Linux 5.3/5.4: `Офисный-Помощник-AstraLinux.run` (Static ELF64, POSIX API)
 *
 * Почему это работает даже там, где заблокированы .bat, cmd.exe, PowerShell и .sh:
 *   1) Программа является обычным бинарным приложением (.exe / ELF) и использует
 *      прямые системные вызовы ядра (`CreateProcessW` и `ShellExecuteW` на Windows,
 *      `fork` / `execve` на Linux), вообще не вызывая `cmd.exe` или `/bin/sh`.
 *   2) Автоматически выставляет переменную среды `NODE_SKIP_PLATFORM_CHECK=1`
 *      внутри процесса для работы на старом ядре Windows 7 SP1.
 *   3) Запускает локальный сервер и открывает браузер по адресу http://127.0.0.1:3000.
 */

#ifdef _WIN32
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int nCmdShow) {
    (void)hInstance; (void)hPrevInstance; (void)lpCmdLine; (void)nCmdShow;

    wchar_t exePath[MAX_PATH];
    GetModuleFileNameW(NULL, exePath, MAX_PATH);

    // Определяем папку, в которой лежит Офисный-Помощник.exe
    wchar_t *lastSlash = wcsrchr(exePath, L'\\');
    if (lastSlash) *lastSlash = L'\0';

    SetCurrentDirectoryW(exePath);

    // Включаем совместимость с Windows 7 SP1 и продакшен-режим без cmd.exe
    SetEnvironmentVariableW(L"NODE_SKIP_PLATFORM_CHECK", L"1");
    SetEnvironmentVariableW(L"NODE_ENV", L"production");
    SetEnvironmentVariableW(L"PORT", L"3000");
    SetEnvironmentVariableW(L"HOST", L"127.0.0.1");
    SetEnvironmentVariableW(L"AUTO_OPEN_BROWSER", L"1");

    wchar_t cmdLine[MAX_PATH * 2];
    wsprintfW(
        cmdLine,
        L"\"%s\\bin\\win7-x64\\node.exe\" \"%s\\dist-server\\server.cjs\"",
        exePath,
        exePath
    );

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE; // Запускаем без черного окна консоли
    ZeroMemory(&pi, sizeof(pi));

    // Прямой вызов ядра Windows (CreateProcessW) в обход любых блокировок cmd.exe / .bat
    BOOL started = CreateProcessW(
        NULL,
        cmdLine,
        NULL,
        NULL,
        FALSE,
        CREATE_NO_WINDOW,
        NULL,
        exePath,
        &si,
        &pi
    );

    if (!started) {
        MessageBoxW(
            NULL,
            L"Не удалось найти локальный рантайм bin\\win7-x64\\node.exe или dist-server\\server.cjs.\nУбедитесь, что архив распакован полностью.",
            L"Офисный помощник",
            MB_OK | MB_ICONERROR
        );
        return 1;
    }

    // Ждем 1.2 секунды и открываем браузер напрямую через Win32 ShellExecuteW
    Sleep(1200);
    ShellExecuteW(NULL, L"open", L"http://127.0.0.1:3000", NULL, NULL, SW_SHOWNORMAL);

    // Ожидаем завершения работы
    WaitForSingleObject(pi.hProcess, INFINITE);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return 0;
}

#else
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>
#include <sys/types.h>
#include <sys/wait.h>

int main(int argc, char *argv[]) {
    (void)argc;
    char selfPath[PATH_MAX];
    ssize_t len = readlink("/proc/self/exe", selfPath, sizeof(selfPath) - 1);
    if (len != -1) {
        selfPath[len] = '\0';
        char *lastSlash = strrchr(selfPath, '/');
        if (lastSlash) *lastSlash = '\0';
        chdir(selfPath);
    } else if (argv[0]) {
        char *lastSlash = strrchr(argv[0], '/');
        if (lastSlash) {
            *lastSlash = '\0';
            chdir(argv[0]);
        }
    }

    setenv("NODE_ENV", "production", 1);
    setenv("PORT", "3000", 1);
    setenv("HOST", "127.0.0.1", 1);
    setenv("AUTO_OPEN_BROWSER", "1", 1);

    // Прямой запуск бинарника через execv (без участия /bin/sh или bash)
    char *nodeArgs[] = {
        "./bin/linux-x64/node",
        "./dist-server/server.cjs",
        NULL
    };

    execv("./bin/linux-x64/node", nodeArgs);
    perror("Ошибка запуска ./bin/linux-x64/node");
    return 1;
}
#endif
