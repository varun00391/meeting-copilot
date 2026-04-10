from typing import Any

from deepgram import DeepgramClient
from deepgram.clients.listen.v1.rest.options import PrerecordedOptions

from app.config import settings


def _prerecorded_options_base(*, multichannel: bool) -> PrerecordedOptions:
    """Shared Deepgram prerecorded options; diarization + optional language / diarize_version."""
    kwargs: dict[str, Any] = {
        "model": settings.deepgram_model,
        "smart_format": True,
        "punctuate": True,
        "diarize": True,
        "utterances": True,
        "multichannel": multichannel,
    }
    dv = (settings.deepgram_diarize_version or "").strip()
    if dv:
        kwargs["diarize_version"] = dv
    lang = (settings.deepgram_language or "").strip()
    if lang:
        kwargs["language"] = lang
    return PrerecordedOptions(**kwargs)

# Mic diarization uses 0..(BASE-1); tab stream uses BASE + diarization id (remote is usually 0).
TAB_SPEAKER_BASE = 100


def _get_client() -> DeepgramClient:
    if not settings.deepgram_api_key:
        raise ValueError("DEEPGRAM_API_KEY is not set")
    return DeepgramClient(api_key=settings.deepgram_api_key)


def _word_text_and_speaker(w: Any) -> tuple[str, int]:
    if isinstance(w, dict):
        text = (w.get("punctuated_word") or w.get("word") or "").strip()
        sp = w.get("speaker")
    else:
        text = (
            getattr(w, "punctuated_word", None)
            or getattr(w, "word", None)
            or ""
        )
        text = (text or "").strip()
        sp = getattr(w, "speaker", None)
    if sp is None:
        sid = 0
    else:
        try:
            sid = int(sp)
        except (TypeError, ValueError):
            sid = 0
    return text, sid


def _word_start(w: Any) -> float:
    if isinstance(w, dict):
        try:
            return float(w.get("start") or 0.0)
        except (TypeError, ValueError):
            return 0.0
    try:
        return float(getattr(w, "start", 0.0) or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _words_in_channel(channel: Any) -> list[Any]:
    words: list[Any] = []
    for alt in getattr(channel, "alternatives", None) or []:
        w = getattr(alt, "words", None)
        if w:
            words.extend(list(w))
    return words


def _channel_has_speech(ch: Any) -> bool:
    return len(_words_in_channel(ch)) > 0


def _tokens_from_results(
    results: Any,
    *,
    use_channel_as_speaker: bool,
    speaker_shift: int = 0,
) -> list[tuple[float, int, str]]:
    """Collect (start, speaker, text) from Deepgram results."""
    tokens: list[tuple[float, int, str]] = []
    channels = list(getattr(results, "channels", None) or [])
    for ch_idx, ch in enumerate(channels):
        for w in _words_in_channel(ch):
            text, diar_sp = _word_text_and_speaker(w)
            if not text:
                continue
            t0 = _word_start(w)
            if use_channel_as_speaker:
                sp = ch_idx + speaker_shift
            else:
                sp = diar_sp + speaker_shift
            tokens.append((t0, sp, text))
    tokens.sort(key=lambda x: x[0])
    return tokens


def _segments_from_timed_tokens(tokens: list[tuple[float, int, str]]) -> list[dict[str, Any]]:
    if not tokens:
        return []

    segments: list[dict[str, Any]] = []
    cur_sp: int | None = None
    buf: list[str] = []

    for _t0, sp, text in tokens:
        if cur_sp is None:
            cur_sp = sp
            buf = [text]
            continue
        if sp == cur_sp:
            buf.append(text)
        else:
            joined = " ".join(buf).strip()
            if joined:
                segments.append({"speaker": cur_sp, "transcript": joined})
            cur_sp = sp
            buf = [text]

    if buf and cur_sp is not None:
        joined = " ".join(buf).strip()
        if joined:
            segments.append({"speaker": cur_sp, "transcript": joined})

    return segments


def _fallback_utterances_from_api(results: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not results or not results.utterances:
        return out
    for u in results.utterances:
        t = (u.transcript or "").strip()
        if not t:
            continue
        sp = u.speaker if u.speaker is not None else 0
        out.append({"speaker": sp, "transcript": t})
    return out


def _distinct_speakers_in_segments(segments: list[dict[str, Any]]) -> int:
    return len({s["speaker"] for s in segments})


def _build_utterances_from_word_results(
    results: Any,
    *,
    use_channel_as_speaker: bool,
    speaker_shift: int = 0,
) -> list[dict[str, Any]]:
    timed = _tokens_from_results(
        results,
        use_channel_as_speaker=use_channel_as_speaker,
        speaker_shift=speaker_shift,
    )
    seg = _segments_from_timed_tokens(timed)
    if not seg:
        return _fallback_utterances_from_api(results)

    # If every word collapsed to one speaker but API utterances show multiple speakers, prefer utterances.
    utt_fb = _fallback_utterances_from_api(results)
    if (
        _distinct_speakers_in_segments(seg) <= 1
        and utt_fb
        and _distinct_speakers_in_segments(utt_fb) > 1
    ):
        return utt_fb
    return seg


def _transcribe_one(
    file_bytes: bytes,
    content_type: str | None,
    *,
    multichannel: bool,
) -> tuple[Any, float]:
    """Run Deepgram once; return (results object, duration_sec)."""
    client = _get_client()
    ct = (content_type or "").strip() or "application/octet-stream"
    headers = {"Content-Type": ct}

    options = _prerecorded_options_base(multichannel=multichannel)

    response = client.listen.rest.v("1").transcribe_file(
        {"buffer": file_bytes},
        options,
        headers=headers,
    )

    duration = 0.0
    if response.metadata:
        duration = float(response.metadata.duration or 0.0)

    return response.results, duration


def transcribe_diarized_sync(
    file_bytes: bytes,
    file_tab_bytes: bytes | None = None,
    *,
    content_type: str | None = None,
    content_type_tab: str | None = None,
) -> tuple[str, list[dict[str, Any]], float]:
    """
    Transcribe mic (`file_bytes`); optionally tab (`file_tab_bytes`) as a separate mono file.

    Browsers often **downmix stereo WebM to mono**, so a single mixed clip breaks multichannel.
    Recording **mic and tab separately** (two blobs) lets us label speakers reliably:
    mic stream → diarization IDs 0,1,… ; tab stream → IDs BASE, BASE+1,…

    Single-file mode: one mono/stereo file; use multichannel only when the API returns 2 channels
    with speech on channel 2 (real stereo file); else diarization on words.
    """
    # --- Dual upload: mic + tab as independent mono recordings (preferred) ---
    if file_tab_bytes and len(file_tab_bytes) >= 200:
        results_mic, dur_mic = _transcribe_one(
            file_bytes, content_type, multichannel=False
        )
        results_tab, dur_tab = _transcribe_one(
            file_tab_bytes, content_type_tab or content_type, multichannel=False
        )

        # Re-merge by word timestamps so mic + tab interleave in real time.
        mic_tok = _tokens_from_results(
            results_mic, use_channel_as_speaker=False, speaker_shift=0
        )
        tab_tok = _tokens_from_results(
            results_tab, use_channel_as_speaker=False, speaker_shift=TAB_SPEAKER_BASE
        )
        merged_tok = sorted(mic_tok + tab_tok, key=lambda x: x[0])
        utterances_out = _segments_from_timed_tokens(merged_tok)

        # Billable audio: both streams were sent to the STT API.
        duration = max(dur_mic + dur_tab, 0.001)
        channels = list(getattr(results_mic, "channels", None) or [])
        plain = ""
        if channels:
            alts = channels[0].alternatives
            if alts:
                plain = (alts[0].transcript or "").strip()
        if not plain:
            ch2 = list(getattr(results_tab, "channels", None) or [])
            if ch2 and ch2[0].alternatives:
                plain = (ch2[0].alternatives[0].transcript or "").strip()

        if utterances_out:
            text = "\n".join(
                f"Speaker {u['speaker']}: {u['transcript']}" for u in utterances_out
            )
        else:
            text = plain

        return text, utterances_out, duration

    # Mono / typical browser upload: multichannel=false avoids odd dual-channel behavior.
    results, duration = _transcribe_one(file_bytes, content_type, multichannel=False)
    channels = list(getattr(results, "channels", None) or [])

    # Real stereo in file: 2 channels and tab channel has speech → label by channel.
    use_ch = len(channels) >= 2 and _channel_has_speech(channels[1])
    utterances_out = _build_utterances_from_word_results(
        results, use_channel_as_speaker=use_ch, speaker_shift=0
    )

    if not utterances_out:
        utterances_out = _fallback_utterances_from_api(results)

    plain = ""
    if channels:
        alts = channels[0].alternatives
        if alts:
            plain = (alts[0].transcript or "").strip()

    if utterances_out:
        text = "\n".join(
            f"Speaker {u['speaker']}: {u['transcript']}" for u in utterances_out
        )
    else:
        text = plain

    return text, utterances_out, duration
