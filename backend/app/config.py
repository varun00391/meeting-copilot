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
    chat_model: str = "meta-llama/llama-4-scout-17b-16e-instruct"


settings = Settings()
