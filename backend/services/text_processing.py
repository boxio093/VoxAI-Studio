"""Deterministic verbatim/clean transcript processing and subtitle/document exporters.

Important product guarantee:
- Verbatim mode returns exact ASR text untouched.
- Clean mode only normalizes spacing, capitalization, terminal punctuation, and
  optionally removes hesitation fillers when explicitly requested. It NEVER
  paraphrases, summarizes, or introduces words that were not spoken.
"""

import json
import re
from typing import Literal
from backend.schemas import RecordingRecord, TranscriptSegment


FILLER_PATTERN = re.compile(
    r"(?:(?<=^)|(?<=[\s,]))(?:um+|uh+|er+|ah+|hmm+|mm+)(?=[,\s.!?;:]|$)[,\s]*",
    re.IGNORECASE,
)


def clean_transcript_text(raw_text: str, remove_fillers: bool = False) -> str:
    """Apply deterministic readability cleanup without altering spoken meaning or inventing words."""
    if not raw_text or not raw_text.strip():
        return ""

    text = raw_text.strip()

    if remove_fillers:
        text = FILLER_PATTERN.sub(" ", text)

    # Collapse multiple spaces/tabs while preserving intentional line breaks
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    cleaned_lines: list[str] = []

    for line in lines:
        if not line:
            continue
        # Remove space before punctuation
        line = re.sub(r"\s+([,.;:!?])", r"\1", line)
        # Ensure single space after punctuation when followed by word character
        line = re.sub(r"([,.;:!?])([A-Za-z0-9])", r"\1 \2", line)
        # Collapse repeated commas from filler removal
        line = re.sub(r",\s*,+", ",", line)
        line = re.sub(r"^[,.;:\s]+", "", line)
        if not line:
            continue
        # Capitalize first character of line and after sentence boundaries
        line = line[0].upper() + line[1:]
        line = re.sub(
            r"([.!?]\s+)([a-z])",
            lambda m: m.group(1) + m.group(2).upper(),
            line,
        )
        # Capitalize standalone English 'i'
        line = re.sub(r"\bi\b", "I", line)
        # Ensure terminal punctuation
        if line[-1] not in ".!?":
            line += "."
        cleaned_lines.append(line)

    return "\n".join(cleaned_lines)


def format_srt_timestamp(seconds: float) -> str:
    total_ms = max(0, int(round(seconds * 1000)))
    hours = total_ms // 3_600_000
    minutes = (total_ms % 3_600_000) // 60_000
    secs = (total_ms % 60_000) // 1000
    ms = total_ms % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def format_vtt_timestamp(seconds: float) -> str:
    total_ms = max(0, int(round(seconds * 1000)))
    hours = total_ms // 3_600_000
    minutes = (total_ms % 3_600_000) // 60_000
    secs = (total_ms % 60_000) // 1000
    ms = total_ms % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def format_display_timestamp(seconds: float) -> str:
    total_s = max(0, int(seconds))
    mins = total_s // 60
    secs = total_s % 60
    hours = mins // 60
    mins = mins % 60
    if hours > 0:
        return f"{hours:02d}:{mins:02d}:{secs:02d}"
    return f"{mins:02d}:{secs:02d}"


def _resolve_segments_for_export(
    record: RecordingRecord, variant: Literal["active", "verbatim", "clean"] = "active"
) -> list[TranscriptSegment]:
    if record.segments:
        if variant == "verbatim":
            return [
                s.model_copy(update={"text": s.raw_text or s.text})
                for s in record.segments
            ]
        if variant == "clean":
            return [
                s.model_copy(
                    update={"text": clean_transcript_text(s.raw_text or s.text, remove_fillers=False)}
                )
                for s in record.segments
            ]
        return record.segments

    text = record.transcript
    if variant == "verbatim":
        text = record.raw_transcript
    elif variant == "clean":
        text = record.clean_transcript or record.transcript

    if not text.strip():
        return []

    return [
        TranscriptSegment(
            id=1,
            start=0.0,
            end=max(1.0, record.duration_seconds or 1.0),
            text=text.strip(),
            raw_text=record.raw_transcript or text.strip(),
        )
    ]


def export_txt(
    record: RecordingRecord,
    variant: Literal["active", "verbatim", "clean"] = "active",
    include_timestamps: bool = False,
) -> str:
    if variant == "verbatim":
        base_text = record.raw_transcript
    elif variant == "clean":
        base_text = record.clean_transcript or record.transcript
    else:
        base_text = record.edited_transcript if record.edited_transcript is not None else record.transcript

    if not include_timestamps or not record.segments:
        return base_text

    segments = _resolve_segments_for_export(record, variant=variant)
    lines: list[str] = []
    for seg in segments:
        prefix = f"[{format_display_timestamp(seg.start)} -> {format_display_timestamp(seg.end)}]"
        if seg.speaker:
            prefix += f" {seg.speaker}:"
        lines.append(f"{prefix} {seg.text.strip()}")
    return "\n".join(lines)


def export_srt(
    record: RecordingRecord, variant: Literal["active", "verbatim", "clean"] = "active"
) -> str:
    segments = _resolve_segments_for_export(record, variant=variant)
    blocks: list[str] = []
    for idx, seg in enumerate(segments, start=1):
        start_ts = format_srt_timestamp(seg.start)
        end_ts = format_srt_timestamp(max(seg.end, seg.start + 0.1))
        line_text = f"{seg.speaker}: {seg.text.strip()}" if seg.speaker else seg.text.strip()
        blocks.append(f"{idx}\n{start_ts} --> {end_ts}\n{line_text}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def export_vtt(
    record: RecordingRecord, variant: Literal["active", "verbatim", "clean"] = "active"
) -> str:
    segments = _resolve_segments_for_export(record, variant=variant)
    blocks: list[str] = ["WEBVTT", ""]
    for idx, seg in enumerate(segments, start=1):
        start_ts = format_vtt_timestamp(seg.start)
        end_ts = format_vtt_timestamp(max(seg.end, seg.start + 0.1))
        line_text = f"<v {seg.speaker}>{seg.text.strip()}" if seg.speaker else seg.text.strip()
        blocks.append(f"{idx}\n{start_ts} --> {end_ts}\n{line_text}\n")
    return "\n".join(blocks)


def export_json(record: RecordingRecord) -> str:
    payload = {
        "id": record.id,
        "title": record.title,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
        "duration_seconds": record.duration_seconds,
        "mime_type": record.mime_type,
        "original_filename": record.original_filename,
        "model_used": record.model_used,
        "transcription_mode": record.transcription_mode,
        "detected_language": record.detected_language,
        "language_probability": record.language_probability,
        "processing_duration_ms": record.processing_duration_ms,
        "processing_status": record.processing_status,
        "transcript": record.transcript,
        "raw_transcript": record.raw_transcript,
        "clean_transcript": record.clean_transcript,
        "edited_transcript": record.edited_transcript,
        "segments": [seg.model_dump() for seg in record.segments],
        "tags": record.tags,
    }
    return json.dumps(payload, indent=2, ensure_ascii=False)
