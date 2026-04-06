import { Link } from "react-router-dom";

export function Landing() {
  return (
    <div className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-grid-fade" />
      <div className="pointer-events-none absolute -left-40 top-20 h-96 w-96 rounded-full bg-accent/20 blur-[100px]" />
      <div className="pointer-events-none absolute -right-40 top-60 h-80 w-80 rounded-full bg-violet-500/15 blur-[90px]" />

      <section className="relative mx-auto max-w-6xl px-4 pb-24 pt-16 sm:px-6 sm:pt-24">
        <p className="mb-4 inline-flex items-center rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-slate-300">
          Groq-powered · Live assist
        </p>
        <h1 className="font-display max-w-3xl text-4xl font-bold leading-tight tracking-tight text-white sm:text-5xl lg:text-6xl">
          Answer tough meeting questions{" "}
          <span className="bg-gradient-to-r from-accent-glow to-fuchsia-400 bg-clip-text text-transparent">
            with calm, clear prompts
          </span>
        </h1>
        <p className="mt-6 max-w-xl text-lg text-slate-400">
          Capture what is said in the room (or from another device via your mic), transcribe it in
          real time, and get short suggested replies you can read and speak naturally—without
          fumbling for words.
        </p>
        <div className="mt-10 flex flex-wrap gap-4">
          <Link
            to="/copilot"
            className="inline-flex items-center justify-center rounded-xl bg-accent px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition hover:bg-indigo-500"
          >
            Open copilot
          </Link>
          <a
            href="#how"
            className="inline-flex items-center justify-center rounded-xl border border-white/15 bg-white/5 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
          >
            How it works
          </a>
        </div>
      </section>

      <section
        id="how"
        className="relative mx-auto max-w-6xl border-t border-white/5 px-4 py-20 sm:px-6"
      >
        <h2 className="font-display text-2xl font-semibold text-white sm:text-3xl">How it works</h2>
        <p className="mt-2 max-w-2xl text-slate-400">
          Three focused steps—optimized for speed so you stay in the conversation.
        </p>
        <div className="mt-12 grid gap-6 sm:grid-cols-3">
          {[
            {
              step: "01",
              title: "Listen",
              body: "Use your laptop or phone browser. Audio from the meeting is captured through the microphone (place the device near speakers if needed).",
            },
            {
              step: "02",
              title: "Transcribe",
              body: "Chunks stream to the backend and Groq Whisper turns speech into text, appended to your live transcript.",
            },
            {
              step: "03",
              title: "Reply",
              body: "When someone asks something tricky, request a suggestion. Llama summarizes what they need and drafts text you can read aloud.",
            },
          ].map((c) => (
            <div
              key={c.step}
              className="group rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.07] to-transparent p-6 transition hover:border-accent/30"
            >
              <span className="text-xs font-mono text-accent-glow">{c.step}</span>
              <h3 className="mt-3 font-display text-lg font-semibold text-white">{c.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="relative mx-auto max-w-6xl border-t border-white/5 px-4 py-20 sm:px-6">
        <div className="rounded-3xl border border-white/10 bg-ink-900/80 p-8 sm:p-12">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="font-display text-2xl font-semibold text-white sm:text-3xl">
                Built for privacy-aware teams
              </h2>
              <p className="mt-3 max-w-xl text-slate-400">
                You control when recording runs. Transcripts stay in your session until you clear
                them. Token usage is logged locally on the server for the dashboard—your Groq key
                stays on the backend.
              </p>
            </div>
            <Link
              to="/usage"
              className="shrink-0 rounded-xl border border-white/15 px-6 py-3 text-center text-sm font-semibold text-white hover:bg-white/5"
            >
              View usage dashboard
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/5 py-10 text-center text-sm text-slate-500">
        Meeting Copilot · FastAPI · React · Groq
      </footer>
    </div>
  );
}
