from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool
from deepgram import DeepgramApiError

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from app.config import settings
from app.database import get_db
from app.models import ConversationSession
from app.services import conversation_service, deepgram_service, groq_service

router = APIRouter(prefix="/api", tags=["copilot"])


class SuggestBody(BaseModel):
    transcript: str = Field(..., min_length=1, max_length=200_000)
    context: str | None = Field(
        None,
        max_length=20_000,
        description=(
            "User's situation, goals (e.g. salary target), tone, and what kind of suggested "
            "replies they want; steers the LLM while the transcript supplies facts."
        ),
    )
    session_id: str | None = Field(
        None,
        max_length=64,
        description="Server-side session id to load full stored transcript and briefing.",
    )


class SuggestResponse(BaseModel):
    suggestion: str


class AnswerBody(BaseModel):
    question: str = Field(..., min_length=1, max_length=16_000)
    session_id: str | None = Field(
        None,
        max_length=64,
        description="If set, optional meeting transcript and stored briefing are included when relevant.",
    )
    context: str | None = Field(
        None,
        max_length=20_000,
        description="Meeting briefing from the client; overrides stored briefing when non-empty.",
    )


class AnswerResponse(BaseModel):
    answer: str


@router.post("/transcribe", response_model=dict)
async def transcribe(
    file: UploadFile = File(...),
    session_id: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not file.filename:
        raise HTTPException(400, "Missing filename")
    raw = await file.read()
    if len(raw) > 24 * 1024 * 1024:
        raise HTTPException(413, "Audio file too large (max ~24MB)")
    try:
        text, utterances, duration_sec = await run_in_threadpool(
            deepgram_service.transcribe_diarized_sync,
            raw,
            content_type=file.content_type,
        )
    except ValueError as e:
        raise HTTPException(503, str(e)) from e
    except DeepgramApiError as e:
        raise HTTPException(502, f"Transcription failed: {e}") from e
    except Exception as e:
        raise HTTPException(502, f"Transcription failed: {e!s}") from e

    # Log audio duration (ms) in total_tokens for rough volume tracking vs Groq token rows.
    audio_ms = max(1, int(round(duration_sec * 1000))) if duration_sec > 0 else max(1, len(text) // 4)
    await groq_service.log_usage(
        db,
        endpoint="transcribe",
        model=settings.deepgram_model,
        input_tokens=0,
        output_tokens=0,
        total_tokens=audio_ms,
    )

    if session_id and session_id.strip():
        sid = session_id.strip()[:64]
        lines: list[str] = []
        if utterances:
            for u in utterances:
                t = (u.get("transcript") or "").strip()
                if t:
                    lines.append(f"Speaker {u.get('speaker', 0)}: {t}")
        elif text.strip():
            lines.append(text.strip())
        if lines:
            chunk = "\n".join(lines)
            await conversation_service.append_transcript_segment(db, sid, chunk)

    return {
        "text": text,
        "utterances": utterances,
        "duration_sec": duration_sec,
    }


@router.post("/suggest", response_model=SuggestResponse)
async def suggest(body: SuggestBody, db: AsyncSession = Depends(get_db)) -> SuggestResponse:
    sid = (body.session_id or "").strip()[:64] or None
    ctx_for_llm = (body.context or "").strip()
    if not ctx_for_llm and sid:
        row = await db.get(ConversationSession, sid)
        if row and row.briefing:
            ctx_for_llm = row.briefing.strip()
    if sid:
        await conversation_service.save_briefing(db, sid, body.context)

    try:
        merged = await conversation_service.transcript_for_llm(
            db, sid, body.transcript, max_chars=14000
        )
        suggestion, usage = await run_in_threadpool(
            groq_service.suggest_reply_sync,
            merged,
            ctx_for_llm or None,
        )
    except ValueError as e:
        raise HTTPException(503, str(e)) from e
    except Exception as e:
        raise HTTPException(502, f"LLM failed: {e!s}") from e

    await groq_service.log_usage(
        db,
        endpoint="suggest",
        model=settings.chat_model,
        input_tokens=usage.get("prompt_tokens", 0),
        output_tokens=usage.get("completion_tokens", 0),
        total_tokens=usage.get("total_tokens", 0),
    )
    return SuggestResponse(suggestion=suggestion)


@router.post("/answer", response_model=AnswerResponse)
async def answer_question(body: AnswerBody, db: AsyncSession = Depends(get_db)) -> AnswerResponse:
    sid = (body.session_id or "").strip()[:64] or None
    ctx_for_llm = (body.context or "").strip()
    if not ctx_for_llm and sid:
        row = await db.get(ConversationSession, sid)
        if row and row.briefing:
            ctx_for_llm = row.briefing.strip()

    meeting_excerpt: str | None = None
    if sid:
        row = await db.get(ConversationSession, sid)
        if row and row.transcript.strip():
            meeting_excerpt = row.transcript.strip()[-14000:]

    try:
        ans, usage = await run_in_threadpool(
            groq_service.answer_standalone_question_sync,
            body.question,
            meeting_excerpt,
            ctx_for_llm or None,
        )
    except ValueError as e:
        raise HTTPException(503, str(e)) from e
    except Exception as e:
        raise HTTPException(502, f"LLM failed: {e!s}") from e

    await groq_service.log_usage(
        db,
        endpoint="answer",
        model=settings.chat_model,
        input_tokens=usage.get("prompt_tokens", 0),
        output_tokens=usage.get("completion_tokens", 0),
        total_tokens=usage.get("total_tokens", 0),
    )
    return AnswerResponse(answer=ans)
