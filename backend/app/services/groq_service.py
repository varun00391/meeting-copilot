from typing import Any

from groq import Groq
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import UsageEvent


def _get_client() -> Groq:
    if not settings.groq_api_key:
        raise ValueError("GROQ_API_KEY is not set")
    return Groq(api_key=settings.groq_api_key)


async def log_usage(
    db: AsyncSession,
    *,
    endpoint: str,
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    total_tokens: int = 0,
) -> None:
    if total_tokens == 0 and (input_tokens or output_tokens):
        total_tokens = input_tokens + output_tokens
    event = UsageEvent(
        endpoint=endpoint,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens or (input_tokens + output_tokens),
    )
    db.add(event)
    await db.commit()


def suggest_reply_sync(transcript: str, extra_context: str | None) -> tuple[str, dict[str, Any]]:
    client = _get_client()
    ctx = (extra_context or "").strip()
    system = (
        "You are an expert real-time meeting copilot. The user hears a live conversation and needs "
        "accurate, relevant help responding out loud.\n\n"
        "Meeting briefing (when provided):\n"
        "- The user may paste a block describing their situation (who they are meeting, topic, "
        "stakes), concrete goals or numbers (e.g. salary target), red lines, and what they want "
        "from you: tone (confident, diplomatic), type of help (phrases to say, how to counter, "
        "questions to ask), or pitfalls to avoid.\n"
        "- Treat that briefing as mandatory steering for **Suggested reply**: align vocabulary, "
        "stance, and tactics with it. Example: HR joiner discussion with a 30 LPA goal → help them "
        "discuss comp professionally, anchor near their target when the transcript opens that "
        "topic, without claiming the other side said things they did not.\n"
        "- If the briefing conflicts with the transcript, the transcript wins for facts; use the "
        "briefing for intent, tone, and what to optimize for.\n\n"
        "Strict rules:\n"
        "- Ground everything in the transcript. Do not invent facts, names, numbers, dates, or "
        "commitments that are not clearly supported by the text.\n"
        "- Prioritize the most recent lines: explicit questions, requests, objections, or "
        "decisions that need input. If multiple threads exist, address the newest one first.\n"
        "- If the latest content is small talk, unclear, or needs clarification, say so in one "
        "short sentence and give a neutral, honest follow-up question—not a made-up answer.\n"
        "- Suggested speech must sound natural when read aloud: plain language, 2–5 sentences "
        "for the reply block unless a shorter acknowledgment is clearly enough.\n\n"
        "Use exactly these section headings (markdown **bold**):\n"
        "**Latest turn (facts):** — 1–2 sentences, only what the transcript shows about the last "
        "relevant exchange.\n"
        "**What they need from you:** — one precise sentence.\n"
        "**Suggested reply (say this):** — what the user can speak verbatim or paraphrase; "
        "directly serve their stated goals and expected style from the briefing when present."
    )
    user_msg = f"Transcript:\n{transcript[-12000:]}"
    if ctx:
        user_msg += (
            "\n\n=== User meeting briefing (situation + what kind of help they want) ===\n"
            f"{ctx}\n"
            "=== End briefing ===\n"
            "Use the briefing to shape stance, tone, and tactics in **Suggested reply**, while "
            "keeping claims tied to the transcript."
        )
    completion = client.chat.completions.create(
        model=settings.chat_model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_msg},
        ],
        temperature=0.25,
        max_tokens=1024,
    )
    content = completion.choices[0].message.content or ""
    usage_obj = completion.usage
    usage = {}
    if usage_obj:
        usage = {
            "prompt_tokens": usage_obj.prompt_tokens or 0,
            "completion_tokens": usage_obj.completion_tokens or 0,
            "total_tokens": usage_obj.total_tokens or 0,
        }
    return content.strip(), usage
