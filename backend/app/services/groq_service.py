import io
from typing import Any

from groq import Groq
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import UsageEvent


def _get_client() -> Groq:
    if not settings.groq_api_key:
        raise ValueError("GROQ_API_KEY is not set")
    return Groq(api_key=settings.groq_api_key)


async def log_usage(
    db: AsyncSession,
    *,
    endpoint: str,
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    total_tokens: int = 0,
) -> None:
    if total_tokens == 0 and (input_tokens or output_tokens):
        total_tokens = input_tokens + output_tokens
    event = UsageEvent(
        endpoint=endpoint,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens or (input_tokens + output_tokens),
    )
    db.add(event)
    await db.commit()


def transcribe_audio_sync(file_bytes: bytes, filename: str) -> tuple[str, dict[str, Any]]:
    client = _get_client()
    transcription = client.audio.transcriptions.create(
        file=(filename, io.BytesIO(file_bytes)),
        model=settings.whisper_model,
        response_format="verbose_json",
    )
    text = getattr(transcription, "text", "") or ""
    usage: dict[str, Any] = {}
    u = getattr(transcription, "usage", None) or getattr(transcription, "x_groq", None)
    if u is not None:
        if hasattr(u, "model_dump"):
            usage = u.model_dump()
        elif isinstance(u, dict):
            usage = u
        else:
            for k in ("prompt_tokens", "completion_tokens", "total_tokens"):
                if hasattr(u, k):
                    usage[k] = getattr(u, k)
    return text.strip(), usage


def suggest_reply_sync(transcript: str, extra_context: str | None) -> tuple[str, dict[str, Any]]:
    client = _get_client()
    ctx = (extra_context or "").strip()
    system = (
        "You are a meeting copilot. Given the live transcript, identify the most recent "
        "question, request, or topic directed at the user (or that clearly needs a response). "
        "If nothing needs an answer, say so briefly. "
        "Output: (1) One short line: what was asked or implied. "
        "(2) A concise suggested reply the user can speak (2–5 sentences max, natural spoken tone). "
        "Use clear labels: **What they need:** and **Suggested reply:**"
    )
    user_msg = f"Transcript:\n{transcript[-12000:]}"
    if ctx:
        user_msg += f"\n\nUser notes / context:\n{ctx}"
    completion = client.chat.completions.create(
        model=settings.chat_model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_msg},
        ],
        temperature=0.4,
        max_tokens=1024,
    )
    content = completion.choices[0].message.content or ""
    usage_obj = completion.usage
    usage = {}
    if usage_obj:
        usage = {
            "prompt_tokens": usage_obj.prompt_tokens or 0,
            "completion_tokens": usage_obj.completion_tokens or 0,
            "total_tokens": usage_obj.total_tokens or 0,
        }
    return content.strip(), usage
