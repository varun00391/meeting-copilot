from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool
from deepgram import DeepgramApiError

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.config import settings
from app.database import get_db
from app.services import deepgram_service, groq_service

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


class SuggestResponse(BaseModel):
    suggestion: str


@router.post("/transcribe", response_model=dict)
async def transcribe(
    file: UploadFile = File(...),
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
    return {
        "text": text,
        "utterances": utterances,
        "duration_sec": duration_sec,
    }


@router.post("/suggest", response_model=SuggestResponse)
async def suggest(body: SuggestBody, db: AsyncSession = Depends(get_db)) -> SuggestResponse:
    try:
        suggestion, usage = await run_in_threadpool(
            groq_service.suggest_reply_sync, body.transcript, body.context
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
