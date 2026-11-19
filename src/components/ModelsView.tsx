import React, { useState } from 'react';
import { RefreshCw, CheckCircle2, AlertTriangle, Terminal } from 'lucide-react';
import { ModelInfo } from '../types';
import { switchActiveModel } from '../utils/api';

interface ModelsViewProps {
  asrModels: ModelInfo[];
  ttsModels: ModelInfo[];
  onRefreshModels: () => Promise<void>;
}

export const ModelsView: React.FC<ModelsViewProps> = ({
  asrModels,
  ttsModels,
  onRefreshModels,
}) => {
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleActivate = async (model: ModelInfo) => {
    setSwitchingId(model.id);
    setError(null);
    try {
      await switchActiveModel(model.category, model.id);
      await onRefreshModels();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to switch active model.');
    } finally {
      setSwitchingId(null);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      await onRefreshModels();
    } finally {
      setRefreshing(false);
    }
  };

  const renderModelList = (title: string, subtitle: string, models: ModelInfo[]) => (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>
      </div>

      <div className="divide-y divide-slate-200 dark:divide-slate-800 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {models.map((m) => (
          <div key={m.id} id={`model-card-${m.id}`} className="p-5 space-y-3">
            <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {m.name}
                  </h3>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {m.engine_family} · {m.open_source_status} ({m.license})
                  </span>
                </div>

                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  {m.description}
                </p>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400 pt-1">
                  <span>
                    Status:{' '}
                    {m.available ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {m.weights_cached ? 'Installed & Cached' : 'Installed (Downloads weights on first run)'}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400 font-medium">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Not Installed
                      </span>
                    )}
                  </span>
                  <span>Hardware: {m.hardware_requirements}</span>
                  <span>Languages: {m.language_support}</span>
                </div>

                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {m.status_detail}
                </p>
              </div>

              <div className="shrink-0">
                {m.active ? (
                  <span className="inline-flex items-center px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium">
                    Active Default
                  </span>
                ) : (
                  <button
                    id={`activate-model-${m.id}`}
                    type="button"
                    disabled={!m.available || switchingId === m.id}
                    onClick={() => handleActivate(m)}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      !m.available
                        ? 'border border-slate-200 dark:border-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed'
                        : 'border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700'
                    }`}
                  >
                    {switchingId === m.id ? 'Activating...' : m.available ? 'Set Active' : 'Unavailable'}
                  </button>
                )}
              </div>
            </div>

            {!m.available && (
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex items-start gap-2 text-xs font-mono text-slate-700 dark:text-slate-300">
                <Terminal className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400" />
                <code className="break-all">{m.install_instructions}</code>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Model Management
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Live backend inspection of installed speech recognition and voice generation adapters
          </p>
        </div>

        <button
          id="refresh-models-btn"
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors self-start sm:self-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          <span>Check Backend Status</span>
        </button>
      </div>

      {error && (
        <div className="p-4 rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {renderModelList(
        'Speech Recognition Adapters (ASR)',
        'Modular ASR backends. Faster-Whisper runs locally via CTranslate2; PyTorch models activate automatically when installed.',
        asrModels
      )}

      {renderModelList(
        'Voice Generation Adapters (TTS)',
        'Decoupled open-weight text-to-speech engines.',
        ttsModels
      )}
    </div>
  );
};
