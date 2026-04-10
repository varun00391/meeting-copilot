import { useCallback, useEffect, useRef, useState } from "react";
import { answerQuestion, suggestReply, transcribeAudio } from "../lib/api";

type Status = "idle" | "listening" | "error";

type CaptureInfo = {
  hasMic: boolean;
  hasTabAudio: boolean;
};

/** Full MediaRecorder segments (valid files for the API), every N ms. */
const RECORD_SEGMENT_MS = 10_000;

const SUGGEST_DEBOUNCE_MS = 400;

/** Separates prepended transcript segments so we can reorder oldest→newest for the LLM. */
const TRANSCRIPT_SEGMENT_SEP = "\n\n---\n\n";

function toChronologicalForModel(displayTranscript: string): string {
  const t = displayTranscript.trim();
  if (!t) return "";
  if (!t.includes(TRANSCRIPT_SEGMENT_SEP)) return t;
  return t.split(TRANSCRIPT_SEGMENT_SEP).filter(Boolean).reverse().join("\n\n");
}

function extensionForRecorderMime(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

export function MeetingCopilot() {
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  /** Newest suggestion first; each entry is timestamp + body. */
  const [suggestionFeed, setSuggestionFeed] = useState<string[]>([]);
  const [questionText, setQuestionText] = useState("");
  /** Newest answer blocks first (timestamp + question + answer). */
  const [questionFeed, setQuestionFeed] = useState<string[]>([]);
  const [context, setContext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [questionBusy, setQuestionBusy] = useState(false);
  const [captureInfo, setCaptureInfo] = useState<CaptureInfo | null>(null);
  const [briefingOpen, setBriefingOpen] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const listeningRef = useRef(false);
  const mergedStreamRef = useRef<MediaStream | null>(null);
  const recorderMimeRef = useRef("audio/webm");
  const segmentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);
  const transcriptRef = useRef("");
  const contextRef = useRef("");
  /** Server-side conversation session (transcript + briefing); set on Start, cleared on Stop. */
  const sessionIdRef = useRef<string | null>(null);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  transcriptRef.current = transcript;
  contextRef.current = context;

  const runSuggest = useCallback(async (textOverride?: string) => {
    const display = (textOverride ?? transcriptRef.current).trim();
    const t = toChronologicalForModel(display).trim();
    if (!t) {
      setError("Nothing to analyze yet—wait for transcript lines or paste text.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { suggestion: s } = await suggestReply(
        t,
        contextRef.current || undefined,
        sessionIdRef.current
      );
      const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const block = `[${stamp}]\n\n${s.trim()}`;
      setSuggestionFeed((prev) => [block, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Suggestion failed");
    } finally {
      setBusy(false);
    }
  }, []);

  const scheduleLiveSuggest = useCallback(
    (fullTranscript: string) => {
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
      suggestTimerRef.current = setTimeout(() => {
        suggestTimerRef.current = null;
        void runSuggest(fullTranscript);
      }, SUGGEST_DEBOUNCE_MS);
    },
    [runSuggest]
  );

  const processBlob = useCallback(
    async (blob: Blob) => {
      if (blob.size < 200) return;
      const ext = extensionForRecorderMime(blob.type || recorderMimeRef.current);
      try {
        const res = await transcribeAudio(blob, `segment.${ext}`, sessionIdRef.current);
        const lines: string[] = [];
        if (res.utterances?.length) {
          for (const u of res.utterances) {
            const t = u.transcript?.trim();
            if (t) lines.push(`Speaker ${u.speaker}: ${t}`);
          }
        } else if (res.text?.trim()) {
          lines.push(res.text.trim());
        }
        if (!lines.length) return;
        const block = lines.join("\n").trim();
        const next = transcriptRef.current
          ? `${block}${TRANSCRIPT_SEGMENT_SEP}${transcriptRef.current}`
          : block;
        transcriptRef.current = next;
        setTranscript(next);
        scheduleLiveSuggest(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Transcription failed");
      }
    },
    [scheduleLiveSuggest]
  );

  const beginSegment = useCallback(() => {
    const merged = mergedStreamRef.current;
    if (!merged || !listeningRef.current) return;

    const mime = recorderMimeRef.current;
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(merged, { mimeType: mime });
    recorderRef.current = rec;

    rec.ondataavailable = (ev) => {
      if (ev.data.size) chunks.push(ev.data);
    };
    rec.onstop = () => {
      recorderRef.current = null;
      const blob = new Blob(chunks, { type: mime });
      if (blob.size >= 200) void processBlob(blob);
      if (listeningRef.current) beginSegment();
    };

    try {
      rec.start();
    } catch {
      setError("Could not start audio recorder for this browser/format.");
      listeningRef.current = false;
      return;
    }

    segmentTimerRef.current = setTimeout(() => {
      segmentTimerRef.current = null;
      if (rec.state === "recording") {
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
      }
    }, RECORD_SEGMENT_MS);
  }, [processBlob]);

  const cleanupStreams = useCallback(() => {
    listeningRef.current = false;

    if (segmentTimerRef.current) {
      clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }

    if (suggestTimerRef.current) {
      clearTimeout(suggestTimerRef.current);
      suggestTimerRef.current = null;
    }

    const r = recorderRef.current;
    if (r && r.state !== "inactive") {
      try {
        r.stop();
      } catch {
        /* ignore */
      }
    }
    recorderRef.current = null;
    mergedStreamRef.current = null;

    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;

    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;

    if (hiddenVideoRef.current) {
      hiddenVideoRef.current.srcObject = null;
    }

    const ctx = audioContextRef.current;
    if (ctx && ctx.state !== "closed") {
      void ctx.close();
    }
    audioContextRef.current = null;

    setCaptureInfo(null);
  }, []);

  const stop = useCallback(() => {
    sessionIdRef.current = null;
    cleanupStreams();
    setStatus("idle");
  }, [cleanupStreams]);

  const start = useCallback(async () => {
    setError(null);
    cleanupStreams();

    let micStream: MediaStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch {
      setError("Microphone permission denied or unavailable.");
      setStatus("error");
      return;
    }
    micStreamRef.current = micStream;

    let displayStream: MediaStream | null = null;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
    } catch {
      /* user cancelled share — continue mic-only */
    }
    displayStreamRef.current = displayStream;

    const audioCtx = new AudioContext();
    audioContextRef.current = audioCtx;
    await audioCtx.resume();

    const dest = audioCtx.createMediaStreamDestination();
    const micSource = audioCtx.createMediaStreamSource(micStream);
    micSource.connect(dest);

    let hasTabAudio = false;
    if (displayStream) {
      const aTracks = displayStream.getAudioTracks();
      if (aTracks.length > 0) {
        const tabAudioStream = new MediaStream(aTracks);
        const tabSource = audioCtx.createMediaStreamSource(tabAudioStream);
        tabSource.connect(dest);
        hasTabAudio = true;
      }
      const v = displayStream.getVideoTracks()[0];
      if (v && hiddenVideoRef.current) {
        hiddenVideoRef.current.srcObject = displayStream;
        void hiddenVideoRef.current.play().catch(() => {});
      }
    }

    setCaptureInfo({ hasMic: true, hasTabAudio });

    const merged = dest.stream;
    mergedStreamRef.current = merged;

    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "audio/webm";
    recorderMimeRef.current = mime;

    sessionIdRef.current =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    listeningRef.current = true;
    setStatus("listening");
    beginSegment();
  }, [beginSegment, cleanupStreams]);

  useEffect(() => () => cleanupStreams(), [cleanupStreams]);

  useEffect(() => {
    const el = document.getElementById("live-transcript") as HTMLTextAreaElement | null;
    if (el) el.scrollTop = 0;
  }, [transcript]);

  useEffect(() => {
    const el = document.getElementById("live-suggestion-scroll");
    if (el) el.scrollTop = 0;
  }, [suggestionFeed]);

  useEffect(() => {
    const el = document.getElementById("questions-answer-scroll");
    if (el) el.scrollTop = 0;
  }, [questionFeed]);

  const onTranscriptChange = (v: string) => {
    transcriptRef.current = v;
    setTranscript(v);
  };

  const saveTranscript = useCallback(() => {
    const body = transcriptRef.current.trim();
    if (!body) return;
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const fname = `meeting-transcript-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
    const header = `Meeting Copilot — transcript\nSaved: ${d.toLocaleString()}\n\n`;
    const blob = new Blob([header + body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    a.rel = "noopener";
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const runAskQuestion = useCallback(async () => {
    const q = questionText.trim();
    if (!q) {
      setError("Type a question first.");
      return;
    }
    setQuestionBusy(true);
    setError(null);
    try {
      const { answer } = await answerQuestion(q, contextRef.current || undefined, sessionIdRef.current);
      const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const block = `[${stamp}]\n\nQ: ${q}\n\n${answer.trim()}`;
      setQuestionFeed((prev) => [block, ...prev]);
      setQuestionText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not get an answer");
    } finally {
      setQuestionBusy(false);
    }
  }, [questionText]);

  const suggestionDisplay = suggestionFeed.join("\n\n────────\n\n");
  const questionsDisplay = questionFeed.join("\n\n────────\n\n");

  return (
    <div className="flex h-[calc(100dvh-4.5rem)] min-h-[420px] flex-row bg-ink-950">
      <video
        ref={hiddenVideoRef}
        className="pointer-events-none fixed left-0 top-0 h-px w-px opacity-0"
        muted
        playsInline
        autoPlay
        aria-hidden
      />

      {/* Collapsible briefing sidebar */}
      <aside
        className={`flex shrink-0 flex-col border-r border-white/10 bg-ink-900/50 transition-[width] duration-200 ease-out ${
          briefingOpen ? "w-[min(100vw,20rem)] sm:w-[22rem]" : "w-11 sm:w-12"
        }`}
      >
        {briefingOpen ? (
          <>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
              <span className="font-display text-xs font-semibold uppercase tracking-wide text-slate-300">
                Your meeting briefing
              </span>
              <button
                type="button"
                onClick={() => setBriefingOpen(false)}
                className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-white/10 hover:text-white"
                aria-label="Collapse meeting briefing"
              >
                ⟨
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
              <p className="text-xs leading-relaxed text-slate-400">
                Describe your situation and what you want from the AI (tone, tactics, numbers).
                Suggestions use this with the transcript.
              </p>
              <label className="sr-only" htmlFor="meeting-briefing-text">
                Meeting briefing details
              </label>
              <textarea
                id="meeting-briefing-text"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder={
                  "Example:\n" +
                  "HR discussion about joining and compensation. I want to aim for 30 LPA and stay professional if they start lower. Help me with short lines I can say, good questions about breakdown (base/bonus/equity), and how to pause or follow up—not aggressive, credible."
                }
                className="min-h-[200px] flex-1 resize-y rounded-lg border border-white/10 bg-ink-950/90 px-3 py-2.5 text-sm leading-relaxed text-white placeholder:text-slate-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setBriefingOpen(true)}
            className="flex min-h-0 flex-1 flex-col items-center gap-3 bg-ink-900/30 py-6 text-slate-500 hover:bg-white/[0.06] hover:text-slate-200"
            aria-label="Open meeting briefing sidebar"
          >
            <span className="text-lg leading-none" aria-hidden>
              ≡
            </span>
            <span className="max-w-[1.25rem] text-center text-[9px] font-bold uppercase leading-tight tracking-tight text-slate-500 [word-break:break-word] sm:text-[10px]">
              Briefing
            </span>
          </button>
        )}
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Compact toolbar — keeps transcript / suggestion / questions high on the screen */}
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/10 bg-ink-950/95 px-3 py-2 sm:gap-4 sm:px-4">
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="font-display truncate text-base font-bold text-white sm:text-lg">
              Live meeting copilot
            </h1>
            <p className="hidden text-xs text-slate-500 xl:inline">
              Mic + optional tab audio · {RECORD_SEGMENT_MS / 1000}s segments · open{" "}
              <button
                type="button"
                onClick={() => setBriefingOpen(true)}
                className="text-accent-glow underline decoration-accent/40 underline-offset-2 hover:text-indigo-300"
              >
                briefing
              </button>{" "}
              for goals and tone
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setBriefingOpen((o) => !o)}
              className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold sm:px-3 ${
                briefingOpen
                  ? "border-accent/40 bg-accent/15 text-accent-glow"
                  : "border-white/15 bg-white/5 text-slate-300 hover:bg-white/10"
              }`}
            >
              Briefing
            </button>
            {status !== "listening" ? (
              <button
                type="button"
                onClick={() => void start()}
                className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-emerald-400 sm:px-4 sm:text-sm"
              >
                Start
              </button>
            ) : (
              <button
                type="button"
                onClick={stop}
                className="rounded-lg bg-rose-500/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 sm:px-4 sm:text-sm"
              >
                Stop
              </button>
            )}
            <span
              className={`text-xs sm:text-sm ${status === "listening" ? "text-emerald-400" : "text-slate-500"}`}
            >
              {status === "listening" ? `● ${RECORD_SEGMENT_MS / 1000}s` : "○ Idle"}
            </span>
            {captureInfo && status === "listening" && (
              <span className="hidden text-xs text-slate-500 sm:inline">
                {captureInfo.hasTabAudio ? "Tab audio" : "Mic only"}
              </span>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void runSuggest()}
              className="rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-50 sm:px-3 sm:text-sm"
            >
              {busy ? "…" : "Refresh"}
            </button>
          </div>
        </header>

        {error && (
          <div className="shrink-0 border-b border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200 sm:px-4">
            {error}
          </div>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-white/10 lg:grid-cols-3 lg:divide-x lg:divide-y-0">
        <section className="flex min-h-[11rem] flex-col lg:min-h-0 lg:border-0">
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-3 sm:px-5">
            <h2 className="font-display text-xs font-bold uppercase tracking-wider text-slate-200 sm:text-sm">
              Live transcript
            </h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!transcript.trim()}
                onClick={saveTranscript}
                className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  sessionIdRef.current =
                    typeof crypto !== "undefined" && crypto.randomUUID
                      ? crypto.randomUUID()
                      : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
                  transcriptRef.current = "";
                  setTranscript("");
                  setSuggestionFeed([]);
                }}
                className="text-xs text-slate-500 hover:text-slate-300"
              >
                Clear
              </button>
            </div>
          </div>
          <textarea
            id="live-transcript"
            value={transcript}
            onChange={(e) => onTranscriptChange(e.target.value)}
            className="min-h-0 flex-1 resize-none border-0 bg-ink-950/50 px-4 py-4 font-mono text-sm leading-relaxed text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-0 sm:px-5"
            placeholder="Newest transcript segments appear at the top (older below). Separator --- between auto-captured segments."
          />
        </section>

        <section className="flex min-h-[11rem] flex-col lg:min-h-0">
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-3 sm:px-5">
            <h2 className="font-display text-xs font-bold uppercase tracking-wider text-slate-200 sm:text-sm">
              Live suggestion
              {busy && (
                <span className="ml-2 font-sans text-xs font-normal normal-case text-accent-glow">
                  updating…
                </span>
              )}
            </h2>
          </div>
          <div
            id="live-suggestion-scroll"
            className="min-h-0 flex-1 overflow-y-auto bg-gradient-to-b from-indigo-500/[0.06] to-ink-950 px-4 py-4 sm:px-5"
          >
            {suggestionDisplay ? (
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-100">
                {suggestionDisplay}
              </div>
            ) : (
              <p className="text-sm text-slate-600">
                Suggestions appear after each transcribed segment (newest at top, older below),
                grounded in the transcript and your meeting briefing when you fill it in.
              </p>
            )}
          </div>
        </section>

        <section className="flex min-h-[11rem] flex-col lg:min-h-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 px-4 py-3 sm:px-5">
            <h2 className="font-display text-xs font-bold uppercase tracking-wider text-slate-200 sm:text-sm">
              Questions
              {questionBusy && (
                <span className="ml-2 font-sans text-xs font-normal normal-case text-emerald-400/90">
                  answering…
                </span>
              )}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={questionBusy || !questionText.trim()}
                onClick={() => void runAskQuestion()}
                className="rounded-lg bg-emerald-600/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 sm:px-4"
              >
                Ask
              </button>
              <button
                type="button"
                disabled={!questionText.trim()}
                onClick={() => setQuestionText("")}
                className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Clear input
              </button>
              <button
                type="button"
                disabled={!questionFeed.length}
                onClick={() => setQuestionFeed([])}
                className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-40"
              >
                Clear answers
              </button>
            </div>
          </div>
          <p className="shrink-0 border-b border-white/5 px-4 py-2 text-xs leading-relaxed text-slate-500 sm:px-5">
            Ask anything—programming, tools, concepts—or something about the meeting. With a live
            session, your briefing and transcript are sent when relevant.
          </p>
          <label className="sr-only" htmlFor="standalone-question">
            Your question
          </label>
          <textarea
            id="standalone-question"
            value={questionText}
            onChange={(e) => setQuestionText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void runAskQuestion();
              }
            }}
            placeholder="e.g. What’s the difference between async and await in TypeScript? (⌘/Ctrl+Enter to send)"
            className="min-h-[5.5rem] shrink-0 resize-y border-b border-white/5 bg-ink-900/50 px-4 py-3 text-sm leading-relaxed text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-0 sm:px-5"
          />
          <div
            id="questions-answer-scroll"
            className="min-h-0 flex-1 overflow-y-auto bg-ink-950/80 px-4 py-4 sm:px-5"
          >
            {questionsDisplay ? (
              <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-100">
                {questionsDisplay}
              </div>
            ) : (
              <p className="text-sm text-slate-600">
                Answers appear here. General questions don’t need a recording; for meeting-related
                questions, start the copilot so context can be included.
              </p>
            )}
          </div>
        </section>
        </div>
      </div>
    </div>
  );
}
