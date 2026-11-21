from __future__ import annotations

import ast
import configparser
import csv
import io
import json
from pathlib import Path
from typing import Any, Callable
from xml.dom import minidom
from xml.etree import ElementTree

from config import (
    FILE_MANAGER_AI_MAX_INPUT_CHARS,
    FILE_MANAGER_AI_MODEL,
    FILE_MANAGER_AI_TIMEOUT_SECONDS,
    OPENAI_API_KEY,
)
from services.llm_gateway import LLMError, LLMNotConfigured, complete

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.11+ includes tomllib.
    tomllib = None  # type: ignore[assignment]

try:
    import yaml
except ModuleNotFoundError:  # pragma: no cover - requirements install PyYAML.
    yaml = None  # type: ignore[assignment]


class FileManagerAIError(RuntimeError):
    """Raised when AI assist cannot complete successfully."""


class FileManagerAIUnavailable(FileManagerAIError):
    """Raised when AI assist is not configured."""


ValidationResult = dict[str, Any]


def _result(
    *,
    valid: bool,
    supported: bool,
    formatted_content: str,
    summary: str,
    issues: list[str] | None = None,
    formatter_applied: bool = False,
) -> ValidationResult:
    return {
        "valid": valid,
        "supported": supported,
        "formatted_content": formatted_content,
        "summary": summary,
        "issues": issues or [],
        "formatter_applied": formatter_applied,
    }


def _strip_markdown_fences(value: str) -> str:
    cleaned = value.strip()
    if cleaned.startswith("```"):
        first_newline = cleaned.find("\n")
        cleaned = cleaned[first_newline + 1:] if first_newline != -1 else cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    return cleaned.strip()


def _with_trailing_newline(value: str) -> str:
    if not value:
        return ""
    return value if value.endswith("\n") else f"{value}\n"


def _validate_json(content: str, _file_path: str) -> ValidationResult:
    parsed = json.loads(content)
    formatted = _with_trailing_newline(json.dumps(parsed, indent=2, ensure_ascii=False))
    return _result(
        valid=True,
        supported=True,
        formatted_content=formatted,
        summary="Valid JSON. Reformatted with 2-space indentation.",
        formatter_applied=formatted != content,
    )


def _validate_yaml(content: str, _file_path: str) -> ValidationResult:
    if yaml is None:
        return _result(
            valid=False,
            supported=False,
            formatted_content=content,
            summary="YAML validation is unavailable on this backend.",
            issues=["Install PyYAML to validate and format YAML files."],
        )

    parsed = yaml.safe_load(content)
    formatted = yaml.safe_dump(parsed, sort_keys=False, allow_unicode=True)
    formatted = _with_trailing_newline(formatted)
    return _result(
        valid=True,
        supported=True,
        formatted_content=formatted,
        summary="Valid YAML. Reformatted using the backend YAML serializer.",
        formatter_applied=formatted != content,
    )


def _validate_xml(content: str, _file_path: str) -> ValidationResult:
    ElementTree.fromstring(content)
    pretty = minidom.parseString(content.encode("utf-8")).toprettyxml(indent="  ")
    lines = [line for line in pretty.splitlines() if line.strip()]
    if not content.lstrip().startswith("<?xml") and lines and lines[0].startswith("<?xml"):
        lines = lines[1:]
    formatted = _with_trailing_newline("\n".join(lines))
    return _result(
        valid=True,
        supported=True,
        formatted_content=formatted,
        summary="Valid XML. Reformatted with 2-space indentation.",
        formatter_applied=formatted != content,
    )


def _validate_toml(content: str, _file_path: str) -> ValidationResult:
    if tomllib is None:
        return _result(
            valid=False,
            supported=False,
            formatted_content=content,
            summary="TOML validation is unavailable on this Python runtime.",
            issues=["Python 3.11+ is required for built-in TOML parsing."],
        )

    tomllib.loads(content)
    return _result(
        valid=True,
        supported=True,
        formatted_content=content,
        summary="Valid TOML. Safe formatter unavailable, so the original text was preserved.",
    )


def _validate_ini(content: str, _file_path: str) -> ValidationResult:
    parser = configparser.ConfigParser()
    parser.optionxform = str
    parser.read_string(content)
    return _result(
        valid=True,
        supported=True,
        formatted_content=content,
        summary="Valid INI syntax. Safe formatter unavailable, so comments and ordering were preserved.",
    )


def _validate_properties(content: str, _file_path: str) -> ValidationResult:
    parser = configparser.ConfigParser()
    parser.optionxform = str
    parser.read_string(f"[properties]\n{content}")
    return _result(
        valid=True,
        supported=True,
        formatted_content=content,
        summary="Valid Java properties syntax. The original ordering was preserved.",
    )


def _validate_python(content: str, file_path: str) -> ValidationResult:
    ast.parse(content, filename=file_path or "<file>")
    return _result(
        valid=True,
        supported=True,
        formatted_content=content,
        summary="Valid Python syntax. Safe formatter unavailable, so the original text was preserved.",
    )


def _validate_csv(content: str, _file_path: str) -> ValidationResult:
    list(csv.reader(io.StringIO(content)))
    return _result(
        valid=True,
        supported=True,
        formatted_content=content,
        summary="Valid CSV structure. The original text was preserved.",
    )


_VALIDATORS: dict[str, Callable[[str, str], ValidationResult]] = {
    ".json": _validate_json,
    ".yaml": _validate_yaml,
    ".yml": _validate_yaml,
    ".xml": _validate_xml,
    ".toml": _validate_toml,
    ".ini": _validate_ini,
    ".properties": _validate_properties,
    ".py": _validate_python,
    ".csv": _validate_csv,
}


def validate_and_format_file_content(file_path: str, content: str) -> ValidationResult:
    ext = Path(file_path or "").suffix.lower()
    if not str(content or "").strip():
        return _result(
            valid=True,
            supported=True,
            formatted_content=content,
            summary="File is empty. Nothing to validate yet.",
        )

    validator = _VALIDATORS.get(ext)
    if validator is None:
        return _result(
            valid=False,
            supported=False,
            formatted_content=content,
            summary="Validation is not available for this file type yet.",
            issues=[f"No safe validator is configured for {ext or 'this file type'}."],
        )

    try:
        return validator(content, file_path)
    except Exception as exc:
        return _result(
            valid=False,
            supported=True,
            formatted_content=content,
            summary="Syntax issues detected.",
            issues=[str(exc)],
        )


async def assist_file_content(file_path: str, content: str) -> dict[str, Any]:
    if not OPENAI_API_KEY:
        raise FileManagerAIUnavailable("AI assist is not available because OPENAI_API_KEY is not configured.")
    if len(content) > FILE_MANAGER_AI_MAX_INPUT_CHARS:
        raise ValueError(
            f"AI assist is limited to {FILE_MANAGER_AI_MAX_INPUT_CHARS:,} characters per request."
        )

    validation = validate_and_format_file_content(file_path, content)
    validation_issues = validation.get("issues") or []
    validation_text = validation.get("summary") or "No validation summary available."
    issue_block = "\n".join(f"- {issue}" for issue in validation_issues) or "- None reported"
    file_ext = Path(file_path or "").suffix.lower()
    json_guidance = ""
    if file_ext == ".json":
        json_guidance = (
            " The file is JSON. Return corrected_content as valid JSON with 2-space indentation, "
            "double-quoted keys/strings, and a trailing newline. Preserve existing key order unless syntax repair requires otherwise."
        )

    system_prompt = (
        "You repair server-side text and configuration files for an admin file manager. "
        "Preserve operator intent. Make only minimal syntax, structure, quoting, delimiter, or formatting fixes. "
        "Do not invent new configuration keys, paths, ports, credentials, or comments. "
        f"Return strict JSON with keys: summary, issues, corrected_content, changed.{json_guidance}"
    )
    user_prompt = (
        f"File path: {file_path}\n"
        f"Validation summary: {validation_text}\n"
        f"Validation issues:\n{issue_block}\n\n"
        "Review the file, fix syntax or structural problems if present, and return the complete corrected file contents. "
        "If the file is already sound, return it unchanged with changed=false.\n\n"
        f"FILE CONTENT START\n{content}\nFILE CONTENT END"
    )
    try:
        result = await complete(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            model=FILE_MANAGER_AI_MODEL,
            json_mode=True,
            temperature=0.2,
            max_tokens=2000,
            timeout=FILE_MANAGER_AI_TIMEOUT_SECONDS,
        )
    except LLMNotConfigured as exc:
        raise FileManagerAIUnavailable(
            "AI assist is not available because OPENAI_API_KEY is not configured."
        ) from exc
    except LLMError as exc:
        if exc.status_code is not None:
            raise FileManagerAIError(f"AI service returned HTTP {exc.status_code}.") from exc
        raise FileManagerAIError("Could not reach the AI service.") from exc

    cleaned = _strip_markdown_fences(result.text)

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise FileManagerAIError("AI service returned an unreadable response.") from exc

    corrected_content = parsed.get("corrected_content")
    if not isinstance(corrected_content, str):
        corrected_content = content
    issues = [str(item).strip() for item in parsed.get("issues", []) if str(item).strip()]
    summary = str(parsed.get("summary") or "AI reviewed the file.").strip()
    changed = bool(parsed.get("changed")) or corrected_content != content

    return {
        "summary": summary,
        "issues": issues,
        "corrected_content": corrected_content,
        "changed": changed,
        "model": FILE_MANAGER_AI_MODEL,
    }