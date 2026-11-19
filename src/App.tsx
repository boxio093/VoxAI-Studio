/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  AppSettings,
  AppTab,
  HealthResponse,
  ModelInfo,
  RecordingRecord,
} from './types';
import {
  deleteRecording,
  fetchHealth,
  fetchModels,
  fetchRecording,
  fetchRecordings,
  fetchSettings,
} from './utils/api';
import { Header } from './components/Header';
import { StudioView } from './components/StudioView';
import { RecordingsView } from './components/RecordingsView';
import { TranscriptionsView } from './components/TranscriptionsView';
import { TTSView } from './components/TTSView';
import { ModelsView } from './components/ModelsView';
import { SettingsView } from './components/SettingsView';
import { KeyboardShortcutsModal } from './components/KeyboardShortcutsModal';

const DEFAULT_SETTINGS: AppSettings = {
  active_asr_model: 'faster-whisper-base',
  active_tts_model: 'kokoro-onnx',
  default_mode: 'verbatim',
  default_language: 'auto',
  retention_days: 0,
  max_upload_mb: 100,
  storage_backend: 'local',
  training_consent_default: false,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('studio');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('voxai_theme');
      if (saved === 'dark' || saved === 'light') return saved;
    }
    return 'light';
  });

  const [records, setRecords] = useState<RecordingRecord[]>([]);
  const [asrModels, setAsrModels] = useState<ModelInfo[]>([]);
  const [ttsModels, setTtsModels] = useState<ModelInfo[]>([]);
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [ttsInputText, setTtsInputText] = useState('');
  const [focusRecording, setFocusRecording] = useState<RecordingRecord | null>(null);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      localStorage.setItem('voxai_theme', theme);
    }
  }, [theme]);

  const refreshModels = useCallback(async () => {
    const res = await fetchModels();
    setAsrModels(res.asr_models);
    setTtsModels(res.tts_models);
  }, []);

  const refreshRecords = useCallback(async () => {
    const list = await fetchRecordings();
    setRecords(list);
  }, []);

  const refreshHealth = useCallback(async () => {
    const h = await fetchHealth();
    setHealth(h);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([fetchModels(), fetchRecordings(), fetchSettings(), fetchHealth()])
      .then(([modelsRes, recList, cfg, h]) => {
        if (!active) return;
        setAsrModels(modelsRes.asr_models);
        setTtsModels(modelsRes.tts_models);
        setRecords(recList);
        setAppSettings(cfg);
        setHealth(h);
        setBackendError(null);
      })
      .catch((err) => {
        if (!active) return;
        setBackendError(
          err instanceof Error
            ? err.message
            : 'Unable to reach the VoxAI FastAPI speech backend.'
        );
      });
    return () => {
      active = false;
    };
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable;

      const isMac =
        typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const mod = isMac ? e.metaKey : e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setActiveTab('transcriptions');
        setTimeout(() => {
          const el = document.getElementById('history-search-input') as HTMLInputElement | null;
          el?.focus();
        }, 80);
        return;
      }

      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setFocusRecording(null);
        setActiveTab('studio');
        return;
      }

      if (!isInput && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault();
        setIsShortcutsOpen((prev) => !prev);
        return;
      }

      if (e.altKey && !mod) {
        const tabMap: Record<string, AppTab> = {
          '1': 'studio',
          '2': 'recordings',
          '3': 'transcriptions',
          '4': 'tts',
          '5': 'models',
          '6': 'settings',
        };
        if (tabMap[e.key]) {
          e.preventDefault();
          setActiveTab(tabMap[e.key]);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleRecordingCompleted = async (recordId: string): Promise<RecordingRecord | null> => {
    await refreshRecords();
    try {
      return await fetchRecording(recordId);
    } catch {
      return null;
    }
  };

  const handleDeleteRecord = async (id: string) => {
    await deleteRecording(id);
    setRecords((prev) => prev.filter((r) => r.id !== id));
    if (focusRecording?.id === id) {
      setFocusRecording(null);
    }
  };

  const handleOpenInStudio = (rec: RecordingRecord) => {
    setFocusRecording(rec);
    setActiveTab('studio');
  };

  const handleSendToTTS = (text: string) => {
    setTtsInputText(text);
    setActiveTab('tts');
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        theme={theme}
        onToggleTheme={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
      />

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {backendError && (
          <div
            role="alert"
            className="mb-6 p-4 rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300"
          >
            Backend connection issue: {backendError}
          </div>
        )}

        {activeTab === 'studio' && (
          <StudioView
            asrModels={asrModels}
            appSettings={appSettings}
            onRecordingCompleted={handleRecordingCompleted}
            onSendToTTS={handleSendToTTS}
            focusRecording={focusRecording}
          />
        )}

        {activeTab === 'recordings' && (
          <RecordingsView
            records={records}
            asrModels={asrModels}
            onOpenInStudio={handleOpenInStudio}
            onDeleteRecord={handleDeleteRecord}
            onRefresh={refreshRecords}
            onGoToStudio={() => setActiveTab('studio')}
          />
        )}

        {activeTab === 'transcriptions' && (
          <TranscriptionsView
            records={records}
            onDeleteRecord={handleDeleteRecord}
            onOpenInStudio={handleOpenInStudio}
            onSendToTTS={handleSendToTTS}
            onGoToStudio={() => setActiveTab('studio')}
          />
        )}

        {activeTab === 'tts' && (
          <TTSView
            initialText={ttsInputText}
            ttsModels={ttsModels}
            activeTtsModel={appSettings.active_tts_model}
          />
        )}

        {activeTab === 'models' && (
          <ModelsView
            asrModels={asrModels}
            ttsModels={ttsModels}
            onRefreshModels={async () => {
              await refreshModels();
              const cfg = await fetchSettings();
              setAppSettings(cfg);
            }}
          />
        )}

        {activeTab === 'settings' && (
          <SettingsView
            settings={appSettings}
            health={health}
            asrModels={asrModels}
            ttsModels={ttsModels}
            theme={theme}
            onChangeTheme={setTheme}
            onSettingsUpdated={(next) => {
              setAppSettings(next);
              setBackendError(null);
              refreshModels().catch(() => {});
              refreshRecords().catch(() => {});
            }}
            onRefreshHealth={refreshHealth}
          />
        )}
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 py-4">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>VoxAI · Open-Model Voice Intelligence Studio</span>
          <button
            type="button"
            onClick={() => setIsShortcutsOpen(true)}
            className="hover:text-slate-900 dark:hover:text-slate-200 transition-colors"
          >
            Keyboard shortcuts (?)
          </button>
        </div>
      </footer>

      <KeyboardShortcutsModal
        isOpen={isShortcutsOpen}
        onClose={() => setIsShortcutsOpen(false)}
      />
    </div>
  );
}
