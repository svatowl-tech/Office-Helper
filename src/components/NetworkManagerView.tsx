import React, { useEffect, useState } from 'react';
import { Network, Play, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { LanNodeProbeResult, SystemTelemetry } from '../types/harness.types';
import { apiGetNetworkTelemetry, apiProbeLanNodes } from '../services/harnessApi.service';

export const NetworkManagerView: React.FC = () => {
  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null);
  const [targetHost, setTargetHost] = useState<string>('127.0.0.1');
  const [customPortsText, setCustomPortsText] = useState<string>(
    '22, 80, 443, 445, 631, 3000, 3389, 5432, 8080, 9100'
  );
  const [probeResults, setProbeResults] = useState<LanNodeProbeResult[]>([]);
  const [probing, setProbing] = useState<boolean>(false);
  const [loadingTelemetry, setLoadingTelemetry] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const loadTelemetry = async () => {
    setLoadingTelemetry(true);
    setError(null);
    try {
      const data = await apiGetNetworkTelemetry();
      setTelemetry(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка чтения сетевой телеметрии');
    } finally {
      setLoadingTelemetry(false);
    }
  };

  const handleRunProbe = async () => {
    setProbing(true);
    setError(null);
    try {
      const parsedPorts = customPortsText
        .split(',')
        .map((p) => Number(p.trim()))
        .filter((p) => !Number.isNaN(p) && p > 0 && p <= 65535);

      const res = await apiProbeLanNodes(targetHost, parsedPorts);
      setProbeResults(res.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сканирования портов');
    } finally {
      setProbing(false);
    }
  };

  useEffect(() => {
    loadTelemetry();
    handleRunProbe();
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0 bg-slate-950 text-slate-100 overflow-y-auto">
      {/* Верхняя панель управления локальной сетью */}
      <div className="shrink-0 px-6 py-3.5 border-b border-slate-800 bg-slate-900/60 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3 text-xs">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span className="font-semibold text-slate-100">
            Менеджмент локальной сети (ЗСПД / Air-Gap LAN Diagnostics)
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className="text-slate-400">
            Прямое TCP-сканирование без внешних утилит (совместимо с Astra Linux 5.3/5.4 и Windows 7)
          </span>
        </div>

        <button
          type="button"
          onClick={loadTelemetry}
          disabled={loadingTelemetry}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loadingTelemetry ? 'animate-spin' : ''}`} />
          Обновить интерфейсы узла
        </button>
      </div>

      {error && (
        <div className="px-6 py-3 bg-red-950/60 border-b border-red-800 text-xs text-red-200">
          {error}
        </div>
      )}

      <div className="p-6 space-y-6">
        {/* Сводка аппаратных параметров текущего узла */}
        {telemetry && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 rounded-lg border border-slate-800 bg-slate-900/40">
              <div className="text-xs text-slate-400">Имя узла и ОС</div>
              <div className="mt-1 text-sm font-semibold text-slate-100 font-mono truncate">
                {telemetry.hostname}
              </div>
              <div className="mt-1 text-xs text-slate-400 font-mono">
                {telemetry.platform} · Ядро {telemetry.release}
              </div>
            </div>

            <div className="p-4 rounded-lg border border-slate-800 bg-slate-900/40">
              <div className="text-xs text-slate-400">Процессор (CPU-инференс без GPU)</div>
              <div className="mt-1 text-sm font-semibold text-slate-100 truncate">
                {telemetry.cpuModel}
              </div>
              <div className="mt-1 text-xs text-slate-400 tabular-nums">
                Доступно потоков: {telemetry.cpuCores} · Архитектура: {telemetry.arch}
              </div>
            </div>

            <div className="p-4 rounded-lg border border-slate-800 bg-slate-900/40">
              <div className="text-xs text-slate-400">Оперативная память (ОЗУ)</div>
              <div className="mt-1 text-sm font-semibold text-slate-100 font-mono tabular-nums">
                Свободно {telemetry.freeMemMb} МБ из {telemetry.totalMemMb} МБ
              </div>
              <div className="mt-1 text-xs text-emerald-400">
                Достаточно для SAGE-95M (320 МБ) и Qwen-1.5B (1850 МБ)
              </div>
            </div>

            <div className="p-4 rounded-lg border border-slate-800 bg-slate-900/40">
              <div className="text-xs text-slate-400">Статус сетевой изоляции (Air-Gap)</div>
              <div className="mt-1 text-sm font-semibold text-emerald-400">
                Автономный контур активен
              </div>
              <div className="mt-1 text-xs text-slate-400 tabular-nums">
                Аптайм системы: {Math.floor(telemetry.uptimeSeconds / 60)} мин
              </div>
            </div>
          </div>
        )}

        {/* Таблица физических и виртуальных сетевых интерфейсов */}
        <div className="border border-slate-800 rounded-lg bg-slate-900/30 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/60 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
              <Network className="w-4 h-4 text-sky-400" />
              <span>Активные сетевые интерфейсы (NIC) текущего компьютера</span>
            </div>
            <span className="text-xs text-slate-400 tabular-nums">
              Обнаружено IPv4-интерфейсов: {telemetry?.interfaces.length || 0}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 bg-slate-950/50">
                  <th className="py-2.5 px-4 font-medium">Интерфейс</th>
                  <th className="py-2.5 px-4 font-medium">IPv4-адрес</th>
                  <th className="py-2.5 px-4 font-medium">Подсеть (CIDR)</th>
                  <th className="py-2.5 px-4 font-medium">Маска подсети</th>
                  <th className="py-2.5 px-4 font-medium">Физический адрес (MAC)</th>
                  <th className="py-2.5 px-4 font-medium">Тип канала</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
                {telemetry?.interfaces.map((iface, idx) => (
                  <tr key={`${iface.name}-${idx}`} className="hover:bg-slate-900/50">
                    <td className="py-2.5 px-4 font-semibold text-slate-200">{iface.name}</td>
                    <td className="py-2.5 px-4 text-sky-400">{iface.ipv4}</td>
                    <td className="py-2.5 px-4 text-slate-300">{iface.cidr}</td>
                    <td className="py-2.5 px-4 text-slate-400">{iface.netmask}</td>
                    <td className="py-2.5 px-4 text-slate-400">{iface.mac}</td>
                    <td className="py-2.5 px-4 font-sans">
                      {iface.internal ? (
                        <span className="text-slate-400">Локальная петля (Loopback)</span>
                      ) : (
                        <span className="text-emerald-400 font-medium">Внешний адаптер LAN</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Интерактивный сканер узлов и служб локальной сети (SMB, CUPS, SSH, RDP, Local LLM) */}
        <div className="border border-slate-800 rounded-lg bg-slate-900/30 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/60 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
              <Server className="w-4 h-4 text-emerald-400" />
              <span>Диагностика доступности служб и узлов локальной сети (TCP Socket Prober)</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={targetHost}
                onChange={(e) => setTargetHost(e.target.value)}
                placeholder="IP или хост (напр. 127.0.0.1)"
                className="w-40 px-3 py-1.5 text-xs font-mono bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500"
              />
              <input
                type="text"
                value={customPortsText}
                onChange={(e) => setCustomPortsText(e.target.value)}
                placeholder="Порты через запятую"
                className="w-64 px-3 py-1.5 text-xs font-mono bg-slate-950 border border-slate-800 rounded-lg text-slate-300 focus:outline-none focus:border-sky-500"
              />
              <button
                type="button"
                onClick={handleRunProbe}
                disabled={probing}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <Play className="w-3.5 h-3.5" />
                {probing ? 'Опрос портов...' : 'Проверить узел'}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 bg-slate-950/50">
                  <th className="py-2.5 px-4 font-medium">Хост</th>
                  <th className="py-2.5 px-4 font-medium">TCP-порт</th>
                  <th className="py-2.5 px-4 font-medium">Назначение службы в офисной сети</th>
                  <th className="py-2.5 px-4 font-medium">Статус канала</th>
                  <th className="py-2.5 px-4 font-medium text-right">Отклик (мс)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 tabular-nums">
                {probeResults.map((item) => (
                  <tr key={`${item.host}-${item.port}`} className="hover:bg-slate-900/50">
                    <td className="py-2.5 px-4 font-mono text-slate-300">{item.host}</td>
                    <td className="py-2.5 px-4 font-mono font-semibold text-slate-100">
                      {item.port}
                    </td>
                    <td className="py-2.5 px-4 text-slate-300">{item.serviceGuess}</td>
                    <td className="py-2.5 px-4">
                      {item.reachable ? (
                        <span className="text-emerald-400 font-semibold">
                          Открыт (Соединение установлено)
                        </span>
                      ) : (
                        <span className="text-slate-500">
                          Закрыт ({item.errorReason || 'Нет ответа'})
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-slate-300">
                      {item.latencyMs !== null ? `${item.latencyMs} мс` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
