import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Download, Heart, Loader2, Play, Search, Sparkles, Volume2, WandSparkles } from 'lucide-react';
import { ModelInfo, TTSResponse, TTSVoiceInfo } from '../types';
import { fetchTTSVoices, synthesizeTTS } from '../utils/api';
import { pcmToWavBlob } from '../utils/audio';

interface TTSViewProps {
  initialText?: string;
  ttsModels: ModelInfo[];
  activeTtsModel: string;
}

const PREVIEW_TEXT = 'Hello there. This is a voice preview from VoxAI Studio.';

export const TTSView: React.FC<TTSViewProps> = ({ initialText = '', ttsModels, activeTtsModel }) => {
  const [text, setText] = useState(initialText || '');
  const [voices, setVoices] = useState<TTSVoiceInfo[]>([]);
  const [selectedVoice, setSelectedVoice] = useState('af_heart');
  const [speed, setSpeed] = useState(1);
  const [voiceSearch, setVoiceSearch] = useState('');
  const [languageFilter, setLanguageFilter] = useState('all');
  const [favorites, setFavorites] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('voxai_tts_favorites') || '[]'); } catch { return []; }
  });
  const [showFavorites, setShowFavorites] = useState(false);
  const [isLoadingVoices, setIsLoadingVoices] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [meta, setMeta] = useState<TTSResponse | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => { if (initialText) setText(initialText); }, [initialText]);
  useEffect(() => {
    try { localStorage.setItem('voxai_tts_favorites', JSON.stringify(favorites)); } catch {}
  }, [favorites]);
  useEffect(() => () => { if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current); }, []);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingVoices(true);
    setError(null);
    fetchTTSVoices(activeTtsModel).then(list => {
      if (cancelled) return;
      setVoices(list);
      if (list.length && !list.some(v => v.id === selectedVoice)) setSelectedVoice(list[0].id);
    }).catch(err => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load voices.');
    }).finally(() => { if (!cancelled) setIsLoadingVoices(false); });
    return () => { cancelled = true; };
  }, [activeTtsModel]);

  const currentModel = ttsModels.find(m => m.id === activeTtsModel);
  const currentVoice = voices.find(v => v.id === selectedVoice);
  const languages = useMemo(() => Array.from(new Set(voices.map(v => v.language).filter(Boolean))).sort(), [voices]);
  const filteredVoices = useMemo(() => voices.filter(v => {
    const q = voiceSearch.trim().toLowerCase();
    const matchesSearch = !q || [v.name, v.id, v.language, v.gender, v.accent, v.description].some(x => (x || '').toLowerCase().includes(q));
    return matchesSearch && (languageFilter === 'all' || v.language === languageFilter) && (!showFavorites || favorites.includes(v.id));
  }), [voices, voiceSearch, languageFilter, showFavorites, favorites]);

  const synthesize = async (content: string, preview = false) => {
    if (!content.trim()) { setError('Type or paste text to generate speech.'); return; }
    preview ? setIsPreviewing(true) : setIsGenerating(true);
    setError(null);
    try {
      const response = await synthesizeTTS({ text: content, voice: selectedVoice, speed, model: activeTtsModel });
      const wav = pcmToWavBlob(response.audio_base64, response.sample_rate || 24000);
      const url = URL.createObjectURL(wav);
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = url;
      setAudioBlob(wav);
      setAudioUrl(url);
      setMeta(response);
      if (preview) setTimeout(() => audioRef.current?.play().catch(() => {}), 80);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speech synthesis failed.');
    } finally {
      preview ? setIsPreviewing(false) : setIsGenerating(false);
    }
  };

  const toggleFavorite = (id: string) => setFavorites(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const downloadAudio = () => {
    if (!audioBlob) return;
    const a = document.createElement('a');
    const url = URL.createObjectURL(audioBlob);
    a.href = url; a.download = `voxai_${selectedVoice}_${Date.now()}.wav`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 text-xs font-semibold uppercase tracking-[0.16em]"><Sparkles size={14}/> Voice Studio</div>
          <h1 className="mt-1 text-2xl sm:text-3xl font-semibold tracking-tight text-slate-900 dark:text-white">Text to Speech</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Turn your script into expressive audio with VoxAI's available voices.</p>
        </div>
        <div className="inline-flex items-center gap-2 self-start rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
          <span className="h-2 w-2 rounded-full bg-emerald-500"/>
          {currentModel?.name || activeTtsModel}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
        <section className="xl:col-span-8 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-sm">
          <div className="p-5 sm:p-6 space-y-4">
            <div className="flex justify-between items-center gap-3">
              <label htmlFor="tts-text-input" className="font-medium text-sm text-slate-800 dark:text-slate-100">Your script</label>
              <span className="text-xs tabular-nums text-slate-400">{text.length.toLocaleString()} / 5000</span>
            </div>
            <textarea id="tts-text-input" value={text} onChange={e => setText(e.target.value)} rows={11} maxLength={5000}
              placeholder="Start writing or paste your script here…"
              className="w-full resize-y min-h-[220px] rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-4 sm:p-5 text-sm leading-7 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"/>
            <div className="flex flex-wrap gap-2">
              {['Clear script','Sample narration','Sample dialogue'].map((label, i) => (
                <button key={label} type="button" onClick={() => setText(i === 0 ? '' : i === 1 ? 'Welcome to VoxAI Studio. Create clear, natural speech from your words. Adjust your voice and pace, then generate your audio in seconds.' : 'Alex: Are you ready to begin?\nJordan: Absolutely. Let’s make something great today.')}
                  className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">{label}</button>
              ))}
            </div>
          </div>
          <div className="border-t border-slate-100 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/50 p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400"><AudioLines size={15}/> WAV output · {speed.toFixed(2)}× speed</div>
            <button id="tts-generate-btn" type="button" onClick={() => synthesize(text)} disabled={isGenerating || !text.trim() || voices.length === 0}
              className="inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:text-slate-500 dark:disabled:bg-slate-800 transition-colors">
              {isGenerating ? <><Loader2 size={16} className="animate-spin"/>Generating audio…</> : <><WandSparkles size={16}/>Generate speech</>}
            </button>
          </div>
        </section>

        <aside className="xl:col-span-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6 space-y-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-900 dark:text-white">Voice settings</h2>
            <span className="text-xs text-slate-400">{voices.length} voices</span>
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
              <input value={voiceSearch} onChange={e => setVoiceSearch(e.target.value)} placeholder="Search voices" aria-label="Search voices" className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/60"/>
            </div>
            <button type="button" onClick={() => setShowFavorites(x => !x)} title="Toggle favorite voices" className={`rounded-lg border px-3 ${showFavorites ? 'border-pink-300 bg-pink-50 text-pink-600 dark:bg-pink-950/40' : 'border-slate-200 dark:border-slate-800 text-slate-500'}`}><Heart size={16} fill={showFavorites ? 'currentColor' : 'none'}/></button>
          </div>
          <select aria-label="Filter voices by language" value={languageFilter} onChange={e => setLanguageFilter(e.target.value)} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm">
            <option value="all">All languages</option>{languages.map(lang => <option key={lang} value={lang}>{lang}</option>)}
          </select>
          <div className="max-h-[310px] overflow-y-auto space-y-2 pr-1" aria-label="Voice list">
            {isLoadingVoices ? <div className="py-8 text-center text-sm text-slate-500"><Loader2 size={18} className="inline animate-spin mr-2"/>Loading voice catalog…</div> :
              filteredVoices.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">No voices match those filters.</p> :
              filteredVoices.map(v => {
                const selected = selectedVoice === v.id;
                const favorite = favorites.includes(v.id);
                return <div key={v.id} className={`group flex items-center gap-2 rounded-xl border p-3 transition-colors ${selected ? 'border-indigo-400 bg-indigo-50/70 dark:bg-indigo-950/30' : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-950'}`}>
                  <button type="button" onClick={() => setSelectedVoice(v.id)} className="flex-1 min-w-0 text-left">
                    <div className="font-medium text-sm text-slate-800 dark:text-slate-100 truncate">{v.name}</div>
                    <div className="mt-0.5 text-[11px] text-slate-500 truncate">{v.language} · {v.gender}{v.accent ? ` · ${v.accent}` : ''}</div>
                  </button>
                  <button type="button" onClick={() => toggleFavorite(v.id)} aria-label={favorite ? 'Remove favorite voice' : 'Favorite voice'} className="p-1.5 rounded-md text-slate-400 hover:text-pink-500"><Heart size={15} fill={favorite ? 'currentColor' : 'none'}/></button>
                </div>;
              })}
          </div>
          <div className="pt-1 space-y-2">
            <div className="flex justify-between text-sm"><label htmlFor="tts-speed-range" className="text-slate-600 dark:text-slate-300">Speaking speed</label><span className="font-mono text-slate-700 dark:text-slate-200">{speed.toFixed(2)}×</span></div>
            <input id="tts-speed-range" type="range" min="0.6" max="1.6" step="0.05" value={speed} onChange={e => setSpeed(Number(e.target.value))} className="w-full accent-indigo-600"/>
            <div className="flex justify-between text-[10px] text-slate-400"><span>Slow</span><span>Fast</span></div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3">
            <div className="text-sm font-medium text-slate-800 dark:text-slate-200">{currentVoice?.name || 'Select a voice'}</div>
            <p className="mt-1 text-xs leading-5 text-slate-500">{currentVoice?.description || 'Choose a voice from the list to see its profile details.'}</p>
            <button type="button" onClick={() => synthesize(PREVIEW_TEXT, true)} disabled={isPreviewing || !selectedVoice || isLoadingVoices} className="mt-3 inline-flex items-center gap-2 text-xs font-semibold text-indigo-600 dark:text-indigo-400 disabled:opacity-50">
              {isPreviewing ? <Loader2 size={14} className="animate-spin"/> : <Play size={14}/>} Preview selected voice
            </button>
          </div>
        </aside>
      </div>

      {error && <div role="alert" className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 p-4 text-sm text-red-700 dark:text-red-300">{error}</div>}
      {audioUrl && meta && <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div><div className="font-semibold text-slate-900 dark:text-white flex items-center gap-2"><Volume2 size={16}/> Audio output</div><p className="mt-1 text-xs text-slate-500">{meta.model_used} · {meta.voice_used} · {meta.sample_rate} Hz · {meta.duration_seconds}s · {(meta.processing_duration_ms/1000).toFixed(2)}s generation</p></div>
          <button type="button" onClick={downloadAudio} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"><Download size={15}/>Download WAV</button>
        </div>
        <audio ref={audioRef} src={audioUrl} controls className="w-full"/>
      </section>}
    </div>
  );
};
