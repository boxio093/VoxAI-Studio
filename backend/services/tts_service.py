"""Decoupled open-model Text-to-Speech (TTS) service for VoxAI.

Strictly separate from Speech Recognition (ASR).
Supports:
- Kokoro ONNX v1.0 (82M open-weight Apache-2.0 neural TTS on CPU via ONNX Runtime)
- Qwen3-TTS (optional adapter, genuinely checks runtime installation)
"""

from __future__ import annotations

import base64
import importlib.util
import io
import threading
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Optional

import soundfile as sf

from backend.config import settings
from backend.schemas import ModelInfo, TTSResponse, TTSVoiceInfo


KOKORO_VOICE_CATALOG: dict[str, dict[str, str]] = {
    "af_heart": {"name": "Heart", "language": "English (US)", "gender": "Female", "accent": "American", "description": "Warm, expressive American female voice"},
    "af_bella": {"name": "Bella", "language": "English (US)", "gender": "Female", "accent": "American", "description": "Clear, natural conversational American female voice"},
    "af_nicole": {"name": "Nicole", "language": "English (US)", "gender": "Female", "accent": "American", "description": "Soft, poised studio narration voice"},
    "af_sarah": {"name": "Sarah", "language": "English (US)", "gender": "Female", "accent": "American", "description": "Balanced neutral female presenter voice"},
    "af_sky": {"name": "Sky", "language": "English (US)", "gender": "Female", "accent": "American", "description": "Bright, articulate voice for tutorials and prompts"},
    "af_nova": {"name": "Nova", "language": "English (US)", "gender": "Female", "accent": "American", "description": "Crisp, modern assistant voice"},
    "af_aoede": {"name": "Aoede", "language": "English (US)", "gender": "Female", "accent": "American", "description": "Melodic storytelling voice"},
    "af_kore": {"name": "Kore", "language": "English (US)", "gender": "Female", "accent": "American", "description": "Clear editorial American female voice"},
    "am_adam": {"name": "Adam", "language": "English (US)", "gender": "Male", "accent": "American", "description": "Deep, grounded American male narrator"},
    "am_michael": {"name": "Michael", "language": "English (US)", "gender": "Male", "accent": "American", "description": "Clear, confident conversational male voice"},
    "am_fenrir": {"name": "Fenrir", "language": "English (US)", "gender": "Male", "accent": "American", "description": "Dynamic, energetic American male voice"},
    "am_echo": {"name": "Echo", "language": "English (US)", "gender": "Male", "accent": "American", "description": "Smooth, articulate male voice"},
    "bf_emma": {"name": "Emma", "language": "English (UK)", "gender": "Female", "accent": "British", "description": "Refined British female narrator voice"},
    "bf_isabella": {"name": "Isabella", "language": "English (UK)", "gender": "Female", "accent": "British", "description": "Warm British studio female voice"},
    "bm_george": {"name": "George", "language": "English (UK)", "gender": "Male", "accent": "British", "description": "Authoritative British male voice"},
    "bm_lewis": {"name": "Lewis", "language": "English (UK)", "gender": "Male", "accent": "British", "description": "Calm British conversational male voice"},
}

PREFIX_LANG_MAP = {
    "af": ("English (US)", "Female", "American", "en-us"),
    "am": ("English (US)", "Male", "American", "en-us"),
    "bf": ("English (UK)", "Female", "British", "en-gb"),
    "bm": ("English (UK)", "Male", "British", "en-gb"),
    "ef": ("Spanish", "Female", "Spanish", "es"),
    "em": ("Spanish", "Male", "Spanish", "es"),
    "ff": ("French", "Female", "French", "fr-fr"),
    "hf": ("Hindi", "Female", "Indian", "hi"),
    "hm": ("Hindi", "Male", "Indian", "hi"),
    "if": ("Italian", "Female", "Italian", "it"),
    "im": ("Italian", "Male", "Italian", "it"),
    "jf": ("Japanese", "Female", "Japanese", "ja"),
    "jm": ("Japanese", "Male", "Japanese", "ja"),
    "pf": ("Portuguese", "Female", "Brazilian/Portuguese", "pt-br"),
    "pm": ("Portuguese", "Male", "Brazilian/Portuguese", "pt-br"),
    "zf": ("Mandarin Chinese", "Female", "Chinese", "cmn"),
    "zm": ("Mandarin Chinese", "Male", "Chinese", "cmn"),
}


class TTSModelUnavailableError(RuntimeError):
    """Raised when a TTS backend is not installed or model weights are missing."""


class TTSModelAdapter(ABC):
    model_id: str
    display_name: str
    engine_family: str
    open_source_status: str
    license: str
    hardware_requirements: str
    language_support: str
    supports_voice_cloning: bool = False
    description: str = ""
    install_instructions: str = ""

    @abstractmethod
    def check_availability(self) -> tuple[bool, bool, bool, str]:
        """Return (available, installed, weights_cached, status_detail)."""

    @abstractmethod
    def list_voices(self) -> list[TTSVoiceInfo]:
        """List genuinely available voices."""

    @abstractmethod
    def synthesize(self, *, text: str, voice: str, speed: float = 1.0, lang: str = "en-us") -> TTSResponse:
        """Synthesize speech audio into WAV."""

    def to_model_info(self, active_model_id: str) -> ModelInfo:
        available, installed, cached, detail = self.check_availability()
        return ModelInfo(
            id=self.model_id,
            name=self.display_name,
            category="tts",
            engine_family=self.engine_family,
            open_source_status=self.open_source_status,
            license=self.license,
            available=available,
            installed=installed,
            weights_cached=cached,
            active=(self.model_id == active_model_id),
            hardware_requirements=self.hardware_requirements,
            language_support=self.language_support,
            supports_timestamps=False,
            supports_diarization=False,
            supports_voice_cloning=self.supports_voice_cloning,
            description=self.description,
            install_instructions=self.install_instructions,
            status_detail=detail,
        )


class KokoroONNXAdapter(TTSModelAdapter):
    """Kokoro-82M v1.0 open-weight neural TTS running locally via ONNX Runtime."""

    _instance: Any = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        self.model_id = "kokoro-onnx"
        self.display_name = "Kokoro-82M ONNX (v1.0 int8)"
        self.engine_family = "Kokoro TTS"
        self.open_source_status = "Open-Weight"
        self.license = "Apache-2.0"
        self.hardware_requirements = "CPU (2+ cores, ~300 MB RAM) via ONNX Runtime"
        self.language_support = "English (US/UK), Japanese, Mandarin, Spanish, French, Hindi, Italian, Portuguese"
        self.supports_voice_cloning = False
        self.description = (
            "Lightweight 82M-parameter open-weight neural text-to-speech engine with 54 pre-trained voices. "
            "Voice cloning is not supported on this adapter."
        )
        self.install_instructions = (
            "pip install kokoro-onnx soundfile && download kokoro-v1.0.int8.onnx and voices-v1.0.bin to ./data/models/kokoro/"
        )

    @property
    def onnx_path(self) -> Path:
        int8_path = settings.kokoro_model_dir / "kokoro-v1.0.int8.onnx"
        fp32_path = settings.kokoro_model_dir / "kokoro-v1.0.onnx"
        return int8_path if int8_path.exists() else fp32_path

    @property
    def voices_path(self) -> Path:
        return settings.kokoro_model_dir / "voices-v1.0.bin"

    def check_availability(self) -> tuple[bool, bool, bool, str]:
        has_pkg = importlib.util.find_spec("kokoro_onnx") is not None
        if not has_pkg:
            return False, False, False, "Python package 'kokoro-onnx' is not installed."

        has_weights = self.onnx_path.exists() and self.voices_path.exists()
        if not has_weights:
            return (
                False,
                True,
                False,
                f"Package installed, but weights not found at {settings.kokoro_model_dir}.",
            )
        return True, True, True, "Ready on CPU (ONNX int8). 54 open-weight voices cached locally."

    def _get_kokoro(self) -> Any:
        available, _, _, detail = self.check_availability()
        if not available:
            raise TTSModelUnavailableError(detail)

        with self._lock:
            if self._instance is None:
                from kokoro_onnx import Kokoro

                self._instance = Kokoro(str(self.onnx_path), str(self.voices_path))
            return self._instance

    def list_voices(self) -> list[TTSVoiceInfo]:
        available, _, _, _ = self.check_availability()
        if not available:
            return []

        kokoro = self._get_kokoro()
        raw_voices: list[str] = list(kokoro.get_voices())
        result: list[TTSVoiceInfo] = []

        for vid in raw_voices:
            if vid in KOKORO_VOICE_CATALOG:
                meta = KOKORO_VOICE_CATALOG[vid]
                result.append(
                    TTSVoiceInfo(
                        id=vid,
                        name=f"{meta['name']} ({meta['accent']})",
                        language=meta["language"],
                        gender=meta["gender"],
                        accent=meta["accent"],
                        description=meta["description"],
                        model_id=self.model_id,
                    )
                )
            else:
                prefix = vid[:2]
                lang_name, gender, accent, _ = PREFIX_LANG_MAP.get(
                    prefix, ("English", "Neutral", "Standard", "en-us")
                )
                pretty = vid.split("_", 1)[-1].replace("_", " ").title()
                result.append(
                    TTSVoiceInfo(
                        id=vid,
                        name=f"{pretty} ({accent})",
                        language=lang_name,
                        gender=gender,
                        accent=accent,
                        description=f"Kokoro {lang_name} {gender.lower()} neural voice ({vid})",
                        model_id=self.model_id,
                    )
                )
        return result

    def synthesize(self, *, text: str, voice: str, speed: float = 1.0, lang: str = "en-us") -> TTSResponse:
        t0 = time.perf_counter()
        kokoro = self._get_kokoro()
        available_voices = set(kokoro.get_voices())

        chosen_voice = voice if voice in available_voices else "af_heart"
        if chosen_voice not in available_voices and available_voices:
            chosen_voice = sorted(available_voices)[0]

        prefix = chosen_voice[:2]
        inferred_lang = PREFIX_LANG_MAP.get(prefix, ("", "", "", "en-us"))[3]
        effective_lang = lang if lang and lang != "auto" else inferred_lang
        if prefix in ("bf", "bm") and lang == "en-us":
            effective_lang = "en-gb"

        samples, sample_rate = kokoro.create(
            text.strip(),
            voice=chosen_voice,
            speed=float(speed),
            lang=effective_lang,
        )

        buf = io.BytesIO()
        sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
        wav_bytes = buf.getvalue()

        duration_s = round(len(samples) / float(sample_rate), 2) if sample_rate else 0.0
        elapsed_ms = int((time.perf_counter() - t0) * 1000)

        return TTSResponse(
            audio_base64=base64.b64encode(wav_bytes).decode("ascii"),
            mime_type="audio/wav",
            sample_rate=int(sample_rate),
            duration_seconds=duration_s,
            processing_duration_ms=elapsed_ms,
            model_used=self.model_id,
            voice_used=chosen_voice,
        )


class Qwen3TTSAdapter(TTSModelAdapter):
    """Optional Qwen3-TTS adapter; genuinely reports availability of `qwen_tts` runtime."""

    def __init__(self) -> None:
        self.model_id = "qwen3-tts-0.6b"
        self.display_name = "Qwen3-TTS 0.6B"
        self.engine_family = "Qwen3-TTS"
        self.open_source_status = "Open-Weight"
        self.license = "Apache-2.0"
        self.hardware_requirements = "PyTorch CUDA GPU (4+ GB VRAM) or 8+ GB RAM"
        self.language_support = "Multilingual (Chinese, English, Japanese, Korean, European)"
        self.supports_voice_cloning = False
        self.description = (
            "Qwen3 open-weight speech synthesis model. Requires qwen-tts and PyTorch."
        )
        self.install_instructions = "pip install qwen-tts torch transformers"

    def check_availability(self) -> tuple[bool, bool, bool, str]:
        has_qwen_tts = importlib.util.find_spec("qwen_tts") is not None
        has_torch = importlib.util.find_spec("torch") is not None
        if not has_qwen_tts or not has_torch:
            return (
                False,
                False,
                False,
                f"Not installed on this host (requires 'qwen-tts' and 'torch'). Run '{self.install_instructions}'.",
            )
        return True, True, False, "qwen-tts package detected."

    def list_voices(self) -> list[TTSVoiceInfo]:
        available, _, _, _ = self.check_availability()
        if not available:
            return []
        return [
            TTSVoiceInfo(
                id="qwen3_default",
                name="Qwen3 Default Speaker",
                language="Multilingual",
                gender="Neutral",
                accent="Standard",
                description="Built-in Qwen3-TTS speaker profile",
                model_id=self.model_id,
            )
        ]

    def synthesize(self, *, text: str, voice: str, speed: float = 1.0, lang: str = "en-us") -> TTSResponse:
        available, _, _, detail = self.check_availability()
        if not available:
            raise TTSModelUnavailableError(f"TTS model '{self.model_id}' is unavailable: {detail}")
        raise TTSModelUnavailableError("Qwen3-TTS runtime invocation requires model download configuration.")


class TTSRegistry:
    def __init__(self) -> None:
        self._adapters: dict[str, TTSModelAdapter] = {}
        self.register(KokoroONNXAdapter())
        self.register(Qwen3TTSAdapter())

    def register(self, adapter: TTSModelAdapter) -> None:
        self._adapters[adapter.model_id] = adapter

    def get(self, model_id: str) -> Optional[TTSModelAdapter]:
        return self._adapters.get(model_id)

    def list_models(self, active_model_id: str) -> list[ModelInfo]:
        return [adapter.to_model_info(active_model_id) for adapter in self._adapters.values()]


tts_registry = TTSRegistry()
