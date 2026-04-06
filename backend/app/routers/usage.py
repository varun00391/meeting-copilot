from datetime import date, datetime, timedelta, timezone

from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from fastapi import APIRouter, Depends, Query

from app.database import get_db
from app.models import UsageEvent

router = APIRouter(prefix="/api/usage", tags=["usage"])


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


def _parse_day(s: str) -> date:
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

    # Fill missing days with zeros
    daily: list[DailyRow] = []
    cur = d0
    while cur <= d1:
        key = cur.isoformat()
        daily.append(daily_map.get(key) or DailyRow(day=key, input_tokens=0, output_tokens=0, total_tokens=0, requests=0))
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
