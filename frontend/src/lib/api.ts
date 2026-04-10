const base = import.meta.env.VITE_API_URL ?? "";

export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

export type TranscribeUtterance = { speaker: number; transcript: string };

export type TranscribeResponse = {
  text: string;
  utterances: TranscribeUtterance[];
  duration_sec: number;
};

export async function transcribeAudio(
  micBlob: Blob,
  filename: string,
  sessionId?: string | null,
  /** Separate tab/system-audio recording (mono). Enables reliable you vs remote speaker IDs. */
  tabBlob?: Blob | null
): Promise<TranscribeResponse> {
  const form = new FormData();
  form.append("file", micBlob, filename);
  if (tabBlob && tabBlob.size >= 200) {
    form.append("file_tab", tabBlob, `tab-${filename}`);
  }
  if (sessionId) {
    form.append("session_id", sessionId);
  }
  const res = await fetch(apiUrl("/api/transcribe"), {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || res.statusText);
  }
  return res.json();
}

export type RagMode = "off" | "auto" | "on";

export async function suggestReply(
  transcript: string,
  context?: string,
  sessionId?: string | null,
  options?: { ragMode?: RagMode; ragKeywords?: string | null }
): Promise<{ suggestion: string }> {
  const res = await fetch(apiUrl("/api/suggest"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript,
      context: context || null,
      session_id: sessionId || null,
      rag_mode: options?.ragMode ?? "auto",
      rag_keywords: options?.ragKeywords?.trim() || null,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || res.statusText);
  }
  return res.json();
}

export async function answerQuestion(
  question: string,
  context?: string,
  sessionId?: string | null,
  options?: { ragMode?: RagMode; ragKeywords?: string | null }
): Promise<{ answer: string }> {
  const res = await fetch(apiUrl("/api/answer"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      context: context || null,
      session_id: sessionId || null,
      rag_mode: options?.ragMode ?? "auto",
      rag_keywords: options?.ragKeywords?.trim() || null,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || res.statusText);
  }
  return res.json();
}

export type RagDocumentInfo = {
  id: string;
  filename: string;
  topic_tags: string | null;
  chunk_count: number;
  created_at: string;
};

export async function fetchRagDocuments(): Promise<{ documents: RagDocumentInfo[] }> {
  const res = await fetch(apiUrl("/api/rag/documents"));
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function uploadRagDocument(
  file: File,
  topicTags?: string
): Promise<{ id: string; filename: string; topic_tags: string | null }> {
  const form = new FormData();
  form.append("file", file);
  if (topicTags?.trim()) form.append("topic_tags", topicTags.trim());
  const res = await fetch(apiUrl("/api/rag/upload"), { method: "POST", body: form });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteRagDocument(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/rag/documents/${encodeURIComponent(id)}`), {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await res.text());
}

export type DailyUsage = {
  day: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  requests: number;
};

export type UsageSummary = {
  start: string;
  end: string;
  daily: DailyUsage[];
  totals: Record<string, number>;
};

export async function fetchUsageSummary(start: string, end: string): Promise<UsageSummary> {
  const q = new URLSearchParams({ start, end });
  const res = await fetch(apiUrl(`/api/usage/summary?${q}`));
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export type UsageWindow = "30m" | "1h" | "6h" | "12h" | "1d" | "1w";

export type ModelEndpointUsage = {
  model: string;
  endpoint: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type UsageReport = {
  window: string;
  window_label: string;
  window_start_utc: string;
  window_end_utc: string;
  explanation: string[];
  llm: {
    requests: number;
    input_tokens: number;
    output_tokens: number;
    combined_tokens: number;
  };
  transcription: {
    requests: number;
    audio_ms: number;
    audio_minutes: number;
  };
  total_requests: number;
  by_model: ModelEndpointUsage[];
};

export async function fetchUsageReport(window: UsageWindow): Promise<UsageReport> {
  const q = new URLSearchParams({ window });
  const res = await fetch(apiUrl(`/api/usage/report?${q}`));
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
