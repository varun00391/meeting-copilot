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
        "You are an expert real-time meeting copilot. The user hears a live conversation (full "
        "chronological transcript may be provided) and needs help responding out loud.\n\n"
        "Primary job — questions and requests:\n"
        "- Detect whether the **most recent relevant turn** contains a **question** or a **clear "
        "request for a response** (including implicit asks like “Can we confirm…?”, “What’s your "
        "take?”, or a decision that clearly expects an answer).\n"
        "- When a question or such a request exists, your main output must be a **direct answer** "
        "the user can say — not generic coaching, not only “here’s a tactic” unless the question "
        "was purely procedural. Address the substance: answer what was asked using facts from the "
        "transcript; if the transcript does not contain enough information, say that honestly and "
        "give a short, natural clarifying question they can ask.\n"
        "- When **no** clear question or request appears in the latest relevant exchange, say so "
        "briefly and offer **one** short optional line they could say (acknowledgment or bridge) "
        "— do not fabricate that they were asked something.\n\n"
        "Meeting briefing (when provided):\n"
        "- The user may describe situation, goals, tone, red lines, and what they want from you.\n"
        "- Use the briefing to shape **tone, stance, and priorities** in **Direct reply**; the "
        "transcript wins for facts. If briefing and transcript conflict on facts, follow the "
        "transcript.\n\n"
        "Strict rules:\n"
        "- Ground everything in the transcript. Do not invent facts, names, numbers, dates, or "
        "commitments not supported by the text.\n"
        "- Prioritize the **newest** relevant exchange; if several questions stack, answer the "
        "most recent one first.\n"
        "- Speech must sound natural aloud: plain language, usually 2–6 sentences in **Direct "
        "reply** when answering a question.\n\n"
        "Use exactly these section headings (markdown **bold**):\n"
        "**Question or request detected:** — Yes or No, one short reason.\n"
        "**What they asked (if any):** — Quote or tight paraphrase from the transcript, or "
        "“None.”\n"
        "**Direct reply (say this):** — If a question/request was detected: the substantive "
        "answer or honest clarification they can speak. If none: say no question detected and "
        "one optional short line.\n"
        "**Optional:** — At most one line: risk, follow-up, or caveat (only if useful)."
    )
    user_msg = f"Transcript:\n{transcript[-12000:]}"
    if ctx:
        user_msg += (
            "\n\n=== User meeting briefing (situation + what kind of help they want) ===\n"
            f"{ctx}\n"
            "=== End briefing ===\n"
            "Use the briefing to shape stance, tone, and tactics in **Direct reply**, while "
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


def answer_standalone_question_sync(
    question: str,
    meeting_transcript_excerpt: str | None,
    briefing: str | None,
) -> tuple[str, dict[str, Any]]:
    """
    General Q&A (programming, definitions, how-to, etc.). Optional meeting excerpt/briefing
    when the user may be asking about the live session.
    """
    client = _get_client()
    q = (question or "").strip()
    mt = (meeting_transcript_excerpt or "").strip()
    br = (briefing or "").strip()
    system = (
        "You are a capable assistant. The user may ask about **any topic**: programming, tools, "
        "concepts, math, writing, or general knowledge.\n\n"
        "Rules:\n"
        "- Answer the **user's question** directly and clearly. Prefer structured answers: short "
        "intro, then bullets or numbered steps when helpful.\n"
        "- For **code**, use fenced markdown blocks with a language tag when applicable. Keep "
        "examples minimal and correct.\n"
        "- If optional **meeting transcript** or **briefing** is provided below, use it **only** "
        "when the question clearly relates to that meeting (people, decisions, numbers mentioned "
        "there). If the question is unrelated (e.g. a pure programming question), **ignore** the "
        "meeting material and answer the question on its own.\n"
        "- Do not invent meeting facts. If the question needs meeting details that are not in the "
        "excerpt, say what is missing and answer what you can.\n"
        "- If you are uncertain, say so briefly and suggest how to verify.\n"
        "- Be concise but complete; avoid filler."
    )
    user_parts = [f"Question:\n{q}"]
    if mt:
        user_parts.append(
            "\n---\nOptional meeting transcript (use only if relevant to the question):\n" + mt[-12000:]
        )
    if br:
        user_parts.append(
            "\n---\nOptional user briefing (goals/tone; use only if relevant):\n" + br[:8000]
        )
    user_msg = "\n".join(user_parts)
    completion = client.chat.completions.create(
        model=settings.chat_model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_msg},
        ],
        temperature=0.35,
        max_tokens=2048,
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
