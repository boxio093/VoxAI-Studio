import React, { useEffect, useRef, useState } from 'react';
import {
  Mic,
  Square,
  Pause,
  Play,
  RotateCcw,
  Upload,
  Download,
  Copy,
  Check,
  Save,
  Volume2,
  AlertCircle,
  Clock,
  FileAudio,
} from 'lucide-react';
import {
  AppSettings,
  ModelInfo,
  RecordingRecord,
  TranscribeResponse,
  TranscriptSegment,
  TranscriptionMode,
} from '../types';
import {
  createTranscribeWebSocket,
  downloadAuthorizedAudio,
  fetchJobStatus,
  transcribeAudio,
  updateRecording,
  waitForWebSocketOpen,
} from '../utils/api';
import { formatTime } from '../utils/audio';
import {
  buildSrtExport,
  buildTxtExport,
  buildVttExport,
  formatSegmentClock,
  triggerFileDownload,
} from '../utils/exporters';
import { AuthorizedAudio } from './AuthorizedAudio';

interface StudioViewProps {
  asrModels: ModelInfo[];
  appSettings: AppSettings;
  onRecordingCompleted: (recordId: string) => Promise<RecordingRecord | null>;
  onSendToTTS: (text: string) => void;
  focusRecording?: RecordingRecord | null;
}

const LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Auto-detect language' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'pl', label: 'Polish' },
  { value: 'ru', label: 'Russian' },
  { value: 'uk', label: 'Ukrainian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Mandarin Chinese' },
  { value: 'ko', label: 'Korean' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ar', label: 'Arabic' },
  { value: 'tr', label: 'Turkish' },
];

export const StudioView: React.FC<StudioViewProps> = ({
  asrModels,
  appSettings,
  onRecordingCompleted,
  onSendToTTS,
  focusRecording,
}) => {
  // Recording state
  const [recState, setRecState] = useState<'idle' | 'recording' | 'paused'>('idle');
  const [micPermission, setMicPermission] = useState<'unknown' | 'granted' | 'denied' | 'prompt'>('unknown');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioFilename, setAudioFilename] = useState<string>('');
  const [recordingTitle, setRecordingTitle] = useState<string>('');

  // Configuration state
  const [selectedModel, setSelectedModel] = useState<string>(appSettings.active_asr_model || 'faster-whisper-base');
  const [language, setLanguage] = useState<string>(appSettings.default_language || 'auto');
  const [mode, setMode] = useState<TranscriptionMode>(appSettings.default_mode || 'verbatim');
  const [removeFillers, setRemoveFillers] = useState<boolean>(false);
  const [enableTimestamps, setEnableTimestamps] = useState<boolean>(true);
  const [enableSpeakerTurns, setEnableSpeakerTurns] = useState<boolean>(false);
  const [useBackgroundJob, setUseBackgroundJob] = useState<boolean>(false);

  // Processing & WebSocket state
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [progressStage, setProgressStage] = useState('');
  const [streamingSegments, setStreamingSegments] = useState<TranscriptSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Active Transcription Result & Editing state
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);
  const [result, setResult] = useState<TranscribeResponse | null>(null);
  const [transcriptViewTab, setTranscriptViewTab] = useState<'editable' | 'verbatim' | 'clean' | 'segments'>('editable');
  const [editedText, setEditedText] = useState('');
  const [isSavingEdits, setIsSavingEdits] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const [copied, setCopied] = useState(false);

  // Audio playback
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);

  // Web Audio & MediaRecorder refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const cancelledRef = useRef<boolean>(false);
  const localBlobUrlRef = useRef<string | null>(null);

  const setLocalAudioUrl = (nextUrl: string | null) => {
    if (localBlobUrlRef.current && localBlobUrlRef.current !== nextUrl) {
      URL.revokeObjectURL(localBlobUrlRef.current);
      localBlobUrlRef.current = null;
    }
    if (nextUrl && nextUrl.startsWith('blob:')) {
      localBlobUrlRef.current = nextUrl;
    }
    setAudioUrl(nextUrl);
  };

  // Sync defaults when settings arrive
  useEffect(() => {
    if (appSettings.active_asr_model) {
      setSelectedModel(appSettings.active_asr_model);
    }
    if (appSettings.default_mode) {
      setMode(appSettings.default_mode);
    }
    if (appSettings.default_language) {
      setLanguage(appSettings.default_language);
    }
  }, [appSettings]);

  // Populate workspace if user clicked "Open in Studio" from Recordings/Transcriptions
  useEffect(() => {
    if (!focusRecording) return;
    setActiveRecordId(focusRecording.id);
    setRecordingTitle(focusRecording.title);
    setAudioFilename(focusRecording.original_filename);
    setAudioBlob(null);
    setLocalAudioUrl(focusRecording.audio_url || null);
    setElapsedSeconds(Math.round(focusRecording.duration_seconds || 0));
    setMode(focusRecording.transcription_mode);
    setEditedText(focusRecording.edited_transcript ?? focusRecording.transcript);
    setResult({
      recording_id: focusRecording.id,
      transcript: focusRecording.transcript,
      raw_transcript: focusRecording.raw_transcript,
      clean_transcript: focusRecording.clean_transcript,
      detected_language: focusRecording.detected_language,
      language_probability: focusRecording.language_probability,
      duration_seconds: focusRecording.duration_seconds,
      processing_duration_ms: focusRecording.processing_duration_ms,
      model_used: focusRecording.model_used,
      transcription_mode: focusRecording.transcription_mode,
      timestamps_enabled: focusRecording.segments.length > 0,
      segments: focusRecording.segments,
      processing_status: focusRecording.processing_status,
      audio_url: focusRecording.audio_url,
      silence_detected: !focusRecording.raw_transcript,
      warnings: [],
    });
    setTranscriptViewTab('editable');
    setError(null);
  }, [focusRecording]);

  // Check microphone permission state cleanly
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
      navigator.permissions
        .query({ name: 'microphone' as PermissionName })
        .then((status) => {
          setMicPermission(status.state as 'granted' | 'denied' | 'prompt');
          status.onchange = () => {
            setMicPermission(status.state as 'granted' | 'denied' | 'prompt');
          };
        })
        .catch(() => setMicPermission('unknown'));
    }
  }, []);

  useEffect(() => {
    return () => {
      cleanupAudioPipeline();
      if (localBlobUrlRef.current) {
        URL.revokeObjectURL(localBlobUrlRef.current);
        localBlobUrlRef.current = null;
      }
    };
  }, []);

  const cleanupAudioPipeline = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
  };

  const getSupportedMimeType = (): string => {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (const mime of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    }
    return '';
  };

  const startWaveformLoop = (stream: MediaStream) => {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.78;
      analyserRef.current = analyser;

      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);

      const render = () => {
        animFrameRef.current = requestAnimationFrame(render);
        const canvas = canvasRef.current;
        if (!canvas) return;
        const g = canvas.getContext('2d');
        if (!g) return;

        g.clearRect(0, 0, canvas.width, canvas.height);

        if (mediaRecorderRef.current?.state === 'paused') {
          g.fillStyle = 'rgba(148, 163, 184, 0.35)';
          const centerY = canvas.height / 2;
          g.fillRect(0, centerY - 1, canvas.width, 2);
          return;
        }

        analyser.getByteFrequencyData(data);
        const bars = 48;
        const gap = 3;
        const barW = (canvas.width - gap * (bars - 1)) / bars;

        for (let i = 0; i < bars; i++) {
          const idx = Math.floor((i / bars) * (data.length * 0.75));
          const normalized = data[idx] / 255;
          const barH = Math.max(4, normalized * (canvas.height - 6));
          const x = i * (barW + gap);
          const y = (canvas.height - barH) / 2;

          g.fillStyle = normalized > 0.55 ? '#4f46e5' : '#6366f1';
          g.beginPath();
          g.roundRect(x, y, barW, barH, 3);
          g.fill();
        }
      };

      render();
    } catch {
      // Waveform unavailable in restricted environments
    }
  };

  const handleStartRecording = async () => {
    setError(null);
    setWarnings([]);
    setResult(null);
    setActiveRecordId(null);
    setSavedFeedback(false);
    cancelledRef.current = false;
    chunksRef.current = [];

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone recording is not supported by this browser. Please upload an audio file instead.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      setMicPermission('granted');
      streamRef.current = stream;

      const mimeType = getSupportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          chunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = () => {
        cleanupAudioPipeline();
        if (cancelledRef.current) {
          setAudioBlob(null);
          setLocalAudioUrl(null);
          setAudioFilename('');
          setElapsedSeconds(0);
          return;
        }
        const finalMime = recorder.mimeType || 'audio/webm';
        const ext = finalMime.includes('ogg') ? 'ogg' : finalMime.includes('mp4') ? 'm4a' : 'webm';
        const blob = new Blob(chunksRef.current, { type: finalMime });
        if (blob.size === 0) {
          setError('Recorded audio buffer was empty. Please speak into the microphone and try again.');
          return;
        }
        setAudioBlob(blob);
        const url = URL.createObjectURL(blob);
        setLocalAudioUrl(url);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        setAudioFilename(`recording_${stamp}.${ext}`);
        setRecordingTitle(`Voice Recording ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
      };

      recorder.start(250);
      setRecState('recording');
      setElapsedSeconds(0);
      timerRef.current = window.setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
      startWaveformLoop(stream);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('denied') || msg.toLowerCase().includes('permission') || (err as { name?: string })?.name === 'NotAllowedError') {
        setMicPermission('denied');
        setError('Microphone permission was denied. Allow microphone access in browser settings or upload an audio file.');
      } else if ((err as { name?: string })?.name === 'NotFoundError') {
        setError('No microphone input device was detected on this system.');
      } else {
        setError(`Could not access microphone: ${msg}`);
      }
    }
  };

  const handlePauseRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.pause();
      setRecState('paused');
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };

  const handleResumeRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
      mediaRecorderRef.current.resume();
      setRecState('recording');
      timerRef.current = window.setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    }
  };

  const handleStopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      setRecState('idle');
    }
  };

  const handleCancelRecording = () => {
    cancelledRef.current = true;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else {
      cleanupAudioPipeline();
    }
    setRecState('idle');
    setAudioBlob(null);
    setLocalAudioUrl(null);
    setAudioFilename('');
    setElapsedSeconds(0);
    setError(null);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validExt = /\.(mp3|wav|m4a|mp4|webm|ogg|opus|flac|aac|wma)$/i.test(file.name);
    if (!file.type.startsWith('audio/') && !file.type.startsWith('video/webm') && !validExt) {
      setError(`Unsupported file '${file.name}'. Upload WAV, MP3, M4A, WEBM, OGG, FLAC, or AAC.`);
      return;
    }

    const maxBytes = (appSettings.max_upload_mb || 100) * 1024 * 1024;
    if (file.size > maxBytes) {
      setError(`File exceeds the ${appSettings.max_upload_mb} MB upload limit.`);
      return;
    }

    setError(null);
    setWarnings([]);
    setResult(null);
    setActiveRecordId(null);
    setAudioBlob(file);
    const url = URL.createObjectURL(file);
    setLocalAudioUrl(url);
    setAudioFilename(file.name);
    setRecordingTitle(file.name.replace(/\.[^.]+$/, ''));

    const probe = new Audio(url);
    probe.onloadedmetadata = () => {
      if (probe.duration && isFinite(probe.duration)) {
        setElapsedSeconds(Math.round(probe.duration));
      }
    };
  };

  const handleTranscribe = async () => {
    if (!audioBlob && !activeRecordId) {
      setError('Record speech or upload an audio file before running transcription.');
      return;
    }

    setIsTranscribing(true);
    setError(null);
    setWarnings([]);
    setProgressPct(5);
    setProgressStage('Submitting audio to open-model speech backend...');
    setStreamingSegments([]);
    setSavedFeedback(false);

    const channel = `studio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ws = createTranscribeWebSocket(channel);

    if (ws) {
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'progress') {
            if (typeof msg.progress === 'number') setProgressPct(msg.progress);
            if (msg.stage) setProgressStage(msg.stage);
            if (msg.segment) {
              setStreamingSegments((prev) => [...prev, msg.segment]);
            }
          } else if (msg.type === 'error') {
            setError(msg.error || 'Transcription failed.');
          }
        } catch {
          // Ignore malformed WS message
        }
      };
      await waitForWebSocketOpen(ws, 1500);
    }

    try {
      const response = await transcribeAudio({
        file: audioBlob || undefined,
        filename: audioFilename || 'recording.webm',
        recordingId: !audioBlob && activeRecordId ? activeRecordId : undefined,
        title: recordingTitle || audioFilename || 'Voice Recording',
        language,
        model: selectedModel,
        mode,
        removeFillers: mode === 'clean' ? removeFillers : false,
        timestamps: enableTimestamps,
        speakerTurns: enableSpeakerTurns,
        background: useBackgroundJob,
        wsChannel: channel,
        consentForTraining: appSettings.training_consent_default,
      });

      // Handle async background queue (202 Accepted)
      let finalResult: TranscribeResponse = response;
      if (response.processing_status === 'queued' && response.job_id) {
        setProgressStage('Processing in background queue...');
        while (true) {
          await new Promise((r) => setTimeout(r, 1000));
          const job = await fetchJobStatus(response.job_id);
          setProgressPct(job.progress);
          setProgressStage(job.stage);
          if (job.status === 'completed' && job.result) {
            finalResult = job.result;
            break;
          }
          if (job.status === 'failed') {
            throw new Error(job.error || 'Background transcription job failed.');
          }
        }
      }

      setResult(finalResult);
      setActiveRecordId(finalResult.recording_id);
      setEditedText(finalResult.transcript);
      setWarnings(finalResult.warnings || []);
      if (finalResult.audio_url && !localBlobUrlRef.current) {
        setLocalAudioUrl(finalResult.audio_url);
      }
      setProgressPct(100);
      setProgressStage('Complete');
      await onRecordingCompleted(finalResult.recording_id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Transcription request failed.';
      setError(msg);
    } finally {
      setIsTranscribing(false);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
  };

  const handleSaveEdits = async () => {
    if (!activeRecordId) return;
    setIsSavingEdits(true);
    setError(null);
    try {
      const updated = await updateRecording(activeRecordId, {
        title: recordingTitle || undefined,
        edited_transcript: editedText,
      });
      setResult((prev) =>
        prev
          ? {
              ...prev,
              transcript: updated.transcript,
            }
          : prev
      );
      setSavedFeedback(true);
      setTimeout(() => setSavedFeedback(false), 2500);
      await onRecordingCompleted(activeRecordId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save edits.');
    } finally {
      setIsSavingEdits(false);
    }
  };

  const handleCopyTranscript = () => {
    const text =
      transcriptViewTab === 'verbatim'
        ? result?.raw_transcript || ''
        : transcriptViewTab === 'clean'
        ? result?.clean_transcript || ''
        : editedText;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadAudio = async () => {
    if (!audioUrl) return;
    setError(null);
    try {
      await downloadAuthorizedAudio(
        audioUrl,
        audioFilename || `recording_${Date.now()}.webm`
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to download audio.');
    }
  };

  const seekAudio = (seconds: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = seconds;
    audioRef.current.play().catch(() => {});
    setIsPlayingAudio(true);
  };

  const activeModelMeta = asrModels.find((m) => m.id === selectedModel);
  const safeBaseName = (recordingTitle || audioFilename || 'transcript').replace(/[^a-zA-Z0-9_-]+/g, '_');

  return (
    <div className="space-y-8">
      {/* Studio Workspace Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left: Primary Recording & Audio Input Console */}
        <section className="lg:col-span-7 min-w-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
              <div className="min-w-0">
                <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Voice Studio
                </h1>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Record from microphone or upload audio for open-model speech recognition
                </p>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 shrink-0 whitespace-nowrap">
                <span>Mic:</span>
                <span
                  className={
                    micPermission === 'denied'
                      ? 'text-red-600 dark:text-red-400 font-medium'
                      : micPermission === 'granted'
                      ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                      : 'text-slate-600 dark:text-slate-300'
                  }
                >
                  {micPermission === 'granted'
                    ? 'Ready'
                    : micPermission === 'denied'
                    ? 'Blocked'
                    : 'On demand'}
                </span>
              </div>
            </div>

            {/* Live Waveform & Recording Stage */}
            <div className="my-6 p-6 rounded-xl bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 flex flex-col items-center justify-center gap-5 min-h-[240px]">
              {/* Live Status & Tabular Timer */}
              <div className="flex items-center gap-3">
                {recState === 'recording' && (
                  <span
                    aria-label="Live recording active"
                    className="w-2.5 h-2.5 rounded-full bg-red-600 animate-pulse"
                  />
                )}
                <span className="font-mono tabular-nums text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                  {formatTime(elapsedSeconds)}
                </span>
                {recState !== 'idle' && (
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    {recState === 'recording' ? 'Recording' : 'Paused'}
                  </span>
                )}
              </div>

              {/* Live Canvas Waveform */}
              <canvas
                ref={canvasRef}
                width={480}
                height={68}
                aria-label="Live audio waveform"
                className="w-full max-w-md h-16"
              />

              {/* Accessible Recording Controls */}
              <div className="flex flex-wrap items-center justify-center gap-3">
                {recState === 'idle' ? (
                  <button
                    id="start-recording-btn"
                    type="button"
                    onClick={handleStartRecording}
                    className="inline-flex items-center gap-2.5 px-6 py-3 min-h-[44px] rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  >
                    <Mic className="w-4 h-4" />
                    <span>{audioBlob ? 'Record New Clip' : 'Start Recording'}</span>
                  </button>
                ) : (
                  <>
                    {recState === 'recording' ? (
                      <button
                        id="pause-recording-btn"
                        type="button"
                        onClick={handlePauseRecording}
                        className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 text-sm font-medium transition-colors"
                      >
                        <Pause className="w-4 h-4" />
                        <span>Pause</span>
                      </button>
                    ) : (
                      <button
                        id="resume-recording-btn"
                        type="button"
                        onClick={handleResumeRecording}
                        className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors"
                      >
                        <Play className="w-4 h-4" />
                        <span>Resume</span>
                      </button>
                    )}

                    <button
                      id="stop-recording-btn"
                      type="button"
                      onClick={handleStopRecording}
                      className="inline-flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors"
                    >
                      <Square className="w-4 h-4 fill-current" />
                      <span>Stop</span>
                    </button>

                    <button
                      id="cancel-recording-btn"
                      type="button"
                      onClick={handleCancelRecording}
                      className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm font-medium transition-colors"
                    >
                      <RotateCcw className="w-4 h-4" />
                      <span>Cancel</span>
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* File Upload Input */}
            <div>
              <input
                id="audio-upload-input"
                type="file"
                accept="audio/*,.mp3,.wav,.m4a,.mp4,.webm,.ogg,.opus,.flac,.aac"
                onChange={handleFileUpload}
                className="hidden"
              />
              <label
                htmlFor="audio-upload-input"
                className="flex items-center justify-center gap-2.5 py-3 px-4 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 hover:border-indigo-500 dark:hover:border-indigo-400 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer text-xs font-medium text-slate-700 dark:text-slate-300 transition-colors"
              >
                <Upload className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                <span>Upload Audio File (WAV, MP3, M4A, WEBM, OGG, FLAC — up to {appSettings.max_upload_mb} MB)</span>
              </label>
            </div>
          </div>

          {/* Active Audio Playback & Download Bar */}
          {audioUrl && (
            <div className="mt-5 pt-4 border-t border-slate-100 dark:border-slate-800 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <FileAudio className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                  <span className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                    {audioFilename || recordingTitle || 'Audio ready'}
                  </span>
                  <span className="text-xs text-slate-400">·</span>
                  <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                    {formatTime(elapsedSeconds)}
                  </span>
                </div>

                <button
                  id="download-original-audio-btn"
                  type="button"
                  onClick={handleDownloadAudio}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download Audio</span>
                </button>
              </div>

              <AuthorizedAudio
                ref={audioRef}
                src={audioUrl}
                controls
                onAuthError={(err) => setError(err.message)}
                onPlay={() => setIsPlayingAudio(true)}
                onPause={() => setIsPlayingAudio(false)}
                onEnded={() => setIsPlayingAudio(false)}
                className="w-full h-9"
              />
            </div>
          )}
        </section>

        {/* Right: Transcription Model, Mode & Language Configuration */}
        <section className="lg:col-span-5 min-w-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col justify-between space-y-5">
          <div className="space-y-4">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 pb-3 border-b border-slate-100 dark:border-slate-800">
              Recognition Settings
            </h2>

            {/* Recording Title */}
            <div>
              <label
                htmlFor="recording-title-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Session Title
              </label>
              <input
                id="recording-title-input"
                type="text"
                value={recordingTitle}
                onChange={(e) => setRecordingTitle(e.target.value)}
                placeholder="e.g., Architecture Review or Field Interview"
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            {/* ASR Model Selection */}
            <div>
              <label
                htmlFor="asr-model-select"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Speech Recognition Model
              </label>
              <select
                id="asr-model-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {asrModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} {m.available ? (m.weights_cached ? '(Ready)' : '(Installed)') : '(Not installed)'}
                  </option>
                ))}
              </select>
              {activeModelMeta && !activeModelMeta.available && (
                <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                  {activeModelMeta.status_detail}
                </p>
              )}
            </div>

            {/* Language Selection */}
            <div>
              <label
                htmlFor="asr-language-select"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Spoken Language
              </label>
              <select
                id="asr-language-select"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Verbatim vs Clean Transcription Mode */}
            <div>
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Transcription Mode
              </span>
              <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800">
                <button
                  id="mode-verbatim-btn"
                  type="button"
                  onClick={() => setMode('verbatim')}
                  className={`py-2 px-3 rounded-md text-xs font-medium transition-colors ${
                    mode === 'verbatim'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  Verbatim
                </button>
                <button
                  id="mode-clean-btn"
                  type="button"
                  onClick={() => setMode('clean')}
                  className={`py-2 px-3 rounded-md text-xs font-medium transition-colors ${
                    mode === 'clean'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  Clean
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                {mode === 'verbatim'
                  ? 'Preserves exact spoken wording, repetitions, and audible fillers without silent grammar edits.'
                  : 'Polishes punctuation and capitalization without inventing words. Original verbatim remains saved.'}
              </p>
            </div>

            {/* Processing Options */}
            <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              {mode === 'clean' && (
                <label className="flex items-center justify-between text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                  <span>Remove hesitation fillers (um, uh, er)</span>
                  <input
                    type="checkbox"
                    checked={removeFillers}
                    onChange={(e) => setRemoveFillers(e.target.checked)}
                    className="rounded border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500"
                  />
                </label>
              )}

              <label className="flex items-center justify-between text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <span>Generate word & segment timestamps</span>
                <input
                  type="checkbox"
                  checked={enableTimestamps}
                  onChange={(e) => setEnableTimestamps(e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500"
                />
              </label>

              <label className="flex items-center justify-between text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <span>Pause-based speaker turn segmentation</span>
                <input
                  type="checkbox"
                  checked={enableSpeakerTurns}
                  onChange={(e) => setEnableSpeakerTurns(e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500"
                />
              </label>

              <label className="flex items-center justify-between text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <span>Run in background queue (long recordings)</span>
                <input
                  type="checkbox"
                  checked={useBackgroundJob}
                  onChange={(e) => setUseBackgroundJob(e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500"
                />
              </label>
            </div>
          </div>

          <button
            id="transcribe-submit-btn"
            type="button"
            onClick={handleTranscribe}
            disabled={(!audioBlob && !activeRecordId) || isTranscribing || recState !== 'idle'}
            className={`w-full py-3 px-4 min-h-[44px] rounded-xl text-sm font-medium transition-colors ${
              (!audioBlob && !activeRecordId) || isTranscribing || recState !== 'idle'
                ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-700 text-white'
            }`}
          >
            {isTranscribing ? `Transcribing (${progressPct}%)...` : 'Transcribe Audio'}
          </button>
        </section>
      </div>

      {/* Live Progress Bar & Streaming Segments */}
      {isTranscribing && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-800 dark:text-slate-200">{progressStage}</span>
            <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
              {progressPct}%
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-indigo-600 transition-all duration-200"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          {streamingSegments.length > 0 && (
            <div className="pt-2 space-y-1 text-xs text-slate-600 dark:text-slate-300 max-h-36 overflow-y-auto">
              {streamingSegments.map((s) => (
                <div key={s.id} className="flex gap-2">
                  <span className="font-mono tabular-nums text-slate-400 shrink-0">
                    [{formatSegmentClock(s.start)}]
                  </span>
                  <span>{s.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Honest Error Feedback */}
      {error && (
        <div
          role="alert"
          className="p-4 rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-300 text-xs flex items-start justify-between gap-3"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-600 dark:text-red-400 font-semibold hover:underline shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Silence / Diagnostics Warnings */}
      {warnings.length > 0 && (
        <div className="p-4 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 text-xs">
          {warnings.join(' ')}
        </div>
      )}

      {/* Editable Transcription Workspace */}
      {result && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
          {/* Header & Clean Metadata Line */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Transcription Output
              </h2>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mt-1">
                <span>Model: {result.model_used}</span>
                <span aria-hidden="true">·</span>
                <span>Language: {result.detected_language}</span>
                {result.language_probability !== null && result.language_probability !== undefined && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      Confidence: {Math.round(result.language_probability * 100)}%
                    </span>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  Processed in {(result.processing_duration_ms / 1000).toFixed(2)}s
                </span>
                <span aria-hidden="true">·</span>
                <span>Mode: {result.transcription_mode}</span>
              </div>
            </div>

            {/* Transcript Variant Switcher */}
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800 self-start max-w-full overflow-x-auto">
              {(
                [
                  { id: 'editable', label: 'Editor' },
                  { id: 'verbatim', label: 'Verbatim Original' },
                  { id: 'clean', label: 'Clean' },
                  { id: 'segments', label: `Timestamps (${result.segments.length})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  id={`transcript-view-${tab.id}`}
                  type="button"
                  onClick={() => setTranscriptViewTab(tab.id)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                    transcriptViewTab === tab.id
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Content Area based on active view tab */}
          {transcriptViewTab === 'editable' && (
            <div className="space-y-3">
              <textarea
                id="editable-transcript-textarea"
                value={editedText}
                onChange={(e) => setEditedText(e.target.value)}
                rows={9}
                aria-label="Editable transcript"
                className="w-full p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100 leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>
                  Edits are saved separately; the original verbatim ASR output remains preserved.
                </span>
                <button
                  id="save-transcript-edits-btn"
                  type="button"
                  onClick={handleSaveEdits}
                  disabled={isSavingEdits || !activeRecordId}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 font-medium transition-colors"
                >
                  {savedFeedback ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                  <span>{savedFeedback ? 'Saved' : isSavingEdits ? 'Saving...' : 'Save Edits'}</span>
                </button>
              </div>
            </div>
          )}

          {transcriptViewTab === 'verbatim' && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 leading-relaxed whitespace-pre-wrap">
              {result.raw_transcript || 'No audible speech detected.'}
            </div>
          )}

          {transcriptViewTab === 'clean' && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 leading-relaxed whitespace-pre-wrap">
              {result.clean_transcript || 'No audible speech detected.'}
            </div>
          )}

          {transcriptViewTab === 'segments' && (
            <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              {result.segments.length === 0 ? (
                <p className="p-4 text-xs text-slate-500 dark:text-slate-400">
                  No timestamped segments available.
                </p>
              ) : (
                result.segments.map((seg) => (
                  <button
                    key={seg.id}
                    type="button"
                    onClick={() => seekAudio(seg.start)}
                    className="w-full p-3.5 text-left flex items-start gap-4 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
                  >
                    <span className="inline-flex items-center gap-1 font-mono tabular-nums text-xs text-indigo-600 dark:text-indigo-400 shrink-0 pt-0.5">
                      <Clock className="w-3 h-3" />
                      {formatSegmentClock(seg.start)} - {formatSegmentClock(seg.end)}
                    </span>
                    <div className="text-sm text-slate-800 dark:text-slate-200">
                      {seg.speaker && (
                        <span className="font-semibold text-slate-900 dark:text-white mr-2">
                          {seg.speaker}:
                        </span>
                      )}
                      <span>{seg.text}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}

          {/* Export & Action Toolbar */}
          <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                id="copy-transcript-btn"
                type="button"
                onClick={handleCopyTranscript}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>

              <button
                id="export-txt-btn"
                type="button"
                onClick={() =>
                  triggerFileDownload(
                    buildTxtExport(editedText, result.segments, enableTimestamps),
                    `${safeBaseName}.txt`,
                    'text/plain;charset=utf-8'
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>TXT</span>
              </button>

              <button
                id="export-srt-btn"
                type="button"
                onClick={() =>
                  triggerFileDownload(
                    buildSrtExport(result.segments, editedText, result.duration_seconds),
                    `${safeBaseName}.srt`,
                    'application/x-subrip;charset=utf-8'
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>SRT</span>
              </button>

              <button
                id="export-vtt-btn"
                type="button"
                onClick={() =>
                  triggerFileDownload(
                    buildVttExport(result.segments, editedText, result.duration_seconds),
                    `${safeBaseName}.vtt`,
                    'text/vtt;charset=utf-8'
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>VTT</span>
              </button>

              <button
                id="export-json-btn"
                type="button"
                onClick={() =>
                  triggerFileDownload(
                    JSON.stringify({ ...result, edited_transcript: editedText }, null, 2),
                    `${safeBaseName}.json`,
                    'application/json;charset=utf-8'
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>JSON</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => onSendToTTS(editedText)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 text-xs font-medium transition-colors"
            >
              <Volume2 className="w-3.5 h-3.5" />
              <span>Send to Text to Speech</span>
            </button>
          </div>
        </section>
      )}
    </div>
  );
};
