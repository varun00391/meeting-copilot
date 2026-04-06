import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchUsageSummary, type DailyUsage } from "../lib/api";

function defaultRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 13);
  return { start: toYMD(start), end: toYMD(end) };
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function Usage() {
  const [{ start, end }, setRange] = useState(defaultRange);
  const [data, setData] = useState<DailyUsage[]>([]);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetchUsageSummary(start, end);
      setData(res.daily);
      setTotals(res.totals);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  useEffect(() => {
    void load();
  }, [load]);

  const chartData = useMemo(
    () =>
      data.map((d) => ({
        day: d.day.slice(5),
        input: d.input_tokens,
        output: d.output_tokens,
        total: d.total_tokens,
      })),
    [data]
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-3xl font-bold text-white">Token usage</h1>
      <p className="mt-2 max-w-2xl text-slate-400">
        Aggregated tokens recorded by this server for Groq calls (transcription and chat). Dates are
        UTC.
      </p>

      <div className="mt-8 flex flex-wrap items-end gap-4">
        <label className="text-sm text-slate-400">
          Start
          <input
            type="date"
            value={start}
            onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
            className="ml-2 rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-white"
          />
        </label>
        <label className="text-sm text-slate-400">
          End
          <input
            type="date"
            value={end}
            onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
            className="ml-2 rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-white"
          />
        </label>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {err && (
        <p className="mt-4 text-sm text-rose-400">{err}</p>
      )}

      <div className="mt-10 grid gap-6 lg:grid-cols-4">
        {[
          { label: "Total tokens", value: totals.total_tokens ?? 0 },
          { label: "Input tokens", value: totals.input_tokens ?? 0 },
          { label: "Output tokens", value: totals.output_tokens ?? 0 },
          { label: "API requests", value: totals.requests ?? 0 },
        ].map((c) => (
          <div
            key={c.label}
            className="rounded-2xl border border-white/10 bg-ink-900/60 px-5 py-4"
          >
            <p className="text-xs uppercase tracking-wide text-slate-500">{c.label}</p>
            <p className="mt-2 font-display text-2xl font-semibold text-white">
              {c.value.toLocaleString()}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-10 rounded-2xl border border-white/10 bg-ink-900/40 p-4 sm:p-6">
        <h2 className="font-display text-lg font-semibold text-white">Daily total tokens</h2>
        <div className="mt-4 h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff14" vertical={false} />
              <XAxis dataKey="day" tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} />
              <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#11141c",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "12px",
                }}
                labelStyle={{ color: "#e2e8f0" }}
              />
              <Bar dataKey="total" fill="#6366f1" radius={[6, 6, 0, 0]} name="Total tokens" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="mt-10 overflow-x-auto rounded-2xl border border-white/10">
        <table className="w-full min-w-[480px] text-left text-sm">
          <thead className="border-b border-white/10 bg-ink-900/80 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Day (UTC)</th>
              <th className="px-4 py-3 text-right">Input</th>
              <th className="px-4 py-3 text-right">Output</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3 text-right">Requests</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {data.map((row) => (
              <tr key={row.day} className="hover:bg-white/[0.02]">
                <td className="px-4 py-3 font-mono text-slate-300">{row.day}</td>
                <td className="px-4 py-3 text-right text-slate-400">
                  {row.input_tokens.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right text-slate-400">
                  {row.output_tokens.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right text-white">
                  {row.total_tokens.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right text-slate-500">{row.requests}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
