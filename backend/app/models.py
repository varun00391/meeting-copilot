from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def _utc_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class UsageEvent(Base):
    __tablename__ = "usage_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_naive)
    endpoint: Mapped[str] = mapped_column(String(64), index=True)
    model: Mapped[str] = mapped_column(String(128))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)


class ConversationSession(Base):
    """Server-side rolling transcript for a copilot session (chronological text)."""

    __tablename__ = "conversation_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_naive)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_naive, onupdate=_utc_naive)
    transcript: Mapped[str] = mapped_column(Text, default="")
    briefing: Mapped[str | None] = mapped_column(Text, nullable=True)


class RagDocument(Base):
    """Uploaded PDF/DOCX for optional RAG; embeddings stored in RagChunk."""

    __tablename__ = "rag_documents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utc_naive)
    filename: Mapped[str] = mapped_column(String(512))
    mime: Mapped[str] = mapped_column(String(128))
    # Comma-separated topics (e.g. "security, data leakage") for filtering in auto mode
    topic_tags: Mapped[str | None] = mapped_column(Text, nullable=True)

    chunks: Mapped[list["RagChunk"]] = relationship(
        "RagChunk",
        back_populates="document",
        cascade="all, delete-orphan",
    )


class RagChunk(Base):
    __tablename__ = "rag_chunks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("rag_documents.id", ondelete="CASCADE"),
        index=True,
    )
    chunk_index: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    embedding_json: Mapped[str] = mapped_column(Text)

    document: Mapped["RagDocument"] = relationship("RagDocument", back_populates="chunks")
