const base = import.meta.env.VITE_API_URL ?? "";

export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

export async function transcribeAudio(blob: Blob, filename: string): Promise<{ text: string }> {
  const form = new FormData();
  form.append("file", blob, filename);
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

export async function suggestReply(
  transcript: string,
  context?: string
): Promise<{ suggestion: string }> {
  const res = await fetch(apiUrl("/api/suggest"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript, context: context || null }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || res.statusText);
  }
  return res.json();
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
