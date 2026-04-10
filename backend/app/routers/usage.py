from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from fastapi import APIRouter, Depends, HTTPException, Query

from app.database import get_db
from app.models import UsageEvent

router = APIRouter(prefix="/api/usage", tags=["usage"])

WINDOW_MINUTES: dict[str, int] = {
    "30m": 30,
    "1h": 60,
    "6h": 6 * 60,
    "12h": 12 * 60,
    "1d": 24 * 60,
    "1w": 7 * 24 * 60,
}

WINDOW_LABELS: dict[str, str] = {
    "30m": "Last 30 minutes",
    "1h": "Last 1 hour",
    "6h": "Last 6 hours",
    "12h": "Last 12 hours",
    "1d": "Last 24 hours",
    "1w": "Last 7 days",
}


class ModelEndpointRow(BaseModel):
    model: str
    endpoint: str
    requests: int
    input_tokens: int
    output_tokens: int
    total_tokens: int = Field(
        ...,
        description="Per DB row: Groq suggest ≈ provider total; transcribe = audio duration ms.",
    )


class LlmTotals(BaseModel):
    requests: int
    input_tokens: int
    output_tokens: int
    combined_tokens: int = Field(..., description="input + output (suggest endpoint only).")


class TranscriptionTotals(BaseModel):
    requests: int
    audio_ms: int = Field(..., description="Sum of total_tokens on transcribe rows = audio ms.")
    audio_minutes: float


class UsageReportResponse(BaseModel):
    window: str
    window_label: str
    window_start_utc: str
    window_end_utc: str
    explanation: list[str]
    llm: LlmTotals
    transcription: TranscriptionTotals
    total_requests: int
    by_model: list[ModelEndpointRow]


# --- Rolling-window report (primary UI) ---


@router.get("/report", response_model=UsageReportResponse)
async def usage_report(
    window: str = Query(
        "1d",
        description="One of: 30m, 1h, 6h, 12h, 1d, 1w",
    ),
    db: AsyncSession = Depends(get_db),
) -> UsageReportResponse:
    w = window.strip().lower()
    if w not in WINDOW_MINUTES:
        raise HTTPException(
            400,
            f"Invalid window. Use one of: {', '.join(sorted(WINDOW_MINUTES))}",
        )

    minutes = WINDOW_MINUTES[w]
    end_dt = datetime.now(timezone.utc).replace(tzinfo=None)
    start_dt = end_dt - timedelta(minutes=minutes)

    stmt = (
        select(
            UsageEvent.model,
            UsageEvent.endpoint,
            func.count(UsageEvent.id).label("reqs"),
            func.coalesce(func.sum(UsageEvent.input_tokens), 0).label("in_tok"),
            func.coalesce(func.sum(UsageEvent.output_tokens), 0).label("out_tok"),
            func.coalesce(func.sum(UsageEvent.total_tokens), 0).label("tot_tok"),
        )
        .where(UsageEvent.created_at >= start_dt)
        .where(UsageEvent.created_at <= end_dt)
        .group_by(UsageEvent.model, UsageEvent.endpoint)
        .order_by(UsageEvent.endpoint, UsageEvent.model)
    )
    result = await db.execute(stmt)
    rows = result.all()

    by_model: list[ModelEndpointRow] = []
    llm_in = llm_out = llm_req = 0
    tr_ms = tr_req = 0

    for r in rows:
        endpoint = str(r.endpoint)
        reqs = int(r.reqs)
        in_t = int(r.in_tok)
        out_t = int(r.out_tok)
        tot = int(r.tot_tok)
        by_model.append(
            ModelEndpointRow(
                model=str(r.model),
                endpoint=endpoint,
                requests=reqs,
                input_tokens=in_t,
                output_tokens=out_t,
                total_tokens=tot,
            )
        )
        if endpoint in ("suggest", "answer"):
            llm_req += reqs
            llm_in += in_t
            llm_out += out_t
        elif endpoint == "transcribe":
            tr_req += reqs
            tr_ms += tot

    total_requests = sum(m.requests for m in by_model)

    explanation = [
        "Numbers do not add across “input + output = total” because different event types store different meanings.",
        "Suggestions (Groq chat): input_tokens and output_tokens are real LLM usage; combined_tokens is their sum. The provider’s total_tokens is usually the same as that sum.",
        "Transcription (e.g. Deepgram): input and output are stored as 0; total_tokens holds estimated audio duration in milliseconds for volume tracking—not LLM tokens.",
        "So the old “total tokens” column mixed LLM totals with audio milliseconds. This page splits LLM vs transcription explicitly.",
    ]

    return UsageReportResponse(
        window=w,
        window_label=WINDOW_LABELS[w],
        window_start_utc=start_dt.isoformat() + "Z",
        window_end_utc=end_dt.isoformat() + "Z",
        explanation=explanation,
        llm=LlmTotals(
            requests=llm_req,
            input_tokens=llm_in,
            output_tokens=llm_out,
            combined_tokens=llm_in + llm_out,
        ),
        transcription=TranscriptionTotals(
            requests=tr_req,
            audio_ms=tr_ms,
            audio_minutes=round(tr_ms / 60_000.0, 2),
        ),
        total_requests=total_requests,
        by_model=by_model,
    )


# --- Legacy day-range summary (optional / API consumers) ---


class DailyRow(BaseModel):
    day: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    requests: int


class UsageSummaryResponse(BaseModel):
    start: str
    end: str
    daily: list[DailyRow]
    totals: dict[str, int]


def _parse_day(s: str):
    return datetime.strptime(s, "%Y-%m-%d").date()


@router.get("/summary", response_model=UsageSummaryResponse)
async def usage_summary(
    start: str = Query(..., description="Start date YYYY-MM-DD (UTC)"),
    end: str = Query(..., description="End date YYYY-MM-DD (UTC)"),
    db: AsyncSession = Depends(get_db),
) -> UsageSummaryResponse:
    d0 = _parse_day(start)
    d1 = _parse_day(end)
    if d1 < d0:
        d0, d1 = d1, d0
    start_dt = datetime(d0.year, d0.month, d0.day, tzinfo=timezone.utc)
    end_dt = datetime(d1.year, d1.month, d1.day, tzinfo=timezone.utc) + timedelta(days=1)

    day_col = func.date(UsageEvent.created_at)

    stmt = (
        select(
            day_col.label("day"),
            func.coalesce(func.sum(UsageEvent.input_tokens), 0).label("in_tok"),
            func.coalesce(func.sum(UsageEvent.output_tokens), 0).label("out_tok"),
            func.coalesce(func.sum(UsageEvent.total_tokens), 0).label("tot_tok"),
            func.count(UsageEvent.id).label("reqs"),
        )
        .where(UsageEvent.created_at >= start_dt.replace(tzinfo=None))
        .where(UsageEvent.created_at < end_dt.replace(tzinfo=None))
        .group_by(day_col)
        .order_by(day_col)
    )
    result = await db.execute(stmt)
    rows = result.all()

    daily_map: dict[str, DailyRow] = {}
    for r in rows:
        day_str = str(r.day)
        daily_map[day_str] = DailyRow(
            day=day_str,
            input_tokens=int(r.in_tok),
            output_tokens=int(r.out_tok),
            total_tokens=int(r.tot_tok),
            requests=int(r.reqs),
        )

    daily: list[DailyRow] = []
    cur = d0
    while cur <= d1:
        key = cur.isoformat()
        daily.append(
            daily_map.get(key)
            or DailyRow(day=key, input_tokens=0, output_tokens=0, total_tokens=0, requests=0)
        )
        cur += timedelta(days=1)

    tot_in = sum(d.input_tokens for d in daily)
    tot_out = sum(d.output_tokens for d in daily)
    tot_all = sum(d.total_tokens for d in daily)
    tot_req = sum(d.requests for d in daily)

    return UsageSummaryResponse(
        start=d0.isoformat(),
        end=d1.isoformat(),
        daily=daily,
        totals={
            "input_tokens": tot_in,
            "output_tokens": tot_out,
            "total_tokens": tot_all,
            "requests": tot_req,
        },
    )
