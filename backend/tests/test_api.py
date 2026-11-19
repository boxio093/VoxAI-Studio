"""Automated integration and unit tests for the VoxAI FastAPI backend."""

import base64
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.config import settings
from backend.main import app, ws_hub
from backend.services.text_processing import clean_transcript_text


client = TestClient(app)


def test_health_endpoint():
    res = client.get("/api/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["ffmpeg_available"] is True
    assert data["active_asr_ready"] is True
    assert data["active_tts_ready"] is True


def test_models_inventory_honesty():
    res = client.get("/api/models")
    assert res.status_code == 200
    data = res.json()
    asr = {m["id"]: m for m in data["asr_models"]}
    tts = {m["id"]: m for m in data["tts_models"]}

    assert asr["faster-whisper-base"]["installed"] is True
    assert asr["faster-whisper-base"]["weights_cached"] is True
    assert asr["faster-whisper-tiny"]["installed"] is True
    assert asr["faster-whisper-tiny"]["weights_cached"] is True

    # Uninstalled models must never pretend to be installed
    assert asr["qwen3-asr-0.6b"]["installed"] is False
    assert asr["qwen3-asr-0.6b"]["available"] is False
    assert asr["openai-whisper-base"]["installed"] is False

    assert tts["kokoro-onnx"]["installed"] is True
    assert tts["kokoro-onnx"]["weights_cached"] is True
    assert tts["kokoro-onnx"]["supports_voice_cloning"] is False
    assert tts["qwen3-tts-0.6b"]["installed"] is False


def test_clean_transcript_deterministic_no_hallucination():
    raw = "um i think uh we should go to the lab and test it"
    clean_keep = clean_transcript_text(raw, remove_fillers=False)
    assert "Um" in clean_keep
    assert "uh" in clean_keep
    assert clean_keep.endswith(".")

    clean_no_fillers = clean_transcript_text(raw, remove_fillers=True)
    assert "um" not in clean_no_fillers.lower()
    assert "uh" not in clean_no_fillers.lower()
    assert "go to the lab" in clean_no_fillers.lower()


def test_unsupported_audio_rejected():
    fake_file = b"<!doctype html><html><body>Not audio</body></html>"
    res = client.post(
        "/api/audio/transcribe",
        files={"file": ("broken.mp3", fake_file, "audio/mpeg")},
        data={"mode": "verbatim", "model": "faster-whisper-tiny"},
    )
    assert res.status_code == 400
    assert "Unsupported" in res.json()["detail"]


def test_uninstalled_model_reports_honest_error():
    # Create a tiny valid silent wav header + 0.1s data
    import wave
    import io

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * 1600)

    res = client.post(
        "/api/audio/transcribe",
        files={"file": ("sample.wav", buf.getvalue(), "audio/wav")},
        data={"mode": "verbatim", "model": "qwen3-asr-0.6b"},
    )
    assert res.status_code == 503
    assert "not available" in res.json()["detail"].lower()


def test_real_tts_to_asr_roundtrip_verbatim_clean_switch_export_delete():
    # 1. Generate real spoken audio via open-weight Kokoro TTS
    tts_res = client.post(
        "/api/audio/tts",
        json={
            "text": "Hello team, welcome to the VoxAI studio. Let us verify verbatim transcription.",
            "voice": "af_heart",
            "speed": 1.0,
        },
    )
    assert tts_res.status_code == 200
    tts_data = tts_res.json()
    assert tts_data["model_used"] == "kokoro-onnx"
    wav_bytes = base64.b64decode(tts_data["audio_base64"])
    assert len(wav_bytes) > 1000

    # 2. Transcribe with faster-whisper-base in verbatim mode
    tr_res = client.post(
        "/api/audio/transcribe",
        files={"file": ("roundtrip_test.wav", wav_bytes, "audio/wav")},
        data={
            "title": "Roundtrip Integration Test",
            "language": "en",
            "model": "faster-whisper-base",
            "mode": "verbatim",
            "timestamps": "true",
        },
    )
    assert tr_res.status_code == 200
    tr_data = tr_res.json()
    rec_id = tr_data["recording_id"]

    assert tr_data["model_used"] == "faster-whisper-base"
    assert tr_data["processing_status"] == "completed"
    assert "welcome" in tr_data["raw_transcript"].lower()
    assert len(tr_data["segments"]) >= 1
    assert tr_data["detected_language"].lower() == "english"

    # 3. Switch ASR model to faster-whisper-tiny and re-transcribe the persisted recording in clean mode
    sw_res = client.post(
        "/api/models/active",
        json={"category": "asr", "model_id": "faster-whisper-tiny"},
    )
    assert sw_res.status_code == 200

    tr_tiny = client.post(
        "/api/audio/transcribe",
        data={
            "recording_id": rec_id,
            "language": "auto",
            "model": "faster-whisper-tiny",
            "mode": "clean",
            "remove_fillers": "true",
            "timestamps": "true",
        },
    )
    assert tr_tiny.status_code == 200
    assert tr_tiny.json()["model_used"] == "faster-whisper-tiny"
    assert tr_tiny.json()["raw_transcript"] != ""
    assert tr_tiny.json()["clean_transcript"] != ""

    # Switch active model back to faster-whisper-base
    client.post("/api/models/active", json={"category": "asr", "model_id": "faster-whisper-base"})

    # 4. Verify persistence & editing
    patch_res = client.patch(
        f"/api/audio/recordings/{rec_id}",
        json={"edited_transcript": "Edited: Hello team, welcome to the VoxAI studio."},
    )
    assert patch_res.status_code == 200
    assert patch_res.json()["transcript"].startswith("Edited:")

    list_res = client.get("/api/audio/recordings")
    assert list_res.status_code == 200
    assert any(r["id"] == rec_id for r in list_res.json())

    # 5. Verify original audio playback endpoint
    audio_res = client.get(f"/api/audio/recordings/{rec_id}/audio")
    assert audio_res.status_code == 200
    assert len(audio_res.content) == len(wav_bytes)

    # 6. Verify TXT, SRT, VTT, JSON exports
    txt_res = client.get(f"/api/audio/recordings/{rec_id}/export?format=txt")
    assert txt_res.status_code == 200
    assert "VoxAI" in txt_res.text or "Edited:" in txt_res.text

    srt_res = client.get(f"/api/audio/recordings/{rec_id}/export?format=srt")
    assert srt_res.status_code == 200
    assert "-->" in srt_res.text

    vtt_res = client.get(f"/api/audio/recordings/{rec_id}/export?format=vtt")
    assert vtt_res.status_code == 200
    assert vtt_res.text.startswith("WEBVTT")

    json_res = client.get(f"/api/audio/recordings/{rec_id}/export?format=json")
    assert json_res.status_code == 200
    assert json_res.json()["id"] == rec_id

    # 7. Delete recording and verify cleanup
    del_res = client.delete(f"/api/audio/recordings/{rec_id}")
    assert del_res.status_code == 200
    assert client.get(f"/api/audio/recordings/{rec_id}").status_code == 404


def test_api_key_auth_and_websocket_enforcement():
    prev_key = settings.voxai_api_key
    settings.voxai_api_key = "voxai-phase1-secret"
    try:
        with TestClient(app) as auth_client:
            # HTTP endpoints reject missing/invalid tokens and accept valid Bearer token
            assert auth_client.get("/api/models").status_code == 401
            assert (
                auth_client.get(
                    "/api/models", headers={"Authorization": "Bearer wrong-token"}
                ).status_code
                == 403
            )
            ok_res = auth_client.get(
                "/api/models", headers={"Authorization": "Bearer voxai-phase1-secret"}
            )
            assert ok_res.status_code == 200

            # WebSocket rejects missing token with close code 1008
            with pytest.raises(WebSocketDisconnect) as missing_exc:
                with auth_client.websocket_connect("/api/ws/transcribe?channel=auth_check"):
                    pass
            assert missing_exc.value.code == 1008

            # WebSocket rejects wrong token with close code 1008
            with pytest.raises(WebSocketDisconnect) as bad_exc:
                with auth_client.websocket_connect(
                    "/api/ws/transcribe?channel=auth_check&token=wrong-token"
                ):
                    pass
            assert bad_exc.value.code == 1008

            # WebSocket accepts valid ?token= query parameter
            with auth_client.websocket_connect(
                "/api/ws/transcribe?channel=auth_ok&token=voxai-phase1-secret"
            ) as ws:
                hello = ws.receive_json()
                assert hello == {"type": "connected", "channel": "auth_ok"}
                ws.send_text("ping")
                assert ws.receive_json() == {"type": "pong"}

            # WebSocket accepts valid Sec-WebSocket-Protocol subprotocol auth
            with auth_client.websocket_connect(
                "/api/ws/transcribe?channel=auth_proto",
                subprotocols=["bearer", "voxai-phase1-secret"],
            ) as ws_proto:
                hello = ws_proto.receive_json()
                assert hello == {"type": "connected", "channel": "auth_proto"}
    finally:
        settings.voxai_api_key = prev_key


def test_websocket_cross_channel_isolation():
    with TestClient(app) as ws_client:
        with ws_client.websocket_connect("/api/ws/transcribe?channel=global") as global_ws:
            assert global_ws.receive_json() == {"type": "connected", "channel": "global"}

            with ws_client.websocket_connect(
                "/api/ws/transcribe?channel=studio_private"
            ) as private_ws:
                assert private_ws.receive_json() == {
                    "type": "connected",
                    "channel": "studio_private",
                }

                assert ws_client.portal is not None
                ws_client.portal.call(
                    ws_hub._send_json,
                    "studio_private",
                    {"type": "progress", "progress": 42, "stage": "private-only"},
                )

                priv_msg = private_ws.receive_json()
                assert priv_msg["type"] == "progress"
                assert priv_msg["stage"] == "private-only"

                # Global channel must NOT receive studio_private broadcasts; ping returns pong directly
                global_ws.send_text("ping")
                assert global_ws.receive_json() == {"type": "pong"}

