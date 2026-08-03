#!/usr/bin/env python3
"""Re-derive every verdict in data/captures.json from the raw HTML, in another language.

This shares no code with the diff engine. Different language, different HTML parser
(CPython's html.parser rather than the hand-written one in src/html.js), different tree
representation, different comparison. A bug in src/html.js or src/diff.js cannot be present
here, which is the only way a check can catch it.

Four independent derivations, in increasing order of how much they would embarrass the engine:

  1. Grounding. Every value the engine claims to have found on a side must literally occur in
     that side's raw HTML. No tree logic involved: if the engine says the DOM held "epoch
     1785762873155" then that string is in the DOM's bytes or the engine invented it.

  2. Verdict. Parse both sides here, normalise here, compare here, and require the same
     yes/no answer about whether the hydration root differs.

  3. Third opinion. React's own onRecoverableError was recorded during the run. It must agree
     with both of the above about which runs are broken.

  4. Freshness. The recording must cover every scenario file on disk, so a scenario added
     without re-running cannot pass unexamined.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
CAPTURES = ROOT / "data" / "captures.json"

VOID = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}
RAW_TEXT = {"script", "style"}
# React writes an empty comment between adjacent text children, and marks suspense boundaries
# with these. None of it is content.
DROPPED_COMMENTS = {"", " ", "$", "/$", "$!", "$?", "&", "/&"}

passed = 0
failed = 0


def ok(msg: str) -> None:
    global passed
    print(f"  ok    {msg}")
    passed += 1


def bad(msg: str) -> None:
    global failed
    print(f"  FAIL  {msg}")
    failed += 1


class Element:
    __slots__ = ("tag", "attrs", "children")

    def __init__(self, tag: str, attrs: dict[str, str]):
        self.tag = tag
        self.attrs = attrs
        self.children: list[object] = []


class Comment:
    __slots__ = ("data",)

    def __init__(self, data: str):
        self.data = data


def normalise_style(value: str) -> str:
    out = []
    for decl in value.split(";"):
        decl = decl.strip()
        if not decl:
            continue
        if ":" in decl:
            prop, _, val = decl.partition(":")
            out.append(f"{prop.strip().lower()}:{val.strip()}")
        else:
            out.append(decl)
    return ";".join(out)


def normalise_attrs(attrs: dict[str, str]) -> tuple[tuple[str, str], ...]:
    out = {}
    for name, value in attrs.items():
        name = name.lower()
        if value is None:
            value = ""
        if name == "style":
            value = normalise_style(value)
        elif name == "class":
            value = " ".join(value.split())
        out[name] = value
    return tuple(sorted(out.items()))


class Builder(HTMLParser):
    """A literal tree builder. Like src/html.js it never repairs, but it is written from the
    HTMLParser callbacks rather than from a hand-rolled scanner."""

    def __init__(self) -> None:
        # convert_charrefs makes CPython decode entities, which is a genuinely separate
        # implementation of the piece src/html.js does by hand.
        super().__init__(convert_charrefs=True)
        self.root = Element("#document", {})
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        el = Element(tag, {k: (v if v is not None else "") for k, v in attrs})
        self.stack[-1].children.append(el)
        if tag not in VOID:
            self.stack.append(el)

    def handle_startendtag(self, tag, attrs):
        el = Element(tag, {k: (v if v is not None else "") for k, v in attrs})
        self.stack[-1].children.append(el)

    def handle_endtag(self, tag):
        for depth in range(len(self.stack) - 1, 0, -1):
            if self.stack[depth].tag == tag:
                del self.stack[depth:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(data)

    def handle_comment(self, data):
        self.stack[-1].children.append(Comment(data))


def build(html: str) -> Element:
    parser = Builder()
    parser.feed(html)
    parser.close()
    return parser.root


def condense(node: Element) -> list[object]:
    """Drop the comments that are not content and merge adjacent text."""
    out: list[object] = []
    for child in node.children:
        if isinstance(child, Comment):
            if child.data in DROPPED_COMMENTS:
                continue
            out.append(child)
        elif isinstance(child, str):
            if child == "":
                continue
            if out and isinstance(out[-1], str):
                out[-1] = out[-1] + child
            else:
                out.append(child)
        else:
            out.append(child)
    return out


def facts(node: Element, path: str = "", acc: list[tuple] | None = None) -> list[tuple]:
    """A canonical, order-preserving list of everything the tree asserts."""
    if acc is None:
        acc = []
    kids = condense(node)
    counts: dict[str, int] = {}
    for child in kids:
        if isinstance(child, Element):
            kind = child.tag
        elif isinstance(child, Comment):
            kind = "#comment"
        else:
            kind = "#text"
        n = counts.get(kind, 0)
        counts[kind] = n + 1
        here = f"{path}/{kind}[{n}]"
        if isinstance(child, Element):
            acc.append(("element", here, child.tag, normalise_attrs(child.attrs)))
            if child.tag in RAW_TEXT:
                text = "".join(c for c in child.children if isinstance(c, str))
                acc.append(("raw", here, text))
            else:
                facts(child, here, acc)
        elif isinstance(child, Comment):
            acc.append(("comment", here, child.data))
        else:
            acc.append(("text", here, child))
    return acc


def find_root(node: Element) -> Element | None:
    if isinstance(node, Element) and node.attrs.get("id") == "root":
        return node
    for child in getattr(node, "children", []):
        if isinstance(child, Element):
            found = find_root(child)
            if found is not None:
                return found
    return None


def root_facts(html: str, label: str) -> list[tuple] | None:
    tree = build(html)
    root = find_root(tree)
    if root is None:
        bad(f"{label}: no element with id=root, so nothing could be compared")
        return None
    return facts(root)


def main() -> int:
    if not CAPTURES.exists():
        print(f"  FAIL  {CAPTURES.relative_to(ROOT)} does not exist. Run: node scripts/assert-scenarios.mjs")
        return 1
    data = json.loads(CAPTURES.read_text())
    captures = data["captures"]

    # 4. Freshness, first, because a stale recording makes everything else meaningless.
    on_disk = {
        p.stem
        for p in (ROOT / "scenarios").glob("*.js")
        if p.name != "index.js"
    }
    recorded = {c["scenario"]["id"] for c in captures}
    if on_disk == recorded:
        ok(f"the recording covers all {len(on_disk)} scenario files on disk")
    else:
        bad(
            "the recording does not match the scenarios on disk "
            f"(only on disk: {sorted(on_disk - recorded)}, only recorded: {sorted(recorded - on_disk)})"
        )

    agree_engine = 0
    agree_react = 0
    grounded = 0
    for capture in captures:
        label = f"{capture['scenario']['id']}/{capture['variant']}"
        html = capture["html"]
        # preHydrationBody is a whole <body>, so find_root does the scoping.
        dom_facts = root_facts(html["preHydrationBody"], f"{label} dom")
        render_facts = root_facts(f'<div id="root">{html["clientRender"]}</div>', f"{label} render")
        if dom_facts is None or render_facts is None:
            continue

        python_says_mismatch = dom_facts != render_facts
        engine_says_mismatch = capture["counts"]["hydration"] > 0
        react_says_mismatch = len(capture["react"]["recoverable"]) > 0

        if python_says_mismatch == engine_says_mismatch:
            agree_engine += 1
        else:
            bad(
                f"{label}: this checker says mismatch={python_says_mismatch} "
                f"and the engine says {engine_says_mismatch}"
            )
            if python_says_mismatch:
                only_dom = [f for f in dom_facts if f not in render_facts][:3]
                only_render = [f for f in render_facts if f not in dom_facts][:3]
                for f in only_dom:
                    print(f"        only in the DOM:    {str(f)[:140]}")
                for f in only_render:
                    print(f"        only in the render: {str(f)[:140]}")

        if python_says_mismatch == react_says_mismatch:
            agree_react += 1
        else:
            bad(
                f"{label}: this checker says mismatch={python_says_mismatch} "
                f"and React itself reported {react_says_mismatch}"
            )

        # 1. Grounding, against raw bytes.
        problems = []
        for op in capture["diffs"]["hydration"]["ops"]:
            if op["scope"] != "in-root":
                continue
            if op["kind"] == "text-changed":
                if op["left"] not in html["preHydrationBody"]:
                    problems.append(f"text {op['left']!r} is not in the DOM")
                if op["right"] not in html["clientRender"]:
                    problems.append(f"text {op['right']!r} is not in the client render")
            elif op["kind"] == "attr-changed":
                # The attribute NAME is matched case-insensitively on purpose. React's server
                # output spells some attributes in camelCase (`dateTime`, `readOnly`) while the
                # DOM lowercases them, and this check found that difference the first time it
                # ran. The engine folds the case; the grounding check only cares that the value
                # is really there.
                for side, raw in (("DOM", html["preHydrationBody"]), ("client render", html["clientRender"])):
                    want = op["left"] if side == "DOM" else op["right"]
                    pattern = re.compile(
                        re.escape(op["attr"]) + r'\s*=\s*"' + re.escape(want) + '"',
                        re.IGNORECASE,
                    )
                    if not pattern.search(raw):
                        problems.append(f'{op["attr"]}="{want}" is not in the {side}')
        if problems:
            bad(f"{label}: {len(problems)} reported value(s) do not appear in the raw HTML")
            for p in problems[:4]:
                print(f"        {p}")
        else:
            grounded += 1

        # The parser-repair claim, checked without any tree comparison at all.
        if capture["counts"]["repair"] > 0:
            emitted = html["serverEmitted"]
            if emitted in html["parsedBody"]:
                bad(f"{label}: the engine claims a parser repair but the DOM contains the emitted string verbatim")
            else:
                ok(f"{label}: the emitted string does not occur in the DOM, so it really was restructured")

    if agree_engine == len(captures):
        ok(f"an independent parse and comparison agrees with the engine on all {len(captures)} runs")
    if agree_react == len(captures):
        ok(f"React's own error reporting agrees with this checker on all {len(captures)} runs")
    if grounded == len(captures):
        ok(f"every reported text and attribute value occurs in the raw HTML of its own side ({grounded} runs)")

    print(f"  {passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
