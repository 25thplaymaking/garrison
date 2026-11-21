"""Root-cause analysis for one Reforger server session.

The engine's *last* error line is almost never the cause. When a server
fails, Reforger tears the game down and prints a ``==== Resource leaks ====``
report, whose only entry is usually ``ui/fonts/robotomono_msdf_28.edds``;
anything that shows "the last (E) line" therefore blames a font. The real
cause sits above it: a script that no longer compiles, a VM exception, an
invalid server config, a prefab with no mass, a stalled Workshop download.

``analyze_session`` reads one ``profile/logs/logs_<timestamp>/`` directory
(``crash.log`` first, it holds the engine's own crash record, then
``console.log``/``error.log``), ranks every recognised failure signature,
labels shutdown noise as noise, and names the mod that owns the failing
resource by reading the addons' pak indexes (``services.addon_index``). It
then proposes remediation actions; executing them is the route's job.

Everything here is synchronous file I/O on bounded windows: a runaway
session can leave multi-GB logs, so no file is ever read whole above
``_FULL_READ_BYTES``.
"""

from __future__ import annotations

import re
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from services import addon_index

_FULL_READ_BYTES = 8 * 1024 * 1024
_WINDOW_BYTES = 4 * 1024 * 1024
_CRASH_LOG_READ_BYTES = 512 * 1024
_EVIDENCE_CONTEXT = 3
_SESSION_DIR_RE = re.compile(r"^logs_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})$")
_TS_PREFIX_RE = re.compile(r"^\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*")
_SEVERITY_RE = re.compile(r"^\s*(?:\d{2}:\d{2}:\d{2}(?:\.\d+)?)?\s*([A-Z_]+)\s*\((E|W|F)\)\s*:\s*(.*)$")

# --- signatures ------------------------------------------------------------

_COMPILE_HEAD_RE = re.compile(r"""Can't compile "(\w+)" script module!""")
_COMPILE_DETAIL_RE = re.compile(r"""^\s*@?"?((?:[Ss]cripts)/[^"(,]+\.c)"?(?:\((\d+)\)|,(\d+)"?)\s*:\s*(.+)$""")
_COMPILE_DETAIL_LOG_RE = re.compile(r"""SCRIPT\s*\(E\)\s*:\s*@"((?:[Ss]cripts)/[^"]+\.c),(\d+)"\s*:\s*(.+)$""")
_VME_HEAD_RE = re.compile(r"Virtual Machine Exception")
_VME_REASON_RE = re.compile(r"^\s*Reason:\s*(.+?)\s*$")
_VME_CLASS_RE = re.compile(r"^\s*Class:\s*'([^']+)'")
_VME_FUNCTION_RE = re.compile(r"^\s*Function:\s*'([^']+)'")
_STACK_FRAME_RE = re.compile(r"^\s*((?:[Ss]cripts)/[^:]+\.c):(\d+)\s+Function\s+(\w+)")
_RESOURCE_IN_TEXT_RE = re.compile(r"\{[0-9A-Fa-f]{16}\}([\w./ -]+\.(?:et|conf|ent|layer|xob|emat|edds|st|c))")
_MISSION_HEADER_RE = re.compile(r"Unable to read the mission header '([^']+)'")
_CONFIG_PARAM_RE = re.compile(r'Param "#/([^"]+)" (.+)$')
_CONFIG_INVALID_RE = re.compile(r"JSON is invalid!|There are errors in server config!|broken DS config")
_UNKNOWN_CLASS_RE = re.compile(r"Unknown class '([^']+)'")
_PREFAB_CONTEXT_RE = re.compile(r'(?:prefab load|GetResourceObject|load project data|Loading)\s*@"(\{[0-9A-Fa-f]{16}\}[^"]+)"')
_CANT_LOAD_PREFAB_RE = re.compile(r"Can't load prefab (\S+)")
_ADDON_LOAD_FAILED_RE = re.compile(r"Addon loading failed \{([^}]*)\}?")
_DOWNLOAD_STARTED_RE = re.compile(r"Addon Download started ([0-9A-Fa-f]{16}) - (.+?)\s*$")
_DOWNLOAD_VERSION_RE = re.compile(r"(?:Updating ([0-9A-Fa-f]{16}) from (\S+) to (\S+)|Downloading ([0-9A-Fa-f]{16}) version (\S+))")
_DOWNLOAD_ZERO_SPEED_RE = re.compile(r"Download speed 0\.00 KB/s")
_DOWNLOAD_ERROR_RE = re.compile(r"Fragmentizer: Download error|Connection timeout to workshop API|asset-blocked|Failed to download|WorkshopApi/\S+\]\s+ENV:\[\w+\]\s+Timeout", re.IGNORECASE)
_NOT_DOWNLOADABLE_RE = re.compile(r"(\d+) addons? (?:are|is) not downloadable")
_DEPS_UNRESOLVABLE_RE = re.compile(r"assetDependenciesUnresolvable.*?Dependencies of asset ([0-9A-Fa-f]{16})(?: v\. (\S+))?")
_GUID_RE = re.compile(r"\b([0-9A-F]{16})\b")
_FATAL_GENERIC_RE = re.compile(r"Cannot create game!|Unable to initialize the game|Error while initializing game|Unable to continue")
_ONLINE_RE = re.compile(r"Entered online game state|Server registered with address")
_GAME_DESTROYED_RE = re.compile(r"Game destroyed\.")
_REQUIRED_ADDONS_READY_RE = re.compile(r"Required addons are ready to use")
_OOM_RE = re.compile(r"Out of memory|std::bad_alloc|Not enough memory", re.IGNORECASE)
_SEGFAULT_RE = re.compile(r"Segmentation fault|SIGSEGV|Application crashed|Unhandled exception", re.IGNORECASE)
_BIND_RE = re.compile(r"Address already in use|Failed to bind|Unable to bind", re.IGNORECASE)

# Lines that are never the cause, however loud. Matched against the message
# after the severity marker.
_NOISE_PATTERNS: Tuple[Tuple[re.Pattern, str], ...] = (
    (re.compile(r"==== Resource leaks ===="), "Shutdown resource-leak report printed after the game was destroyed."),
    (re.compile(r"^\S+\.(?:edds|xob|emat|ptc|et|conf)\s+\d+\s*$"), "Resource-leak entry from the shutdown report; a side effect, not the cause."),
    (re.compile(r"Wrong GUID/name for resource .* in property \"StringTableSource\""), "Load-time localisation warning from mod metadata; harmless."),
    (re.compile(r"is obsolete"), "Script deprecation warning."),
    (re.compile(r"Multiple 'Physics Settings' are not supported"), "Engine notice when several mods ship physics settings."),
    (re.compile(r"thermalProfileDefault"), "Stock dedicated-server thermal profile notice."),
    (re.compile(r"^Failed to load$"), "Follow-on line of an earlier failure."),
)

_KIND_INFO: Dict[str, Dict[str, Any]] = {
    "script_compile_error": {
        "score": 100,
        "title": "A mod's script failed to compile",
        "explanation": (
            "Reforger compiles every mod's scripts together at startup. One file "
            "refers to something the game or one of its dependencies no longer "
            "has (typical after a game or dependency update), so the whole "
            "script module fails and the server cannot start. Every restart "
            "will fail the same way until the mod is updated, rolled back or removed."
        ),
    },
    "server_config_invalid": {
        "score": 98,
        "title": "The server config was rejected",
        "explanation": (
            "The engine validated server-config.json against its schema and "
            "refused to start. The parameter named below has the wrong type or "
            "value; fix it in Server Settings."
        ),
    },
    "scenario_unavailable": {
        "score": 97,
        "title": "The configured scenario is not available",
        "explanation": (
            "The server is set to a scenario (mission header) that none of the "
            "loaded mods provide, so the game cannot initialise. This happens "
            "when the mod that ships the scenario was removed from the mod list "
            "(a mirror or revert can do this) or the scenario was renamed."
        ),
    },
    "workshop_unavailable": {
        "score": 96,
        "title": "A mod can't be downloaded from the Workshop",
        "explanation": (
            "The Workshop refused to serve a mod in the list (removed, made "
            "private, blocked, or one of its own dependencies can't be resolved). "
            "Reforger will not start until it is taken out of the server config."
        ),
    },
    "script_vm_exception": {
        "score": 90,
        "title": "A mod script threw an exception",
        "explanation": (
            "A script raised a VM exception while the world was loading or "
            "running. The stack trace shows which script hit it; when the "
            "reason names a prefab, the mod that ships that prefab is usually "
            "the one to fix."
        ),
    },
    "script_exception_loop": {
        "score": 80,
        "title": "A script error is repeating every frame",
        "explanation": (
            "The same script exception fired many times. Even when it does not "
            "crash the server it floods the logs (gigabytes per hour) and burns "
            "the simulation thread."
        ),
    },
    "missing_class": {
        "score": 70,
        "title": "Content references a class no loaded mod defines",
        "explanation": (
            "A prefab or config uses a script class that does not exist, so it "
            "loads as null. This happens when a dependency is missing or out "
            "of date, or a leftover addon in the workshop folder overrides a config."
        ),
    },
    "engine_crash": {
        "score": 75,
        "title": "The engine crashed",
        "explanation": "The engine wrote a crash record. The excerpt below is its own account of what failed.",
    },
    "out_of_memory": {
        "score": 85,
        "title": "The server ran out of memory",
        "explanation": "An allocation failed. Check the host's free memory and the server's mod count.",
    },
    "port_in_use": {
        "score": 85,
        "title": "A network port is already in use",
        "explanation": "Another process holds this server's game, query or RCON port.",
    },
    "workshop_download_failed": {
        "score": 55,
        "title": "A Workshop download stalled or failed",
        "explanation": (
            "The server could not finish downloading a mod. This is usually a "
            "transient Workshop or network problem; a restart retries it. If "
            "it keeps failing on the same mod, that mod may be blocked or removed."
        ),
    },
    "addon_load_failed": {
        "score": 30,
        "title": "Addon loading failed",
        "explanation": "The engine gave up loading the mod set. This is a consequence; look at the errors before it.",
    },
    "generic_fatal": {
        "score": 10,
        "title": "The game failed to initialise",
        "explanation": "The engine stopped during startup without a more specific error in the logs.",
    },
}


# --- bounded reading ---------------------------------------------------------

class LogWindow:
    """Lines of a log file with absolute line numbers where known.

    Small files are read whole. Large ones keep the first and last
    ``_WINDOW_BYTES``; head lines keep exact numbers, tail lines carry
    ``None`` because counting them would mean reading the whole file.
    """

    def __init__(self, name: str, lines: List[Tuple[Optional[int], str]], truncated: bool, size: int):
        self.name = name
        self.lines = lines
        self.truncated = truncated
        self.size = size

    @classmethod
    def read(cls, path: Path) -> "LogWindow":
        try:
            size = path.stat().st_size
        except OSError:
            return cls(path.name, [], False, 0)
        try:
            with open(path, "rb") as handle:
                if size <= _FULL_READ_BYTES:
                    text = handle.read().decode("utf-8", "replace")
                    lines = [(i + 1, line) for i, line in enumerate(text.splitlines())]
                    return cls(path.name, lines, False, size)
                head = handle.read(_WINDOW_BYTES).decode("utf-8", "replace").splitlines()
                handle.seek(max(size - _WINDOW_BYTES, 0))
                tail = handle.read().decode("utf-8", "replace").splitlines()[1:]
        except OSError:
            return cls(path.name, [], False, 0)
        head = head[:-1]  # last head line may be cut mid-way
        lines = [(i + 1, line) for i, line in enumerate(head)] + [(None, line) for line in tail]
        return cls(path.name, lines, True, size)

    def texts(self) -> List[str]:
        return [line for _, line in self.lines]


def _evidence(window: LogWindow, index: int, *, before: int = _EVIDENCE_CONTEXT, after: int = _EVIDENCE_CONTEXT) -> Dict[str, Any]:
    start = max(index - before, 0)
    end = min(index + after + 1, len(window.lines))
    return {
        "file": window.name,
        "line": window.lines[index][0],
        "text": window.lines[index][1].rstrip(),
        "context": [
            {"line": number, "text": text.rstrip(), "focus": i == index}
            for i, (number, text) in enumerate(window.lines[start:end], start=start)
        ],
    }


def _timestamp(line: str) -> Optional[str]:
    match = _TS_PREFIX_RE.match(line)
    return match.group(1) if match else None


def _message(line: str) -> str:
    match = _SEVERITY_RE.match(line)
    if match:
        return match.group(3).strip()
    return _TS_PREFIX_RE.sub("", line, count=1).strip()


def classify_noise(line: str) -> Optional[str]:
    """Return why a log line is known noise, or None if it may matter."""
    message = _message(line)
    for pattern, reason in _NOISE_PATTERNS:
        if pattern.search(message):
            return reason
    return None


# --- crash.log -------------------------------------------------------------

def parse_crash_log(text: str) -> List[Dict[str, Any]]:
    """Split crash.log into its crash records.

    Each record follows a ``------------------------------------`` rule and a
    ``DD.MM YYYY HH:MM:SS`` stamp; the lines until ``Runtime mode``/``CLI
    params`` (or the next rule) are the engine's account of the failure.
    """
    records: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.rstrip()
        if re.fullmatch(r"-{20,}", line.strip()):
            if current and current["lines"]:
                records.append(current)
            current = {"line": number, "stamp": None, "lines": []}
            continue
        if current is None:
            continue
        if current["stamp"] is None and re.match(r"^\d{2}\.\d{2} \d{4} \d{2}:\d{2}:\d{2}", line):
            current["stamp"] = line.strip()
            continue
        if line.startswith("Runtime mode") or line.startswith("CLI params"):
            if current["lines"]:
                records.append(current)
            current = None
            continue
        if line.strip() or current["lines"]:
            current["lines"].append((number, line))
    if current and current["lines"]:
        records.append(current)
    # The file opens with a "Log ... started at" banner under its own rule;
    # only stamped blocks are crash records.
    records = [r for r in records if r["stamp"]]
    for record in records:
        while record["lines"] and not record["lines"][-1][1].strip():
            record["lines"].pop()
    return records


def _finding(kind: str, *, summary: str, evidence: List[Dict[str, Any]], **extra: Any) -> Dict[str, Any]:
    info = _KIND_INFO[kind]
    finding = {
        "kind": kind,
        "title": info["title"],
        "explanation": info["explanation"],
        "score": info["score"],
        "summary": summary,
        "evidence": evidence,
        "resources": [],
        "count": 1,
        "confidence": "high",
        "source": "console",
    }
    finding.update(extra)
    return finding


def _findings_from_crash_log(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    grouped: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
    for record in records:
        body = [text for _, text in record["lines"]]
        key = "\n".join(body[:6])
        if key in grouped:
            grouped[key]["count"] += 1
            continue
        grouped[key] = {"record": record, "count": 1}

    for entry in grouped.values():
        record, count = entry["record"], entry["count"]
        lines = record["lines"]
        texts = [text for _, text in lines]
        evidence = [{
            "file": "crash.log",
            "line": lines[0][0] if lines else record["line"],
            "text": "\n".join(texts[:12]),
            "context": [{"line": n, "text": t, "focus": i == 0} for i, (n, t) in enumerate(lines[:16])],
        }]
        joined = "\n".join(texts)
        head = _COMPILE_HEAD_RE.search(joined)
        if head:
            detail = next((m for m in (_COMPILE_DETAIL_RE.match(t) for t in texts) if m), None)
            resource = detail.group(1) if detail else None
            line_no = int(detail.group(2) or detail.group(3)) if detail else None
            message = detail.group(4).strip() if detail else head.group(0)
            summary = f"{resource} line {line_no}: {message}" if resource else message
            findings.append(_finding(
                "script_compile_error", summary=summary, evidence=evidence, count=count,
                module=head.group(1), resources=[r for r in [resource] if r], script_line=line_no,
                detail=message, stamp=record["stamp"],
            ))
            continue
        if _VME_HEAD_RE.search(joined):
            findings.append(_vme_finding(texts, evidence, count, record["stamp"]))
            continue
        if _OOM_RE.search(joined):
            findings.append(_finding("out_of_memory", summary=texts[0].strip(), evidence=evidence, count=count, stamp=record["stamp"]))
            continue
        summary = next((t.strip() for t in texts if t.strip()), "Engine crash record")
        findings.append(_finding(
            "engine_crash", summary=summary, evidence=evidence, count=count,
            resources=_resources_in(texts), stamp=record["stamp"], confidence="medium",
        ))
    for finding in findings:
        finding["source"] = "crash.log"
    return findings


def _vme_finding(texts: Sequence[str], evidence: List[Dict[str, Any]], count: int, stamp: Optional[str]) -> Dict[str, Any]:
    reason = cls = function = None
    frames: List[Dict[str, Any]] = []
    for text in texts:
        reason = reason or _match_group(_VME_REASON_RE, text)
        cls = cls or _match_group(_VME_CLASS_RE, text)
        function = function or _match_group(_VME_FUNCTION_RE, text)
        frame = _STACK_FRAME_RE.match(text)
        if frame:
            frames.append({"script": frame.group(1), "line": int(frame.group(2)), "function": frame.group(3)})
    content = _resources_in([reason or ""])
    scripts = [frame["script"] for frame in frames[:6]]
    summary = reason or "Virtual Machine Exception"
    if cls or function:
        summary += f" (in {cls or '?'}.{function or '?'})"
    kind = "script_exception_loop" if count >= 25 else "script_vm_exception"
    return _finding(
        kind, summary=summary, evidence=evidence, count=count, stamp=stamp,
        reason=reason, script_class=cls, function=function, stack=frames[:8],
        # The prefab/config named in the reason is the content at fault; the
        # script frame is the code that noticed. Both get attributed.
        resources=content + [s for s in scripts if s not in content],
        content_resources=content,
        stack_resources=[s for s in scripts if s not in content],
    )


def _match_group(pattern: re.Pattern, text: str) -> Optional[str]:
    match = pattern.match(text)
    return match.group(1) if match else None


def _resources_in(texts: Iterable[str]) -> List[str]:
    found: List[str] = []
    for text in texts:
        for match in _RESOURCE_IN_TEXT_RE.finditer(text):
            value = match.group(1).strip()
            if value not in found:
                found.append(value)
    return found


# --- console.log / error.log -------------------------------------------------

def _findings_from_console(window: LogWindow) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    facts: Dict[str, Any] = {
        "online": False,
        "online_at": None,
        "destroyed": False,
        "fatal_generic": False,
        "addons_ready": False,
        "updates": {},
        "download_in_progress": None,
        "last_error": None,
        "first_line_ts": None,
        "last_line_ts": None,
    }
    lines = window.lines
    if not lines:
        return findings, facts

    compile_details: List[int] = []
    compile_head: Optional[int] = None
    config_params: List[int] = []
    config_invalid: Optional[int] = None
    vme_starts: List[int] = []
    unknown_classes: "OrderedDict[str, List[int]]" = OrderedDict()
    addon_failed: Optional[int] = None
    fatal_generic: Optional[int] = None
    download_errors: List[int] = []
    zero_speed: List[int] = []
    last_download: Optional[Tuple[int, str, str]] = None
    mission_header: Optional[int] = None
    not_downloadable: Optional[int] = None
    unresolvable: "OrderedDict[str, int]" = OrderedDict()
    oom: Optional[int] = None
    segv: Optional[int] = None
    bind: Optional[int] = None

    for index, (_, text) in enumerate(lines):
        if facts["first_line_ts"] is None:
            facts["first_line_ts"] = _timestamp(text)
        if _ONLINE_RE.search(text):
            facts["online"] = True
            facts["online_at"] = facts["online_at"] or _timestamp(text)
        if facts["online"] and _GAME_DESTROYED_RE.search(text):
            # Startup creates and destroys a bootstrap game before addons
            # load; only a teardown after going online is a shutdown.
            facts["destroyed"] = True
        if _REQUIRED_ADDONS_READY_RE.search(text):
            facts["addons_ready"] = True
        update = _DOWNLOAD_VERSION_RE.search(text)
        if update:
            if update.group(1):
                facts["updates"][update.group(1).upper()] = {"from": update.group(2), "to": update.group(3)}
            elif update.group(4):
                facts["updates"].setdefault(update.group(4).upper(), {"from": None, "to": update.group(5)})
        started = _DOWNLOAD_STARTED_RE.search(text)
        if started:
            last_download = (index, started.group(1).upper(), started.group(2))
        if _DOWNLOAD_ZERO_SPEED_RE.search(text):
            zero_speed.append(index)
        if _DOWNLOAD_ERROR_RE.search(text):
            download_errors.append(index)
        if _COMPILE_HEAD_RE.search(text):
            compile_head = index
        if _COMPILE_DETAIL_LOG_RE.search(text):
            compile_details.append(index)
        if _CONFIG_PARAM_RE.search(text):
            config_params.append(index)
        if _CONFIG_INVALID_RE.search(text):
            config_invalid = config_invalid if config_invalid is not None else index
        if _VME_HEAD_RE.search(text):
            vme_starts.append(index)
        unknown = _UNKNOWN_CLASS_RE.search(text)
        if unknown:
            unknown_classes.setdefault(unknown.group(1), []).append(index)
        if not_downloadable is None and _NOT_DOWNLOADABLE_RE.search(text):
            not_downloadable = index
        unresolved = _DEPS_UNRESOLVABLE_RE.search(text)
        if unresolved:
            unresolvable.setdefault(unresolved.group(1).upper(), index)
        if mission_header is None and _MISSION_HEADER_RE.search(text):
            mission_header = index
        if _ADDON_LOAD_FAILED_RE.search(text):
            addon_failed = index
        if _FATAL_GENERIC_RE.search(text):
            fatal_generic = fatal_generic if fatal_generic is not None else index
            facts["fatal_generic"] = True
        if oom is None and _OOM_RE.search(text):
            oom = index
        if segv is None and _SEGFAULT_RE.search(text):
            segv = index
        if bind is None and _BIND_RE.search(text):
            bind = index
        if re.search(r"\((?:E|F)\)", text) and not classify_noise(text):
            facts["last_error"] = {"line": lines[index][0], "text": text.rstrip()}
    facts["last_line_ts"] = next((_timestamp(t) for _, t in reversed(lines) if _timestamp(t)), None)
    last_error_any = next(((n, t) for n, t in reversed(lines) if re.search(r"\((?:E|F)\)", t)), None)
    if last_error_any:
        facts["last_error_line"] = {"line": last_error_any[0], "text": last_error_any[1].rstrip(), "noise": classify_noise(last_error_any[1])}

    if compile_head is not None or compile_details:
        anchor = compile_details[0] if compile_details else compile_head
        detail = _COMPILE_DETAIL_LOG_RE.search(lines[anchor][1]) if compile_details else None
        resource = detail.group(1) if detail else None
        line_no = int(detail.group(2)) if detail else None
        message = detail.group(3).strip() if detail else "Can't compile script module"
        findings.append(_finding(
            "script_compile_error",
            summary=f"{resource} line {line_no}: {message}" if resource else message,
            evidence=[_evidence(window, anchor)],
            resources=[r for r in [resource] if r], script_line=line_no, detail=message,
            count=max(len(compile_details), 1),
        ))

    if config_invalid is not None or config_params:
        anchor = config_params[0] if config_params else config_invalid
        params = []
        for index in config_params:
            match = _CONFIG_PARAM_RE.search(lines[index][1])
            if match:
                params.append({"path": match.group(1).replace("/", "."), "problem": match.group(2).strip()})
        summary = "; ".join(f"{p['path']}: {p['problem']}" for p in params) or _message(lines[anchor][1])
        findings.append(_finding(
            "server_config_invalid", summary=summary, evidence=[_evidence(window, anchor, after=4)],
            config_params=params,
        ))

    if mission_header is not None:
        scenario_id = _MISSION_HEADER_RE.search(lines[mission_header][1]).group(1)
        findings.append(_finding(
            "scenario_unavailable", summary=f"Scenario {scenario_id} could not be read",
            evidence=[_evidence(window, mission_header, before=2, after=2)],
            scenario_id=scenario_id, resources=[scenario_id],
        ))

    if unresolvable or not_downloadable is not None:
        anchor = next(iter(unresolvable.values())) if unresolvable else not_downloadable
        mod_ids = list(unresolvable)
        if not mod_ids and not_downloadable is not None:
            # The engine names the offending addons in the lines just above.
            for _, text in lines[max(not_downloadable - 12, 0):not_downloadable]:
                for guid in _GUID_RE.findall(text):
                    if guid not in mod_ids and guid not in addon_index.BASE_GAME_GUIDS:
                        mod_ids.append(guid)
        summary = (
            "Workshop could not resolve the dependencies of " + ", ".join(mod_ids)
            if unresolvable else _message(lines[not_downloadable][1])
        )
        findings.append(_finding(
            "workshop_unavailable", summary=summary,
            evidence=[_evidence(window, anchor, before=6, after=1)],
            mod_ids=mod_ids, confidence="high" if mod_ids else "medium",
        ))

    if vme_starts:
        groups: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        for start in vme_starts:
            block = [t for _, t in lines[start:start + 16]]
            reason = next((m for m in (_match_group(_VME_REASON_RE, t) for t in block) if m), "")
            cls = next((m for m in (_match_group(_VME_CLASS_RE, t) for t in block) if m), "")
            function = next((m for m in (_match_group(_VME_FUNCTION_RE, t) for t in block) if m), "")
            key = f"{reason}|{cls}|{function}"
            if key not in groups:
                groups[key] = {"start": start, "block": block, "count": 0}
            groups[key]["count"] += 1
        for group in sorted(groups.values(), key=lambda g: -g["count"])[:6]:
            evidence = [_evidence(window, group["start"], before=2, after=10)]
            findings.append(_vme_finding(group["block"], evidence, group["count"], _timestamp(lines[group["start"]][1])))

    if unknown_classes:
        compile_failed = compile_head is not None or bool(compile_details)
        for name, indices in list(unknown_classes.items())[:5]:
            anchor = indices[0]
            context_resource = _resource_context(lines, anchor)
            findings.append(_finding(
                "missing_class",
                summary=f"Unknown class '{name}'" + (f" while loading {context_resource}" if context_resource else ""),
                evidence=[_evidence(window, anchor, before=3, after=2)],
                resources=[context_resource] if context_resource else [],
                class_name=name, count=len(indices),
                # After a compile failure every script class is "unknown":
                # these are echoes of that failure, not separate causes.
                confidence="low" if compile_failed else "medium",
                consequence_of="script_compile_error" if compile_failed else None,
            ))

    if oom is not None:
        findings.append(_finding("out_of_memory", summary=_message(lines[oom][1]), evidence=[_evidence(window, oom)]))
    if bind is not None:
        findings.append(_finding("port_in_use", summary=_message(lines[bind][1]), evidence=[_evidence(window, bind)]))
    if segv is not None:
        findings.append(_finding("engine_crash", summary=_message(lines[segv][1]), evidence=[_evidence(window, segv)], confidence="medium"))

    stalled = last_download is not None and len([i for i in zero_speed if i > last_download[0]]) >= 3
    if download_errors or stalled:
        anchor = (download_errors[-1] if download_errors else zero_speed[-1])
        mod = last_download[1] if last_download else None
        mod_name = last_download[2] if last_download else None
        summary = (
            f"Download of {mod_name} ({mod}) stalled" if stalled and mod
            else _message(lines[anchor][1])
        )
        findings.append(_finding(
            "workshop_download_failed", summary=summary, evidence=[_evidence(window, anchor)],
            count=max(len(download_errors), 1), mod_ids=[mod] if mod else [], confidence="medium",
        ))
    if last_download and not facts["addons_ready"]:
        facts["download_in_progress"] = {"mod_id": last_download[1], "name": last_download[2]}

    if addon_failed is not None:
        findings.append(_finding(
            "addon_load_failed", summary="The engine gave up loading the mod set.",
            evidence=[_evidence(window, addon_failed, before=1, after=1)], confidence="low",
        ))
    if fatal_generic is not None:
        findings.append(_finding(
            "generic_fatal", summary=_message(lines[fatal_generic][1]),
            evidence=[_evidence(window, fatal_generic, before=6, after=1)], confidence="low",
        ))
    facts["script_exception_total"] = len(vme_starts)
    return findings, facts


def _resource_context(lines: List[Tuple[Optional[int], str]], index: int) -> Optional[str]:
    for _, text in reversed(lines[max(index - 4, 0):index + 1]):
        match = _PREFAB_CONTEXT_RE.search(text)
        if match:
            return addon_index._normalize_resource(match.group(1))
    for _, text in lines[index:index + 3]:
        match = _CANT_LOAD_PREFAB_RE.search(text)
        if match:
            return match.group(1)
    return None


# --- assembling a diagnosis ---------------------------------------------------

def session_started_at(session_dir: Path) -> Optional[str]:
    match = _SESSION_DIR_RE.match(session_dir.name)
    if not match:
        return None
    date, hh, mm, ss = match.groups()
    return f"{date}T{hh}:{mm}:{ss}+00:00"


def list_session_dirs(logs_root: Path) -> List[Path]:
    try:
        dirs = [p for p in logs_root.iterdir() if p.is_dir() and _SESSION_DIR_RE.match(p.name)]
    except OSError:
        return []
    return sorted(dirs, key=lambda p: p.name, reverse=True)


def _dedupe(findings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """crash.log and console.log often describe the same failure; keep one."""
    kept: List[Dict[str, Any]] = []
    for finding in findings:
        duplicate = next(
            (k for k in kept if k["kind"] == finding["kind"] and (
                (k.get("resources") and k.get("resources") == finding.get("resources"))
                or k.get("summary") == finding.get("summary")
            )),
            None,
        )
        if duplicate:
            duplicate["evidence"].extend(finding["evidence"][:1])
            duplicate["count"] = max(duplicate["count"], finding["count"])
            continue
        kept.append(finding)
    return kept


_FATAL_KINDS = frozenset({
    "script_compile_error", "server_config_invalid", "scenario_unavailable",
    "workshop_unavailable", "out_of_memory", "port_in_use", "engine_crash",
})


def _outcome(facts: Dict[str, Any], findings: List[Dict[str, Any]], is_latest: bool, running: bool) -> str:
    # crash.log also records non-fatal VM exceptions, so its mere presence is
    # not a crash: only a fatal signature or the engine's own fatal line is.
    if any(f["kind"] in _FATAL_KINDS for f in findings) or facts.get("fatal_generic"):
        return "crashed_runtime" if facts.get("online") else "failed_to_start"
    if is_latest and running:
        if facts.get("online"):
            return "running"
        return "downloading" if facts.get("download_in_progress") else "starting"
    # Docker stops Reforger with SIGKILL (it ignores SIGTERM), so a session
    # that went online and then simply ends is a stop, not a crash.
    if facts.get("destroyed") or facts.get("online"):
        return "stopped"
    return "ended_unexpectedly"


def analyze_session(
    session_dir: Path,
    *,
    addons_dir: Optional[Path] = None,
    mods: Optional[List[Dict[str, Any]]] = None,
    is_latest: bool = False,
    running: bool = False,
) -> Dict[str, Any]:
    """Diagnose one session directory. Pure file I/O; call it off the event loop."""
    crash_records: List[Dict[str, Any]] = []
    crash_path = session_dir / "crash.log"
    if crash_path.is_file():
        try:
            with open(crash_path, "rb") as handle:
                crash_records = parse_crash_log(handle.read(_CRASH_LOG_READ_BYTES).decode("utf-8", "replace"))
        except OSError:
            crash_records = []

    console = LogWindow.read(session_dir / "console.log")
    findings = _findings_from_crash_log(crash_records)
    console_findings, facts = _findings_from_console(console)
    findings.extend(console_findings)
    findings = _dedupe(findings)
    findings.sort(key=lambda f: (-f["score"], 0 if f["confidence"] == "high" else 1))

    outcome = _outcome(facts, findings, is_latest, running)
    if outcome not in {"failed_to_start", "crashed_runtime"}:
        # Without a fatal signature, warnings are not a root cause.
        findings = [f for f in findings if f["kind"] in {"script_exception_loop", "workshop_download_failed", "script_vm_exception"}]

    culprits: List[Dict[str, Any]] = []
    if addons_dir is not None and findings:
        culprits = attribute_culprits(findings, addons_dir, mods or [], facts.get("updates") or {})

    primary = findings[0] if findings else None
    last_error_line = facts.get("last_error_line")
    noise_note = None
    if primary and last_error_line and last_error_line.get("noise"):
        noise_note = (
            f"The last error line in the log (\"{_message(last_error_line['text'])}\") is "
            f"noise: {last_error_line['noise']} The cause is the finding above it."
        )

    return {
        "session": session_dir.name,
        "started_at": session_started_at(session_dir),
        "outcome": outcome,
        "online": facts.get("online", False),
        "crash_records": len(crash_records),
        "primary": _public_finding(primary) if primary else None,
        "findings": [_public_finding(f) for f in findings[:8]],
        "culprits": culprits,
        "actions": suggest_actions(primary, culprits, outcome) if primary else [],
        "last_error_line": last_error_line,
        "noise_note": noise_note,
        "download_in_progress": facts.get("download_in_progress"),
        "mod_updates": [
            {"mod_id": mod_id, "from": change.get("from"), "to": change.get("to")}
            for mod_id, change in (facts.get("updates") or {}).items()
        ],
        "logs": {
            "console": {"size": console.size, "truncated": console.truncated},
            "crash": crash_path.is_file(),
        },
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
    }


def _public_finding(finding: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in finding.items() if k != "score"}


# --- culprits ---------------------------------------------------------------

def _mod_id(mod: Dict[str, Any]) -> str:
    return str(mod.get("modId") or mod.get("mod_id") or mod.get("id") or "").upper()


def listed_dependents(culprit_id: str, listed_ids: Iterable[str], addons: Dict[str, Dict[str, Any]]) -> List[str]:
    """Listed mods whose (transitive) dependency closure includes the culprit."""
    culprit_id = culprit_id.upper()
    dependents: List[str] = []
    for mod_id in listed_ids:
        if mod_id == culprit_id:
            continue
        seen = set()
        stack = list((addons.get(mod_id) or {}).get("dependencies") or [])
        while stack:
            dep = stack.pop()
            if dep in seen:
                continue
            seen.add(dep)
            if dep == culprit_id:
                dependents.append(mod_id)
                break
            stack.extend((addons.get(dep) or {}).get("dependencies") or [])
    return dependents


def attribute_culprits(
    findings: List[Dict[str, Any]],
    addons_dir: Path,
    mods: List[Dict[str, Any]],
    updates: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Name the mods behind the top findings, with what removing them implies."""
    relevant = [f for f in findings[:3] if f.get("confidence") != "low"]
    resources: List[str] = []
    for finding in relevant:
        for resource in finding.get("resources") or []:
            if resource not in resources:
                resources.append(resource)
    owners = addon_index.find_resource_owners(addons_dir, resources) if resources else {}
    addons = addon_index.list_addons(addons_dir)
    listed = [_mod_id(m) for m in mods if _mod_id(m)]
    listed_set = set(listed)
    names = {_mod_id(m): m.get("name") for m in mods}

    culprits: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()

    def add(mod_id: str, *, finding: Dict[str, Any], role: str, resource: Optional[str], exact: bool) -> None:
        mod_id = mod_id.upper()
        if mod_id in addon_index.BASE_GAME_GUIDS:
            return
        if mod_id in culprits:
            culprits[mod_id]["exact_case"] = culprits[mod_id]["exact_case"] or exact
            return
        info = addons.get(mod_id) or {}
        dependents = listed_dependents(mod_id, listed, addons)
        update = updates.get(mod_id)
        culprits[mod_id] = {
            "mod_id": mod_id,
            "name": info.get("name") or names.get(mod_id) or mod_id,
            "folder": info.get("folder"),
            "installed_version": info.get("version"),
            "role": role,
            "finding": finding["kind"],
            "resource": resource,
            "exact_case": exact,
            "in_mod_list": mod_id in listed_set,
            "listed_dependents": [{"mod_id": d, "name": (addons.get(d) or {}).get("name") or names.get(d) or d} for d in dependents],
            "orphan": mod_id not in listed_set and not dependents,
            "previous_version": (update or {}).get("from"),
            "updated_this_session": bool(update and update.get("from")),
            "workshop_url": f"https://reforger.armaplatform.com/workshop/{mod_id}",
        }

    def owners_of(resource: str) -> List[Dict[str, Any]]:
        hits = owners.get(addon_index._normalize_resource(resource)) or []
        # When several addons ship the same path, the engine's spelling
        # identifies the copy it actually used.
        return [h for h in hits if h["exact_case"]] or hits

    for finding in relevant:
        content = finding.get("content_resources") or []
        stack = finding.get("stack_resources")
        for resource in finding.get("resources") or []:
            if stack is not None and resource in stack:
                continue
            hits = owners_of(resource)
            if finding["kind"] == "missing_class" and len(hits) > 3:
                # A base prefab that many mods override: the owner list says
                # nothing about which override references the missing class.
                continue
            if resource in content:
                role = "content"
            elif finding["kind"] == "scenario_unavailable":
                role = "scenario"
            else:
                role = "script"
            for hit in hits:
                add(hit["mod_id"], finding=finding, role=role, resource=resource, exact=bool(hit["exact_case"]))
        # Stack frames run innermost first; base-game frames have no owner, so
        # the first frame an addon ships is the mod code that failed.
        for resource in stack or []:
            hits = owners_of(resource)
            if hits:
                for hit in hits:
                    add(hit["mod_id"], finding=finding, role="script", resource=resource, exact=bool(hit["exact_case"]))
                break
        for mod_id in finding.get("mod_ids") or []:
            role = "unavailable" if finding["kind"] == "workshop_unavailable" else "download"
            add(mod_id, finding=finding, role=role, resource=None, exact=True)
    return list(culprits.values())


# --- remediation ----------------------------------------------------------------

def suggest_actions(primary: Dict[str, Any], culprits: List[Dict[str, Any]], outcome: str) -> List[Dict[str, Any]]:
    """Proposed fixes, most direct first. Each is executable by the rectify route."""
    actions: List[Dict[str, Any]] = []
    kind = primary["kind"]
    code_kinds = {"script_compile_error", "script_vm_exception", "script_exception_loop", "missing_class", "engine_crash"}

    if kind in code_kinds:
        ranked = sorted(culprits, key=lambda c: (c["role"] != "content", not c["exact_case"]))
        for culprit in ranked[:2]:
            if culprit["role"] == "download":
                continue
            if culprit["in_mod_list"] and culprit["previous_version"]:
                actions.append({
                    "type": "pin_version",
                    "mod_id": culprit["mod_id"],
                    "version": culprit["previous_version"],
                    "label": f"Roll {culprit['name']} back to {culprit['previous_version']}",
                    "detail": (
                        f"It was updated to {culprit['installed_version'] or 'a new version'} in this "
                        "session. Pinning the previous version keeps the mod while its author fixes it."
                    ),
                    "restart": True,
                })
            removable = ([culprit["mod_id"]] if culprit["in_mod_list"] else []) + [d["mod_id"] for d in culprit["listed_dependents"]]
            if removable:
                others = len(removable) - (1 if culprit["in_mod_list"] else 0)
                label = f"Remove {culprit['name']} from the mod list" if culprit["in_mod_list"] else f"Remove the {len(removable)} mod(s) that pull in {culprit['name']}"
                if culprit["in_mod_list"] and others:
                    label += f" (and {others} mod(s) that depend on it)"
                actions.append({
                    "type": "remove_mods",
                    "mod_ids": removable,
                    "culprit_id": culprit["mod_id"],
                    "label": label,
                    "detail": (
                        "Removing only the culprit would not help: Reforger downloads a dependency "
                        "again for any listed mod that needs it."
                        if culprit["listed_dependents"] else
                        "A backup and a mod revision are recorded, so this can be undone from Mod History."
                    ),
                    "restart": True,
                })
            elif culprit["orphan"] and culprit["folder"]:
                actions.append({
                    "type": "delete_addon",
                    "mod_id": culprit["mod_id"],
                    "folder": culprit["folder"],
                    "label": f"Delete the leftover {culprit['name']} addon folder",
                    "detail": "It is not in the mod list and no listed mod depends on it, but Reforger still loads it.",
                    "restart": True,
                })
    elif kind == "scenario_unavailable":
        for culprit in culprits:
            if culprit["role"] == "scenario" and not culprit["in_mod_list"]:
                actions.append({
                    "type": "add_mods",
                    "mod_ids": [culprit["mod_id"]],
                    "label": f"Add {culprit['name']} back to the mod list",
                    "detail": "It ships the configured scenario but is no longer in the mod list.",
                    "restart": True,
                })
        actions.append({
            "type": "open_settings",
            "path": "game.scenarioId",
            "label": "Choose a different scenario",
            "detail": primary.get("scenario_id") or "",
        })
    elif kind == "workshop_unavailable":
        for culprit in culprits:
            removable = ([culprit["mod_id"]] if culprit["in_mod_list"] else []) + [d["mod_id"] for d in culprit["listed_dependents"]]
            if not removable:
                continue
            label = f"Remove {culprit['name']}"
            if len(removable) > 1:
                label += f" and {len(removable) - 1} mod(s) that need it"
            actions.append({
                "type": "remove_mods",
                "mod_ids": removable,
                "culprit_id": culprit["mod_id"],
                "label": label + " from the mod list",
                "detail": "The Workshop will not serve it, so the server cannot start with it listed.",
                "restart": True,
            })
    elif kind == "server_config_invalid":
        for param in primary.get("config_params") or []:
            actions.append({
                "type": "open_settings",
                "path": param["path"],
                "label": f"Fix {param['path']} in Server Settings",
                "detail": param["problem"],
            })
    elif kind == "workshop_download_failed":
        actions.append({
            "type": "restart",
            "label": "Restart to retry the download",
            "detail": "Workshop and CDN hiccups are usually transient.",
        })

    if outcome in {"failed_to_start", "crashed_runtime"}:
        actions.append({
            "type": "stop",
            "label": "Stop the server",
            "detail": "Docker restarts a crashed server indefinitely; stopping ends the crash loop while you decide.",
        })
    return actions




# --- per-server entry points ----------------------------------------------------

_FATAL_OUTCOMES = frozenset({"failed_to_start", "crashed_runtime"})
_LIGHT_CACHE: "OrderedDict[tuple, Dict[str, Any]]" = OrderedDict()
_LIGHT_CACHE_MAX = 128

# Highest-signal engine lines, used to rank raw docker-log errors when no
# session directory is readable. Order matters: first match wins.
_LINE_PRIORITY: Tuple[Tuple[re.Pattern, int], ...] = (
    (_COMPILE_HEAD_RE, 100),
    (_COMPILE_DETAIL_LOG_RE, 100),
    (re.compile(r'Param "#/'), 98),
    (_MISSION_HEADER_RE, 97),
    (_NOT_DOWNLOADABLE_RE, 96),
    (_DEPS_UNRESOLVABLE_RE, 96),
    (_VME_HEAD_RE, 90),
    (re.compile(r"NULL pointer to instance"), 80),
    (_UNKNOWN_CLASS_RE, 40),
    (_FATAL_GENERIC_RE, 10),
)


def line_priority(line: str) -> int:
    """How strongly one raw log line points at a root cause (noise is -1)."""
    if classify_noise(line):
        return -1
    for pattern, score in _LINE_PRIORITY:
        if pattern.search(line):
            return score
    return 0


def resolve_server_dirs(server: Dict[str, Any]) -> Tuple[Optional[Path], Optional[Path]]:
    """``(profile/logs, workshop addons dir)`` for a managed-server record."""
    profile = str(server.get("profile_path") or "").replace("\\", "/").rstrip("/")
    workshop = str(server.get("workshop_path") or "").replace("\\", "/").rstrip("/")
    logs_root = Path(profile) / "logs" if profile else None
    addons_dir: Optional[Path] = None
    if workshop:
        candidate = Path(workshop) / "addons"
        addons_dir = candidate if candidate.is_dir() else Path(workshop)
    return logs_root, addons_dir


def _file_signature(path: Path) -> Tuple[int, int]:
    try:
        stat = path.stat()
        return int(stat.st_mtime), stat.st_size
    except OSError:
        return 0, 0


def _light_summary(session_dir: Path, is_latest: bool, running: bool) -> Dict[str, Any]:
    key = (
        str(session_dir), is_latest, running,
        _file_signature(session_dir / "console.log"), _file_signature(session_dir / "crash.log"),
    )
    cached = _LIGHT_CACHE.get(key)
    if cached is not None:
        _LIGHT_CACHE.move_to_end(key)
        return cached
    result = analyze_session(session_dir, is_latest=is_latest, running=running)
    primary = result.get("primary") or {}
    summary = {
        "session": result["session"],
        "started_at": result["started_at"],
        "outcome": result["outcome"],
        "online": result["online"],
        "kind": primary.get("kind"),
        "title": primary.get("title"),
        "summary": primary.get("summary"),
    }
    _LIGHT_CACHE[key] = summary
    while len(_LIGHT_CACHE) > _LIGHT_CACHE_MAX:
        _LIGHT_CACHE.popitem(last=False)
    return summary


def diagnose_server(
    server: Dict[str, Any],
    *,
    session: Optional[str] = None,
    running: bool = False,
    max_sessions: int = 8,
) -> Dict[str, Any]:
    """Recent session outcomes plus a full diagnosis of the session that matters.

    Without an explicit ``session`` this picks the newest session that failed.
    When a later session has since come online the diagnosis is marked
    ``stale``: it explains what happened, but its fixes may no longer apply.
    """
    logs_root, addons_dir = resolve_server_dirs(server)
    dirs = list_session_dirs(logs_root) if logs_root else []
    recent = dirs[:max_sessions]
    sessions = [
        _light_summary(path, is_latest=(index == 0), running=running)
        for index, path in enumerate(recent)
    ]
    if not dirs:
        return {"sessions": [], "diagnosis": None, "logs_root": str(logs_root) if logs_root else None}

    target: Optional[Path] = None
    if session:
        target = next((p for p in dirs if p.name == session), None)
        if target is None:
            raise FileNotFoundError(session)
    else:
        failed = next((recent[i] for i, s in enumerate(sessions) if s["outcome"] in _FATAL_OUTCOMES), None)
        target = failed or recent[0]

    is_latest = target == dirs[0]
    diagnosis = analyze_session(
        target, addons_dir=addons_dir, mods=server.get("mods") or [],
        is_latest=is_latest, running=running,
    )
    names = [s["session"] for s in sessions]
    position = names.index(target.name) if target.name in names else None
    recovered = next((s for s in sessions[:position or 0] if s["online"]), None)
    diagnosis["stale"] = bool(recovered)
    diagnosis["recovered_in"] = recovered["session"] if recovered else None
    # The engine writes one session per boot, so consecutive failures with
    # the same signature are one crash loop, not separate problems.
    repeats = 0
    kind = (diagnosis.get("primary") or {}).get("kind")
    for summary in sessions[position:] if position is not None else []:
        if summary["outcome"] not in _FATAL_OUTCOMES or summary["kind"] != kind:
            break
        repeats += 1
    diagnosis["repeat_count"] = repeats
    return {"sessions": sessions, "diagnosis": diagnosis, "logs_root": str(logs_root)}
