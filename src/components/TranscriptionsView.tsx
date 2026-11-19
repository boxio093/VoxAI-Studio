import React, { useMemo, useState } from 'react';
import {
  Search,
  Download,
  Copy,
  Check,
  Trash2,
  BookOpen,
  Volume2,
  ExternalLink,
  X,
} from 'lucide-react';
import { RecordingRecord } from '../types';
import { formatDuration } from '../utils/audio';
import {
  buildSrtExport,
  buildTxtExport,
  buildVttExport,
  exportRecordingCsv,
  triggerFileDownload,
} from '../utils/exporters';
import { LanguageDistributionCard } from './LanguageDistributionCard';
import { ReadAlongModal } from './ReadAlongModal';
import { AuthorizedAudio } from './AuthorizedAudio';

interface TranscriptionsViewProps {
  records: RecordingRecord[];
  onDeleteRecord: (id: string) => Promise<void>;
  onOpenInStudio: (record: RecordingRecord) => void;
  onSendToTTS: (text: string) => void;
  onGoToStudio: () => void;
}

export const TranscriptionsView: React.FC<TranscriptionsViewProps> = ({
  records,
  onDeleteRecord,
  onOpenInStudio,
  onSendToTTS,
  onGoToStudio,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'week' | 'month'>('all');
  const [modeFilter, setModeFilter] = useState<'all' | 'verbatim' | 'clean'>('all');
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [viewModeMap, setViewModeMap] = useState<Record<string, 'active' | 'verbatim' | 'clean'>>({});
  const [readAlongRecord, setReadAlongRecord] = useState<RecordingRecord | null>(null);

  const transcribedRecords = useMemo(
    () => records.filter((r) => Boolean(r.raw_transcript || r.transcript)),
    [records]
  );

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const now = Date.now();
    const oneDay = 86_400_000;

    return transcribedRecords.filter((rec) => {
      if (selectedLanguage && rec.detected_language.toLowerCase() !== selectedLanguage.toLowerCase()) {
        return false;
      }
      if (modeFilter !== 'all' && rec.transcription_mode !== modeFilter) {
        return false;
      }
      if (dateFilter === 'today') {
        if (new Date(rec.created_at).toDateString() !== new Date(now).toDateString()) return false;
      } else if (dateFilter === 'week') {
        if (now - rec.created_at > 7 * oneDay) return false;
      } else if (dateFilter === 'month') {
        if (now - rec.created_at > 30 * oneDay) return false;
      }

      if (!q) return true;
      return (
        rec.title.toLowerCase().includes(q) ||
        rec.raw_transcript.toLowerCase().includes(q) ||
        rec.clean_transcript.toLowerCase().includes(q) ||
        (rec.edited_transcript || '').toLowerCase().includes(q) ||
        rec.detected_language.toLowerCase().includes(q) ||
        rec.model_used.toLowerCase().includes(q) ||
        new Date(rec.created_at).toLocaleDateString().toLowerCase().includes(q)
      );
    });
  }, [transcribedRecords, searchQuery, dateFilter, modeFilter, selectedLanguage]);

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Transcriptions
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Search, compare verbatim vs clean transcripts, launch read-along, and export TXT, SRT, VTT, JSON, or CSV
          </p>
        </div>

        {filtered.length > 0 && (
          <button
            id="export-all-csv-btn"
            type="button"
            onClick={() => exportRecordingCsv(filtered)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors self-start sm:self-auto"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV ({filtered.length})</span>
          </button>
        )}
      </div>

      {/* Language Distribution Card */}
      <LanguageDistributionCard
        records={transcribedRecords}
        selectedLanguage={selectedLanguage}
        onSelectLanguage={setSelectedLanguage}
      />

      {/* Search & Filter Controls */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
            <input
              id="history-search-input"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search transcripts by keyword, model, language, or date..."
              className="w-full pl-10 pr-9 py-2.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800 overflow-x-auto">
            {(
              [
                { id: 'all', label: 'All Time' },
                { id: 'today', label: 'Today' },
                { id: 'week', label: '7 Days' },
                { id: 'month', label: '30 Days' },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setDateFilter(f.id)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                  dateFilter === f.id
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800">
            {(
              [
                { id: 'all', label: 'All Modes' },
                { id: 'verbatim', label: 'Verbatim' },
                { id: 'clean', label: 'Clean' },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setModeFilter(m.id)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                  modeFilter === m.id
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Transcript Cards */}
      {filtered.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-12 text-center space-y-3">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
            {transcribedRecords.length === 0
              ? 'No completed transcriptions yet'
              : 'No transcripts match your current filters'}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Record speech or upload an audio file in the Studio to generate your first transcript.
          </p>
          {transcribedRecords.length === 0 && (
            <button
              type="button"
              onClick={onGoToStudio}
              className="mt-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition-colors"
            >
              Go to Studio
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((rec) => {
            const viewTab = viewModeMap[rec.id] || 'active';
            const displayText =
              viewTab === 'verbatim'
                ? rec.raw_transcript
                : viewTab === 'clean'
                ? rec.clean_transcript
                : rec.edited_transcript ?? rec.transcript;
            const safeBase = rec.title.replace(/[^a-zA-Z0-9_-]+/g, '_') || rec.id;

            return (
              <article
                key={rec.id}
                id={`transcript-card-${rec.id}`}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4"
              >
                {/* Header & Unboxed Metadata */}
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {rec.title}
                    </h2>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mt-1">
                      <span className="font-mono tabular-nums">
                        {formatDuration(rec.duration_seconds)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{rec.detected_language}</span>
                      <span aria-hidden="true">·</span>
                      <span>{rec.model_used}</span>
                      <span aria-hidden="true">·</span>
                      <span>{rec.transcription_mode}</span>
                      <span aria-hidden="true">·</span>
                      <span>{new Date(rec.created_at).toLocaleString()}</span>
                    </div>
                  </div>

                  {/* Variant Switcher */}
                  <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800 self-start lg:self-auto">
                    {(
                      [
                        { id: 'active', label: rec.edited_transcript ? 'Edited' : 'Active' },
                        { id: 'verbatim', label: 'Verbatim' },
                        { id: 'clean', label: 'Clean' },
                      ] as const
                    ).map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setViewModeMap((prev) => ({ ...prev, [rec.id]: t.id }))}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                          viewTab === t.id
                            ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Transcript Text */}
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-800 dark:text-slate-200 leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {displayText || 'No audible speech detected.'}
                </div>

                {/* Original Audio Playback */}
                {rec.audio_url && (
                  <AuthorizedAudio src={rec.audio_url} controls className="w-full max-w-md h-8" />
                )}

                {/* Actions & Exports */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setReadAlongRecord(rec)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition-colors"
                    >
                      <BookOpen className="w-3.5 h-3.5" />
                      <span>Read-Along</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onOpenInStudio(rec)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Edit</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onSendToTTS(displayText)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      <Volume2 className="w-3.5 h-3.5" />
                      <span>TTS</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleCopy(rec.id, displayText)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      {copiedId === rec.id ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      <span>{copiedId === rec.id ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        triggerFileDownload(
                          buildTxtExport(displayText, rec.segments, false),
                          `${safeBase}.txt`,
                          'text/plain;charset=utf-8'
                        )
                      }
                      className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      TXT
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        triggerFileDownload(
                          buildSrtExport(rec.segments, displayText, rec.duration_seconds),
                          `${safeBase}.srt`,
                          'application/x-subrip;charset=utf-8'
                        )
                      }
                      className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      SRT
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        triggerFileDownload(
                          buildVttExport(rec.segments, displayText, rec.duration_seconds),
                          `${safeBase}.vtt`,
                          'text/vtt;charset=utf-8'
                        )
                      }
                      className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      VTT
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        triggerFileDownload(
                          JSON.stringify(rec, null, 2),
                          `${safeBase}.json`,
                          'application/json;charset=utf-8'
                        )
                      }
                      className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      JSON
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteRecord(rec.id)}
                      aria-label={`Delete ${rec.title}`}
                      className="p-1.5 rounded-lg border border-red-200 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {readAlongRecord && (
        <ReadAlongModal
          record={readAlongRecord}
          onClose={() => setReadAlongRecord(null)}
        />
      )}
    </div>
  );
};
