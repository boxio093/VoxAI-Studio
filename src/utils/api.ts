import {
  AppSettings,
  HealthResponse,
  JobStatusResponse,
  ModelsResponse,
  RecordingRecord,
  TranscribeResponse,
  TranscriptionMode,
  TTSResponse,
  TTSVoiceInfo,
} from '../types';

async function parseApiResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    let snippet = text.slice(0, 180);
    if (text.includes('<!doctype') || text.includes('<html')) {
      snippet = 'Speech backend returned HTML instead of JSON. Please verify the FastAPI server is running.';
    }
    throw new Error(`HTTP ${response.status}: ${snippet}`);
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.detail || data.error || `Request failed (${response.status})`);
  }
  return data as T;
}

export function getApiToken(): string | null {
  return typeof window !== 'undefined' ? localStorage.getItem('voxai_api_token') : null;
}

export function authHeaders(): Record<string, string> {
  const token = getApiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchAuthorizedAudioBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(url, { headers: authHeaders(), signal });
  if (!res.ok) {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || errData.error || `Audio request failed (${res.status})`);
    }
    throw new Error(`Audio request failed (${res.status})`);
  }
  return res.blob();
}

export async function downloadAuthorizedAudio(url: string, filename: string): Promise<void> {
  if (url.startsWith('blob:') || url.startsWith('data:')) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }

  const downloadUrl = url.includes('?') ? `${url}&download=1` : `${url}?download=1`;
  const blob = await fetchAuthorizedAudioBlob(downloadUrl);
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch('/api/health', { headers: authHeaders() });
  return parseApiResponse<HealthResponse>(res);
}

export async function fetchModels(): Promise<ModelsResponse> {
  const res = await fetch('/api/models', { headers: authHeaders() });
  return parseApiResponse<ModelsResponse>(res);
}

export async function switchActiveModel(category: 'asr' | 'tts', modelId: string): Promise<void> {
  const res = await fetch('/api/models/active', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ category, model_id: modelId }),
  });
  await parseApiResponse(res);
}

export async function uploadAudioFile(
  file: Blob,
  filename: string,
  title?: string,
  consentForTraining = false
): Promise<RecordingRecord> {
  const form = new FormData();
  form.append('file', file, filename);
  if (title) form.append('title', title);
  form.append('consent_for_training', String(consentForTraining));

  const res = await fetch('/api/audio/upload', {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  return parseApiResponse<RecordingRecord>(res);
}

export interface TranscribeRequestParams {
  file?: Blob;
  filename?: string;
  recordingId?: string;
  title?: string;
  language?: string;
  model?: string;
  mode: TranscriptionMode;
  removeFillers?: boolean;
  timestamps?: boolean;
  speakerTurns?: boolean;
  background?: boolean;
  wsChannel?: string;
  consentForTraining?: boolean;
}

export async function transcribeAudio(params: TranscribeRequestParams): Promise<TranscribeResponse> {
  const form = new FormData();
  if (params.file) {
    form.append('file', params.file, params.filename || 'recording.webm');
  }
  if (params.recordingId) form.append('recording_id', params.recordingId);
  if (params.title) form.append('title', params.title);
  form.append('language', params.language || 'auto');
  if (params.model) form.append('model', params.model);
  form.append('mode', params.mode);
  form.append('remove_fillers', String(Boolean(params.removeFillers)));
  form.append('timestamps', String(params.timestamps !== false));
  form.append('speaker_turns', String(Boolean(params.speakerTurns)));
  form.append('background', String(Boolean(params.background)));
  if (params.wsChannel) form.append('ws_channel', params.wsChannel);
  form.append('consent_for_training', String(Boolean(params.consentForTraining)));

  const res = await fetch('/api/audio/transcribe', {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  return parseApiResponse<TranscribeResponse>(res);
}

export async function fetchJobStatus(jobId: string): Promise<JobStatusResponse> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { headers: authHeaders() });
  return parseApiResponse<JobStatusResponse>(res);
}

export async function fetchRecordings(query?: string, mode?: string): Promise<RecordingRecord[]> {
  const sp = new URLSearchParams();
  if (query) sp.set('q', query);
  if (mode) sp.set('mode', mode);
  const qs = sp.toString();
  const res = await fetch(`/api/audio/recordings${qs ? `?${qs}` : ''}`, {
    headers: authHeaders(),
  });
  return parseApiResponse<RecordingRecord[]>(res);
}

export async function fetchRecording(id: string): Promise<RecordingRecord> {
  const res = await fetch(`/api/audio/recordings/${encodeURIComponent(id)}`, {
    headers: authHeaders(),
  });
  return parseApiResponse<RecordingRecord>(res);
}

export async function updateRecording(
  id: string,
  payload: { title?: string; edited_transcript?: string; transcription_mode?: TranscriptionMode; tags?: string[] }
): Promise<RecordingRecord> {
  const res = await fetch(`/api/audio/recordings/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse<RecordingRecord>(res);
}

export async function deleteRecording(id: string): Promise<void> {
  const res = await fetch(`/api/audio/recordings/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  await parseApiResponse(res);
}

export async function fetchTTSVoices(model?: string): Promise<TTSVoiceInfo[]> {
  const qs = model ? `?model=${encodeURIComponent(model)}` : '';
  const res = await fetch(`/api/audio/tts/voices${qs}`, { headers: authHeaders() });
  return parseApiResponse<TTSVoiceInfo[]>(res);
}

export async function synthesizeTTS(payload: {
  text: string;
  voice: string;
  speed?: number;
  model?: string;
  lang?: string;
}): Promise<TTSResponse> {
  const res = await fetch('/api/audio/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse<TTSResponse>(res);
}

export async function fetchSettings(): Promise<AppSettings> {
  const res = await fetch('/api/settings', { headers: authHeaders() });
  return parseApiResponse<AppSettings>(res);
}

export async function updateSettings(payload: AppSettings): Promise<AppSettings> {
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse<AppSettings>(res);
}

export function createTranscribeWebSocket(channel: string): WebSocket | null {
  if (typeof window === 'undefined') return null;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getApiToken();
  const params = new URLSearchParams({ channel });
  if (token) {
    params.set('token', token);
  }
  const url = `${proto}//${window.location.host}/api/ws/transcribe?${params.toString()}`;
  try {
    return new WebSocket(url);
  } catch {
    return null;
  }
}

export function waitForWebSocketOpen(ws: WebSocket | null, timeoutMs = 1500): Promise<void> {
  if (!ws || ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeEventListener('open', finish);
      ws.removeEventListener('error', finish);
      ws.removeEventListener('close', finish);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    ws.addEventListener('open', finish);
    ws.addEventListener('error', finish);
    ws.addEventListener('close', finish);
  });
}
