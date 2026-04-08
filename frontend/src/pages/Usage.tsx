import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchUsageReport, type UsageReport, type UsageWindow } from "../lib/api";

const WINDOWS: { id: UsageWindow; label: string }[] = [
  { id: "30m", label: "30 min" },
  { id: "1h", label: "1 hr" },
  { id: "6h", label: "6 hr" },
  { id: "12h", label: "12 hr" },
  { id: "1d", label: "1 day" },
  { id: "1w", label: "1 week" },
];

function shortModel(name: string, max = 32): string {
  if (name.length <= max) return name;
  return `${name.slice(0, max - 1)}…`;
}

export function Usage() {
  const [window, setWindow] = useState<UsageWindow>("1d");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetchUsageReport(window);
      setReport(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [window]);

  useEffect(() => {
    void load();
  }, [load]);

  const llmChartData = useMemo(() => {
    if (!report) return [];
    return report.by_model
      .filter((r) => r.endpoint === "suggest")
      .map((r) => ({
        name: shortModel(r.model),
        fullModel: r.model,
        prompt: r.input_tokens,
        completion: r.output_tokens,
      }));
  }, [report]);

  const sttChartData = useMemo(() => {
    if (!report) return [];
    return report.by_model
      .filter((r) => r.endpoint === "transcribe")
      .map((r) => ({
        name: shortModel(r.model),
        fullModel: r.model,
        minutes: Math.round((r.total_tokens / 60_000) * 100) / 100,
      }));
  }, [report]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-3xl font-bold text-white">Token usage</h1>
      <p className="mt-2 max-w-3xl text-slate-400">
        Rolling windows in UTC. LLM token counts apply only to suggestions; transcription rows use
        duration in milliseconds, not tokens—so totals are split below to avoid mixing units.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-2">
        <span className="mr-2 text-sm text-slate-500">Period</span>
        {WINDOWS.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => setWindow(w.id)}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
              window === w.id
                ? "bg-accent text-white"
                : "border border-white/10 bg-ink-900 text-slate-300 hover:bg-white/5"
            }`}
          >
            {w.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="ml-2 rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {report && (
        <p className="mt-3 font-mono text-xs text-slate-500">
          {report.window_label}: {report.window_start_utc} → {report.window_end_utc}
        </p>
      )}

      {err && <p className="mt-4 text-sm text-rose-400">{err}</p>}

      {report && (
        <>
          <div className="mt-8 rounded-2xl border border-amber-500/25 bg-amber-500/5 p-5">
            <h2 className="font-display text-sm font-semibold text-amber-200/90">
              Why input + output did not match “total” before
            </h2>
            <ul className="mt-3 list-inside list-disc space-y-2 text-sm text-slate-300">
              {report.explanation.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-2xl border border-white/10 bg-ink-900/60 px-5 py-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">LLM prompt (input)</p>
              <p className="mt-2 font-display text-2xl font-semibold text-white">
                {report.llm.input_tokens.toLocaleString()}
              </p>
              <p className="mt-1 text-xs text-slate-500">Groq chat · suggest endpoint only</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-ink-900/60 px-5 py-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">LLM completion (output)</p>
              <p className="mt-2 font-display text-2xl font-semibold text-white">
                {report.llm.output_tokens.toLocaleString()}
              </p>
              <p className="mt-1 text-xs text-slate-500">Matches provider completion tokens</p>
            </div>
            <div className="rounded-2xl border border-indigo-500/30 bg-indigo-500/10 px-5 py-4 sm:col-span-2 lg:col-span-1">
              <p className="text-xs uppercase tracking-wide text-indigo-200/80">LLM combined</p>
              <p className="mt-2 font-display text-2xl font-semibold text-white">
                {report.llm.combined_tokens.toLocaleString()}
              </p>
              <p className="mt-1 text-xs text-slate-400">input + output (apples-to-apples)</p>
            </div>
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 px-5 py-4">
              <p className="text-xs uppercase tracking-wide text-emerald-200/80">Transcribed audio</p>
              <p className="mt-2 font-display text-2xl font-semibold text-white">
                {report.transcription.audio_minutes.toLocaleString()} min
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Sum of stored duration ({report.transcription.audio_ms.toLocaleString()} ms) ·{" "}
                {report.transcription.requests} requests
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-ink-900/60 px-5 py-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">LLM API calls</p>
              <p className="mt-2 font-display text-2xl font-semibold text-white">
                {report.llm.requests.toLocaleString()}
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-ink-900/60 px-5 py-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">All requests</p>
              <p className="mt-2 font-display text-2xl font-semibold text-white">
                {report.total_requests.toLocaleString()}
              </p>
              <p className="mt-1 text-xs text-slate-500">Transcribe + suggest</p>
            </div>
          </div>

          {llmChartData.length > 0 && (
            <div className="mt-10 rounded-2xl border border-white/10 bg-ink-900/40 p-4 sm:p-6">
              <h2 className="font-display text-lg font-semibold text-white">
                LLM tokens by model (prompt + completion)
              </h2>
              <p className="mt-1 text-sm text-slate-500">Suggestion endpoint only · stacked bars</p>
              <div className="mt-4 h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={llmChartData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ffffff14" vertical={false} />
                    <XAxis
                      dataKey="name"
                      tick={{ fill: "#94a3b8", fontSize: 10 }}
                      axisLine={false}
                      interval={0}
                      angle={-25}
                      textAnchor="end"
                      height={70}
                    />
                    <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#11141c",
                        border: "1px solid rgba(255,255,255,0.1)",
                        borderRadius: "12px",
                      }}
                      formatter={(value: number, name: string) => [value.toLocaleString(), name]}
                      labelFormatter={(_, payload) =>
                        (payload?.[0]?.payload as { fullModel?: string })?.fullModel ?? ""
                      }
                    />
                    <Legend />
                    <Bar dataKey="prompt" stackId="llm" fill="#6366f1" name="Prompt" radius={[0, 0, 0, 0]} />
                    <Bar
                      dataKey="completion"
                      stackId="llm"
                      fill="#a78bfa"
                      name="Completion"
                      radius={[6, 6, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {sttChartData.length > 0 && (
            <div className="mt-10 rounded-2xl border border-white/10 bg-ink-900/40 p-4 sm:p-6">
              <h2 className="font-display text-lg font-semibold text-white">
                Transcription volume by model
              </h2>
              <p className="mt-1 text-sm text-slate-500">Minutes of audio (from stored ms) · transcribe endpoint</p>
              <div className="mt-4 h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={sttChartData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ffffff14" vertical={false} />
                    <XAxis
                      dataKey="name"
                      tick={{ fill: "#94a3b8", fontSize: 10 }}
                      axisLine={false}
                      interval={0}
                      angle={-25}
                      textAnchor="end"
                      height={70}
                    />
                    <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#11141c",
                        border: "1px solid rgba(255,255,255,0.1)",
                        borderRadius: "12px",
                      }}
                      formatter={(v: number) => [`${v} min`, "Audio"]}
                      labelFormatter={(_, payload) =>
                        (payload?.[0]?.payload as { fullModel?: string })?.fullModel ?? ""
                      }
                    />
                    <Bar dataKey="minutes" fill="#34d399" name="Minutes" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <div className="mt-10 overflow-x-auto rounded-2xl border border-white/10">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-white/10 bg-ink-900/80 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Model</th>
                  <th className="px-4 py-3">Endpoint</th>
                  <th className="px-4 py-3 text-right">Requests</th>
                  <th className="px-4 py-3 text-right">Input tokens</th>
                  <th className="px-4 py-3 text-right">Output tokens</th>
                  <th className="px-4 py-3 text-right">Stored total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {report.by_model.map((row, idx) => (
                  <tr key={`${row.model}-${row.endpoint}-${idx}`} className="hover:bg-white/[0.02]">
                    <td className="max-w-[200px] truncate px-4 py-3 font-mono text-xs text-slate-300" title={row.model}>
                      {row.model}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-medium ${
                          row.endpoint === "suggest"
                            ? "bg-indigo-500/20 text-indigo-200"
                            : "bg-emerald-500/20 text-emerald-200"
                        }`}
                      >
                        {row.endpoint}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-400">{row.requests}</td>
                    <td className="px-4 py-3 text-right text-slate-400">
                      {row.endpoint === "transcribe" ? "—" : row.input_tokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-400">
                      {row.endpoint === "transcribe" ? "—" : row.output_tokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-200">
                      {row.endpoint === "transcribe" ? (
                        <span title="Milliseconds of audio, not LLM tokens">
                          {row.total_tokens.toLocaleString()} ms
                        </span>
                      ) : (
                        <span title="Usually matches LLM total from provider">{row.total_tokens.toLocaleString()}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-white/5 px-4 py-3 text-xs text-slate-500">
              For <code className="text-slate-400">transcribe</code>, “Stored total” is audio duration in milliseconds.
              For <code className="text-slate-400">suggest</code>, it is the provider total_tokens field when logged.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
