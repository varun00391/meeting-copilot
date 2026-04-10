from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    groq_api_key: str = ""
    deepgram_api_key: str = ""
    database_url: str = "sqlite+aiosqlite:///./data/usage.db"
    cors_origins: str = (
        "http://localhost:5173,http://localhost:3000,http://localhost,http://localhost:8080"
    )
    deepgram_model: str = "nova-3"
    # Optional: e.g. "2023-07-06.0" — see Deepgram diarization docs; empty = API default
    deepgram_diarize_version: str = ""
    # Optional BCP-47 tag, e.g. "en", "en-IN" — can improve diarization when set
    deepgram_language: str = ""
    # sentence-transformers model name for RAG embeddings (cached after first load)
    rag_embedding_model: str = "all-MiniLM-L6-v2"
    chat_model: str = "meta-llama/llama-4-scout-17b-16e-instruct"


settings = Settings()
