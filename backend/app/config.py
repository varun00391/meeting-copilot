from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    groq_api_key: str = ""
    database_url: str = "sqlite+aiosqlite:///./data/usage.db"
    cors_origins: str = (
        "http://localhost:5173,http://localhost:3000,http://localhost,http://localhost:8080"
    )
    whisper_model: str = "whisper-large-v3-turbo"
    chat_model: str = "llama-3.3-70b-versatile"


settings = Settings()
