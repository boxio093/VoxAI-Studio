import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Download, Heart, Loader2, Play, Search, Sparkles, Volume2, WandSparkles, Library, Trash2, Pencil, Check, Mic, FileAudio, Plus, X } from 'lucide-react';
import { ModelInfo, TTSResponse, TTSVoiceInfo } from '../types';
import { fetchTTSVoices, synthesizeTTS } from '../utils/api';
import { pcmToWavBlob } from '../utils/audio';

interface TTSViewProps {
  initialText?: string;
  ttsModels: ModelInfo[];
  activeTtsModel: string;
}

const PREVIEW_TEXT = 'Hello there. This is a voice preview from VoxAI Studio.';
interface SavedAudio { id: string; title: string; voice: string; model: string; createdAt: number; duration: number; blob: Blob; }
interface VoiceProfile { id: string; name: string; notes: string; filename: string; createdAt: number; sample: Blob; }
const VOICE_DB = 'voxai_voice_profiles'; const VOICE_STORE = 'profiles';
const openVoiceDb = (): Promise<IDBDatabase> => new Promise((resolve,reject)=>{const req=indexedDB.open(VOICE_DB,1);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(VOICE_STORE))db.createObjectStore(VOICE_STORE,{keyPath:'id'});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||new Error('Could not open voice profile storage'));});
const loadVoiceProfiles = async (): Promise<VoiceProfile[]> => {const db=await openVoiceDb();return new Promise((resolve,reject)=>{const req=db.transaction(VOICE_STORE,'readonly').objectStore(VOICE_STORE).getAll();req.onerror=()=>{db.close();reject(req.error);};req.onsuccess=()=>{db.close();resolve((req.result as VoiceProfile[]).sort((a,b)=>b.createdAt-a.createdAt);};});};
const saveVoiceProfile = async (profile: VoiceProfile) => {const db=await openVoiceDb();await new Promise<void>((resolve,reject)=>{const req=db.transaction(VOICE_STORE,'readwrite').objectStore(VOICE_STORE).put(profile);req.onsuccess=()=>resolve();req.onerror=()=>reject(req.error);});db.close();};
const removeVoiceProfile = async (id:string)=>{const db=await openVoiceDb();await new Promise<void>((resolve,reject)=>{const req=db.transaction(VOICE_STORE,'readwrite').objectStore(VOICE_STORE).delete(id);req.onsuccess=()=>resolve();req.onerror=()=>reject(req.error);});db.close();};

const LIBRARY_DB = 'voxai_audio_library'; const LIBRARY_STORE = 'audio';
const openLibrary = (): Promise<IDBDatabase> => new Promise((resolve, reject) => { const req = indexedDB.open(LIBRARY_DB, 1); req.onupgradeneeded = () => { const db=req.result; if(!db.objectStoreNames.contains(LIBRARY_STORE)) db.createObjectStore(LIBRARY_STORE,{keyPath:'id'}); }; req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error||new Error('Could not open local audio library')); });
const libraryAll = async (): Promise<SavedAudio[]> => { const db=await openLibrary(); return new Promise((resolve,reject)=>{ const req=db.transaction(LIBRARY_STORE,'readonly').objectStore(LIBRARY_STORE).getAll(); req.onerror=()=>{db.close();reject(req.error);}; req.onsuccess=()=>{db.close();resolve((req.result as SavedAudio[]).sort((a,b)=>b.createdAt-a.createdAt));}; }); };
const librarySave = async (item: SavedAudio) => { const db=await openLibrary(); await new Promise<void>((resolve,reject)=>{const req=db.transaction(LIBRARY_STORE,'readwrite').objectStore(LIBRARY_STORE).put(item);req.onsuccess=()=>resolve();req.onerror=()=>reject(req.error);});db.close();};
const libraryDelete = async (id: string) => { const db=await openLibrary(); await new Promise<void>((resolve,reject)=>{const req=db.transaction(LIBRARY_STORE,'readwrite').objectStore(LIBRARY_STORE).delete(id);req.onsuccess=()=>resolve();req.onerror=()=>reject(req.error);});db.close();};


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
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [meta, setMeta] = useState<TTSResponse | null>(null);
  const [savedAudios, setSavedAudios] = useState<SavedAudio[]>([]);
  const [libraryUrls, setLibraryUrls] = useState<Record<string, string>>({});
  const [librarySearch, setLibrarySearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [libraryNotice, setLibraryNotice] = useState('');
  const [voiceProfiles, setVoiceProfiles] = useState<VoiceProfile[]>([]);
  const [voiceSampleUrls, setVoiceSampleUrls] = useState<Record<string,string>>({});
  const [profileName, setProfileName] = useState('');
  const [profileNotes, setProfileNotes] = useState('');
  const [profileSample, setProfileSample] = useState<File | null>(null);
  const [profileNotice, setProfileNotice] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const previewBlobUrlRef = useRef<string | null>(null);

  useEffect(() => { if (initialText) setText(initialText); }, [initialText]);
  useEffect(() => { libraryAll().then(setSavedAudios).catch(() => setLibraryNotice('Local library is unavailable in this browser.')); }, []);
  useEffect(() => { loadVoiceProfiles().then(setVoiceProfiles).catch(()=>setProfileNotice('Voice profile storage could not be opened in this browser.')); }, []);
  useEffect(() => { const urls:Record<string,string>={}; voiceProfiles.forEach(profile=>{urls[profile.id]=URL.createObjectURL(profile.sample);}); setVoiceSampleUrls(urls); return ()=>Object.values(urls).forEach(URL.revokeObjectURL); }, [voiceProfiles]);
  useEffect(() => { const next: Record<string,string> = {}; savedAudios.forEach(item => { next[item.id] = URL.createObjectURL(item.blob); }); setLibraryUrls(next); return () => Object.values(next).forEach(url => URL.revokeObjectURL(url)); }, [savedAudios]);
  useEffect(() => {
    try { localStorage.setItem('voxai_tts_favorites', JSON.stringify(favorites)); } catch {}
  }, [favorites]);
  useEffect(() => () => { if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current); if (previewBlobUrlRef.current) URL.revokeObjectURL(previewBlobUrlRef.current); }, []);

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
      if (preview) {
        if (previewBlobUrlRef.current) URL.revokeObjectURL(previewBlobUrlRef.current);
        previewBlobUrlRef.current = url;
        setPreviewUrl(url);
        setTimeout(() => previewAudioRef.current?.play().catch(() => {}), 80);
      } else {
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = url;
        setAudioBlob(wav);
        setAudioUrl(url);
        setMeta(response);
        const saved: SavedAudio = { id: crypto.randomUUID(), title: content.trim().replace(/\s+/g, ' ').slice(0, 48) || 'Untitled audio', voice: selectedVoice, model: response.model_used || activeTtsModel, createdAt: Date.now(), duration: response.duration_seconds || 0, blob: wav };
        try { await librarySave(saved); setSavedAudios(prev => [saved, ...prev]); setLibraryNotice('Audio automatically saved to your local library.'); } catch { setLibraryNotice('Audio generated, but automatic local saving failed. Download the WAV to keep it.'); }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Speech synthesis failed.');
    } finally {
      preview ? setIsPreviewing(false) : setIsGenerating(false);
    }
  };



  const createVoiceProfile = async () => { if(!profileName.trim() || !profileSample) { setProfileNotice('Add a profile name and an audio sample first.'); return; } if(profileSample.size > 20*1024*1024) { setProfileNotice('Sample audio must be 20 MB or smaller.'); return; } if(!profileSample.type.startsWith('audio/')) { setProfileNotice('Choose a supported audio file.'); return; } setSavingProfile(true); try { const profile:VoiceProfile={id:crypto.randomUUID(),name:profileName.trim(),notes:profileNotes.trim(),filename:profileSample.name,createdAt:Date.now(),sample:profileSample}; await saveVoiceProfile(profile); setVoiceProfiles(prev=>[profile,...prev]); setProfileName('');setProfileNotes('');setProfileSample(null);setProfileNotice('Voice profile saved locally. This is a reference profile; cloning is not enabled by the current TTS engine.'); } catch {setProfileNotice('Could not save profile. Browser storage may be full.');} finally{setSavingProfile(false);} };
  const deleteVoiceProfile = async (id:string) => { try{await removeVoiceProfile(id);setVoiceProfiles(prev=>prev.filter(p=>p.id!==id));setProfileNotice('Voice profile deleted.');}catch{setProfileNotice('Could not delete profile.');} };

  const deleteSavedAudio = async (id: string) => { try { await libraryDelete(id); setSavedAudios(prev => prev.filter(item => item.id !== id)); setLibraryNotice('Saved audio removed from this browser.'); } catch { setLibraryNotice('Unable to delete this saved audio.'); } };
  const renameSavedAudio = async (item: SavedAudio) => { const title=renameValue.trim(); if(!title) return; const updated={...item,title}; try { await librarySave(updated); setSavedAudios(prev=>prev.map(x=>x.id===item.id?updated:x)); setRenamingId(null); setLibraryNotice('Audio renamed.'); } catch { setLibraryNotice('Unable to rename this audio.'); } };
  const downloadSavedAudio = (item: SavedAudio) => { const url=URL.createObjectURL(item.blob); const a=document.createElement('a'); a.href=url; a.download=(item.title.replace(/[^a-z0-9-_ ]/gi,'').trim().replace(/\s+/g,'_')||'voxai_audio')+'.wav'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500); };
  const filteredLibrary = savedAudios.filter(item => item.title.toLowerCase().includes(librarySearch.toLowerCase()) || item.voice.toLowerCase().includes(librarySearch.toLowerCase()));

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
            {previewUrl && <audio ref={previewAudioRef} src={previewUrl} controls className="mt-3 w-full" aria-label="Voice preview audio player"/>
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

      <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6 shadow-sm space-y-4">
        <header><h2 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white"><Mic size={17}/> Voice Profile Lab</h2><p className="mt-1 text-xs text-slate-500">Build a local collection of voice reference samples for future voice-cloning workflows.</p></header>
        <div className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/20 p-3 text-xs leading-5 text-amber-800 dark:text-amber-300"><strong>Voice cloning is not active yet.</strong> Your profile and reference recording are stored locally for organization and playback only. The current TTS adapters do not accept voice samples for cloned synthesis.</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3"><input value={profileName} onChange={e=>setProfileName(e.target.value)} placeholder="Voice profile name (e.g. My narration)" maxLength={80} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"/><label className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm text-slate-600 dark:text-slate-300 cursor-pointer"><FileAudio size={16}/><span className="truncate">{profileSample?.name || 'Choose reference audio (20 MB max)'}</span><input type="file" accept="audio/*" className="sr-only" onChange={e=>setProfileSample(e.target.files?.[0] || null)}/></label></div>
        <textarea value={profileNotes} onChange={e=>setProfileNotes(e.target.value)} rows={2} maxLength={500} placeholder="Optional notes: tone, pacing, accent, recording conditions…" className="w-full resize-y rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"/>
        <div className="flex flex-wrap items-center gap-3"><button type="button" onClick={createVoiceProfile} disabled={savingProfile||!profileName.trim()||!profileSample} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"><Plus size={15}/>{savingProfile?'Saving profile…':'Save reference profile'}</button>{profileSample && <button type="button" onClick={()=>setProfileSample(null)} className="inline-flex items-center gap-1 text-xs text-slate-500"><X size={14}/>Remove selected file</button>}</div>
        {profileNotice && <p className="text-xs text-slate-500" role="status">{profileNotice}</p>}
        {voiceProfiles.length>0 && <div className="space-y-3"><div className="text-xs font-medium text-slate-500">{voiceProfiles.length} reference profile{voiceProfiles.length===1?'':'s'} saved on this device</div>{voiceProfiles.map(profile=><article key={profile.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 sm:p-4 flex flex-col gap-2"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="font-medium text-sm text-slate-900 dark:text-white">{profile.name}</h3><p className="text-xs text-slate-500 mt-0.5">{profile.filename} · saved {new Date(profile.createdAt).toLocaleDateString()}</p>{profile.notes && <p className="text-xs text-slate-500 mt-1">{profile.notes}</p>}</div><button type="button" onClick={()=>deleteVoiceProfile(profile.id)} title="Delete profile" className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg"><Trash2 size={15}/></button></div><audio controls preload="none" src={voiceSampleUrls[profile.id]} className="w-full"/></article>)}</div>}
      </section>

      <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6 shadow-sm space-y-4">
        <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white"><Library size={17}/> Local Audio Library</h2><p className="mt-1 text-xs text-slate-500">Generated audio is saved in this browser for playback and offline WAV downloads.</p></div><span className="rounded-full bg-slate-100 dark:bg-slate-800 px-3 py-1 text-xs text-slate-600 dark:text-slate-300">{savedAudios.length} saved</span></header>
        <input value={librarySearch} onChange={e=>setLibrarySearch(e.target.value)} placeholder="Search saved audio by title or voice…" className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/60"/>
        {libraryNotice && <p className="text-xs text-slate-500" role="status">{libraryNotice}</p>}
        {filteredLibrary.length===0 ? <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 py-8 text-center text-sm text-slate-500">{savedAudios.length===0 ? 'Your library is empty. Generate speech to automatically save it here.' : 'No saved audio matches that search.'}</div> : <div className="space-y-3">{filteredLibrary.map(item=><article key={item.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 sm:p-4 flex flex-col gap-3"><div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2"><div className="min-w-0 flex-1">{renamingId===item.id ? <div className="flex gap-2"><input autoFocus value={renameValue} onChange={e=>setRenameValue(e.target.value)} className="flex-1 rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1 text-sm"/><button onClick={()=>renameSavedAudio(item)} aria-label="Save title" className="text-emerald-600 p-1"><Check size={16}/></button></div> : <><h3 className="font-medium text-sm text-slate-900 dark:text-white truncate">{item.title}</h3><p className="text-xs text-slate-500 mt-1">{item.voice} · {item.model} · {new Date(item.createdAt).toLocaleString()} · {item.duration ? item.duration.toFixed(1)+'s' : 'WAV'}</p></>}</div><div className="flex items-center gap-1 self-end sm:self-auto"><button onClick={()=>{setRenamingId(item.id);setRenameValue(item.title);}} title="Rename" className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><Pencil size={15}/></button><button onClick={()=>downloadSavedAudio(item)} title="Download WAV" className="p-2 rounded-lg text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/30"><Download size={15}/></button><button onClick={()=>deleteSavedAudio(item.id)} title="Delete" className="p-2 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"><Trash2 size={15}/></button></div></div><audio controls preload="none" src={libraryUrls[item.id]} className="w-full"/></article>)}</div>}
      </section>
    </div>
  );
};
