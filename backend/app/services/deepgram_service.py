from typing import Any

from deepgram import DeepgramClient
from deepgram.clients.listen.v1.rest.options import PrerecordedOptions

from app.config import settings


def _get_client() -> DeepgramClient:
    if not settings.deepgram_api_key:
        raise ValueError("DEEPGRAM_API_KEY is not set")
    return DeepgramClient(api_key=settings.deepgram_api_key)


def transcribe_diarized_sync(
    file_bytes: bytes,
    *,
    content_type: str | None = None,
) -> tuple[str, list[dict[str, Any]], float]:
    """
    Returns (flat transcript with speaker labels, utterance dicts, audio duration seconds).
    """
    client = _get_client()
    ct = (content_type or "").strip() or "application/octet-stream"
    headers = {"Content-Type": ct}

    options = PrerecordedOptions(
        model=settings.deepgram_model,
        smart_format=True,
        punctuate=True,
        diarize=True,
        utterances=True,
    )

    response = client.listen.rest.v("1").transcribe_file(
        {"buffer": file_bytes},
        options,
        headers=headers,
    )

    duration = 0.0
    if response.metadata:
        duration = float(response.metadata.duration or 0.0)

    utterances_out: list[dict[str, Any]] = []
    results = response.results
    if results and results.utterances:
        for u in results.utterances:
            t = (u.transcript or "").strip()
            if not t:
                continue
            sp = u.speaker if u.speaker is not None else 0
            utterances_out.append({"speaker": sp, "transcript": t})

    plain = ""
    if results and results.channels:
        alts = results.channels[0].alternatives
        if alts:
            plain = (alts[0].transcript or "").strip()

    if utterances_out:
        text = "\n".join(f"Speaker {u['speaker']}: {u['transcript']}" for u in utterances_out)
    else:
        text = plain

    return text, utterances_out, duration
