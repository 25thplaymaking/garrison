"""Unified LLM gateway — the single async entry point for every model call.

One place for provider dispatch, retries, timeouts, JSON-mode handling and
usage telemetry. Callers keep their own
budgets, feature gates, and fallback behavior — the gateway only raises
LLMError / LLMNotConfigured and lets the call site decide how to degrade.
The one shared budget is ``enforce_account_llm_budget``: user-triggered
generation routes call it before ``complete`` so one account cannot run up
unbounded paid calls by clicking "generate".

Provider is dispatched from the model name:
  "claude-*"  -> Anthropic Messages API (ANTHROPIC_API_KEY)
  anything else -> OpenAI chat completions (OPENAI_API_KEY)

Every AI feature is optional: with no key set the call sites degrade cleanly.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

logger = logging.getLogger("llm")

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"

# Capability tiers. Per-feature env vars (RADIO_CHATTER_MODEL, etc.) still
# win — call sites pass them via model= — but new code can just name a tier.
TIER_MODELS = {
    "fast": os.environ.get("LLM_MODEL_FAST", "gpt-4o-mini"),
    "standard": os.environ.get("LLM_MODEL_STANDARD", "gpt-4o"),
}

DEFAULT_TIMEOUT_SECONDS = 45.0
DEFAULT_RETRIES = 2  # extra attempts after the first, on retryable failures
RETRY_BASE_DELAY = 0.75
_RETRYABLE_STATUS = {408, 429, 500, 502, 503, 529}

# Anthropic requires max_tokens; used when the caller doesn't set one. Current
# Claude models think before answering and that thinking counts against
# max_tokens, so a small cap would cut the answer off: callers' caps are raised
# to at least the floor (only tokens actually produced are billed).
_ANTHROPIC_DEFAULT_MAX_TOKENS = 16000
_ANTHROPIC_MIN_MAX_TOKENS = 8000
# Thinking makes Claude calls slower than the OpenAI ones this gateway was tuned for.
_ANTHROPIC_MIN_TIMEOUT_SECONDS = 120.0
# Server-side refusal fallback (Opus / Sonnet; Haiku has none): a declined
# request is re-run on a model chosen by refusal category within the same call.
_ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01"


def _anthropic_has_fallback(model: str) -> bool:
    return model.startswith(("claude-opus", "claude-sonnet", "claude-fable"))


class LLMError(Exception):
    """A model call failed after retries. `status_code` is the upstream HTTP
    status when one exists (None for transport errors/timeouts)."""

    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


class LLMNotConfigured(LLMError):
    """No API key configured for the resolved provider."""


@dataclass
class LLMResult:
    text: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    latency_ms: int = 0

    def json(self) -> Any:
        """Parse the response as JSON, tolerating markdown code fences."""
        return parse_json_response(self.text)


def parse_json_response(text: str) -> Any:
    """json.loads with the fence-stripping the old call sites hand-rolled."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    return json.loads(cleaned)


# ── In-process usage telemetry ────────────────────────────────────────────────
# Lightweight counters for cost visibility; reset on restart. Deliberately not
# persisted — per-feature daily budgets stay at the call sites.
_usage: Dict[str, Dict[str, int]] = {}


def _record_usage(model: str, input_tokens: int, output_tokens: int) -> None:
    stats = _usage.setdefault(model, {"calls": 0, "input_tokens": 0, "output_tokens": 0})
    stats["calls"] += 1
    stats["input_tokens"] += input_tokens
    stats["output_tokens"] += output_tokens


def usage_stats() -> Dict[str, Dict[str, int]]:
    """Per-model call/token counters since process start."""
    return {model: dict(stats) for model, stats in _usage.items()}


# ── Per-account budget for staff-triggered generations ───────────────────────
# Background features keep their own daily ceilings (RADIO_CHATTER_MAX_DAILY_AI_CALLS
# etc.). Routes where a person asks for a generation call this first: each
# feature has its own per-account hourly limit, and every call also draws on
# one shared hourly allowance per account (config.LLM_ACCOUNT_HOURLY_BUDGET), so
# spreading clicks across features cannot multiply the spend. It reuses the
# in-process sliding window in middleware.ip_rate_limiter: a brake on abuse and
# runaway clicking, not a billing ledger (with two uvicorn workers the effective
# ceiling is up to twice the configured one, and a restart resets it).
LLM_ACCOUNT_BUDGET_BUCKET = "llm_account_hourly"
_BUDGET_WINDOW_SECONDS = 3600


def enforce_account_llm_budget(
    user: Optional[Dict[str, Any]],
    feature: str,
    *,
    feature_limit: int,
    action_label: str,
    request: Any = None,
) -> None:
    """Charge one paid generation to ``user``; raise HTTP 429 when over budget.

    ``feature`` names the per-feature bucket and ``feature_limit`` is its
    per-account hourly cap. The per-feature check runs first, so requests a
    feature rejects do not use up the shared allowance. An account without an
    id is charged to one shared ``unknown`` key rather than going unlimited.
    """
    from config import LLM_ACCOUNT_HOURLY_BUDGET
    from middleware.ip_rate_limiter import check_account_rate_limit

    account = str((user or {}).get("id") or "").strip() or "unknown"
    check_account_rate_limit(
        f"llm_{feature}", account, feature_limit, _BUDGET_WINDOW_SECONDS,
        request=request, action_label=action_label,
    )
    check_account_rate_limit(
        LLM_ACCOUNT_BUDGET_BUCKET, account, LLM_ACCOUNT_HOURLY_BUDGET, _BUDGET_WINDOW_SECONDS,
        request=request, action_label="AI generation requests",
    )


# ── Provider request builders ─────────────────────────────────────────────────

def _resolve_model(model: Optional[str], tier: str) -> str:
    if model:
        return model
    try:
        return TIER_MODELS[tier]
    except KeyError:
        raise LLMError(f"Unknown LLM tier '{tier}' (expected one of {sorted(TIER_MODELS)})")


def _is_anthropic(model: str) -> bool:
    return model.startswith("claude")


def _openai_payload(model, messages, json_mode, temperature, max_tokens, stream=False):
    payload: Dict[str, Any] = {"model": model, "messages": messages}
    if temperature is not None:
        payload["temperature"] = temperature
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    if stream:
        payload["stream"] = True
    return payload


def _anthropic_payload(model, messages, json_mode, max_tokens, stream=False):
    # Anthropic takes the system prompt as a top-level field, requires
    # max_tokens, and current Claude models reject sampling parameters —
    # temperature is deliberately not forwarded.
    system_parts = [m["content"] for m in messages if m.get("role") == "system"]
    chat = [m for m in messages if m.get("role") != "system"]
    if json_mode:
        system_parts.append(
            "Respond with a single valid JSON object and nothing else — "
            "no prose, no markdown code fences."
        )
    payload: Dict[str, Any] = {
        "model": model,
        "max_tokens": max(max_tokens or _ANTHROPIC_DEFAULT_MAX_TOKENS, _ANTHROPIC_MIN_MAX_TOKENS),
        "messages": chat,
    }
    if _anthropic_has_fallback(model):
        payload["fallbacks"] = "default"
    if system_parts:
        payload["system"] = "\n\n".join(system_parts)
    if stream:
        payload["stream"] = True
    return payload


def _provider_request(model, messages, json_mode, temperature, max_tokens, stream=False):
    """Return (url, headers, payload) for the resolved provider."""
    if _is_anthropic(model):
        if not ANTHROPIC_API_KEY:
            raise LLMNotConfigured("ANTHROPIC_API_KEY not configured")
        headers = {
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        }
        if _anthropic_has_fallback(model):
            headers["anthropic-beta"] = _ANTHROPIC_FALLBACK_BETA
        return ANTHROPIC_MESSAGES_URL, headers, _anthropic_payload(
            model, messages, json_mode, max_tokens, stream
        )
    if not OPENAI_API_KEY:
        raise LLMNotConfigured("OPENAI_API_KEY not configured")
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "content-type": "application/json",
    }
    return OPENAI_CHAT_URL, headers, _openai_payload(
        model, messages, json_mode, temperature, max_tokens, stream
    )


def _parse_response(model: str, data: Dict[str, Any], latency_ms: int) -> LLMResult:
    if _is_anthropic(model):
        if data.get("stop_reason") == "refusal":
            raise LLMError(f"Model {model} refused the request", status_code=200)
        text = "".join(
            block.get("text", "") for block in data.get("content", [])
            if block.get("type") == "text"
        )
        usage = data.get("usage", {})
        input_tokens = usage.get("input_tokens", 0)
        output_tokens = usage.get("output_tokens", 0)
    else:
        try:
            text = data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            raise LLMError(f"Malformed response from {model}")
        usage = data.get("usage", {})
        input_tokens = usage.get("prompt_tokens", 0)
        output_tokens = usage.get("completion_tokens", 0)
    return LLMResult(
        text=text,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        latency_ms=latency_ms,
    )


# ── Public API ────────────────────────────────────────────────────────────────

async def complete(
    messages: List[Dict[str, str]],
    *,
    model: Optional[str] = None,
    tier: str = "fast",
    json_mode: bool = False,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    timeout: Optional[float] = None,
    retries: int = DEFAULT_RETRIES,
) -> LLMResult:
    """One-shot completion. Raises LLMNotConfigured / LLMError; never returns
    a partial result. Callers keep their existing fallback behavior by
    catching LLMError."""
    resolved = _resolve_model(model, tier)
    url, headers, payload = _provider_request(
        resolved, messages, json_mode, temperature, max_tokens
    )
    timeout = timeout or DEFAULT_TIMEOUT_SECONDS
    if _is_anthropic(resolved):
        timeout = max(timeout, _ANTHROPIC_MIN_TIMEOUT_SECONDS)

    last_error: Optional[LLMError] = None
    for attempt in range(retries + 1):
        if attempt:
            await asyncio.sleep(RETRY_BASE_DELAY * (2 ** (attempt - 1)))
        started = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(url, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            last_error = LLMError(f"{resolved}: transport error: {exc}")
            logger.warning("llm transport error (attempt %d/%d): %s", attempt + 1, retries + 1, exc)
            continue

        latency_ms = int((time.monotonic() - started) * 1000)
        if response.status_code != 200:
            body = response.text[:300]
            last_error = LLMError(
                f"{resolved}: HTTP {response.status_code}: {body}",
                status_code=response.status_code,
            )
            if response.status_code in _RETRYABLE_STATUS:
                logger.warning(
                    "llm retryable failure %s (attempt %d/%d): %s",
                    response.status_code, attempt + 1, retries + 1, body,
                )
                continue
            raise last_error

        result = _parse_response(resolved, response.json(), latency_ms)
        _record_usage(resolved, result.input_tokens, result.output_tokens)
        logger.info(
            "llm call model=%s latency_ms=%d in_tokens=%d out_tokens=%d json_mode=%s",
            resolved, latency_ms, result.input_tokens, result.output_tokens, json_mode,
        )
        return result

    raise last_error or LLMError(f"{resolved}: exhausted retries")


async def stream(
    messages: List[Dict[str, str]],
    *,
    model: Optional[str] = None,
    tier: str = "fast",
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    timeout: Optional[float] = None,
) -> AsyncIterator[str]:
    """Stream text deltas. No automatic retry — a stream that dies mid-flight
    can't be transparently resumed; callers own their fallback lines."""
    resolved = _resolve_model(model, tier)
    url, headers, payload = _provider_request(
        resolved, messages, False, temperature, max_tokens, stream=True
    )
    timeout = timeout or DEFAULT_TIMEOUT_SECONDS
    if _is_anthropic(resolved):
        timeout = max(timeout, _ANTHROPIC_MIN_TIMEOUT_SECONDS)

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as response:
            if response.status_code != 200:
                body = (await response.aread())[:300]
                raise LLMError(
                    f"{resolved}: HTTP {response.status_code}: {body!r}",
                    status_code=response.status_code,
                )
            anthropic = _is_anthropic(resolved)
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                chunk = line[5:].strip()
                if not chunk or chunk == "[DONE]":
                    continue
                try:
                    data = json.loads(chunk)
                except json.JSONDecodeError:
                    continue
                if anthropic:
                    if data.get("type") == "content_block_delta":
                        delta = data.get("delta", {})
                        if delta.get("type") == "text_delta" and delta.get("text"):
                            yield delta["text"]
                else:
                    try:
                        delta = data["choices"][0]["delta"].get("content")
                    except (KeyError, IndexError, TypeError):
                        continue
                    if delta:
                        yield delta
