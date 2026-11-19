import React, { useEffect, useState } from 'react';
import { Save, Check, RefreshCw, ShieldCheck } from 'lucide-react';
import { AppSettings, HealthResponse, ModelInfo, TranscriptionMode } from '../types';
import { updateSettings } from '../utils/api';

interface SettingsViewProps {
  settings: AppSettings;
  health: HealthResponse | null;
  asrModels: ModelInfo[];
  ttsModels: ModelInfo[];
  theme: 'light' | 'dark';
  onChangeTheme: (theme: 'light' | 'dark') => void;
  onSettingsUpdated: (next: AppSettings) => void;
  onRefreshHealth: () => Promise<void>;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  health,
  asrModels,
  ttsModels,
  theme,
  onChangeTheme,
  onSettingsUpdated,
  onRefreshHealth,
}) => {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [apiToken, setApiToken] = useState<string>(
    typeof window !== 'undefined' ? localStorage.getItem('voxai_api_token') || '' : ''
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      if (typeof window !== 'undefined') {
        if (apiToken.trim()) {
          localStorage.setItem('voxai_api_token', apiToken.trim());
        } else {
          localStorage.removeItem('voxai_api_token');
        }
      }
      const updated = await updateSettings(draft);
      onSettingsUpdated(updated);
      await onRefreshHealth();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Settings & Privacy
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          Configure appearance, default open models, audio retention, and verify backend runtime health
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 pb-3 border-b border-slate-100 dark:border-slate-800">
            Studio Preferences
          </h2>

          {/* Theme Mode */}
          <div>
            <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Interface Theme
            </span>
            <div className="inline-flex p-1 bg-slate-100 dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => onChangeTheme('light')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  theme === 'light'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                Light
              </button>
              <button
                type="button"
                onClick={() => onChangeTheme('dark')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  theme === 'dark'
                    ? 'bg-slate-800 text-white shadow-xs'
                    : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                Dark
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Default ASR Model
              </label>
              <select
                value={draft.active_asr_model}
                onChange={(e) => setDraft({ ...draft, active_asr_model: e.target.value })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                {asrModels.map((m) => (
                  <option key={m.id} value={m.id} disabled={!m.available}>
                    {m.name} {m.available ? '' : '(Unavailable)'}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Default TTS Model
              </label>
              <select
                value={draft.active_tts_model}
                onChange={(e) => setDraft({ ...draft, active_tts_model: e.target.value })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                {ttsModels.map((m) => (
                  <option key={m.id} value={m.id} disabled={!m.available}>
                    {m.name} {m.available ? '' : '(Unavailable)'}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Default Transcription Mode
              </label>
              <select
                value={draft.default_mode}
                onChange={(e) =>
                  setDraft({ ...draft, default_mode: e.target.value as TranscriptionMode })
                }
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                <option value="verbatim">Verbatim (Preserve exact spoken words)</option>
                <option value="clean">Clean (Punctuation & readability)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Audio Retention (Days, 0 = Keep Forever)
              </label>
              <input
                type="number"
                min={0}
                max={3650}
                value={draft.retention_days}
                onChange={(e) =>
                  setDraft({ ...draft, retention_days: Math.max(0, parseInt(e.target.value || '0', 10)) })
                }
                className="w-full px-3 py-2 text-xs font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Max Upload Limit (MB)
              </label>
              <input
                type="number"
                min={1}
                max={500}
                value={draft.max_upload_mb}
                onChange={(e) =>
                  setDraft({ ...draft, max_upload_mb: Math.max(1, parseInt(e.target.value || '100', 10)) })
                }
                className="w-full px-3 py-2 text-xs font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                API Bearer Token (if VOXAI_API_KEY enabled)
              </label>
              <input
                type="password"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder="Optional backend token"
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-200">
              <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span>Privacy & Model Training Policy</span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Audio recordings and transcripts are processed by your configured open-model FastAPI backend and stored locally. Recordings are never used for model training without explicit opt-in consent.
            </p>
            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 pt-1 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.training_consent_default}
                onChange={(e) => setDraft({ ...draft, training_consent_default: e.target.checked })}
                className="rounded border-slate-300 dark:border-slate-700 text-indigo-600"
              />
              <span>Opt-in new recordings for optional local dataset export (default off)</span>
            </label>
          </div>

          {error && (
            <div className="p-3 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <div className="flex justify-end">
            <button
              id="save-settings-btn"
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition-colors"
            >
              {saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
              <span>{saved ? 'Settings Saved' : saving ? 'Saving...' : 'Save Settings'}</span>
            </button>
          </div>
        </section>

        {/* Backend Health Diagnostics */}
        <section className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Backend Health
            </h2>
            <button
              type="button"
              onClick={onRefreshHealth}
              className="inline-flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh</span>
            </button>
          </div>

          {!health ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Checking backend health...
            </p>
          ) : (
            <dl className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {[
                ['Service Status', health.status === 'ok' ? 'Operational' : 'Degraded'],
                ['Runtime', `Python ${health.python_version}`],
                ['Compute Device', `${health.compute_device.toUpperCase()} (${health.gpu_available ? 'CUDA GPU' : 'CPU int8'})`],
                ['FFmpeg Transcoding', health.ffmpeg_available ? 'Available' : 'Missing'],
                ['Active ASR Model', `${health.active_asr_model} (${health.active_asr_ready ? 'Ready' : 'Unavailable'})`],
                ['Active TTS Model', `${health.active_tts_model} (${health.active_tts_ready ? 'Ready' : 'Unavailable'})`],
                ['Storage Backend', health.storage_backend],
                ['Stored Recordings', String(health.recordings_count)],
                ['Disk Free Space', `${health.disk_free_gb} GB`],
                ['API Authentication', health.auth_enabled ? 'Bearer Token Required' : 'Local Open Access'],
              ].map(([label, value]) => (
                <div key={label} className="py-2.5 flex items-center justify-between gap-4">
                  <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
                  <dd className="font-mono tabular-nums text-slate-900 dark:text-slate-100 text-right">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>
    </div>
  );
};
