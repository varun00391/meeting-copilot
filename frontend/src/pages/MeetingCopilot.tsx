import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  answerQuestion,
  deleteRagDocument,
  fetchRagDocuments,
  type RagMode,
  suggestReply,
  transcribeAudio,
  uploadRagDocument,
} from "../lib/api";

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

const COPILOT_MARKDOWN_PROSE_CLASS = [
  "prose prose-invert prose-sm max-w-none",
  "prose-headings:font-display prose-headings:font-semibold prose-headings:tracking-tight",
  "prose-p:leading-relaxed prose-li:leading-relaxed",
  "prose-pre:bg-ink-900 prose-pre:border prose-pre:border-white/10 prose-pre:rounded-lg",
  "prose-code:rounded prose-code:bg-white/[0.08] prose-code:px-1.5 prose-code:py-0.5 prose-code:font-normal prose-code:text-accent-glow",
  "prose-code:before:content-none prose-code:after:content-none",
  "prose-table:border-collapse prose-th:border prose-th:border-white/15 prose-td:border prose-td:border-white/10",
].join(" ");

const copilotMarkdownComponents = {
  a: ({
    href,
    children,
    ...props
  }: {
    href?: string;
    children?: ReactNode;
    className?: string;
  }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent-glow underline decoration-accent/50 underline-offset-2 hover:text-indigo-300"
      {...props}
    >
      {children}
    </a>
  ),
  pre: ({
    children,
    className,
    ...props
  }: {
    children?: ReactNode;
    className?: string;
  }) => (
    <pre {...props} className={[className, "overflow-x-auto"].filter(Boolean).join(" ")}>
      {children}
    </pre>
  ),
};

function CopilotMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className={COPILOT_MARKDOWN_PROSE_CLASS}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={copilotMarkdownComponents}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

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

function newQuestionEntryId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `q-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

type QuestionEntry = {
  id: string;
  stamp: string;
  question: string;
  /** Markdown from the model */
  answer: string;
};

export function MeetingCopilot() {
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  /** Raw textarea vs rendered Markdown preview (same text). */
  const [transcriptView, setTranscriptView] = useState<"edit" | "preview">("edit");
  /** Newest suggestion first; each entry is timestamp + body. */
  const [suggestionFeed, setSuggestionFeed] = useState<string[]>([]);
  const [questionText, setQuestionText] = useState("");
  /** Newest entries first. Question is plain text; answer rendered as Markdown. */
  const [questionFeed, setQuestionFeed] = useState<QuestionEntry[]>([]);
  const [context, setContext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [questionBusy, setQuestionBusy] = useState(false);
  const [captureInfo, setCaptureInfo] = useState<CaptureInfo | null>(null);
  const [briefingOpen, setBriefingOpen] = useState(false);
  /** RAG: uploaded docs list, optional topic tags on next upload, retrieval mode + keyword triggers */
  const [ragDocuments, setRagDocuments] = useState<
    { id: string; filename: string; topic_tags: string | null; chunk_count: number }[]
  >([]);
  const [ragUploadTopicTags, setRagUploadTopicTags] = useState("");
  const [ragUploadBusy, setRagUploadBusy] = useState(false);
  const [ragMode, setRagMode] = useState<RagMode>("auto");
  const [ragKeywords, setRagKeywords] = useState("");

  const recorderMicRef = useRef<MediaRecorder | null>(null);
  const recorderTabRef = useRef<MediaRecorder | null>(null);
  const listeningRef = useRef(false);
  const recorderMimeRef = useRef("audio/webm");
  const segmentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  /** Tab/system audio only (when screen is shared). Recorded separately from mic for diarization. */
  const tabAudioStreamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);
  const transcriptRef = useRef("");
  const contextRef = useRef("");
  /** Server-side conversation session (transcript + briefing); set on Start, cleared on Stop. */
  const sessionIdRef = useRef<string | null>(null);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ragFileInputRef = useRef<HTMLInputElement | null>(null);

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
        sessionIdRef.current,
        { ragMode, ragKeywords: ragKeywords || null }
      );
      const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const block = `[${stamp}]\n\n${s.trim()}`;
      setSuggestionFeed((prev) => [block, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Suggestion failed");
    } finally {
      setBusy(false);
    }
  }, [ragMode, ragKeywords]);

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
    async (micBlob: Blob, tabBlob: Blob | null) => {
      if (micBlob.size < 200) return;
      const ext = extensionForRecorderMime(micBlob.type || recorderMimeRef.current);
      try {
        const res = await transcribeAudio(
          micBlob,
          `segment.${ext}`,
          sessionIdRef.current,
          tabBlob && tabBlob.size >= 200 ? tabBlob : null
        );
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
    const mic = micStreamRef.current;
    if (!mic || !listeningRef.current) return;

    const tabOnly = tabAudioStreamRef.current;
    const mime = recorderMimeRef.current;
    const chunksMic: Blob[] = [];
    const chunksTab: Blob[] = [];

    const recMic = new MediaRecorder(mic, { mimeType: mime });
    const recTab =
      tabOnly && tabOnly.getAudioTracks().length > 0
        ? new MediaRecorder(tabOnly, { mimeType: mime })
        : null;

    recorderMicRef.current = recMic;
    recorderTabRef.current = recTab;

    let micStopped = false;
    let tabStopped = !recTab;

    const finishSegment = () => {
      if (!micStopped || !tabStopped) return;
      recorderMicRef.current = null;
      recorderTabRef.current = null;
      const blobMic = new Blob(chunksMic, { type: mime });
      const blobTab = recTab ? new Blob(chunksTab, { type: mime }) : null;
      if (blobMic.size >= 200) void processBlob(blobMic, blobTab);
      if (listeningRef.current) beginSegment();
    };

    recMic.ondataavailable = (ev) => {
      if (ev.data.size) chunksMic.push(ev.data);
    };
    recMic.onstop = () => {
      micStopped = true;
      finishSegment();
    };

    if (recTab) {
      recTab.ondataavailable = (ev) => {
        if (ev.data.size) chunksTab.push(ev.data);
      };
      recTab.onstop = () => {
        tabStopped = true;
        finishSegment();
      };
    }

    try {
      recMic.start();
      recTab?.start();
    } catch {
      setError("Could not start audio recorder for this browser/format.");
      listeningRef.current = false;
      return;
    }

    segmentTimerRef.current = setTimeout(() => {
      segmentTimerRef.current = null;
      if (recMic.state === "recording") {
        try {
          recMic.stop();
        } catch {
          /* ignore */
        }
      }
      if (recTab && recTab.state === "recording") {
        try {
          recTab.stop();
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

    const rm = recorderMicRef.current;
    if (rm && rm.state !== "inactive") {
      try {
        rm.stop();
      } catch {
        /* ignore */
      }
    }
    recorderMicRef.current = null;
    const rt = recorderTabRef.current;
    if (rt && rt.state !== "inactive") {
      try {
        rt.stop();
      } catch {
        /* ignore */
      }
    }
    recorderTabRef.current = null;
    tabAudioStreamRef.current = null;

    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;

    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;

    if (hiddenVideoRef.current) {
      hiddenVideoRef.current.srcObject = null;
    }

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

    let hasTabAudio = false;
    if (displayStream) {
      const aTracks = displayStream.getAudioTracks();
      if (aTracks.length > 0) {
        tabAudioStreamRef.current = new MediaStream(aTracks);
        hasTabAudio = true;
      } else {
        tabAudioStreamRef.current = null;
      }
      const v = displayStream.getVideoTracks()[0];
      if (v && hiddenVideoRef.current) {
        hiddenVideoRef.current.srcObject = displayStream;
        void hiddenVideoRef.current.play().catch(() => {});
      }
    } else {
      tabAudioStreamRef.current = null;
    }

    setCaptureInfo({ hasMic: true, hasTabAudio });

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

  const refreshRagDocuments = useCallback(async () => {
    try {
      const { documents } = await fetchRagDocuments();
      setRagDocuments(documents);
    } catch {
      /* ignore list errors */
    }
  }, []);

  useEffect(() => {
    void refreshRagDocuments();
  }, [refreshRagDocuments]);

  const onRagFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      setRagUploadBusy(true);
      setError(null);
      try {
        await uploadRagDocument(file, ragUploadTopicTags || undefined);
        await refreshRagDocuments();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setRagUploadBusy(false);
      }
    },
    [ragUploadTopicTags, refreshRagDocuments]
  );

  useEffect(() => {
    if (transcriptView === "edit") {
      const el = document.getElementById("live-transcript") as HTMLTextAreaElement | null;
      if (el) el.scrollTop = 0;
    } else {
      const el = document.getElementById("live-transcript-preview");
      if (el) el.scrollTop = 0;
    }
  }, [transcript, transcriptView]);

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
      const { answer } = await answerQuestion(
        q,
        contextRef.current || undefined,
        sessionIdRef.current,
        { ragMode, ragKeywords: ragKeywords || null }
      );
      const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setQuestionFeed((prev) => [
        {
          id: newQuestionEntryId(),
          stamp,
          question: q,
          answer: answer.trim(),
        },
        ...prev,
      ]);
      setQuestionText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not get an answer");
    } finally {
      setQuestionBusy(false);
    }
  }, [questionText, ragMode, ragKeywords]);

  const transcriptPreviewSegments = transcript.trim()
    ? transcript.split(TRANSCRIPT_SEGMENT_SEP).filter(Boolean)
    : [];

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

              <div className="border-t border-white/10 pt-3">
                <p className="mb-2 font-display text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Knowledge base (RAG)
                </p>
                <p className="mb-2 text-[11px] leading-relaxed text-slate-500">
                  Upload PDF or DOCX once; embeddings are stored and reused. Leave file topics empty to
                  search by similarity; with topics set, in <span className="text-slate-400">auto</span>{" "}
                  mode a chunk is used only if the question mentions a topic or matches strongly.
                </p>
                <input
                  ref={ragFileInputRef}
                  type="file"
                  accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="hidden"
                  onChange={onRagFileSelected}
                />
                <label className="mb-2 block text-[11px] text-slate-500" htmlFor="rag-upload-topics">
                  Topics for next upload (optional, comma-separated)
                </label>
                <input
                  id="rag-upload-topics"
                  type="text"
                  value={ragUploadTopicTags}
                  onChange={(e) => setRagUploadTopicTags(e.target.value)}
                  placeholder="e.g. data leakage, compliance"
                  className="mb-2 w-full rounded border border-white/10 bg-ink-950/90 px-2 py-1.5 text-xs text-white placeholder:text-slate-600"
                />
                <button
                  type="button"
                  disabled={ragUploadBusy}
                  onClick={() => ragFileInputRef.current?.click()}
                  className="mb-3 w-full rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs font-semibold text-accent-glow hover:bg-accent/20 disabled:opacity-50"
                >
                  {ragUploadBusy ? "Uploading…" : "Upload PDF or DOCX"}
                </button>
                {ragDocuments.length > 0 && (
                  <ul className="mb-3 max-h-28 space-y-1 overflow-y-auto text-[11px] text-slate-400">
                    {ragDocuments.map((d) => (
                      <li
                        key={d.id}
                        className="flex items-start justify-between gap-1 border-b border-white/5 pb-1"
                      >
                        <span className="min-w-0 break-words" title={d.filename}>
                          {d.filename}
                          {d.chunk_count > 0 ? (
                            <span className="text-slate-600"> · {d.chunk_count} chunks</span>
                          ) : null}
                        </span>
                        <button
                          type="button"
                          className="shrink-0 text-rose-400 hover:text-rose-300"
                          onClick={() => {
                            void (async () => {
                              try {
                                await deleteRagDocument(d.id);
                                await refreshRagDocuments();
                              } catch (err) {
                                setError(err instanceof Error ? err.message : "Delete failed");
                              }
                            })();
                          }}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <label className="mb-1 block text-[11px] text-slate-500" htmlFor="rag-mode">
                  Use documents for answers & live suggestions
                </label>
                <select
                  id="rag-mode"
                  value={ragMode}
                  onChange={(e) => setRagMode(e.target.value as RagMode)}
                  className="mb-2 w-full rounded border border-white/10 bg-ink-950/90 px-2 py-1.5 text-xs text-white"
                >
                  <option value="off">Off — model only</option>
                  <option value="auto">Auto — topics / similarity</option>
                  <option value="on">On — always search uploads</option>
                </select>
                <label className="mb-1 block text-[11px] text-slate-500" htmlFor="rag-keywords">
                  Extra trigger phrases (auto mode, comma-separated)
                </label>
                <textarea
                  id="rag-keywords"
                  value={ragKeywords}
                  onChange={(e) => setRagKeywords(e.target.value)}
                  rows={2}
                  placeholder="If the question or live topic contains any of these, search your documents first."
                  className="w-full resize-none rounded border border-white/10 bg-ink-950/90 px-2 py-1.5 text-xs text-white placeholder:text-slate-600"
                />
              </div>
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
                {captureInfo.hasTabAudio
                  ? "Dual capture: speakers 0–99 = mic · 100+ = tab/meeting"
                  : "Mic only · multiple voices via diarization"}
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
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-lg border border-white/10 p-0.5 text-[11px] font-semibold">
                <button
                  type="button"
                  onClick={() => setTranscriptView("edit")}
                  className={`rounded-md px-2 py-1 ${
                    transcriptView === "edit"
                      ? "bg-white/15 text-white"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setTranscriptView("preview")}
                  className={`rounded-md px-2 py-1 ${
                    transcriptView === "preview"
                      ? "bg-white/15 text-white"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  Preview
                </button>
              </div>
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
          {transcriptView === "edit" ? (
            <textarea
              id="live-transcript"
              value={transcript}
              onChange={(e) => onTranscriptChange(e.target.value)}
              className="min-h-0 flex-1 resize-none border-0 bg-ink-950/50 px-4 py-4 font-mono text-sm leading-relaxed text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-0 sm:px-5"
              placeholder="Newest transcript segments appear at the top (older below). Separator --- between auto-captured segments."
            />
          ) : (
            <div
              id="live-transcript-preview"
              className="min-h-0 flex-1 overflow-y-auto bg-ink-950/50 px-4 py-4 sm:px-5"
            >
              {transcriptPreviewSegments.length > 0 ? (
                <div className="flex flex-col gap-4">
                  {transcriptPreviewSegments.map((seg, i) => (
                    <div key={i}>
                      {i > 0 ? (
                        <div
                          className="mb-4 border-t border-white/10 pt-4"
                          role="separator"
                          aria-hidden
                        />
                      ) : null}
                      <CopilotMarkdown markdown={seg.trim()} />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-600">Nothing to preview yet.</p>
              )}
            </div>
          )}
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
            {suggestionFeed.length > 0 ? (
              <div className="flex flex-col gap-6">
                {suggestionFeed.map((block, i) => (
                  <div key={i}>
                    {i > 0 ? (
                      <div
                        className="mb-6 border-t border-white/10"
                        role="separator"
                        aria-hidden
                      />
                    ) : null}
                    <CopilotMarkdown markdown={block} />
                  </div>
                ))}
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
              if (e.key !== "Enter" || e.shiftKey) return;
              e.preventDefault();
              if (!questionBusy && questionText.trim()) {
                void runAskQuestion();
              }
            }}
            placeholder="e.g. What’s the difference between async and await in TypeScript? (Enter to send · Shift+Enter for a new line)"
            className="min-h-[5.5rem] shrink-0 resize-y border-b border-white/5 bg-ink-900/50 px-4 py-3 text-sm leading-relaxed text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-0 sm:px-5"
          />
          <div
            id="questions-answer-scroll"
            className="min-h-0 flex-1 overflow-y-auto bg-ink-950/80 px-4 py-4 sm:px-5"
          >
            {questionFeed.length > 0 ? (
              <div className="flex flex-col gap-8">
                {questionFeed.map((entry) => (
                  <article
                    key={entry.id}
                    className="border-b border-white/10 pb-8 last:border-b-0 last:pb-0"
                  >
                    <p className="mb-2 font-mono text-xs text-slate-500">[{entry.stamp}]</p>
                    <p className="mb-3 break-words text-sm text-slate-300">
                      <span className="font-semibold text-slate-200">Q: </span>
                      {entry.question}
                    </p>
                    <CopilotMarkdown markdown={entry.answer} />
                  </article>
                ))}
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
