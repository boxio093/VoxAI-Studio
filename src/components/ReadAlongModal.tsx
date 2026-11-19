import React, { useState, useRef, useEffect } from 'react';
import { X, Play, Pause, Volume2, RotateCcw } from 'lucide-react';
import { RecordingRecord } from '../types';
import { formatTime, pcmToWavBlob } from '../utils/audio';
import { synthesizeTTS } from '../utils/api';
import { AuthorizedAudio } from './AuthorizedAudio';

interface ReadAlongModalProps {
  record: RecordingRecord;
  onClose: () => void;
}

export const ReadAlongModal: React.FC<ReadAlongModalProps> = ({ record, onClose }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(record.duration_seconds || 0);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [autoScroll, setAutoScroll] = useState(true);
  const [activeAudioUrl, setActiveAudioUrl] = useState<string | null>(record.audio_url || null);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState('af_heart');
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeSegRef = useRef<HTMLButtonElement | null>(null);
  const generatedBlobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (generatedBlobUrlRef.current) {
        URL.revokeObjectURL(generatedBlobUrlRef.current);
        generatedBlobUrlRef.current = null;
      }
    };
  }, []);

  const fullText = record.edited_transcript ?? record.transcript ?? record.raw_transcript ?? '';

  // Use real Whisper segments when available; otherwise split sentences cleanly
  const items = React.useMemo(() => {
    if (record.segments && record.segments.length > 0) {
      return record.segments.map((s) => ({
        text: s.text,
        start: s.start,
        end: s.end,
      }));
    }
    const parts = fullText
      .split(/(?<=[.?!])\s+|\n+/)
      .map((p) => p.trim())
      .filter(Boolean);
    const totalDur = Math.max(1, duration || parts.length * 3);
    return parts.map((text, idx) => ({
      text,
      start: (idx / Math.max(1, parts.length)) * totalDur,
      end: ((idx + 1) / Math.max(1, parts.length)) * totalDur,
    }));
  }, [record.segments, fullText, duration]);

  const activeIndex = React.useMemo(() => {
    if (items.length === 0) return 0;
    const found = items.findIndex((seg) => currentTime >= seg.start && currentTime <= seg.end);
    if (found !== -1) return found;
    if (currentTime > items[items.length - 1].end) return items.length - 1;
    return 0;
  }, [currentTime, items]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === ' ' && e.target === document.body) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, activeAudioUrl]);

  useEffect(() => {
    if (autoScroll && activeSegRef.current) {
      activeSegRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeIndex, autoScroll]);

  const handleSynthesizeSpeech = async () => {
    if (!fullText.trim()) return;
    setIsSynthesizing(true);
    setError(null);
    try {
      const data = await synthesizeTTS({
        text: fullText.slice(0, 1500),
        voice: selectedVoice,
        speed: 1.0,
      });
      const wav = pcmToWavBlob(data.audio_base64, data.sample_rate || 24000);
      if (generatedBlobUrlRef.current) {
        URL.revokeObjectURL(generatedBlobUrlRef.current);
      }
      const url = URL.createObjectURL(wav);
      generatedBlobUrlRef.current = url;
      setActiveAudioUrl(url);
      setTimeout(() => {
        audioRef.current?.play().catch(() => {});
        setIsPlaying(true);
      }, 100);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'TTS synthesis failed.');
    } finally {
      setIsSynthesizing(false);
    }
  };

  const togglePlay = () => {
    if (!audioRef.current) {
      if (!activeAudioUrl) {
        handleSynthesizeSpeech();
      }
      return;
    }
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => {});
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value);
    setCurrentTime(t);
    if (audioRef.current) {
      audioRef.current.currentTime = t;
    }
  };

  const seekToSegment = (start: number) => {
    setCurrentTime(start);
    if (audioRef.current) {
      audioRef.current.currentTime = start;
      if (!isPlaying) {
        audioRef.current.play().catch(() => {});
        setIsPlaying(true);
      }
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="read-along-title"
      className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4"
    >
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="p-5 border-b border-slate-100 dark:border-slate-800 flex items-start justify-between gap-4">
          <div>
            <h2 id="read-along-title" className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {record.title}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Read-Along Playback · {record.detected_language} · {record.model_used}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Read-Along"
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 p-6 overflow-y-auto space-y-3">
          {items.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-8">
              No transcript text available.
            </p>
          ) : (
            <div className="space-y-2 leading-relaxed text-sm sm:text-base">
              {items.map((seg, idx) => {
                const isActive = idx === activeIndex && isPlaying;
                return (
                  <button
                    key={idx}
                    type="button"
                    ref={isActive ? activeSegRef : null}
                    onClick={() => seekToSegment(seg.start)}
                    className={`inline text-left rounded px-1.5 py-0.5 mr-1 transition-colors ${
                      isActive
                        ? 'bg-indigo-600 text-white font-medium'
                        : 'text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {seg.text}
                  </button>
                );
              })}
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
        </div>

        {activeAudioUrl && (
          <AuthorizedAudio
            ref={audioRef}
            src={activeAudioUrl}
            onAuthError={(err) => setError(err.message)}
            onTimeUpdate={() => {
              if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
            }}
            onLoadedMetadata={() => {
              if (audioRef.current && audioRef.current.duration) setDuration(audioRef.current.duration);
            }}
            onEnded={() => {
              setIsPlaying(false);
              setCurrentTime(0);
            }}
          />
        )}

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-900 text-white space-y-3">
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-400">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
            <input
              type="range"
              min="0"
              max={duration || 100}
              step="0.1"
              value={currentTime}
              onChange={handleSeek}
              disabled={!activeAudioUrl}
              className="w-full h-1.5 rounded-lg bg-slate-700 accent-indigo-500 cursor-pointer"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={togglePlay}
                disabled={isSynthesizing}
                className="w-10 h-10 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center transition-colors"
              >
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
              </button>

              <button
                type="button"
                onClick={() => {
                  setCurrentTime(0);
                  if (audioRef.current) audioRef.current.currentTime = 0;
                }}
                disabled={!activeAudioUrl}
                className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                title="Rewind"
              >
                <RotateCcw className="w-4 h-4" />
              </button>

              {!activeAudioUrl && (
                <div className="flex items-center gap-2">
                  <select
                    value={selectedVoice}
                    onChange={(e) => setSelectedVoice(e.target.value)}
                    className="text-xs bg-slate-800 border border-slate-700 text-slate-200 rounded-lg px-2 py-1.5"
                  >
                    <option value="af_heart">Kokoro: Heart (US Female)</option>
                    <option value="am_adam">Kokoro: Adam (US Male)</option>
                    <option value="bf_emma">Kokoro: Emma (UK Female)</option>
                    <option value="bm_george">Kokoro: George (UK Male)</option>
                  </select>
                  <button
                    type="button"
                    onClick={handleSynthesizeSpeech}
                    disabled={isSynthesizing}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium"
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>{isSynthesizing ? 'Synthesizing...' : 'Generate Kokoro Audio'}</span>
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 bg-slate-800 p-1 rounded-lg">
                {[0.75, 1, 1.25, 1.5].map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => {
                      setPlaybackRate(r);
                      if (audioRef.current) audioRef.current.playbackRate = r;
                    }}
                    className={`text-[11px] font-mono px-2 py-0.5 rounded ${
                      playbackRate === r ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {r}x
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  className="rounded border-slate-700 text-indigo-600"
                />
                <span>Auto-scroll</span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
