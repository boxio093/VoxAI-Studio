"""Pydantic request and response schemas for VoxAI REST & WebSocket APIs."""

from typing import Any, Literal, Optional
from pydantic import BaseModel, Field


TranscriptionMode = Literal["verbatim", "clean"]
ProcessingStatus = Literal["uploaded", "queued", "processing", "completed", "failed"]


class WordTimestamp(BaseModel):
    word: str
    start: float
    end: float
    probability: Optional[float] = None


class TranscriptSegment(BaseModel):
    id: int
    start: float
    end: float
    text: str
    raw_text: str
    speaker: Optional[str] = None
    no_speech_prob: Optional[float] = None
    avg_logprob: Optional[float] = None
    words: list[WordTimestamp] = Field(default_factory=list)


class RecordingCreate(BaseModel):
    title: str
    duration_seconds: float = 0.0
    mime_type: str = "audio/webm"
    original_filename: Optional[str] = None
    model_used: Optional[str] = None
    transcription_mode: TranscriptionMode = "verbatim"
    detected_language: Optional[str] = None
    raw_transcript: str = ""
    clean_transcript: str = ""
    edited_transcript: Optional[str] = None
    segments: list[TranscriptSegment] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    consent_for_training: bool = False


class RecordingUpdate(BaseModel):
    title: Optional[str] = None
    edited_transcript: Optional[str] = None
    transcription_mode: Optional[TranscriptionMode] = None
    tags: Optional[list[str]] = None


class RecordingRecord(BaseModel):
    id: str
    title: str
    created_at: int
    updated_at: int
    duration_seconds: float
    mime_type: str
    original_filename: str
    file_size_bytes: int
    has_audio: bool
    audio_url: Optional[str] = None
    model_used: str
    transcription_mode: TranscriptionMode
    detected_language: str
    language_probability: Optional[float] = None
    processing_duration_ms: int
    raw_transcript: str
    clean_transcript: str
    edited_transcript: Optional[str] = None
    transcript: str
    segments: list[TranscriptSegment] = Field(default_factory=list)
    processing_status: ProcessingStatus
    error_message: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    consent_for_training: bool = False


class TranscribeResponse(BaseModel):
    recording_id: str
    job_id: Optional[str] = None
    transcript: str
    raw_transcript: str
    clean_transcript: str
    detected_language: str
    language_probability: Optional[float] = None
    duration_seconds: float
    processing_duration_ms: int
    model_used: str
    transcription_mode: TranscriptionMode
    timestamps_enabled: bool
    segments: list[TranscriptSegment] = Field(default_factory=list)
    processing_status: ProcessingStatus
    audio_url: Optional[str] = None
    silence_detected: bool = False
    warnings: list[str] = Field(default_factory=list)


class JobStatusResponse(BaseModel):
    job_id: str
    recording_id: str
    status: ProcessingStatus
    progress: int
    stage: str
    model_id: str
    mode: TranscriptionMode
    error: Optional[str] = None
    result: Optional[TranscribeResponse] = None
    created_at: int
    updated_at: int


class ModelInfo(BaseModel):
    id: str
    name: str
    category: Literal["asr", "tts"]
    engine_family: str
    open_source_status: str
    license: str
    available: bool
    installed: bool
    weights_cached: bool
    active: bool
    hardware_requirements: str
    language_support: str
    supports_timestamps: bool = False
    supports_diarization: bool = False
    supports_voice_cloning: bool = False
    description: str
    install_instructions: str
    status_detail: str


class ActiveModelSwitchRequest(BaseModel):
    category: Literal["asr", "tts"]
    model_id: str


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    voice: str = "af_heart"
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    model: Optional[str] = None
    lang: str = "en-us"


class TTSVoiceInfo(BaseModel):
    id: str
    name: str
    language: str
    gender: str
    accent: str
    description: str
    model_id: str


class TTSResponse(BaseModel):
    audio_base64: str
    mime_type: str = "audio/wav"
    sample_rate: int
    duration_seconds: float
    processing_duration_ms: int
    model_used: str
    voice_used: str


class AppSettingsPayload(BaseModel):
    active_asr_model: str
    active_tts_model: str
    default_mode: TranscriptionMode = "verbatim"
    default_language: str = "auto"
    retention_days: int = Field(default=0, ge=0, le=3650)
    max_upload_mb: int = Field(default=100, ge=1, le=500)
    storage_backend: str = "local"
    training_consent_default: bool = False


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    service: str
    python_version: str
    ffmpeg_available: bool
    gpu_available: bool
    compute_device: str
    active_asr_model: str
    active_asr_ready: bool
    active_tts_model: str
    active_tts_ready: bool
    storage_backend: str
    recordings_count: int
    disk_free_gb: float
    auth_enabled: bool
    details: dict[str, Any] = Field(default_factory=dict)
