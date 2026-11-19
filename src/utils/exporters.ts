import { RecordingRecord, TranscriptSegment } from '../types';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function pad3(n: number): string {
  if (n < 10) return `00${n}`;
  if (n < 100) return `0${n}`;
  return `${n}`;
}

export function formatSrtTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

export function formatVttTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
}

export function formatSegmentClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

export function buildTxtExport(
  text: string,
  segments: TranscriptSegment[],
  includeTimestamps = false
): string {
  if (!includeTimestamps || segments.length === 0) {
    return text;
  }
  return segments
    .map((seg) => {
      const spk = seg.speaker ? ` ${seg.speaker}:` : '';
      return `[${formatSegmentClock(seg.start)} -> ${formatSegmentClock(seg.end)}]${spk} ${seg.text.trim()}`;
    })
    .join('\n');
}

export function buildSrtExport(segments: TranscriptSegment[], fallbackText: string, durationSeconds = 1): string {
  const list: TranscriptSegment[] =
    segments.length > 0
      ? segments
      : [
          {
            id: 1,
            start: 0,
            end: Math.max(1, durationSeconds),
            text: fallbackText,
            raw_text: fallbackText,
          },
        ];

  return (
    list
      .map((seg, idx) => {
        const start = formatSrtTime(seg.start);
        const end = formatSrtTime(Math.max(seg.end, seg.start + 0.1));
        const body = seg.speaker ? `${seg.speaker}: ${seg.text.trim()}` : seg.text.trim();
        return `${idx + 1}\n${start} --> ${end}\n${body}`;
      })
      .join('\n\n') + '\n'
  );
}

export function buildVttExport(segments: TranscriptSegment[], fallbackText: string, durationSeconds = 1): string {
  const list: TranscriptSegment[] =
    segments.length > 0
      ? segments
      : [
          {
            id: 1,
            start: 0,
            end: Math.max(1, durationSeconds),
            text: fallbackText,
            raw_text: fallbackText,
          },
        ];

  const body = list
    .map((seg, idx) => {
      const start = formatVttTime(seg.start);
      const end = formatVttTime(Math.max(seg.end, seg.start + 0.1));
      const line = seg.speaker ? `<v ${seg.speaker}>${seg.text.trim()}` : seg.text.trim();
      return `${idx + 1}\n${start} --> ${end}\n${line}\n`;
    })
    .join('\n');

  return `WEBVTT\n\n${body}`;
}

export function triggerFileDownload(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportRecordingCsv(records: RecordingRecord[]): void {
  if (records.length === 0) return;
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const headers = [
    'ID',
    'Title',
    'Created',
    'Duration (s)',
    'Model',
    'Mode',
    'Language',
    'Active Transcript',
    'Verbatim Original',
    'Clean Transcript',
  ];
  const rows = records.map((r) => [
    r.id,
    r.title,
    new Date(r.created_at).toISOString(),
    r.duration_seconds.toFixed(2),
    r.model_used,
    r.transcription_mode,
    r.detected_language,
    r.edited_transcript ?? r.transcript,
    r.raw_transcript,
    r.clean_transcript,
  ]);
  const csv = [headers.map(esc).join(','), ...rows.map((row) => row.map(esc).join(','))].join('\n');
  triggerFileDownload(csv, `voxai_transcriptions_${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8;');
}
