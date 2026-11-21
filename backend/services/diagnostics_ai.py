"""AI-powered auto-triage service for log error types.

Periodically (or on demand) fetches error types that have not been reviewed and
passes them through OpenAI for automatic classification.  Results are stored
directly on the ``log_error_types`` documents so that the Diagnostics dashboard
can surface AI recommendations without manual intervention.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List

from config import DIAGNOSTICS_AI_MODEL, DIAGNOSTICS_TRIAGE_INTERVAL
from database import db
from services.llm_gateway import LLMError, complete

logger = logging.getLogger(__name__)

_OPENAI_API_KEY: str = os.environ.get("OPENAI_API_KEY", "")
_DIAGNOSTICS_AI_MODEL: str = DIAGNOSTICS_AI_MODEL

# How many error types to send per OpenAI request (batched in one prompt).
_BATCH_SIZE = 10

# How often the background loop runs (seconds).
_AUTO_TRIAGE_INTERVAL = DIAGNOSTICS_TRIAGE_INTERVAL

_TRIAGE_SYSTEM_PROMPT = """\
You are an automated diagnostics triage engine for Arma Reforger dedicated \
servers.  You receive a batch of error patterns that have not yet been triaged \
by a human operator.

For EACH error pattern, evaluate the normalised message, raw example, severity, \
category, occurrence count, and any linked mod information.  Then provide a \
classification using only the allowed enum values below.

Allowed values for severity_assessment: harmless | low | moderate | high | critical
Allowed values for review_status: active | monitoring | resolved | false_positive
Allowed values for actionability: actionable | monitor | known_safe
Allowed values for attribution: unknown | mod | backend | base_game | engine | rcon | battleye | config | network | performance

Respond with **valid JSON** – an array of objects (one per input error type, in \
the same order), each with exactly these keys:
{
  "error_type_id": "<the id you were given>",
  "summary": "1 sentence plain-English explanation.",
  "severity_assessment": "<enum>",
  "suggested_review_status": "<enum>",
  "suggested_actionability": "<enum>",
  "suggested_attribution": "<enum>",
  "is_safe_to_ignore": true | false
}

Do NOT wrap the JSON in markdown fences.  Keep summaries under 120 characters.
"""


def _build_batch_prompt(error_types: List[Dict[str, Any]]) -> str:
    """Build the user prompt for a batch of error types."""
    entries: list[str] = []
    for et in error_types:
        entries.append(
            f"---\n"
            f"id: {et.get('id')}\n"
            f"label: {et.get('label', '')}\n"
            f"severity: {et.get('severity', 'unknown')}\n"
            f"category: {et.get('category', 'unknown')}\n"
            f"normalised: {(et.get('normalised_message') or '')[:300]}\n"
            f"example_raw: {(et.get('example_raw') or '')[:400]}\n"
            f"total_occurrences: {et.get('total_occurrences', 0)}\n"
            f"linked_mod: {et.get('linked_mod_name') or et.get('linked_mod_guid') or 'none'}\n"
            f"source_streams: {', '.join(et.get('source_streams', [])) or 'unknown'}\n"
        )
    return (
        f"Triage the following {len(error_types)} error patterns:\n\n"
        + "\n".join(entries)
    )


def _parse_response(raw_content: str) -> List[Dict[str, Any]]:
    """Parse the OpenAI response into a list of triage results."""
    cleaned = raw_content.strip()
    if cleaned.startswith("```"):
        first_newline = cleaned.find("\n")
        if first_newline != -1:
            cleaned = cleaned[first_newline + 1:]
        else:
            cleaned = cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()

    parsed = json.loads(cleaned)
    if isinstance(parsed, dict):
        # Sometimes the model wraps the array in a key
        for key in ("results", "error_types", "items", "triage"):
            if isinstance(parsed.get(key), list):
                parsed = parsed[key]
                break
        else:
            parsed = [parsed]
    if not isinstance(parsed, list):
        return []
    return parsed


_VALID_REVIEW = {"active", "monitoring", "resolved", "false_positive"}
_VALID_ACTION = {"actionable", "monitor", "known_safe"}
_VALID_ATTRIBUTION = {
    "unknown", "mod", "backend", "base_game", "engine",
    "rcon", "battleye", "config", "network", "performance",
}
_VALID_SEVERITY = {"harmless", "low", "moderate", "high", "critical"}


async def triage_batch(error_types: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Send a batch of error types to OpenAI and store the results.

    Returns a summary dict: ``{"triaged": int, "failed": int, "errors": [...]}``.
    """
    if not _OPENAI_API_KEY:
        return {"triaged": 0, "failed": 0, "errors": ["OPENAI_API_KEY not configured"]}
    if not error_types:
        return {"triaged": 0, "failed": 0, "errors": []}

    prompt = _build_batch_prompt(error_types)

    try:
        result = await complete(
            [
                {"role": "system", "content": _TRIAGE_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            model=_DIAGNOSTICS_AI_MODEL,
            temperature=0.2,
            max_tokens=1500,
            timeout=45,
        )
        results = _parse_response(result.text)
    except (LLMError, json.JSONDecodeError, Exception) as exc:
        logger.warning("Triage batch failed: %s", exc)
        return {"triaged": 0, "failed": len(error_types), "errors": [str(exc)]}

    # Map results by error_type_id
    result_map: Dict[str, Dict] = {}
    for r in results:
        eid = r.get("error_type_id")
        if eid:
            result_map[eid] = r

    triaged = 0
    failed = 0
    errors: list[str] = []

    for et in error_types:
        eid = et["id"]
        r = result_map.get(eid)
        if not r:
            failed += 1
            errors.append(f"No result for {eid}")
            continue

        update: Dict[str, Any] = {
            "ai_triaged_at": datetime.now(timezone.utc),
            "ai_model": _DIAGNOSTICS_AI_MODEL,
        }
        summary = r.get("summary")
        if summary and isinstance(summary, str):
            update["ai_summary"] = summary[:500]

        sev = r.get("severity_assessment")
        if sev in _VALID_SEVERITY:
            update["ai_severity_assessment"] = sev

        review = r.get("suggested_review_status")
        if review in _VALID_REVIEW:
            update["ai_suggested_review_status"] = review

        action = r.get("suggested_actionability")
        if action in _VALID_ACTION:
            update["ai_suggested_actionability"] = action

        attr = r.get("suggested_attribution")
        if attr in _VALID_ATTRIBUTION:
            update["ai_suggested_attribution"] = attr

        if isinstance(r.get("is_safe_to_ignore"), bool):
            update["ai_is_safe_to_ignore"] = r["is_safe_to_ignore"]

        try:
            await db.log_error_types.update_one(
                {"id": eid},
                {"$set": update},
            )
            triaged += 1
        except Exception as exc:
            failed += 1
            errors.append(f"DB update failed for {eid}: {exc}")

    return {"triaged": triaged, "failed": failed, "errors": errors}


async def auto_triage_uncurated(*, limit: int = 50) -> Dict[str, Any]:
    """Fetch up to *limit* uncurated error types and triage them in batches.

    An error type is considered uncurated if it has no ``reviewed_by`` value
    AND has not been AI-triaged yet.
    """
    query = {
        "$and": [
            {"$or": [{"reviewed_by": ""}, {"reviewed_by": {"$exists": False}}]},
            {"ai_triaged_at": {"$exists": False}},
        ]
    }
    cursor = (
        db.log_error_types.find(query, {"_id": 0})
        .sort("total_occurrences", -1)
        .limit(limit)
    )
    error_types = await cursor.to_list(limit)

    if not error_types:
        return {"triaged": 0, "failed": 0, "batches": 0, "errors": []}

    total_triaged = 0
    total_failed = 0
    all_errors: list[str] = []
    batches = 0

    for i in range(0, len(error_types), _BATCH_SIZE):
        batch = error_types[i : i + _BATCH_SIZE]
        result = await triage_batch(batch)
        total_triaged += result["triaged"]
        total_failed += result["failed"]
        all_errors.extend(result.get("errors", []))
        batches += 1

    logger.info(
        "Auto-triage complete: %d triaged, %d failed across %d batches",
        total_triaged, total_failed, batches,
    )
    return {
        "triaged": total_triaged,
        "failed": total_failed,
        "batches": batches,
        "errors": all_errors[:20],
    }


async def diagnostics_triage_loop(interval: int = _AUTO_TRIAGE_INTERVAL) -> None:
    """Background loop that periodically auto-triages uncurated error types."""
    if not _OPENAI_API_KEY:
        logger.info("Diagnostics triage loop skipped – OPENAI_API_KEY not set")
        return

    logger.info("Diagnostics triage loop started (interval=%ss)", interval)
    while True:
        try:
            await auto_triage_uncurated()
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("Diagnostics triage loop error: %s", exc)
            try:
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                break
