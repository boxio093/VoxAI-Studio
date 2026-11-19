"""Persistent SQLite storage and FFmpeg audio validation/conversion for VoxAI."""

import json
import shutil
import sqlite3
import subprocess
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

from backend.config import settings
from backend.schemas import (
    AppSettingsPayload,
    JobStatusResponse,
    ProcessingStatus,
    RecordingCreate,
    RecordingRecord,
    RecordingUpdate,
    TranscriptSegment,
    TranscriptionMode,
)

SUPPORTED_EXTENSIONS = {
    ".wav",
    ".mp3",
    ".m4a",
    ".mp4",
    ".webm",
    ".ogg",
    ".opus",
    ".flac",
    ".aac",
    ".wma",
}

SUPPORTED_MIME_PREFIXES = (
    "audio/",
    "video/webm",
    "video/mp4",
    "application/ogg",
)

EXTENSION_TO_MIME = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
}


class UnsupportedAudioError(ValueError):
    """Raised when an uploaded file is not a valid supported audio format."""


class StorageManager:
    def __init__(self, db_path: Optional[Path] = None, audio_dir: Optional[Path] = None):
        self.db_path = db_path or settings.db_path
        self.audio_dir = audio_dir or settings.audio_dir
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.audio_dir.mkdir(parents=True, exist_ok=True)
        self._init_db()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS recordings (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    duration_seconds REAL NOT NULL DEFAULT 0,
                    mime_type TEXT NOT NULL,
                    original_filename TEXT NOT NULL,
                    audio_path TEXT,
                    file_size_bytes INTEGER NOT NULL DEFAULT 0,
                    model_used TEXT NOT NULL DEFAULT '',
                    transcription_mode TEXT NOT NULL DEFAULT 'verbatim',
                    detected_language TEXT NOT NULL DEFAULT 'unknown',
                    language_probability REAL,
                    processing_duration_ms INTEGER NOT NULL DEFAULT 0,
                    raw_transcript TEXT NOT NULL DEFAULT '',
                    clean_transcript TEXT NOT NULL DEFAULT '',
                    edited_transcript TEXT,
                    segments_json TEXT NOT NULL DEFAULT '[]',
                    processing_status TEXT NOT NULL DEFAULT 'uploaded',
                    error_message TEXT,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    consent_for_training INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    recording_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    progress INTEGER NOT NULL DEFAULT 0,
                    stage TEXT NOT NULL DEFAULT 'queued',
                    model_id TEXT NOT NULL,
                    mode TEXT NOT NULL DEFAULT 'verbatim',
                    error TEXT,
                    result_json TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )

    # --- Settings ---
    def get_settings(self) -> AppSettingsPayload:
        defaults = AppSettingsPayload(
            active_asr_model=settings.voxai_default_asr_model,
            active_tts_model=settings.voxai_default_tts_model,
            default_mode="verbatim",
            default_language="auto",
            retention_days=settings.voxai_retention_days,
            max_upload_mb=settings.voxai_max_upload_mb,
            storage_backend=settings.voxai_storage_backend,
            training_consent_default=False,
        )
        with self._connect() as conn:
            rows = conn.execute("SELECT key, value FROM app_settings").fetchall()
        data = defaults.model_dump()
        for row in rows:
            k, v = row["key"], row["value"]
            if k in data:
                try:
                    data[k] = json.loads(v)
                except json.JSONDecodeError:
                    data[k] = v
        return AppSettingsPayload(**data)

    def update_settings(self, payload: AppSettingsPayload) -> AppSettingsPayload:
        with self._connect() as conn:
            for k, v in payload.model_dump().items():
                conn.execute(
                    "INSERT INTO app_settings (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (k, json.dumps(v)),
                )
        return self.get_settings()

    def set_setting(self, key: str, value: object) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value)),
            )

    # --- Audio file validation & FFmpeg conversion ---
    @staticmethod
    def validate_audio_upload(filename: str, content_type: Optional[str], header_bytes: bytes) -> str:
        ext = Path(filename or "").suffix.lower()
        mime = (content_type or "").split(";")[0].strip().lower()

        if len(header_bytes) == 0:
            raise UnsupportedAudioError("Uploaded file is empty (0 bytes).")

        # Reject obvious non-audio files (HTML, JSON, plain text, executables, images)
        text_sigs = (b"<!doctype", b"<html", b"<?xml", b"{", b"[", b"%PDF", b"\x89PNG", b"\xff\xd8\xff", b"\x7fELF", b"MZ")
        stripped = header_bytes.lstrip().lower()
        for sig in text_sigs:
            if stripped.startswith(sig.lower()):
                raise UnsupportedAudioError(
                    f"Unsupported file content for '{filename}'. File signature is not a supported audio format."
                )

        if ext and ext not in SUPPORTED_EXTENSIONS:
            raise UnsupportedAudioError(
                f"Unsupported audio extension '{ext}'. Supported formats: {', '.join(sorted(SUPPORTED_EXTENSIONS))}."
            )

        if mime and not any(mime.startswith(prefix) for prefix in SUPPORTED_MIME_PREFIXES) and mime != "application/octet-stream":
            raise UnsupportedAudioError(
                f"Unsupported MIME type '{mime}'. Please upload a valid audio file (WAV, MP3, WEBM, M4A, OGG, FLAC)."
            )

        if not ext:
            if "wav" in mime:
                ext = ".wav"
            elif "mpeg" in mime or "mp3" in mime:
                ext = ".mp3"
            elif "ogg" in mime:
                ext = ".ogg"
            elif "mp4" in mime or "m4a" in mime:
                ext = ".m4a"
            elif "flac" in mime:
                ext = ".flac"
            else:
                ext = ".webm"

        return ext

    @staticmethod
    def ffmpeg_available() -> bool:
        return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None

    @staticmethod
    def probe_audio_duration(audio_path: Path) -> float:
        if shutil.which("ffprobe") is None:
            return 0.0
        try:
            proc = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(audio_path),
                ],
                capture_output=True,
                text=True,
                timeout=20,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                val = float(proc.stdout.strip())
                if val >= 0:
                    return round(val, 2)
        except Exception:
            pass
        return 0.0

    @staticmethod
    def convert_to_wav_16k(input_path: Path, output_wav_path: Path) -> float:
        """Convert arbitrary audio container/codec into 16kHz mono PCM WAV for ASR."""
        if shutil.which("ffmpeg") is None:
            raise RuntimeError("FFmpeg is not installed on the server; audio format conversion is unavailable.")

        proc = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(input_path),
                "-vn",
                "-acodec",
                "pcm_s16le",
                "-ar",
                "16000",
                "-ac",
                "1",
                str(output_wav_path),
            ],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if proc.returncode != 0 or not output_wav_path.exists() or output_wav_path.stat().st_size == 0:
            err_tail = (proc.stderr or proc.stdout or "").strip()[-400:]
            raise UnsupportedAudioError(
                f"Server-side audio decoding failed (file may be corrupted or an unsupported format). Details: {err_tail}"
            )
        return StorageManager.probe_audio_duration(output_wav_path)

    def save_audio_bytes(self, recording_id: str, ext: str, raw_bytes: bytes) -> Path:
        safe_ext = ext if ext.startswith(".") else f".{ext}"
        target = self.audio_dir / f"{recording_id}{safe_ext}"
        target.write_bytes(raw_bytes)
        return target

    # --- Recording CRUD ---
    def _row_to_record(self, row: sqlite3.Row) -> RecordingRecord:
        segments_raw = json.loads(row["segments_json"] or "[]")
        segments = [TranscriptSegment(**s) for s in segments_raw]
        tags = json.loads(row["tags_json"] or "[]")
        mode: TranscriptionMode = row["transcription_mode"] if row["transcription_mode"] in ("verbatim", "clean") else "verbatim"

        raw_t = row["raw_transcript"] or ""
        clean_t = row["clean_transcript"] or raw_t
        edited_t = row["edited_transcript"]

        if edited_t is not None:
            active_t = edited_t
        elif mode == "clean":
            active_t = clean_t
        else:
            active_t = raw_t

        audio_path = row["audio_path"]
        has_audio = bool(audio_path and Path(audio_path).exists())

        return RecordingRecord(
            id=row["id"],
            title=row["title"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            duration_seconds=row["duration_seconds"],
            mime_type=row["mime_type"],
            original_filename=row["original_filename"],
            file_size_bytes=row["file_size_bytes"],
            has_audio=has_audio,
            audio_url=f"/api/audio/recordings/{row['id']}/audio" if has_audio else None,
            model_used=row["model_used"],
            transcription_mode=mode,
            detected_language=row["detected_language"],
            language_probability=row["language_probability"],
            processing_duration_ms=row["processing_duration_ms"],
            raw_transcript=raw_t,
            clean_transcript=clean_t,
            edited_transcript=edited_t,
            transcript=active_t,
            segments=segments,
            processing_status=row["processing_status"],
            error_message=row["error_message"],
            tags=tags,
            consent_for_training=bool(row["consent_for_training"]),
        )

    def create_recording_entry(
        self,
        *,
        recording_id: Optional[str] = None,
        title: str,
        duration_seconds: float,
        mime_type: str,
        original_filename: str,
        audio_path: Optional[Path],
        file_size_bytes: int,
        model_used: str = "",
        transcription_mode: TranscriptionMode = "verbatim",
        detected_language: str = "unknown",
        language_probability: Optional[float] = None,
        processing_duration_ms: int = 0,
        raw_transcript: str = "",
        clean_transcript: str = "",
        edited_transcript: Optional[str] = None,
        segments: Optional[list[TranscriptSegment]] = None,
        processing_status: ProcessingStatus = "uploaded",
        error_message: Optional[str] = None,
        tags: Optional[list[str]] = None,
        consent_for_training: bool = False,
    ) -> RecordingRecord:
        rec_id = recording_id or f"rec_{uuid.uuid4().hex[:12]}"
        now_ms = int(time.time() * 1000)
        segs_json = json.dumps([s.model_dump() for s in (segments or [])])
        tags_json = json.dumps(tags or [])

        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO recordings (
                    id, title, created_at, updated_at, duration_seconds, mime_type,
                    original_filename, audio_path, file_size_bytes, model_used,
                    transcription_mode, detected_language, language_probability,
                    processing_duration_ms, raw_transcript, clean_transcript,
                    edited_transcript, segments_json, processing_status,
                    error_message, tags_json, consent_for_training
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    rec_id,
                    title,
                    now_ms,
                    now_ms,
                    float(duration_seconds),
                    mime_type,
                    original_filename,
                    str(audio_path) if audio_path else None,
                    int(file_size_bytes),
                    model_used,
                    transcription_mode,
                    detected_language,
                    language_probability,
                    int(processing_duration_ms),
                    raw_transcript,
                    clean_transcript,
                    edited_transcript,
                    segs_json,
                    processing_status,
                    error_message,
                    tags_json,
                    1 if consent_for_training else 0,
                ),
            )
        rec = self.get_recording(rec_id)
        assert rec is not None
        return rec

    def create_recording_from_schema(self, payload: RecordingCreate) -> RecordingRecord:
        return self.create_recording_entry(
            title=payload.title,
            duration_seconds=payload.duration_seconds,
            mime_type=payload.mime_type,
            original_filename=payload.original_filename or f"{payload.title}.webm",
            audio_path=None,
            file_size_bytes=0,
            model_used=payload.model_used or "",
            transcription_mode=payload.transcription_mode,
            detected_language=payload.detected_language or "unknown",
            raw_transcript=payload.raw_transcript,
            clean_transcript=payload.clean_transcript or payload.raw_transcript,
            edited_transcript=payload.edited_transcript,
            segments=payload.segments,
            processing_status="completed" if payload.raw_transcript else "uploaded",
            tags=payload.tags,
            consent_for_training=payload.consent_for_training,
        )

    def update_recording_transcription(
        self,
        recording_id: str,
        *,
        model_used: str,
        transcription_mode: TranscriptionMode,
        detected_language: str,
        language_probability: Optional[float],
        processing_duration_ms: int,
        raw_transcript: str,
        clean_transcript: str,
        segments: list[TranscriptSegment],
        processing_status: ProcessingStatus,
        duration_seconds: Optional[float] = None,
        error_message: Optional[str] = None,
    ) -> Optional[RecordingRecord]:
        now_ms = int(time.time() * 1000)
        segs_json = json.dumps([s.model_dump() for s in segments])
        with self._connect() as conn:
            if duration_seconds is not None and duration_seconds > 0:
                conn.execute(
                    """
                    UPDATE recordings SET
                        updated_at = ?,
                        duration_seconds = ?,
                        model_used = ?,
                        transcription_mode = ?,
                        detected_language = ?,
                        language_probability = ?,
                        processing_duration_ms = ?,
                        raw_transcript = ?,
                        clean_transcript = ?,
                        edited_transcript = NULL,
                        segments_json = ?,
                        processing_status = ?,
                        error_message = ?
                    WHERE id = ?
                    """,
                    (
                        now_ms,
                        float(duration_seconds),
                        model_used,
                        transcription_mode,
                        detected_language,
                        language_probability,
                        int(processing_duration_ms),
                        raw_transcript,
                        clean_transcript,
                        segs_json,
                        processing_status,
                        error_message,
                        recording_id,
                    ),
                )
            else:
                conn.execute(
                    """
                    UPDATE recordings SET
                        updated_at = ?,
                        model_used = ?,
                        transcription_mode = ?,
                        detected_language = ?,
                        language_probability = ?,
                        processing_duration_ms = ?,
                        raw_transcript = ?,
                        clean_transcript = ?,
                        edited_transcript = NULL,
                        segments_json = ?,
                        processing_status = ?,
                        error_message = ?
                    WHERE id = ?
                    """,
                    (
                        now_ms,
                        model_used,
                        transcription_mode,
                        detected_language,
                        language_probability,
                        int(processing_duration_ms),
                        raw_transcript,
                        clean_transcript,
                        segs_json,
                        processing_status,
                        error_message,
                        recording_id,
                    ),
                )
        return self.get_recording(recording_id)

    def patch_recording(self, recording_id: str, update: RecordingUpdate) -> Optional[RecordingRecord]:
        existing = self.get_recording(recording_id)
        if not existing:
            return None
        now_ms = int(time.time() * 1000)
        fields: list[str] = ["updated_at = ?"]
        values: list[object] = [now_ms]

        if update.title is not None:
            fields.append("title = ?")
            values.append(update.title)
        if update.edited_transcript is not None:
            fields.append("edited_transcript = ?")
            values.append(update.edited_transcript)
        if update.transcription_mode is not None:
            fields.append("transcription_mode = ?")
            values.append(update.transcription_mode)
        if update.tags is not None:
            fields.append("tags_json = ?")
            values.append(json.dumps(update.tags))

        values.append(recording_id)
        with self._connect() as conn:
            conn.execute(f"UPDATE recordings SET {', '.join(fields)} WHERE id = ?", values)
        return self.get_recording(recording_id)

    def get_recording(self, recording_id: str) -> Optional[RecordingRecord]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM recordings WHERE id = ?", (recording_id,)).fetchone()
        return self._row_to_record(row) if row else None

    def get_audio_file_path(self, recording_id: str) -> Optional[Path]:
        with self._connect() as conn:
            row = conn.execute("SELECT audio_path FROM recordings WHERE id = ?", (recording_id,)).fetchone()
        if row and row["audio_path"]:
            p = Path(row["audio_path"])
            if p.exists():
                return p
        return None

    def list_recordings(self, query: Optional[str] = None, mode: Optional[str] = None) -> list[RecordingRecord]:
        sql = "SELECT * FROM recordings"
        clauses: list[str] = []
        params: list[object] = []

        if mode in ("verbatim", "clean"):
            clauses.append("transcription_mode = ?")
            params.append(mode)

        if query and query.strip():
            q = f"%{query.strip().lower()}%"
            clauses.append(
                "(LOWER(title) LIKE ? OR LOWER(raw_transcript) LIKE ? OR LOWER(clean_transcript) LIKE ? "
                "OR LOWER(COALESCE(edited_transcript, '')) LIKE ? OR LOWER(detected_language) LIKE ?)"
            )
            params.extend([q, q, q, q, q])

        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY created_at DESC"

        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._row_to_record(r) for r in rows]

    def delete_recording(self, recording_id: str) -> bool:
        with self._connect() as conn:
            row = conn.execute("SELECT audio_path FROM recordings WHERE id = ?", (recording_id,)).fetchone()
            if not row:
                return False
            audio_path = row["audio_path"]
            conn.execute("DELETE FROM jobs WHERE recording_id = ?", (recording_id,))
            conn.execute("DELETE FROM recordings WHERE id = ?", (recording_id,))
        if audio_path:
            p = Path(audio_path)
            if p.exists():
                try:
                    p.unlink()
                except OSError:
                    pass
            wav_tmp = self.audio_dir / f"{recording_id}_16k.wav"
            if wav_tmp.exists():
                try:
                    wav_tmp.unlink()
                except OSError:
                    pass
        return True

    def count_recordings(self) -> int:
        with self._connect() as conn:
            row = conn.execute("SELECT COUNT(*) AS cnt FROM recordings").fetchone()
        return int(row["cnt"]) if row else 0

    def enforce_retention_policy(self, retention_days: int) -> int:
        if retention_days <= 0:
            return 0
        cutoff_ms = int((time.time() - retention_days * 86400) * 1000)
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id FROM recordings WHERE created_at < ?", (cutoff_ms,)
            ).fetchall()
        deleted = 0
        for r in rows:
            if self.delete_recording(r["id"]):
                deleted += 1
        return deleted

    # --- Background Job Tracking ---
    def create_job(self, recording_id: str, model_id: str, mode: TranscriptionMode) -> JobStatusResponse:
        job_id = f"job_{uuid.uuid4().hex[:12]}"
        now_ms = int(time.time() * 1000)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO jobs (id, recording_id, status, progress, stage, model_id, mode, error, result_json, created_at, updated_at)
                VALUES (?, ?, 'queued', 0, 'Queued for processing', ?, ?, NULL, NULL, ?, ?)
                """,
                (job_id, recording_id, model_id, mode, now_ms, now_ms),
            )
        job = self.get_job(job_id)
        assert job is not None
        return job

    def update_job(
        self,
        job_id: str,
        *,
        status: ProcessingStatus,
        progress: int,
        stage: str,
        error: Optional[str] = None,
        result_json: Optional[str] = None,
    ) -> None:
        now_ms = int(time.time() * 1000)
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE jobs SET status = ?, progress = ?, stage = ?, error = ?, result_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (status, int(progress), stage, error, result_json, now_ms, job_id),
            )

    def get_job(self, job_id: str) -> Optional[JobStatusResponse]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            return None
        result_obj = None
        if row["result_json"]:
            from backend.schemas import TranscribeResponse

            result_obj = TranscribeResponse(**json.loads(row["result_json"]))
        return JobStatusResponse(
            job_id=row["id"],
            recording_id=row["recording_id"],
            status=row["status"],
            progress=row["progress"],
            stage=row["stage"],
            model_id=row["model_id"],
            mode=row["mode"],
            error=row["error"],
            result=result_obj,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
