"""Healthy server start-up lines must not open mod issues or config alerts.

A fresh server once showed 54 "mod issues" and a "Configuration Error"
alert came from lines every healthy start prints. "stall" matched "Installing",
"fps" matched the engine's stats line, "schema" matched "JSON Schema Validation:".
"""
import pytest

from services.log_monitor import parse_log_line
from services.mod_issue_engine import _classify_entry

HEALTHY = [
    "[----] Installing update...",
    "[----] Verifying installation...",
    "\x1b[0mSuccess! App '1874900' fully installed.",
    "[ 45%] Downloading update (512 of 1,024 KB)...",
    "WARNING: setlocale('en_US.UTF-8') failed, using locale: 'C'. International characters may not work.",
    'ILocalize::AddFile() failed to load file "public/steambootstrapper_english.txt".',
    " BACKEND      : JSON Schema Validation:",
    "  BACKEND      : JSON is Valid",
    "  DEFAULT      : FPS: 120.0, frame time (avg: 8.3 ms, min: 7.3 ms, max: 9.1 ms), Mem: 1007803 kB, Player: 0",
]

FAULTS = [
    ("  BACKEND (E): JSON is invalid!", "config"),
    ("SCRIPT (E): NULL pointer exception in Function 'OnInit'", "runtime-script"),
    ("WORKSHOP: download failed for 5AAAC70D754245DD", "workshop-download"),
    ("ENGINE: server thread stalled for 4500 ms", "performance"),
]


@pytest.mark.parametrize("line", HEALTHY)
def test_healthy_lines_open_no_mod_issue(line):
    assert _classify_entry({"line": line}) is None


@pytest.mark.parametrize("line,category", FAULTS)
def test_real_faults_still_open_one(line, category):
    classified = _classify_entry({"line": line})
    assert classified and classified["source_category"] == category


def test_config_check_heading_is_not_a_config_error():
    for line in (" BACKEND      : JSON Schema Validation:", "  BACKEND      : JSON is Valid"):
        parsed = parse_log_line(line)
        assert not parsed or parsed.get("category") != "config-error"
    parsed = parse_log_line("  BACKEND (E): JSON is invalid!")
    assert parsed and parsed["category"] in {"config-error", "backend-error"}
