from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ConversationSession


def _utc_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def ensure_session(db: AsyncSession, session_id: str) -> ConversationSession:
    row = await db.get(ConversationSession, session_id)
    if row:
        return row
    row = ConversationSession(id=session_id, transcript="", briefing=None)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def append_transcript_segment(db: AsyncSession, session_id: str, chunk: str) -> None:
    chunk = chunk.strip()
    if not chunk:
        return
    row = await ensure_session(db, session_id)
    sep = "\n\n" if row.transcript else ""
    merged = (row.transcript + sep + chunk)[:500_000]
    row.transcript = merged
    row.updated_at = _utc_naive()
    await db.commit()


async def save_briefing(db: AsyncSession, session_id: str, briefing: str | None) -> None:
    b = (briefing or "").strip()
    row = await ensure_session(db, session_id)
    row.briefing = b or None
    row.updated_at = _utc_naive()
    await db.commit()


async def transcript_for_llm(
    db: AsyncSession,
    session_id: str | None,
    client_transcript: str,
    *,
    max_chars: int = 14000,
) -> str:
    """Prefer server-stored chronological transcript when session exists."""
    if not session_id:
        return client_transcript[-max_chars:]
    row = await db.get(ConversationSession, session_id)
    if row and row.transcript.strip():
        return row.transcript.strip()[-max_chars:]
    return client_transcript.strip()[-max_chars:]
