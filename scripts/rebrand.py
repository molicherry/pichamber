#!/usr/bin/env python3
"""
Rebrand the vendored openchamber UI to pichamber:
  OpenChamber -> pichamber
  OpenCode    -> pi

Rules (learned the hard way — see the 2026-08-28 rebrand work):
- i18n messages: only replace the VALUE side (right of ':'), NEVER the key.
  Keys are camelCase (aboutOpenChamber, reloadOpenCode) and must stay stable so
  the UI's t('...') lookups keep resolving.
- Component files: replace brand words inside string literals only. Never touch
  code identifiers (OpenChamberLogo, initializeNewOpenChamberSession), import
  paths, or comments (comments describe real opencode behavior and must stay).

Idempotent: re-running on already-rebranded code is a no-op.
Usage: python3 scripts/rebrand.py
"""

import glob
import re

ROOT = "packages/ui/src"
I18N_DIR = f"{ROOT}/lib/i18n"

BRAND_RE = re.compile(r"\bOpenChamber\b|\bOpenCode\b")
STR_RE = re.compile(r"""'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.)*`""")


def replace_brands(text: str) -> str:
    return BRAND_RE.sub(lambda m: "pichamber" if m.group(0) == "OpenChamber" else "pi", text)


def read_lines(path: str):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.readlines()
    except OSError:
        return []


def write_lines(path: str, lines) -> None:
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.writelines(lines)
    except OSError:
        pass


def rebrand_i18n() -> int:
    files = [f for f in glob.glob(f"{I18N_DIR}/**/*.ts", recursive=True) if not f.endswith(".test.ts")]
    changed = 0
    for f in files:
        lines = read_lines(f)
        out = []
        for line in lines:
            if ":" in line:
                left, right = line.split(":", 1)
                new_right = replace_brands(right)
                if new_right != right:
                    changed += 1
                out.append(left + ":" + new_right)
            else:
                out.append(line)
        write_lines(f, out)
    return changed


def rebrand_components() -> int:
    files = []
    for ext in ("ts", "tsx"):
        files += glob.glob(f"{ROOT}/**/*.{ext}", recursive=True)
    files = [f for f in files if ".test." not in f and "__tests__" not in f and "/lib/i18n/" not in f]
    changed = 0
    for f in files:
        lines = read_lines(f)
        out = []
        for line in lines:
            stripped = line.lstrip()
            if stripped.startswith(("//", "*", "/*", "/**")):
                out.append(line)
                continue
            head, sep, tail = line.partition("//")
            new_head = STR_RE.sub(lambda m: replace_brands(m.group(0)), head)
            if new_head != head:
                changed += 1
            out.append(new_head + (sep + tail if sep else ""))
        write_lines(f, out)
    return changed


if __name__ == "__main__":
    n1 = rebrand_i18n()
    n2 = rebrand_components()
    print(f"rebrand done: {n1} i18n value substitutions, {n2} component string-literal substitutions")
