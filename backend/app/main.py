from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import init_db
from app.routers import copilot, rag, usage


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(
    title="Meeting Copilot API",
    description="Live meeting transcription (Deepgram) and AI reply suggestions (Groq).",
    version="1.0.0",
    lifespan=lifespan,
)

origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(copilot.router)
app.include_router(rag.router)
app.include_router(usage.router)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
