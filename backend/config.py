"""Configuration settings for the VoxAI FastAPI speech processing service."""

from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    voxai_backend_host: str = "127.0.0.1"
    voxai_backend_port: int = 8001

    voxai_data_dir: Path = BASE_DIR / "data"
    voxai_max_upload_mb: int = 100
    voxai_default_asr_model: str = "faster-whisper-base"
    voxai_default_tts_model: str = "kokoro-onnx"
    voxai_storage_backend: str = "local"
    voxai_retention_days: int = 0
    voxai_cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    voxai_api_key: str = ""

    @property
    def audio_dir(self) -> Path:
        return self.voxai_data_dir / "recordings"

    @property
    def model_dir(self) -> Path:
        return self.voxai_data_dir / "models"

    @property
    def whisper_model_dir(self) -> Path:
        return self.model_dir / "whisper"

    @property
    def kokoro_model_dir(self) -> Path:
        return self.model_dir / "kokoro"

    @property
    def db_path(self) -> Path:
        return self.voxai_data_dir / "voxai.db"

    @property
    def max_upload_bytes(self) -> int:
        return self.voxai_max_upload_mb * 1024 * 1024

    def ensure_dirs(self) -> None:
        self.voxai_data_dir.mkdir(parents=True, exist_ok=True)
        self.audio_dir.mkdir(parents=True, exist_ok=True)
        self.model_dir.mkdir(parents=True, exist_ok=True)
        self.whisper_model_dir.mkdir(parents=True, exist_ok=True)
        self.kokoro_model_dir.mkdir(parents=True, exist_ok=True)


settings = Settings()
settings.ensure_dirs()
