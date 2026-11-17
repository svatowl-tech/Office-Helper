import React, { useEffect, useState } from 'react';
import { Check, Copy, Cpu, Download, PackageCheck, Terminal } from 'lucide-react';
import { GithubBundleConfig, LocalModelSpec } from '../types/harness.types';
import {
  apiGenerateGithubBundle,
  apiGetModelCatalog,
  triggerBase64Download,
} from '../services/harnessApi.service';

export const GithubBundleBuilderView: React.FC = () => {
  const [models, setModels] = useState<LocalModelSpec[]>([]);
  const [config, setConfig] = useState<GithubBundleConfig>({
    targetLinux: 'astra_1_7_kernel_5_4',
    targetWindows: 'win7_sp1_x64',
    primaryModel: 'hybrid_sage_qwen',
    includeOcrTessdata: true,
    includeLibreOfficeHeadless: true,
    cpuInstructionSet: 'sse4_2_legacy',
  });

  const [workflowYaml, setWorkflowYaml] = useState<string>('');
  const [linuxScript, setLinuxScript] = useState<string>('');
  const [win7Script, setWin7Script] = useState<string>('');
  const [zipBase64, setZipBase64] = useState<string>('');
  const [activeCodeTab, setActiveCodeTab] = useState<'yaml' | 'linux' | 'win7'>('yaml');
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    apiGetModelCatalog().then(setModels).catch(console.error);
  }, []);

  useEffect(() => {
    apiGenerateGithubBundle(config)
      .then((res) => {
        setWorkflowYaml(res.workflowYaml);
        setLinuxScript(res.linuxScript);
        setWin7Script(res.win7Script);
        setZipBase64(res.zipBase64);
      })
      .catch(console.error);
  }, [config]);

  const handleCopyActiveCode = () => {
    const text =
      activeCodeTab === 'yaml'
        ? workflowYaml
        : activeCodeTab === 'linux'
          ? linuxScript
          : win7Script;
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-slate-950 text-slate-100 overflow-y-auto">
      {/* Верхняя панель конструктора GitHub-сборки */}
      <div className="shrink-0 px-6 py-3.5 border-b border-slate-800 bg-slate-900/60 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3 text-xs">
          <PackageCheck className="w-4 h-4 text-sky-400" />
          <span className="font-semibold text-slate-100">
            Сборщик автономного дистрибутива на GitHub Actions (с вшитой локальной нейросетью внутри архива)
          </span>
        </div>

        {zipBase64 && (
          <button
            type="button"
            onClick={() =>
              triggerBase64Download(
                zipBase64,
                'airgap-github-actions-builder-kit.zip',
                'application/zip'
              )
            }
            className="inline-flex items-center gap-2 px-4 py-1.5 text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Скачать комплект сборки для GitHub (.ZIP)
          </button>
        )}
      </div>

      <div className="p-6 space-y-6">
        {/* Секция 1: Результаты исследования лучших локальных моделей для русского языка без GPU */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-sky-400" />
              <span>
                1. Сравнительная матрица локальных нейросетей для коррекции русского языка на CPU (без видеокарты)
              </span>
            </h2>
            <span className="text-xs text-slate-400">
              Проверено на совместимость с ядром Astra Linux 5.3/5.4 и Windows 7 SP1
            </span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {models.map((m) => (
              <div
                key={m.id}
                className="p-4 rounded-lg border border-slate-800 bg-slate-900/40 flex flex-col justify-between space-y-3"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-xs font-bold text-slate-100 leading-snug">{m.name}</h3>
                    <span className="text-xs font-mono font-semibold text-emerald-400 shrink-0 tabular-nums">
                      {m.sizeMb} МБ
                    </span>
                  </div>

                  <div className="text-[11px] font-mono text-sky-400">
                    HuggingFace: {m.repoId}
                  </div>

                  <p className="text-xs text-slate-300 leading-relaxed">{m.description}</p>

                  <div className="pt-2 border-t border-slate-800/80 space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Потребление ОЗУ:</span>
                      <span className="font-mono text-slate-200 tabular-nums">
                        {m.ramRequiredMb} МБ
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Скорость на CPU:</span>
                      <span className="font-mono text-slate-200">{m.cpuTokensPerSec}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Поддержка Windows 7:</span>
                      <span className="text-emerald-400 font-medium">{m.windows7Support}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Ядро Astra Linux:</span>
                      <span className="text-slate-200">{m.minLinuxKernel}</span>
                    </div>
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-800/80 space-y-1">
                  <div className="text-[11px] font-semibold text-slate-400">
                    Ключевые преимущества для закрытого контура:
                  </div>
                  <ul className="space-y-1 text-[11px] text-slate-300">
                    {m.pros.map((pro, idx) => (
                      <li key={idx} className="flex items-start gap-1.5">
                        <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                        <span>{pro}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Секция 2: Конфигуратор таргетов компиляции и состав GitHub-артефакта */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-5 p-5 rounded-lg border border-slate-800 bg-slate-900/40 space-y-4">
            <h3 className="text-xs font-semibold text-slate-200">
              2. Параметры сборки все-в-одном пакета на GitHub Actions
            </h3>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-400 mb-1">
                  Вшиваемая локальная нейросеть (скачивается сборщиком GitHub прямо в архив):
                </label>
                <select
                  value={config.primaryModel}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      primaryModel: e.target.value as GithubBundleConfig['primaryModel'],
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 focus:outline-none focus:border-sky-500"
                >
                  <option value="hybrid_sage_qwen">
                    Гибрид: SAGE FRED-T5 95M (быстрая орфография) + Qwen2.5-1.5B GGUF (глубокая правка)
                  </option>
                  <option value="sage-fredt5-distilled-95m">
                    Только AI-Forever SAGE FRED-T5 Distilled 95M (Ультралегкий пакет ~112 МБ)
                  </option>
                  <option value="qwen2.5-1.5b-q4_k_m">
                    Только Qwen2.5-1.5B-Instruct Q4_K_M GGUF (~986 МБ)
                  </option>
                </select>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">
                  Набор инструкций старых процессоров (CPU SIMD):
                </label>
                <select
                  value={config.cpuInstructionSet}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      cpuInstructionSet: e.target.value as GithubBundleConfig['cpuInstructionSet'],
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 focus:outline-none focus:border-sky-500"
                >
                  <option value="sse4_2_legacy">
                    SSE4.2 / Базовый x86_64 (Макс. совместимость: старые Pentium / Core 2 / Xeon)
                  </option>
                  <option value="avx2">
                    AVX2 + FMA (Ускорение в 2.5 раза для CPU начиная с Intel Haswell / AMD Ryzen)
                  </option>
                </select>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">
                  Целевая сборка Linux (статическая линковка libstdc++):
                </label>
                <select
                  value={config.targetLinux}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      targetLinux: e.target.value as GithubBundleConfig['targetLinux'],
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 focus:outline-none focus:border-sky-500"
                >
                  <option value="astra_1_7_kernel_5_4">
                    Astra Linux SE 1.6 / 1.7 (Ядра 4.15, 5.3, 5.4 · glibc 2.24+)
                  </option>
                  <option value="debian_10_buster">Debian 10 Buster / Старые корпоративные ядра</option>
                </select>
              </div>

              <div className="pt-2 space-y-2">
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.includeOcrTessdata}
                    onChange={(e) =>
                      setConfig({ ...config, includeOcrTessdata: e.target.checked })
                    }
                    className="rounded border-slate-700 bg-slate-950 text-sky-500"
                  />
                  <span>Вшить оффлайн-словари OCR (rus.traineddata + eng.traineddata)</span>
                </label>
              </div>
            </div>

            <div className="p-3.5 rounded-lg border border-slate-800 bg-slate-950/70 text-xs text-slate-400 space-y-1.5">
              <div className="font-semibold text-slate-200">
                Как решена проблема запуска на Windows 7 и старом ядре Astra Linux 5.3/5.4:
              </div>
              <p>
                • <strong className="text-slate-200">Для Windows 7 SP1:</strong> стандартные сборки llama.cpp падают из-за вызовов API Windows 10. Наш скрипт компилирует бинарник через{' '}
                <code className="text-sky-300">x86_64-w64-mingw32-g++-win32</code> с флагом{' '}
                <code className="text-sky-300">-D_WIN32_WINNT=0x0601</code> и запускает портативный Node.js с переменной{' '}
                <code className="text-emerald-300">NODE_SKIP_PLATFORM_CHECK=1</code>.
              </p>
              <p>
                • <strong className="text-slate-200">Для Astra Linux 5.3/5.4:</strong> бинарник собирается с флагами{' '}
                <code className="text-sky-300">-static-libgcc -static-libstdc++ -DBUILD_SHARED_LIBS=OFF</code>, поэтому он не требует обновления системных библиотек из закрытых репозиториев.
              </p>
            </div>
          </div>

          {/* Правая колонка: Просмотр сгенерированного GitHub Actions YAML и пусковых скриптов */}
          <div className="lg:col-span-7 border border-slate-800 rounded-lg bg-slate-900/40 flex flex-col overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-800 bg-slate-900/80 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
                <button
                  type="button"
                  onClick={() => setActiveCodeTab('yaml')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    activeCodeTab === 'yaml'
                      ? 'bg-sky-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  .github/workflows/build-airgap-bundle.yml
                </button>
                <button
                  type="button"
                  onClick={() => setActiveCodeTab('linux')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    activeCodeTab === 'linux'
                      ? 'bg-sky-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  start-astra-linux.sh
                </button>
                <button
                  type="button"
                  onClick={() => setActiveCodeTab('win7')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    activeCodeTab === 'win7'
                      ? 'bg-sky-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  start-windows7.bat
                </button>
              </div>

              <button
                type="button"
                onClick={handleCopyActiveCode}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    Скопировано
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    Копировать код
                  </>
                )}
              </button>
            </div>

            <div className="p-4 bg-slate-950 overflow-x-auto max-h-[460px] overflow-y-auto">
              <pre className="text-xs font-mono text-slate-200 leading-relaxed">
                {activeCodeTab === 'yaml'
                  ? workflowYaml
                  : activeCodeTab === 'linux'
                    ? linuxScript
                    : win7Script}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
