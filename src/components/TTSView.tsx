import React, { useEffect, useRef, useState } from 'react';
import { Volume2, Download, AlertCircle } from 'lucide-react';
import { ModelInfo, TTSResponse, TTSVoiceInfo } from '../types';
import { fetchTTSVoices, synthesizeTTS } from '../utils/api';
import { pcmToWavBlob } from '../utils/audio';

interface TTSViewProps {
  initialText?: string;
  ttsModels: ModelInfo[];
  activeTtsModel: string;
}

export const TTSView: React.FC<TTSViewProps> = ({
  initialText = '',
  ttsModels,
  activeTtsModel,
}) => {
  const [text, setText] = useState(
    initialText ||
      'Welcome to VoxAI. Open-weight speech synthesis running directly through the Kokoro 82M neural engine.'
  );
  const [voices, setVoices] = useState<TTSVoiceInfo[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>('af_heart');
  const [speed, setSpeed] = useState<number>(1.0);
  const [isLoadingVoices, setIsLoadingVoices] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [meta, setMeta] = useState<TTSResponse | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (initialText) {
      setText(initialText);
    }
  }, [initialText]);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingVoices(true);
    fetchTTSVoices(activeTtsModel)
      .then((list) => {
        if (cancelled) return;
        setVoices(list);
        if (list.length > 0 && !list.some((v) => v.id === selectedVoice)) {
          setSelectedVoice(list[0].id);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load available TTS voices.');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingVoices(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTtsModel]);

  const currentModel = ttsModels.find((m) => m.id === activeTtsModel);
  const currentVoice = voices.find((v) => v.id === selectedVoice);

  const handleGenerate = async () => {
    if (!text.trim()) {
      setError('Enter text to synthesize.');
      return;
    }
    setIsGenerating(true);
    setError(null);
    try {
      const res = await synthesizeTTS({
        text,
        voice: selectedVoice,
        speed,
        model: activeTtsModel,
      });
      const wav = pcmToWavBlob(res.audio_base64, res.sample_rate || 24000);
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
      const url = URL.createObjectURL(wav);
      blobUrlRef.current = url;
      setAudioBlob(wav);
      setAudioUrl(url);
      setMeta(res);
      setTimeout(() => {
        audioRef.current?.play().catch(() => {});
      }, 80);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Speech synthesis failed.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = () => {
    if (!audioBlob) return;
    const url = URL.createObjectURL(audioBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voxai_${selectedVoice}_${Date.now()}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Open-Model Text to Speech
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Synthesize natural speech using open-weight Kokoro voices. Independent from speech recognition.
          </p>
        </div>
        {currentModel && (
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Active Engine: <span className="font-medium text-slate-900 dark:text-slate-100">{currentModel.name}</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <label
              htmlFor="tts-text-input"
              className="text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Input Text
            </label>
            <span className="text-xs font-mono tabular-nums text-slate-400">
              {text.length} / 5000 chars
            </span>
          </div>

          <textarea
            id="tts-text-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            maxLength={5000}
            placeholder="Enter text to synthesize..."
            className="w-full p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100 leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />

          <div className="flex flex-wrap gap-2">
            {[
              'Welcome to VoxAI. Open-weight speech synthesis running on your backend.',
              'Verbatim transcription preserves every spoken word, hesitation, and repetition accurately.',
              'Testing multi-accent synthesis clarity across studio voice profiles.',
            ].map((sample, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setText(sample)}
                className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                Sample {i + 1}
              </button>
            ))}
          </div>
        </section>

        <section className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col justify-between space-y-5">
          <div className="space-y-4">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 pb-3 border-b border-slate-100 dark:border-slate-800">
              Voice Configuration
            </h2>

            <div>
              <label
                htmlFor="tts-voice-select"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Voice Profile ({voices.length} available)
              </label>
              <select
                id="tts-voice-select"
                value={selectedVoice}
                onChange={(e) => setSelectedVoice(e.target.value)}
                disabled={isLoadingVoices || voices.length === 0}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · {v.language} · {v.gender}
                  </option>
                ))}
              </select>
              {currentVoice && (
                <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                  {currentVoice.description}
                </p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <label
                  htmlFor="tts-speed-range"
                  className="font-medium text-slate-700 dark:text-slate-300"
                >
                  Speaking Speed
                </label>
                <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                  {speed.toFixed(2)}x
                </span>
              </div>
              <input
                id="tts-speed-range"
                type="range"
                min="0.6"
                max="1.6"
                step="0.05"
                value={speed}
                onChange={(e) => setSpeed(parseFloat(e.target.value))}
                className="w-full accent-indigo-600 cursor-pointer"
              />
            </div>

            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400">
              Voice cloning is not enabled on this engine. Only built-in pre-trained open-weight voices are available.
            </div>
          </div>

          <button
            id="tts-generate-btn"
            type="button"
            onClick={handleGenerate}
            disabled={isGenerating || !text.trim() || voices.length === 0}
            className={`w-full py-3 px-4 min-h-[44px] rounded-xl text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors ${
              isGenerating || !text.trim() || voices.length === 0
                ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-700 text-white'
            }`}
          >
            <Volume2 className="w-4 h-4" />
            <span>{isGenerating ? 'Synthesizing WAV...' : 'Generate Speech'}</span>
          </button>
        </section>
      </div>

      {error && (
        <div
          role="alert"
          className="p-4 rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-xs flex items-center gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {audioUrl && meta && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Generated Audio
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono tabular-nums">
                {meta.model_used} · {meta.voice_used} · {meta.sample_rate} Hz · {meta.duration_seconds}s · Generated in{' '}
                {(meta.processing_duration_ms / 1000).toFixed(2)}s
              </p>
            </div>
            <button
              id="tts-download-wav-btn"
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors self-start sm:self-auto"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download WAV</span>
            </button>
          </div>
          <audio ref={audioRef} src={audioUrl} controls className="w-full h-10" />
        </section>
      )}
    </div>
  );
};
