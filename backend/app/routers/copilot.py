from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.config import settings
from app.database import get_db
from app.services import groq_service

router = APIRouter(prefix="/api", tags=["copilot"])


class SuggestBody(BaseModel):
    transcript: str = Field(..., min_length=1, max_length=200_000)
    context: str | None = Field(None, max_length=20_000)


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
        text, usage = await run_in_threadpool(
            groq_service.transcribe_audio_sync, raw, file.filename
        )
    except ValueError as e:
        raise HTTPException(503, str(e)) from e
    except Exception as e:
        raise HTTPException(502, f"Transcription failed: {e!s}") from e

    pt = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
    ct = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
    tt = int(usage.get("total_tokens") or pt + ct)
    if tt == 0 and text:
        tt = max(1, len(text) // 4)
        pt = tt
    await groq_service.log_usage(
        db,
        endpoint="transcribe",
        model=settings.whisper_model,
        input_tokens=pt,
        output_tokens=ct,
        total_tokens=tt,
    )
    return {"text": text}


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
