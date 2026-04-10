from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.services import rag_service

router = APIRouter(prefix="/api/rag", tags=["rag"])

MAX_UPLOAD_BYTES = 15 * 1024 * 1024


@router.get("/documents")
async def list_documents(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    docs = await rag_service.list_documents(db)
    return {"documents": docs}


@router.post("/upload")
async def upload_document(
    file: UploadFile = File(...),
    topic_tags: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    if not file.filename:
        raise HTTPException(400, "Missing filename")
    raw = await file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File too large (max 15MB)")
    mime = file.content_type or "application/octet-stream"
    fn = file.filename
    if not (
        "pdf" in mime.lower()
        or fn.lower().endswith(".pdf")
        or "wordprocessingml" in mime.lower()
        or fn.lower().endswith(".docx")
    ):
        raise HTTPException(400, "Only PDF and DOCX are supported")
    try:
        doc = await rag_service.ingest_document(
            db,
            filename=fn,
            mime=mime,
            data=raw,
            topic_tags=topic_tags,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        raise HTTPException(502, f"Ingest failed: {e!s}") from e
    return {
        "id": doc.id,
        "filename": doc.filename,
        "topic_tags": doc.topic_tags,
    }


@router.delete("/documents/{doc_id}")
async def remove_document(doc_id: str, db: AsyncSession = Depends(get_db)) -> dict[str, bool]:
    ok = await rag_service.delete_document(db, doc_id)
    if not ok:
        raise HTTPException(404, "Document not found")
    return {"ok": True}
