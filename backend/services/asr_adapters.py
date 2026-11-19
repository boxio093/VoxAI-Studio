"""Modular ASR (Automatic Speech Recognition) adapter architecture for VoxAI.

Supports:
- Faster-Whisper (CTranslate2 open-weight implementation)
- OpenAI Whisper (PyTorch open-weight implementation, when installed)
- Qwen3-ASR (Alibaba open-weight ASR, when installed)

New ASR adapters can be registered via `ASRRegistry.register()` without
rebuilding the application. No adapter simulates transcription or silently
falls back to external proprietary APIs.
"""

from __future__ import annotations

import importlib.util
import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from backend.config import settings
from backend.schemas import (
    ModelInfo,
    TranscriptSegment,
    TranscriptionMode,
    WordTimestamp,
)
from backend.services.text_processing import clean_transcript_text


LANGUAGE_CODE_TO_NAME = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "nl": "Dutch",
    "pl": "Polish",
    "ru": "Russian",
    "uk": "Ukrainian",
    "zh": "Mandarin Chinese",
    "ja": "Japanese",
    "ko": "Korean",
    "ar": "Arabic",
    "hi": "Hindi",
    "tr": "Turkish",
    "vi": "Vietnamese",
    "th": "Thai",
    "id": "Indonesian",
    "sv": "Swedish",
    "no": "Norwegian",
    "da": "Danish",
    "fi": "Finnish",
    "el": "Greek",
    "he": "Hebrew",
    "cs": "Czech",
    "ro": "Romanian",
    "hu": "Hungarian",
}

LANGUAGE_NAME_TO_CODE = {
    "auto": None,
    "auto-detect": None,
    "english": "en",
    "spanish": "es",
    "french": "fr",
    "german": "de",
    "italian": "it",
    "portuguese": "pt",
    "dutch": "nl",
    "polish": "pl",
    "russian": "ru",
    "ukrainian": "uk",
    "chinese": "zh",
    "mandarin chinese": "zh",
    "japanese": "ja",
    "korean": "ko",
    "arabic": "ar",
    "hindi": "hi",
    "turkish": "tr",
    "vietnamese": "vi",
    "thai": "th",
    "indonesian": "id",
}


def normalize_language_code(lang: Optional[str]) -> Optional[str]:
    if not lang:
        return None
    cleaned = lang.strip().lower()
    if cleaned in ("", "auto", "auto-detect", "auto-detect language"):
        return None
    if cleaned in LANGUAGE_CODE_TO_NAME:
        return cleaned
    return LANGUAGE_NAME_TO_CODE.get(cleaned, cleaned if len(cleaned) <= 5 else None)


def format_language_label(code: Optional[str]) -> str:
    if not code:
        return "Unknown"
    low = code.lower()
    return LANGUAGE_CODE_TO_NAME.get(low, code.upper())


def detect_compute_device() -> tuple[str, bool]:
    """Detect whether CUDA GPU acceleration is genuinely available."""
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", True
    except Exception:
        pass

    try:
        if importlib.util.find_spec("torch") is not None:
            import torch

            if torch.cuda.is_available():
                return "cuda", True
    except Exception:
        pass

    return "cpu", False


class ModelUnavailableError(RuntimeError):
    """Raised when a requested ASR model is not installed or fails to load."""


@dataclass
class ASRInferenceResult:
    transcript: str
    raw_transcript: str
    clean_transcript: str
    detected_language: str
    language_probability: Optional[float]
    duration_seconds: float
    processing_duration_ms: int
    model_used: str
    segments: list[TranscriptSegment] = field(default_factory=list)
    silence_detected: bool = False
    warnings: list[str] = field(default_factory=list)


ProgressCallback = Callable[[int, str, Optional[dict[str, Any]]], None]


class ASRModelAdapter(ABC):
    model_id: str
    display_name: str
    engine_family: str
    open_source_status: str
    license: str
    hardware_requirements: str
    language_support: str
    supports_timestamps: bool = True
    supports_diarization: bool = False
    description: str = ""
    install_instructions: str = ""

    @abstractmethod
    def check_availability(self) -> tuple[bool, bool, bool, str]:
        """Return (available, installed, weights_cached, status_detail)."""

    @abstractmethod
    def transcribe(
        self,
        wav_path: Path,
        *,
        language: Optional[str] = None,
        mode: TranscriptionMode = "verbatim",
        remove_fillers: bool = False,
        enable_timestamps: bool = True,
        enable_speaker_turns: bool = False,
        progress_cb: Optional[ProgressCallback] = None,
    ) -> ASRInferenceResult:
        """Execute speech recognition on a 16kHz mono PCM WAV file."""

    def to_model_info(self, active_model_id: str) -> ModelInfo:
        available, installed, cached, detail = self.check_availability()
        return ModelInfo(
            id=self.model_id,
            name=self.display_name,
            category="asr",
            engine_family=self.engine_family,
            open_source_status=self.open_source_status,
            license=self.license,
            available=available,
            installed=installed,
            weights_cached=cached,
            active=(self.model_id == active_model_id),
            hardware_requirements=self.hardware_requirements,
            language_support=self.language_support,
            supports_timestamps=self.supports_timestamps,
            supports_diarization=self.supports_diarization,
            supports_voice_cloning=False,
            description=self.description,
            install_instructions=self.install_instructions,
            status_detail=detail,
        )


class FasterWhisperAdapter(ASRModelAdapter):
    """Open-weight Whisper inference via CTranslate2 (CPU int8 / CUDA float16)."""

    _model_cache: dict[str, Any] = {}
    _lock = threading.Lock()

    def __init__(
        self,
        *,
        model_id: str,
        whisper_size: str,
        display_name: str,
        hardware_requirements: str,
        description: str,
    ):
        self.model_id = model_id
        self.whisper_size = whisper_size
        self.display_name = display_name
        self.engine_family = "Faster-Whisper (CTranslate2)"
        self.open_source_status = "Open-Source / Open-Weight"
        self.license = "MIT"
        self.hardware_requirements = hardware_requirements
        self.language_support = "99 languages + automatic language detection"
        self.supports_timestamps = True
        self.supports_diarization = False
        self.description = description
        self.install_instructions = (
            f"pip install faster-whisper && python -c \"from faster_whisper import WhisperModel; "
            f"WhisperModel('{whisper_size}', download_root='./data/models/whisper')\""
        )

    def _weights_cache_dir_exists(self) -> bool:
        cache_dir = settings.whisper_model_dir / f"models--Systran--faster-whisper-{self.whisper_size}"
        return cache_dir.exists() and any(cache_dir.rglob("model.bin"))

    def check_availability(self) -> tuple[bool, bool, bool, str]:
        pkg_installed = importlib.util.find_spec("faster_whisper") is not None
        if not pkg_installed:
            return False, False, False, "Python package 'faster-whisper' is not installed."

        weights_cached = self._weights_cache_dir_exists()
        device, has_gpu = detect_compute_device()
        if weights_cached:
            return (
                True,
                True,
                True,
                f"Ready on {device.upper()} ({'GPU' if has_gpu else 'int8 CPU'}). Local weights cached.",
            )
        return (
            True,
            True,
            False,
            f"Runtime installed ({device.upper()}); weights for '{self.whisper_size}' will download from HuggingFace on first run.",
        )

    def _get_or_load_model(self) -> Any:
        available, installed, _, detail = self.check_availability()
        if not installed or not available:
            raise ModelUnavailableError(detail)

        with self._lock:
            if self.whisper_size in self._model_cache:
                return self._model_cache[self.whisper_size]

            from faster_whisper import WhisperModel

            device, has_gpu = detect_compute_device()
            compute_type = "float16" if has_gpu else "int8"

            # Keep memory bounded on 4GB hosts by unloading previous heavy models if needed
            if len(self._model_cache) >= 2:
                self._model_cache.clear()

            model = WhisperModel(
                self.whisper_size,
                device=device,
                compute_type=compute_type,
                cpu_threads=4,
                download_root=str(settings.whisper_model_dir),
            )
            self._model_cache[self.whisper_size] = model
            return model

    def transcribe(
        self,
        wav_path: Path,
        *,
        language: Optional[str] = None,
        mode: TranscriptionMode = "verbatim",
        remove_fillers: bool = False,
        enable_timestamps: bool = True,
        enable_speaker_turns: bool = False,
        progress_cb: Optional[ProgressCallback] = None,
    ) -> ASRInferenceResult:
        t0 = time.perf_counter()
        if progress_cb:
            progress_cb(15, f"Loading {self.display_name} weights...", None)

        try:
            model = self._get_or_load_model()
        except Exception as exc:
            raise ModelUnavailableError(f"Failed to initialize {self.display_name}: {exc}") from exc

        if progress_cb:
            progress_cb(30, "Running acoustic speech recognition...", None)

        lang_code = normalize_language_code(language)

        # In verbatim mode, prompt Whisper to retain hesitations, repetitions, and fillers
        initial_prompt = (
            "Umm, uh, er, like, you know, I mean, transcribe every spoken word verbatim "
            "including repetitions, false starts, and hesitations without correcting grammar."
            if mode == "verbatim"
            else None
        )

        # Gentle VAD filter handles background noise and silence without cutting short utterances
        segments_iter, info = model.transcribe(
            str(wav_path),
            language=lang_code,
            beam_size=5,
            best_of=5,
            temperature=0.0,
            initial_prompt=initial_prompt,
            condition_on_previous_text=(mode == "clean"),
            word_timestamps=enable_timestamps,
            vad_filter=True,
            vad_parameters={
                "min_silence_duration_ms": 700 if mode == "verbatim" else 500,
                "speech_pad_ms": 250,
            },
        )

        audio_duration = float(getattr(info, "duration", 0.0) or 0.0)
        detected_lang_code = getattr(info, "language", None) or lang_code or "en"
        lang_prob = float(getattr(info, "language_probability", 0.0) or 0.0)

        segments: list[TranscriptSegment] = []
        raw_parts: list[str] = []
        clean_parts: list[str] = []
        warnings: list[str] = []

        speaker_idx = 1
        prev_end = 0.0

        for seg_idx, seg in enumerate(segments_iter, start=1):
            text_raw = (seg.text or "").strip()
            if not text_raw:
                continue

            no_speech_prob = float(getattr(seg, "no_speech_prob", 0.0) or 0.0)
            avg_logprob = float(getattr(seg, "avg_logprob", 0.0) or 0.0)

            # Filter classic Whisper hallucinations on pure noise/silence
            if no_speech_prob > 0.88 and avg_logprob < -1.15:
                continue

            speaker_label: Optional[str] = None
            if enable_speaker_turns:
                if seg_idx > 1 and (seg.start - prev_end) >= 1.8:
                    speaker_idx = 2 if speaker_idx == 1 else 1
                speaker_label = f"Turn {speaker_idx}"
            prev_end = float(seg.end)

            words: list[WordTimestamp] = []
            if enable_timestamps and getattr(seg, "words", None):
                for w in seg.words:
                    words.append(
                        WordTimestamp(
                            word=(w.word or "").strip(),
                            start=round(float(w.start), 3),
                            end=round(float(w.end), 3),
                            probability=round(float(w.probability), 3)
                            if getattr(w, "probability", None) is not None
                            else None,
                        )
                    )

            seg_clean = clean_transcript_text(text_raw, remove_fillers=remove_fillers)

            seg_obj = TranscriptSegment(
                id=len(segments) + 1,
                start=round(float(seg.start), 3),
                end=round(float(seg.end), 3),
                text=seg_clean if mode == "clean" else text_raw,
                raw_text=text_raw,
                speaker=speaker_label,
                no_speech_prob=round(no_speech_prob, 3),
                avg_logprob=round(avg_logprob, 3),
                words=words,
            )
            segments.append(seg_obj)
            raw_parts.append(text_raw)
            if seg_clean:
                clean_parts.append(seg_clean)

            if progress_cb:
                pct = 35
                if audio_duration > 0:
                    pct = min(95, 35 + int((seg.end / audio_duration) * 60))
                progress_cb(
                    pct,
                    f"Decoded {seg.end:.1f}s / {audio_duration:.1f}s",
                    seg_obj.model_dump(),
                )

        silence_detected = len(segments) == 0
        if silence_detected:
            raw_transcript = ""
            clean_transcript = ""
            warnings.append("No audible speech detected in the audio recording.")
        else:
            raw_transcript = " ".join(raw_parts).strip()
            clean_transcript = clean_transcript_text(raw_transcript, remove_fillers=remove_fillers)

        active_transcript = clean_transcript if mode == "clean" else raw_transcript
        elapsed_ms = int((time.perf_counter() - t0) * 1000)

        if progress_cb:
            progress_cb(100, "Transcription complete", None)

        return ASRInferenceResult(
            transcript=active_transcript,
            raw_transcript=raw_transcript,
            clean_transcript=clean_transcript,
            detected_language=format_language_label(detected_lang_code),
            language_probability=round(lang_prob, 4),
            duration_seconds=round(audio_duration, 2),
            processing_duration_ms=elapsed_ms,
            model_used=self.model_id,
            segments=segments,
            silence_detected=silence_detected,
            warnings=warnings,
        )


class OpenAIWhisperAdapter(ASRModelAdapter):
    """Adapter for OpenAI's open-source PyTorch Whisper package (`openai-whisper`)."""

    _loaded_models: dict[str, Any] = {}
    _lock = threading.Lock()

    def __init__(
        self,
        *,
        model_id: str,
        whisper_size: str,
        display_name: str,
        hardware_requirements: str,
        description: Optional[str] = None,
    ):
        self.model_id = model_id
        self.whisper_size = whisper_size
        self.display_name = display_name
        self.engine_family = "OpenAI Whisper (PyTorch)"
        self.open_source_status = "Open-Source / Open-Weight"
        self.license = "MIT"
        self.hardware_requirements = hardware_requirements
        self.language_support = "99 languages + automatic language detection"
        self.supports_timestamps = True
        self.supports_diarization = False
        self.description = description or (
            "Reference PyTorch implementation of OpenAI Whisper. Requires PyTorch and openai-whisper."
        )
        self.install_instructions = "pip install openai-whisper torch"

    def check_availability(self) -> tuple[bool, bool, bool, str]:
        has_whisper = importlib.util.find_spec("whisper") is not None
        has_torch = importlib.util.find_spec("torch") is not None
        if not has_whisper or not has_torch:
            missing = []
            if not has_torch:
                missing.append("torch")
            if not has_whisper:
                missing.append("openai-whisper")
            return (
                False,
                False,
                False,
                f"Not installed (missing: {', '.join(missing)}). Run '{self.install_instructions}' to enable.",
            )
        weight_path = Path.home() / ".cache" / "whisper" / f"{self.whisper_size}.pt"
        cached = weight_path.exists()
        device, _ = detect_compute_device()
        return (
            True,
            True,
            cached,
            f"Installed ({device.upper()}). {'Weights cached.' if cached else 'Weights download on first run.'}",
        )

    def transcribe(
        self,
        wav_path: Path,
        *,
        language: Optional[str] = None,
        mode: TranscriptionMode = "verbatim",
        remove_fillers: bool = False,
        enable_timestamps: bool = True,
        enable_speaker_turns: bool = False,
        progress_cb: Optional[ProgressCallback] = None,
    ) -> ASRInferenceResult:
        available, installed, _, detail = self.check_availability()
        if not available or not installed:
            raise ModelUnavailableError(
                f"ASR model '{self.model_id}' is unavailable: {detail}"
            )

        t0 = time.perf_counter()
        import whisper

        with self._lock:
            if self.whisper_size not in self._loaded_models:
                device, _ = detect_compute_device()
                self._loaded_models[self.whisper_size] = whisper.load_model(
                    self.whisper_size, device=device
                )
            model = self._loaded_models[self.whisper_size]

        lang_code = normalize_language_code(language)
        initial_prompt = (
            "Umm, uh, keep all repetitions and spoken fillers verbatim."
            if mode == "verbatim"
            else None
        )
        res = model.transcribe(
            str(wav_path),
            language=lang_code,
            initial_prompt=initial_prompt,
            word_timestamps=enable_timestamps,
            fp16=False,
        )

        segments: list[TranscriptSegment] = []
        raw_parts: list[str] = []
        for idx, s in enumerate(res.get("segments", []), start=1):
            t_raw = (s.get("text") or "").strip()
            if not t_raw:
                continue
            t_clean = clean_transcript_text(t_raw, remove_fillers=remove_fillers)
            raw_parts.append(t_raw)
            segments.append(
                TranscriptSegment(
                    id=idx,
                    start=round(float(s.get("start", 0.0)), 3),
                    end=round(float(s.get("end", 0.0)), 3),
                    text=t_clean if mode == "clean" else t_raw,
                    raw_text=t_raw,
                )
            )

        raw_transcript = " ".join(raw_parts).strip()
        clean_transcript = clean_transcript_text(raw_transcript, remove_fillers=remove_fillers)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)

        return ASRInferenceResult(
            transcript=clean_transcript if mode == "clean" else raw_transcript,
            raw_transcript=raw_transcript,
            clean_transcript=clean_transcript,
            detected_language=format_language_label(res.get("language")),
            language_probability=None,
            duration_seconds=round(float(segments[-1].end if segments else 0.0), 2),
            processing_duration_ms=elapsed_ms,
            model_used=self.model_id,
            segments=segments,
            silence_detected=(len(segments) == 0),
        )


class Qwen3ASRAdapter(ASRModelAdapter):
    """Adapter for Qwen3-ASR open-weight speech recognition models (when runtime installed)."""

    def __init__(
        self,
        *,
        model_id: str,
        hf_repo: str,
        display_name: str,
        hardware_requirements: str,
        description: Optional[str] = None,
    ):
        self.model_id = model_id
        self.hf_repo = hf_repo
        self.display_name = display_name
        self.engine_family = "Qwen3-ASR"
        self.open_source_status = "Open-Weight"
        self.license = "Apache-2.0"
        self.hardware_requirements = hardware_requirements
        self.language_support = "30+ languages & dialects (English, Chinese, European, Asian)"
        self.supports_timestamps = True
        self.supports_diarization = False
        self.description = description or (
            f"Alibaba Qwen3-ASR ({hf_repo}) multimodal audio-language speech recognizer. "
            "Requires PyTorch, transformers, and qwen-asr runtime."
        )
        self.install_instructions = f"pip install qwen-asr torch transformers accelerate"

    def check_availability(self) -> tuple[bool, bool, bool, str]:
        has_qwen_asr = importlib.util.find_spec("qwen_asr") is not None
        has_torch = importlib.util.find_spec("torch") is not None
        if not has_qwen_asr or not has_torch:
            return (
                False,
                False,
                False,
                f"Not installed on this host (requires 'qwen-asr' and 'torch'). Run '{self.install_instructions}' on a compatible runtime.",
            )
        device, has_gpu = detect_compute_device()
        return (
            True,
            True,
            False,
            f"qwen-asr runtime detected on {device.upper()} ({'GPU' if has_gpu else 'CPU'}).",
        )

    def transcribe(
        self,
        wav_path: Path,
        *,
        language: Optional[str] = None,
        mode: TranscriptionMode = "verbatim",
        remove_fillers: bool = False,
        enable_timestamps: bool = True,
        enable_speaker_turns: bool = False,
        progress_cb: Optional[ProgressCallback] = None,
    ) -> ASRInferenceResult:
        available, installed, _, detail = self.check_availability()
        if not available or not installed:
            raise ModelUnavailableError(
                f"ASR model '{self.model_id}' is not installed: {detail}"
            )

        t0 = time.perf_counter()
        from qwen_asr import Qwen3ASRModel

        device, has_gpu = detect_compute_device()
        model = Qwen3ASRModel.from_pretrained(
            self.hf_repo,
            device_map="cuda:0" if has_gpu else "cpu",
        )
        results = model.transcribe(audio=str(wav_path), language=language or None)
        first = results[0] if results else None
        raw_transcript = getattr(first, "text", "") if first else ""
        detected_lang = getattr(first, "language", None) or "Unknown"
        clean_transcript = clean_transcript_text(raw_transcript, remove_fillers=remove_fillers)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)

        return ASRInferenceResult(
            transcript=clean_transcript if mode == "clean" else raw_transcript,
            raw_transcript=raw_transcript,
            clean_transcript=clean_transcript,
            detected_language=format_language_label(detected_lang),
            language_probability=None,
            duration_seconds=0.0,
            processing_duration_ms=elapsed_ms,
            model_used=self.model_id,
            segments=[
                TranscriptSegment(
                    id=1,
                    start=0.0,
                    end=1.0,
                    text=clean_transcript if mode == "clean" else raw_transcript,
                    raw_text=raw_transcript,
                )
            ]
            if raw_transcript
            else [],
            silence_detected=(not bool(raw_transcript.strip())),
        )


class ASRRegistry:
    """Registry managing pluggable open-model ASR adapters."""

    def __init__(self) -> None:
        self._adapters: dict[str, ASRModelAdapter] = {}
        self._register_defaults()

    def _register_defaults(self) -> None:
        self.register(
            FasterWhisperAdapter(
                model_id="faster-whisper-base",
                whisper_size="base",
                display_name="Faster-Whisper Base",
                hardware_requirements="CPU (2+ cores, ~300 MB RAM) or CUDA GPU",
                description="Balanced speed and multilingual accuracy using CTranslate2 int8 quantization.",
            )
        )
        self.register(
            FasterWhisperAdapter(
                model_id="faster-whisper-tiny",
                whisper_size="tiny",
                display_name="Faster-Whisper Tiny",
                hardware_requirements="CPU (1+ core, ~150 MB RAM) or CUDA GPU",
                description="Ultra-fast lightweight Whisper model for rapid real-time CPU transcription.",
            )
        )
        self.register(
            FasterWhisperAdapter(
                model_id="faster-whisper-small",
                whisper_size="small",
                display_name="Faster-Whisper Small",
                hardware_requirements="CPU (4+ cores, ~600 MB RAM) or CUDA GPU",
                description="Higher-accuracy Whisper model with improved handling of diverse accents and terminology.",
            )
        )
        self.register(
            OpenAIWhisperAdapter(
                model_id="openai-whisper-base",
                whisper_size="base",
                display_name="OpenAI Whisper Base (PyTorch)",
                hardware_requirements="PyTorch CPU (~1.5 GB RAM) or CUDA GPU (1+ GB VRAM)",
                description="Official OpenAI PyTorch Whisper inference backend.",
            )
        )
        self.register(
            Qwen3ASRAdapter(
                model_id="qwen3-asr-0.6b",
                hf_repo="Qwen/Qwen3-ASR-0.6B",
                display_name="Qwen3-ASR 0.6B",
                hardware_requirements="PyTorch CPU (4+ GB RAM) or CUDA GPU (2+ GB VRAM)",
                description="Compact open-weight Qwen3 speech recognition model for multilingual and dialectal audio.",
            )
        )
        self.register(
            Qwen3ASRAdapter(
                model_id="qwen3-asr-1.7b",
                hf_repo="Qwen/Qwen3-ASR-1.7B",
                display_name="Qwen3-ASR 1.7B",
                hardware_requirements="CUDA GPU (6+ GB VRAM) or 8+ GB RAM",
                description="High-capacity Qwen3 speech recognition model for complex long-form multilingual audio.",
            )
        )

    def register(self, adapter: ASRModelAdapter) -> None:
        self._adapters[adapter.model_id] = adapter

    def get(self, model_id: str) -> Optional[ASRModelAdapter]:
        return self._adapters.get(model_id)

    def list_models(self, active_model_id: str) -> list[ModelInfo]:
        return [adapter.to_model_info(active_model_id) for adapter in self._adapters.values()]


asr_registry = ASRRegistry()
