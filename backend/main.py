"""VoxAI Open-Model Voice Intelligence Studio — FastAPI Backend."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import shutil
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse

from backend.config import settings
from backend.schemas import (
    ActiveModelSwitchRequest,
    AppSettingsPayload,
    HealthResponse,
    JobStatusResponse,
    ModelInfo,
    RecordingCreate,
    RecordingRecord,
    RecordingUpdate,
    TranscribeResponse,
    TranscriptionMode,
    TTSRequest,
    TTSResponse,
    TTSVoiceInfo,
)
from backend.services.asr_adapters import (
    ModelUnavailableError,
    asr_registry,
    detect_compute_device,
)
from backend.services.text_processing import (
    export_json,
    export_srt,
    export_txt,
    export_vtt,
)
from backend.services.tts_service import TTSModelUnavailableError, tts_registry
from backend.storage import EXTENSION_TO_MIME, StorageManager, UnsupportedAudioError

@asynccontextmanager
async def lifespan(_app: FastAPI):
    ws_hub.set_loop(asyncio.get_running_loop())
    app_cfg = storage.get_settings()
    if app_cfg.retention_days > 0:
        storage.enforce_retention_policy(app_cfg.retention_days)
    yield


app = FastAPI(
    title="VoxAI Speech Intelligence API",
    description="Open-model speech recognition (Faster-Whisper / Whisper / Qwen3-ASR) and neural TTS (Kokoro) backend.",
    version="1.0.0",
    lifespan=lifespan,
)

cors_origins = [o.strip() for o in settings.voxai_cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

storage = StorageManager()
executor = ThreadPoolExecutor(max_workers=2)


class WebSocketHub:
    """Manages active WebSocket clients subscribed to transcription job updates."""

    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = {}
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def connect(
        self, channel: str, ws: WebSocket, subprotocol: Optional[str] = None
    ) -> None:
        await ws.accept(subprotocol=subprotocol)
        self._connections.setdefault(channel, set()).add(ws)

    def disconnect(self, channel: str, ws: WebSocket) -> None:
        conns = self._connections.get(channel)
        if conns and ws in conns:
            conns.remove(ws)
            if not conns:
                self._connections.pop(channel, None)

    async def _send_json(self, channel: str, payload: dict[str, Any]) -> None:
        targets = list(self._connections.get(channel, set()))
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(channel, ws)

    def broadcast_threadsafe(self, channel: str, payload: dict[str, Any]) -> None:
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(self._send_json(channel, payload), self._loop)


ws_hub = WebSocketHub()


def verify_api_key(authorization: Optional[str] = Header(default=None)) -> None:
    """Optional Bearer auth when VOXAI_API_KEY is configured."""
    expected = settings.voxai_api_key.strip()
    if not expected:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer authentication token.")
    token = authorization.split(" ", 1)[1].strip()
    if not secrets.compare_digest(token.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=403, detail="Invalid authentication token.")


def _extract_ws_auth(
    websocket: WebSocket, token_param: Optional[str]
) -> tuple[Optional[str], Optional[str]]:
    """Extract auth token from query param, Authorization header, or Sec-WebSocket-Protocol."""
    protocol_header = websocket.headers.get("sec-websocket-protocol") or ""
    offered_protocols = [p.strip() for p in protocol_header.split(",") if p.strip()]
    accepted_subprotocol = offered_protocols[0] if offered_protocols else None

    if token_param and token_param.strip():
        return token_param.strip(), accepted_subprotocol

    auth_header = websocket.headers.get("authorization") or ""
    if auth_header.startswith("Bearer "):
        return auth_header.split(" ", 1)[1].strip(), accepted_subprotocol

    if offered_protocols:
        if len(offered_protocols) >= 2 and offered_protocols[0].lower() in ("bearer", "voxai", "token"):
            return offered_protocols[1], offered_protocols[0]
        first = offered_protocols[0]
        if first.lower().startswith("bearer."):
            return first.split(".", 1)[1].strip(), first
        if first.lower().startswith("token."):
            return first.split(".", 1)[1].strip(), first
        return first, first

    return None, None


async def _read_upload_with_limit(upload: UploadFile, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    chunk_size = 1024 * 1024  # 1 MB
    while True:
        chunk = await upload.read(chunk_size)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"Audio file exceeds the {settings.voxai_max_upload_mb} MB upload limit.",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _run_transcription_pipeline(
    *,
    recording_id: str,
    raw_audio_path: Path,
    model_id: str,
    language: Optional[str],
    mode: TranscriptionMode,
    remove_fillers: bool,
    enable_timestamps: bool,
    enable_speaker_turns: bool,
    job_id: Optional[str] = None,
    ws_channel: str = "global",
) -> TranscribeResponse:
    adapter = asr_registry.get(model_id)
    if not adapter:
        raise ModelUnavailableError(f"Unknown ASR model '{model_id}'.")

    available, installed, _, detail = adapter.check_availability()
    if not available or not installed:
        raise ModelUnavailableError(f"ASR model '{model_id}' is unavailable: {detail}")

    def emit(pct: int, stage: str, segment: Optional[dict[str, Any]]) -> None:
        if job_id:
            storage.update_job(job_id, status="processing", progress=pct, stage=stage)
        ws_hub.broadcast_threadsafe(
            ws_channel,
            {
                "type": "progress",
                "job_id": job_id,
                "recording_id": recording_id,
                "progress": pct,
                "stage": stage,
                "segment": segment,
            },
        )

    emit(5, "Converting audio to 16kHz PCM WAV via FFmpeg...", None)
    wav_path = settings.audio_dir / f"{recording_id}_16k.wav"
    try:
        probed_duration = storage.convert_to_wav_16k(raw_audio_path, wav_path)
    except Exception as exc:
        if job_id:
            storage.update_job(job_id, status="failed", progress=0, stage="Audio decoding failed", error=str(exc))
        storage.update_recording_transcription(
            recording_id,
            model_used=model_id,
            transcription_mode=mode,
            detected_language="unknown",
            language_probability=None,
            processing_duration_ms=0,
            raw_transcript="",
            clean_transcript="",
            segments=[],
            processing_status="failed",
            error_message=str(exc),
        )
        ws_hub.broadcast_threadsafe(
            ws_channel,
            {"type": "error", "job_id": job_id, "recording_id": recording_id, "error": str(exc)},
        )
        raise

    try:
        asr_result = adapter.transcribe(
            wav_path,
            language=language,
            mode=mode,
            remove_fillers=remove_fillers,
            enable_timestamps=enable_timestamps,
            enable_speaker_turns=enable_speaker_turns,
            progress_cb=emit,
        )
    except Exception as exc:
        if job_id:
            storage.update_job(job_id, status="failed", progress=0, stage="Model inference failed", error=str(exc))
        storage.update_recording_transcription(
            recording_id,
            model_used=model_id,
            transcription_mode=mode,
            detected_language="unknown",
            language_probability=None,
            processing_duration_ms=0,
            raw_transcript="",
            clean_transcript="",
            segments=[],
            processing_status="failed",
            error_message=str(exc),
        )
        ws_hub.broadcast_threadsafe(
            ws_channel,
            {"type": "error", "job_id": job_id, "recording_id": recording_id, "error": str(exc)},
        )
        raise
    finally:
        # Clean up temporary 16k WAV derivative while preserving original recording
        if wav_path.exists():
            try:
                wav_path.unlink()
            except OSError:
                pass

    final_duration = asr_result.duration_seconds or probed_duration
    updated_rec = storage.update_recording_transcription(
        recording_id,
        model_used=asr_result.model_used,
        transcription_mode=mode,
        detected_language=asr_result.detected_language,
        language_probability=asr_result.language_probability,
        processing_duration_ms=asr_result.processing_duration_ms,
        raw_transcript=asr_result.raw_transcript,
        clean_transcript=asr_result.clean_transcript,
        segments=asr_result.segments,
        processing_status="completed",
        duration_seconds=final_duration,
    )

    resp = TranscribeResponse(
        recording_id=recording_id,
        job_id=job_id,
        transcript=asr_result.transcript,
        raw_transcript=asr_result.raw_transcript,
        clean_transcript=asr_result.clean_transcript,
        detected_language=asr_result.detected_language,
        language_probability=asr_result.language_probability,
        duration_seconds=final_duration,
        processing_duration_ms=asr_result.processing_duration_ms,
        model_used=asr_result.model_used,
        transcription_mode=mode,
        timestamps_enabled=enable_timestamps,
        segments=asr_result.segments,
        processing_status="completed",
        audio_url=updated_rec.audio_url if updated_rec else f"/api/audio/recordings/{recording_id}/audio",
        silence_detected=asr_result.silence_detected,
        warnings=asr_result.warnings,
    )

    if job_id:
        storage.update_job(
            job_id,
            status="completed",
            progress=100,
            stage="Completed",
            result_json=resp.model_dump_json(),
        )

    ws_hub.broadcast_threadsafe(
        ws_channel,
        {"type": "completed", "job_id": job_id, "recording_id": recording_id, "result": resp.model_dump()},
    )
    return resp


# ---------------------------------------------------------------------------
# Health & Model Management Endpoints
# ---------------------------------------------------------------------------


@app.get("/api/health", response_model=HealthResponse)
def get_health() -> HealthResponse:
    app_cfg = storage.get_settings()
    device, has_gpu = detect_compute_device()
    asr_adapter = asr_registry.get(app_cfg.active_asr_model)
    asr_ready = bool(asr_adapter and asr_adapter.check_availability()[0])
    tts_adapter = tts_registry.get(app_cfg.active_tts_model)
    tts_ready = bool(tts_adapter and tts_adapter.check_availability()[0])
    disk = shutil.disk_usage(str(settings.voxai_data_dir))
    free_gb = round(disk.free / (1024 ** 3), 2)

    return HealthResponse(
        status="ok" if (StorageManager.ffmpeg_available() and asr_ready) else "degraded",
        service="VoxAI FastAPI Speech Backend",
        python_version=sys.version.split()[0],
        ffmpeg_available=StorageManager.ffmpeg_available(),
        gpu_available=has_gpu,
        compute_device=device,
        active_asr_model=app_cfg.active_asr_model,
        active_asr_ready=asr_ready,
        active_tts_model=app_cfg.active_tts_model,
        active_tts_ready=tts_ready,
        storage_backend=app_cfg.storage_backend,
        recordings_count=storage.count_recordings(),
        disk_free_gb=free_gb,
        auth_enabled=bool(settings.voxai_api_key.strip()),
        details={
            "data_dir": str(settings.voxai_data_dir),
            "max_upload_mb": app_cfg.max_upload_mb,
            "retention_days": app_cfg.retention_days,
        },
    )


@app.get("/api/models")
def get_models(_: None = Depends(verify_api_key)) -> dict[str, Any]:
    app_cfg = storage.get_settings()
    asr_models: list[ModelInfo] = asr_registry.list_models(app_cfg.active_asr_model)
    tts_models: list[ModelInfo] = tts_registry.list_models(app_cfg.active_tts_model)
    return {
        "active_asr_model": app_cfg.active_asr_model,
        "active_tts_model": app_cfg.active_tts_model,
        "asr_models": [m.model_dump() for m in asr_models],
        "tts_models": [m.model_dump() for m in tts_models],
    }


@app.post("/api/models/active")
def switch_active_model(
    payload: ActiveModelSwitchRequest,
    _: None = Depends(verify_api_key),
) -> dict[str, Any]:
    app_cfg = storage.get_settings()
    if payload.category == "asr":
        adapter = asr_registry.get(payload.model_id)
        if not adapter:
            raise HTTPException(status_code=404, detail=f"Unknown ASR model '{payload.model_id}'.")
        available, installed, _, detail = adapter.check_availability()
        if not available or not installed:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot activate '{payload.model_id}': {detail}",
            )
        app_cfg.active_asr_model = payload.model_id
        storage.update_settings(app_cfg)
        return {"status": "ok", "category": "asr", "active_model": payload.model_id}

    tts_adapter = tts_registry.get(payload.model_id)
    if not tts_adapter:
        raise HTTPException(status_code=404, detail=f"Unknown TTS model '{payload.model_id}'.")
    available, installed, _, detail = tts_adapter.check_availability()
    if not available or not installed:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot activate '{payload.model_id}': {detail}",
        )
    app_cfg.active_tts_model = payload.model_id
    storage.update_settings(app_cfg)
    return {"status": "ok", "category": "tts", "active_model": payload.model_id}


# ---------------------------------------------------------------------------
# Audio Upload & Transcription Endpoints
# ---------------------------------------------------------------------------


@app.post("/api/audio/upload", response_model=RecordingRecord)
async def upload_audio(
    file: UploadFile = File(...),
    title: Optional[str] = Form(default=None),
    consent_for_training: bool = Form(default=False),
    _: None = Depends(verify_api_key),
) -> RecordingRecord:
    app_cfg = storage.get_settings()
    max_bytes = min(app_cfg.max_upload_mb, 500) * 1024 * 1024
    raw_bytes = await _read_upload_with_limit(file, max_bytes)

    filename = file.filename or "recording.webm"
    try:
        ext = StorageManager.validate_audio_upload(filename, file.content_type, raw_bytes[:64])
    except UnsupportedAudioError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    rec_id = f"rec_{uuid.uuid4().hex[:12]}"
    saved_path = storage.save_audio_bytes(rec_id, ext, raw_bytes)
    duration_s = StorageManager.probe_audio_duration(saved_path)
    mime_type = file.content_type or EXTENSION_TO_MIME.get(ext, "audio/webm")

    record = storage.create_recording_entry(
        recording_id=rec_id,
        title=(title or Path(filename).stem or "Uploaded Audio").strip(),
        duration_seconds=duration_s,
        mime_type=mime_type,
        original_filename=filename,
        audio_path=saved_path,
        file_size_bytes=len(raw_bytes),
        processing_status="uploaded",
        consent_for_training=consent_for_training,
    )
    return record


@app.post("/api/audio/transcribe")
async def transcribe_audio(
    background_tasks: BackgroundTasks,
    file: Optional[UploadFile] = File(default=None),
    recording_id: Optional[str] = Form(default=None),
    title: Optional[str] = Form(default=None),
    language: str = Form(default="auto"),
    model: Optional[str] = Form(default=None),
    mode: TranscriptionMode = Form(default="verbatim"),
    remove_fillers: bool = Form(default=False),
    timestamps: bool = Form(default=True),
    speaker_turns: bool = Form(default=False),
    background: bool = Form(default=False),
    ws_channel: str = Form(default="global"),
    consent_for_training: bool = Form(default=False),
    _: None = Depends(verify_api_key),
) -> Any:
    app_cfg = storage.get_settings()
    selected_model = (model or app_cfg.active_asr_model).strip()

    adapter = asr_registry.get(selected_model)
    if not adapter:
        raise HTTPException(status_code=404, detail=f"Requested ASR model '{selected_model}' is not registered.")
    available, installed, _, detail = adapter.check_availability()
    if not available or not installed:
        raise HTTPException(status_code=503, detail=f"Model '{selected_model}' is not available: {detail}")

    if file is not None:
        max_bytes = min(app_cfg.max_upload_mb, 500) * 1024 * 1024
        raw_bytes = await _read_upload_with_limit(file, max_bytes)
        filename = file.filename or "recording.webm"
        try:
            ext = StorageManager.validate_audio_upload(filename, file.content_type, raw_bytes[:64])
        except UnsupportedAudioError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        rec_id = f"rec_{uuid.uuid4().hex[:12]}"
        audio_path = storage.save_audio_bytes(rec_id, ext, raw_bytes)
        duration_s = StorageManager.probe_audio_duration(audio_path)
        mime_type = file.content_type or EXTENSION_TO_MIME.get(ext, "audio/webm")

        storage.create_recording_entry(
            recording_id=rec_id,
            title=(title or Path(filename).stem or "Voice Recording").strip(),
            duration_seconds=duration_s,
            mime_type=mime_type,
            original_filename=filename,
            audio_path=audio_path,
            file_size_bytes=len(raw_bytes),
            model_used=selected_model,
            transcription_mode=mode,
            processing_status="processing",
            consent_for_training=consent_for_training,
        )
    elif recording_id:
        existing = storage.get_recording(recording_id)
        if not existing:
            raise HTTPException(status_code=404, detail=f"Recording '{recording_id}' not found.")
        audio_path_opt = storage.get_audio_file_path(recording_id)
        if not audio_path_opt:
            raise HTTPException(status_code=400, detail=f"Recording '{recording_id}' has no audio file on disk.")
        rec_id = recording_id
        audio_path = audio_path_opt
        duration_s = existing.duration_seconds
    else:
        raise HTTPException(status_code=400, detail="Provide either an audio 'file' or an existing 'recording_id'.")

    # Background queue automatically engages when explicitly requested or for long-form (> 180s) audio
    use_background = background or (duration_s > 180.0)
    if use_background:
        job = storage.create_job(rec_id, selected_model, mode)
        storage.update_recording_transcription(
            rec_id,
            model_used=selected_model,
            transcription_mode=mode,
            detected_language="pending",
            language_probability=None,
            processing_duration_ms=0,
            raw_transcript="",
            clean_transcript="",
            segments=[],
            processing_status="queued",
        )

        def bg_task() -> None:
            try:
                _run_transcription_pipeline(
                    recording_id=rec_id,
                    raw_audio_path=audio_path,
                    model_id=selected_model,
                    language=language,
                    mode=mode,
                    remove_fillers=remove_fillers,
                    enable_timestamps=timestamps,
                    enable_speaker_turns=speaker_turns,
                    job_id=job.job_id,
                    ws_channel=ws_channel or job.job_id,
                )
            except Exception:
                pass

        background_tasks.add_task(bg_task)
        return JSONResponse(
            status_code=202,
            content={
                "recording_id": rec_id,
                "job_id": job.job_id,
                "processing_status": "queued",
                "model_used": selected_model,
                "transcription_mode": mode,
                "audio_url": f"/api/audio/recordings/{rec_id}/audio",
            },
        )

    loop = asyncio.get_running_loop()
    try:
        resp = await loop.run_in_executor(
            executor,
            lambda: _run_transcription_pipeline(
                recording_id=rec_id,
                raw_audio_path=audio_path,
                model_id=selected_model,
                language=language,
                mode=mode,
                remove_fillers=remove_fillers,
                enable_timestamps=timestamps,
                enable_speaker_turns=speaker_turns,
                ws_channel=ws_channel,
            ),
        )
        return resp
    except UnsupportedAudioError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Speech recognition failed: {exc}") from exc


@app.get("/api/jobs/{job_id}", response_model=JobStatusResponse)
def get_job_status(job_id: str, _: None = Depends(verify_api_key)) -> JobStatusResponse:
    job = storage.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
    return job


# ---------------------------------------------------------------------------
# Recording History & Export Endpoints
# ---------------------------------------------------------------------------


@app.post("/api/audio/recordings", response_model=RecordingRecord)
def create_recording_metadata(
    payload: RecordingCreate,
    _: None = Depends(verify_api_key),
) -> RecordingRecord:
    return storage.create_recording_from_schema(payload)


@app.get("/api/audio/recordings", response_model=list[RecordingRecord])
def list_recordings(
    q: Optional[str] = Query(default=None),
    mode: Optional[str] = Query(default=None),
    _: None = Depends(verify_api_key),
) -> list[RecordingRecord]:
    return storage.list_recordings(query=q, mode=mode)


@app.get("/api/audio/recordings/{recording_id}", response_model=RecordingRecord)
def get_recording(recording_id: str, _: None = Depends(verify_api_key)) -> RecordingRecord:
    rec = storage.get_recording(recording_id)
    if not rec:
        raise HTTPException(status_code=404, detail=f"Recording '{recording_id}' not found.")
    return rec


@app.patch("/api/audio/recordings/{recording_id}", response_model=RecordingRecord)
def update_recording(
    recording_id: str,
    payload: RecordingUpdate,
    _: None = Depends(verify_api_key),
) -> RecordingRecord:
    rec = storage.patch_recording(recording_id, payload)
    if not rec:
        raise HTTPException(status_code=404, detail=f"Recording '{recording_id}' not found.")
    return rec


@app.delete("/api/audio/recordings/{recording_id}")
def delete_recording(recording_id: str, _: None = Depends(verify_api_key)) -> dict[str, Any]:
    deleted = storage.delete_recording(recording_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Recording '{recording_id}' not found.")
    return {"status": "deleted", "id": recording_id}


@app.get("/api/audio/recordings/{recording_id}/audio")
def get_recording_audio(
    recording_id: str,
    download: bool = Query(default=False),
    _: None = Depends(verify_api_key),
) -> FileResponse:
    rec = storage.get_recording(recording_id)
    if not rec:
        raise HTTPException(status_code=404, detail=f"Recording '{recording_id}' not found.")
    audio_path = storage.get_audio_file_path(recording_id)
    if not audio_path:
        raise HTTPException(status_code=404, detail="Original audio file not found on disk.")

    headers = {}
    if download:
        safe_name = os.path.basename(rec.original_filename or f"{recording_id}{audio_path.suffix}")
        headers["Content-Disposition"] = f'attachment; filename="{safe_name}"'

    return FileResponse(
        path=str(audio_path),
        media_type=rec.mime_type or "application/octet-stream",
        headers=headers,
    )


@app.get("/api/audio/recordings/{recording_id}/export")
def export_recording_transcript(
    recording_id: str,
    format: str = Query(default="txt", pattern="^(txt|srt|vtt|json)$"),
    variant: str = Query(default="active", pattern="^(active|verbatim|clean)$"),
    timestamps: bool = Query(default=False),
    _: None = Depends(verify_api_key),
) -> Response:
    rec = storage.get_recording(recording_id)
    if not rec:
        raise HTTPException(status_code=404, detail=f"Recording '{recording_id}' not found.")

    safe_base = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in rec.title).strip("_") or recording_id
    variant_typed = variant  # type: ignore[assignment]

    if format == "txt":
        content = export_txt(rec, variant=variant_typed, include_timestamps=timestamps)
        return PlainTextResponse(
            content=content,
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{safe_base}.txt"'},
        )
    if format == "srt":
        content = export_srt(rec, variant=variant_typed)
        return PlainTextResponse(
            content=content,
            media_type="application/x-subrip; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{safe_base}.srt"'},
        )
    if format == "vtt":
        content = export_vtt(rec, variant=variant_typed)
        return PlainTextResponse(
            content=content,
            media_type="text/vtt; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{safe_base}.vtt"'},
        )
    content = export_json(rec)
    return Response(
        content=content,
        media_type="application/json; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{safe_base}.json"'},
    )


# ---------------------------------------------------------------------------
# Open-Model Text-to-Speech (TTS) Endpoints
# ---------------------------------------------------------------------------


@app.get("/api/audio/tts/voices", response_model=list[TTSVoiceInfo])
def get_tts_voices(
    model: Optional[str] = Query(default=None),
    _: None = Depends(verify_api_key),
) -> list[TTSVoiceInfo]:
    app_cfg = storage.get_settings()
    target_model = model or app_cfg.active_tts_model
    adapter = tts_registry.get(target_model)
    if not adapter:
        raise HTTPException(status_code=404, detail=f"Unknown TTS model '{target_model}'.")
    return adapter.list_voices()


@app.post("/api/audio/tts", response_model=TTSResponse)
async def synthesize_speech(
    payload: TTSRequest,
    _: None = Depends(verify_api_key),
) -> TTSResponse:
    app_cfg = storage.get_settings()
    target_model = payload.model or app_cfg.active_tts_model
    adapter = tts_registry.get(target_model)
    if not adapter:
        raise HTTPException(status_code=404, detail=f"Unknown TTS model '{target_model}'.")

    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(
            executor,
            lambda: adapter.synthesize(
                text=payload.text,
                voice=payload.voice,
                speed=payload.speed,
                lang=payload.lang,
            ),
        )
    except TTSModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {exc}") from exc


# ---------------------------------------------------------------------------
# Settings & Privacy Endpoints
# ---------------------------------------------------------------------------


@app.get("/api/settings", response_model=AppSettingsPayload)
def get_app_settings(_: None = Depends(verify_api_key)) -> AppSettingsPayload:
    return storage.get_settings()


@app.put("/api/settings", response_model=AppSettingsPayload)
def update_app_settings(
    payload: AppSettingsPayload,
    _: None = Depends(verify_api_key),
) -> AppSettingsPayload:
    # Validate requested models exist
    if not asr_registry.get(payload.active_asr_model):
        raise HTTPException(status_code=400, detail=f"Unknown ASR model '{payload.active_asr_model}'.")
    if not tts_registry.get(payload.active_tts_model):
        raise HTTPException(status_code=400, detail=f"Unknown TTS model '{payload.active_tts_model}'.")
    updated = storage.update_settings(payload)
    if updated.retention_days > 0:
        storage.enforce_retention_policy(updated.retention_days)
    return updated


# ---------------------------------------------------------------------------
# WebSocket Streaming Status Endpoint
# ---------------------------------------------------------------------------


@app.websocket("/api/ws/transcribe")
async def websocket_transcribe_status(
    websocket: WebSocket,
    channel: str = "global",
    token: Optional[str] = Query(default=None),
) -> None:
    ws_token, subprotocol = _extract_ws_auth(websocket, token)
    expected = settings.voxai_api_key.strip()
    if expected:
        if not ws_token or not secrets.compare_digest(
            ws_token.encode("utf-8"), expected.encode("utf-8")
        ):
            await websocket.close(code=1008)
            return

    await ws_hub.connect(channel, websocket, subprotocol=subprotocol)
    try:
        await websocket.send_json({"type": "connected", "channel": channel})
        while True:
            msg = await websocket.receive_text()
            if msg == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        ws_hub.disconnect(channel, websocket)
    except Exception:
        ws_hub.disconnect(channel, websocket)
