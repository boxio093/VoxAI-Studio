import React, { useState } from 'react';
import { Download, Trash2, RefreshCw, ExternalLink, Search, FileAudio } from 'lucide-react';
import { ModelInfo, RecordingRecord, TranscriptionMode } from '../types';
import { formatDuration } from '../utils/audio';
import { downloadAuthorizedAudio, transcribeAudio } from '../utils/api';
import { AuthorizedAudio } from './AuthorizedAudio';

interface RecordingsViewProps {
  records: RecordingRecord[];
  asrModels: ModelInfo[];
  onOpenInStudio: (record: RecordingRecord) => void;
  onDeleteRecord: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onGoToStudio: () => void;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const RecordingsView: React.FC<RecordingsViewProps> = ({
  records,
  asrModels,
  onOpenInStudio,
  onDeleteRecord,
  onRefresh,
  onGoToStudio,
}) => {
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [retranscribeModel, setRetranscribeModel] = useState<string>(
    asrModels.find((m) => m.active)?.id || 'faster-whisper-base'
  );
  const [retranscribeMode, setRetranscribeMode] = useState<TranscriptionMode>('verbatim');
  const [error, setError] = useState<string | null>(null);

  const filtered = records.filter((r) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      r.title.toLowerCase().includes(q) ||
      r.original_filename.toLowerCase().includes(q) ||
      r.model_used.toLowerCase().includes(q) ||
      r.detected_language.toLowerCase().includes(q)
    );
  });

  const handleRetranscribe = async (rec: RecordingRecord) => {
    setBusyId(rec.id);
    setError(null);
    try {
      await transcribeAudio({
        recordingId: rec.id,
        model: retranscribeModel,
        mode: retranscribeMode,
        timestamps: true,
      });
      await onRefresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Re-transcription failed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await onDeleteRecord(id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDownloadAudio = async (rec: RecordingRecord) => {
    if (!rec.audio_url) return;
    setError(null);
    try {
      await downloadAuthorizedAudio(
        rec.audio_url,
        rec.original_filename || `${rec.id}.webm`
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Audio download failed.');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Row */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Audio Recordings
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Persistent original audio files stored on your backend with playback, download, and re-transcription
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Model for re-transcription"
            value={retranscribeModel}
            onChange={(e) => setRetranscribeModel(e.target.value)}
            className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200"
          >
            {asrModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} {m.available ? '' : '(Unavailable)'}
              </option>
            ))}
          </select>

          <select
            aria-label="Mode for re-transcription"
            value={retranscribeMode}
            onChange={(e) => setRetranscribeMode(e.target.value as TranscriptionMode)}
            className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200"
          >
            <option value="verbatim">Verbatim Mode</option>
            <option value="clean">Clean Mode</option>
          </select>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter recordings by title, filename, model, or language..."
          className="w-full pl-10 pr-4 py-2.5 text-xs rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      {error && (
        <div className="p-3.5 rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-12 text-center space-y-3">
          <FileAudio className="w-10 h-10 text-slate-300 dark:text-slate-700 mx-auto" />
          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
            {records.length === 0 ? 'No recordings stored yet' : 'No recordings match your filter'}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Record speech or upload an audio file in the Studio to persist it here.
          </p>
          {records.length === 0 && (
            <button
              type="button"
              onClick={onGoToStudio}
              className="mt-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition-colors"
            >
              Open Voice Studio
            </button>
          )}
        </div>
      ) : (
        <div className="divide-y divide-slate-200 dark:divide-slate-800 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          {filtered.map((rec) => {
            const isBusy = busyId === rec.id;
            return (
              <div
                key={rec.id}
                id={`recording-row-${rec.id}`}
                className="p-5 space-y-3 hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors"
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div className="space-y-1 min-w-0">
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                      {rec.title}
                    </h2>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="font-mono tabular-nums">
                        {formatDuration(rec.duration_seconds)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">{formatBytes(rec.file_size_bytes)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{rec.mime_type}</span>
                      <span aria-hidden="true">·</span>
                      <span>{new Date(rec.created_at).toLocaleString()}</span>
                      <span aria-hidden="true">·</span>
                      <span>{rec.model_used || 'Not transcribed'}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onOpenInStudio(rec)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Open in Studio</span>
                    </button>

                    {rec.has_audio && (
                      <button
                        type="button"
                        onClick={() => handleRetranscribe(rec)}
                        disabled={isBusy}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-indigo-200 dark:border-indigo-900 bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 text-xs font-medium transition-colors"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isBusy ? 'animate-spin' : ''}`} />
                        <span>{isBusy ? 'Processing...' : 'Re-transcribe'}</span>
                      </button>
                    )}

                    {rec.audio_url && (
                      <button
                        type="button"
                        onClick={() => handleDownloadAudio(rec)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Audio</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleDelete(rec.id)}
                      disabled={isBusy}
                      aria-label={`Delete ${rec.title}`}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-red-200 dark:border-red-900/60 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Delete</span>
                    </button>
                  </div>
                </div>

                {rec.audio_url && (
                  <AuthorizedAudio
                    src={rec.audio_url}
                    controls
                    onAuthError={(err) => setError(err.message)}
                    className="w-full max-w-xl h-8"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
