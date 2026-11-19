export type AppTab =
  | 'studio'
  | 'recordings'
  | 'transcriptions'
  | 'tts'
  | 'models'
  | 'settings';

export type TranscriptionMode = 'verbatim' | 'clean';

export type ProcessingStatus = 'uploaded' | 'queued' | 'processing' | 'completed' | 'failed';

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
  probability?: number | null;
}

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  raw_text: string;
  speaker?: string | null;
  no_speech_prob?: number | null;
  avg_logprob?: number | null;
  words?: WordTimestamp[];
}

export interface RecordingRecord {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  duration_seconds: number;
  mime_type: string;
  original_filename: string;
  file_size_bytes: number;
  has_audio: boolean;
  audio_url?: string | null;
  model_used: string;
  transcription_mode: TranscriptionMode;
  detected_language: string;
  language_probability?: number | null;
  processing_duration_ms: number;
  raw_transcript: string;
  clean_transcript: string;
  edited_transcript?: string | null;
  transcript: string;
  segments: TranscriptSegment[];
  processing_status: ProcessingStatus;
  error_message?: string | null;
  tags: string[];
  consent_for_training: boolean;
}

export interface TranscribeResponse {
  recording_id: string;
  job_id?: string | null;
  transcript: string;
  raw_transcript: string;
  clean_transcript: string;
  detected_language: string;
  language_probability?: number | null;
  duration_seconds: number;
  processing_duration_ms: number;
  model_used: string;
  transcription_mode: TranscriptionMode;
  timestamps_enabled: boolean;
  segments: TranscriptSegment[];
  processing_status: ProcessingStatus;
  audio_url?: string | null;
  silence_detected: boolean;
  warnings: string[];
}

export interface JobStatusResponse {
  job_id: string;
  recording_id: string;
  status: ProcessingStatus;
  progress: number;
  stage: string;
  model_id: string;
  mode: TranscriptionMode;
  error?: string | null;
  result?: TranscribeResponse | null;
  created_at: number;
  updated_at: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  category: 'asr' | 'tts';
  engine_family: string;
  open_source_status: string;
  license: string;
  available: boolean;
  installed: boolean;
  weights_cached: boolean;
  active: boolean;
  hardware_requirements: string;
  language_support: string;
  supports_timestamps: boolean;
  supports_diarization: boolean;
  supports_voice_cloning: boolean;
  description: string;
  install_instructions: string;
  status_detail: string;
}

export interface ModelsResponse {
  active_asr_model: string;
  active_tts_model: string;
  asr_models: ModelInfo[];
  tts_models: ModelInfo[];
}

export interface TTSVoiceInfo {
  id: string;
  name: string;
  language: string;
  gender: string;
  accent: string;
  description: string;
  model_id: string;
}

export interface TTSResponse {
  audio_base64: string;
  mime_type: string;
  sample_rate: number;
  duration_seconds: number;
  processing_duration_ms: number;
  model_used: string;
  voice_used: string;
}

export interface AppSettings {
  active_asr_model: string;
  active_tts_model: string;
  default_mode: TranscriptionMode;
  default_language: string;
  retention_days: number;
  max_upload_mb: number;
  storage_backend: string;
  training_consent_default: boolean;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  python_version: string;
  ffmpeg_available: boolean;
  gpu_available: boolean;
  compute_device: string;
  active_asr_model: string;
  active_asr_ready: boolean;
  active_tts_model: string;
  active_tts_ready: boolean;
  storage_backend: string;
  recordings_count: number;
  disk_free_gb: number;
  auth_enabled: boolean;
  details: Record<string, unknown>;
}
