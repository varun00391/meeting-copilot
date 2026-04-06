import { useCallback, useEffect, useRef, useState } from "react";
import { suggestReply, transcribeAudio } from "../lib/api";

type Status = "idle" | "listening" | "error";

type CaptureInfo = {
  hasMic: boolean;
  hasTabAudio: boolean;
};

const SUGGEST_DEBOUNCE_MS = 500;
const RECORD_SLICE_MS = 5500;

function extensionForRecorderMime(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

export function MeetingCopilot() {
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  const [suggestion, setSuggestion] = useState("");
  const [context, setContext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [captureInfo, setCaptureInfo] = useState<CaptureInfo | null>(null);

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
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  transcriptRef.current = transcript;
  contextRef.current = context;

  const appendLine = useCallback((line: string) => {
    if (!line.trim()) return;
    const next = transcriptRef.current ? `${transcriptRef.current}\n${line.trim()}` : line.trim();
    transcriptRef.current = next;
    setTranscript(next);
    return next;
  }, []);

  const runSuggest = useCallback(async (textOverride?: string) => {
    const t = (textOverride ?? transcriptRef.current).trim();
    if (!t) {
      setError("Nothing to analyze yet—wait for transcript lines or paste text.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { suggestion: s } = await suggestReply(t, contextRef.current || undefined);
      setSuggestion(s);
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
        const { text } = await transcribeAudio(blob, `segment.${ext}`);
        if (!text?.trim()) return;
        const next = appendLine(text);
        if (next) scheduleLiveSuggest(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Transcription failed");
      }
    },
    [appendLine, scheduleLiveSuggest]
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
    }, RECORD_SLICE_MS);
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

    listeningRef.current = true;
    setStatus("listening");
    beginSegment();
  }, [beginSegment, cleanupStreams]);

  useEffect(() => () => cleanupStreams(), [cleanupStreams]);

  useEffect(() => {
    const el = document.getElementById("live-transcript") as HTMLTextAreaElement | null;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [transcript]);

  const onTranscriptChange = (v: string) => {
    transcriptRef.current = v;
    setTranscript(v);
  };

  return (
    <div className="flex min-h-[calc(100vh-4.5rem)] flex-col">
      <video
        ref={hiddenVideoRef}
        className="pointer-events-none fixed left-0 top-0 h-px w-px opacity-0"
        muted
        playsInline
        autoPlay
        aria-hidden
      />

      <div className="border-b border-white/5 bg-ink-950/90 px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold text-white sm:text-3xl">
              Live meeting copilot
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Mic captures you; when you share your screen, choose the{" "}
              <strong className="font-medium text-slate-300">meeting tab</strong> and enable{" "}
              <strong className="font-medium text-slate-300">Share tab audio</strong> so remote
              voices are included. After each transcribed segment, a suggested reply updates
              automatically on the right.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {status !== "listening" ? (
              <button
                type="button"
                onClick={() => void start()}
                className="rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-ink-950 hover:bg-emerald-400"
              >
                Start listening
              </button>
            ) : (
              <button
                type="button"
                onClick={stop}
                className="rounded-xl bg-rose-500/90 px-5 py-2.5 text-sm font-semibold text-white hover:bg-rose-500"
              >
                Stop
              </button>
            )}
            <span
              className={`text-sm ${status === "listening" ? "text-emerald-400" : "text-slate-500"}`}
            >
              {status === "listening" ? "● Live" : "○ Idle"}
            </span>
            {captureInfo && status === "listening" && (
              <span className="text-xs text-slate-500">
                Mic on
                {captureInfo.hasTabAudio ? " · Tab audio on" : " · Tab audio off (share meeting tab with audio)"}
              </span>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void runSuggest()}
              className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-50"
            >
              {busy ? "Updating…" : "Refresh suggestion"}
            </button>
          </div>
        </div>

        <div className="mx-auto mt-4 max-w-[1600px]">
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
            Your context (optional)
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Role, goals, constraints—helps tailor live suggestions…"
              rows={2}
              className="mt-1.5 w-full rounded-xl border border-white/10 bg-ink-900/80 px-4 py-2.5 text-sm text-white placeholder:text-slate-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40 lg:max-w-3xl"
            />
          </label>
        </div>

        {error && (
          <div className="mx-auto mt-4 max-w-[1600px] rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-0 lg:flex-row">
        <section className="flex min-h-[min(50vh,28rem)] flex-1 flex-col border-white/5 lg:min-h-0 lg:border-r">
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-3 sm:px-5">
            <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-slate-400">
              Live transcript
            </h2>
            <button
              type="button"
              onClick={() => {
                transcriptRef.current = "";
                setTranscript("");
                setSuggestion("");
              }}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              Clear
            </button>
          </div>
          <textarea
            id="live-transcript"
            value={transcript}
            onChange={(e) => onTranscriptChange(e.target.value)}
            className="min-h-0 flex-1 resize-none border-0 bg-ink-950/50 px-4 py-4 font-mono text-sm leading-relaxed text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-0 sm:px-5"
            placeholder="You + remote participants (via tab audio) appear here as speech is transcribed…"
          />
        </section>

        <section className="flex min-h-[min(50vh,28rem)] flex-1 flex-col lg:min-h-0">
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-3 sm:px-5">
            <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-slate-400">
              Suggested reply
              {busy && (
                <span className="ml-2 font-sans text-xs font-normal normal-case text-accent-glow">
                  updating…
                </span>
              )}
            </h2>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto bg-gradient-to-b from-indigo-500/[0.06] to-ink-950 px-4 py-4 sm:px-5">
            {suggestion ? (
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-100">
                {suggestion}
              </div>
            ) : (
              <p className="text-sm text-slate-600">
                Start listening. As new speech is transcribed, this panel refreshes with a reply you
                can read aloud—tailored to the latest conversation.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
