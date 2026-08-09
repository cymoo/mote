#!/usr/bin/env python3
"""mote — CLI for the mote memo server (https://github.com/cymoo/mote).

Pure standard library, Python 3.9+. Content is authored/read as Markdown;
the script converts to/from mote's Slate-style HTML internally.

Config: env MOTE_BASE_URL / MOTE_TOKEN override ~/.config/mote/config.json
        ({"base_url": "...", "token": "..."}).
"""

import argparse
import json
import mimetypes
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "mote" / "config.json"
PAGE_SIZE = 10  # hardcoded server-side
FETCH_CAP = 1000  # safety cap for --all / bulk operations
COLORS = ("red", "green", "blue")


class CLIError(Exception):
    pass


# ---------------------------------------------------------------------------
# Config + HTTP
# ---------------------------------------------------------------------------

_config = None  # (base_url, token)


def load_config():
    global _config
    if _config:
        return _config
    base = os.environ.get("MOTE_BASE_URL")
    token = os.environ.get("MOTE_TOKEN")
    if not base or not token:
        if CONFIG_PATH.exists():
            try:
                cfg = json.loads(CONFIG_PATH.read_text())
            except (json.JSONDecodeError, OSError) as e:
                raise CLIError(f"cannot read {CONFIG_PATH}: {e}")
            base = base or cfg.get("base_url")
            token = token or cfg.get("token")
    if not base or not token:
        raise CLIError(
            "missing configuration. Either set MOTE_BASE_URL and MOTE_TOKEN, or create "
            f"{CONFIG_PATH} with:\n"
            '  {"base_url": "https://your-mote-host", "token": "<MOTE_PASSWORD>"}\n'
            f"then: chmod 600 {CONFIG_PATH}"
        )
    base = base.rstrip("/")
    if base.endswith("/api"):
        base = base[: -len("/api")]
    _config = (base, token)
    return _config


def api(method, path, query=None, body=None, data=None, content_type=None, timeout=30):
    """Call the mote API. Returns parsed JSON, or None for 204/empty responses."""
    base, token = load_config()
    url = f"{base}/api/{path}"
    if query:
        pairs = []
        for k, v in query.items():
            if v is None:
                continue
            if isinstance(v, bool):
                v = "true" if v else "false"
            pairs.append((k, str(v)))
        if pairs:
            url += "?" + urllib.parse.urlencode(pairs)
    headers = {"Authorization": f"Bearer {token}"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    elif data is not None and content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read()
            if not payload:
                return None
            return json.loads(payload)
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("message", e.reason)
        except Exception:
            msg = e.reason
        raise CLIError(f"HTTP {e.code}: {msg}")
    except urllib.error.URLError as e:
        raise CLIError(f"cannot reach {base}: {e.reason}")


# ---------------------------------------------------------------------------
# Markdown -> HTML (targets mote's closed Slate element set)
# ---------------------------------------------------------------------------

_BLOCK_START = re.compile(r"^(#{1,6}\s|```|>|\s*(?:[-*+]|\d+[.)])\s|\|)")


def _esc(text):
    # Mirror the frontend serializer: only < and > are escaped.
    return text.replace("<", "&lt;").replace(">", "&gt;")


def _esc_attr(text):
    return text.replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


class _Stash:
    """Placeholder store protecting fragments from later regex passes."""

    def __init__(self):
        self.items = []

    def put(self, fragment):
        self.items.append(fragment)
        return f"\x00{len(self.items) - 1}\x01"

    def restore(self, text):
        pattern = re.compile(r"\x00(\d+)\x01")
        while pattern.search(text):
            text = pattern.sub(lambda m: self.items[int(m.group(1))], text)
        return text


# A '#' starts a tag unless it directly follows a word character (blocks "C#",
# "page#anchor"). Mirrors the editor's rule (start / space / punctuation), but
# also accepts CJK and bracket punctuation such as 。 ” 》 — which the editor's
# fixed specialChars list misses.
_HASHTAG_MD = re.compile(r"(?<!\w)#([\w/-]+)")
_BARE_URL = re.compile(r"https?://[^\s<>()\[\]]+")


def _inline(text):
    stash = _Stash()
    # 1. backslash escapes -> literal char
    text = re.sub(
        r"\\([\\`*_#\[\]~])", lambda m: stash.put(_esc(m.group(1))), text
    )
    # 2. inline code spans
    text = re.sub(
        r"`([^`]+)`", lambda m: stash.put(f"<code>{_esc(m.group(1))}</code>"), text
    )
    # 3. bare URLs (protects '#fragment' from becoming a tag)
    text = _BARE_URL.sub(lambda m: stash.put(m.group(0)), text)
    # 4. escape < >
    text = _esc(text)
    # 5. links (URL protected from emphasis/hashtag passes)
    def _link(m):
        inner = _emphasis(m.group(1), stash)
        href = _esc_attr(m.group(2))
        return stash.put(
            f'<a href="{href}" target="_blank" rel="noreferrer nofollow">{inner}</a>'
        )

    text = re.sub(r"\[([^\]]*)\]\(([^)\s]+)\)", _link, text)
    # 6. emphasis
    text = _emphasis(text, stash)
    # 7. hash tags: #name, #a/b/c
    text = _HASHTAG_MD.sub(
        lambda m: stash.put(f'<span class="hash-tag">#{m.group(1)}</span>'), text
    )
    return stash.restore(text)


def _emphasis(text, stash):
    text = re.sub(
        r"\*\*\*([^*]+)\*\*\*",
        lambda m: stash.put(f"<em><strong>{m.group(1)}</strong></em>"),
        text,
    )
    text = re.sub(
        r"\*\*([^*]+)\*\*", lambda m: stash.put(f"<strong>{m.group(1)}</strong>"), text
    )
    text = re.sub(r"\*([^*\s][^*]*)\*", lambda m: stash.put(f"<em>{m.group(1)}</em>"), text)
    text = re.sub(
        r"(?<![\w_])__([^_]+)__(?![\w_])",
        lambda m: stash.put(f"<strong>{m.group(1)}</strong>"),
        text,
    )
    text = re.sub(
        r"(?<![\w_])_([^_]+)_(?![\w_])",
        lambda m: stash.put(f"<em>{m.group(1)}</em>"),
        text,
    )
    text = re.sub(
        r"~~([^~]+)~~", lambda m: stash.put(f"<del>{m.group(1)}</del>"), text
    )
    return text


def md_to_html(md):
    lines = md.replace("\r\n", "\n").split("\n")
    return "".join(_render_block(b) for b in _parse_blocks(lines))


def _parse_blocks(lines):
    blocks = []
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        # fenced code block
        m = re.match(r"^(`{3,})\s*(\S*)\s*$", line)
        if m:
            fence = m.group(1)
            code = []
            i += 1
            while i < n and not lines[i].startswith(fence):
                code.append(lines[i])
                i += 1
            i += 1  # closing fence (or EOF)
            blocks.append(("code", "\n".join(code)))
            continue
        # heading (Slate supports h1-h5; ###### maps to h5)
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            blocks.append(("heading", min(len(m.group(1)), 5), m.group(2).strip()))
            i += 1
            continue
        # blockquote
        if line.startswith(">"):
            inner = []
            while i < n and lines[i].startswith(">"):
                inner.append(re.sub(r"^> ?", "", lines[i]))
                i += 1
            blocks.append(("quote", _parse_blocks(inner)))
            continue
        # task list item (top-level check-list)
        m = re.match(r"^[-*+] \[([ xX])\]\s+(.*)$", line)
        if m:
            blocks.append(("check", m.group(1).lower() == "x", m.group(2)))
            i += 1
            continue
        # table: header row + separator row
        if (
            line.lstrip().startswith("|")
            and i + 1 < n
            and re.match(r"^\s*\|[\s|:\-]+\|?\s*$", lines[i + 1])
        ):
            tbl = []
            while i < n and lines[i].lstrip().startswith("|"):
                tbl.append(lines[i])
                i += 1
            blocks.append(("table", tbl))
            continue
        # list (ordered/unordered, nesting via indentation)
        if re.match(r"^\s*(?:[-*+]|\d+[.)])\s+", line):
            items = []
            while i < n:
                lm = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", lines[i])
                if not lm:
                    break
                items.append((len(lm.group(1)), lm.group(2), lm.group(3)))
                i += 1
            blocks.append(("list", items))
            continue
        # block-level image, optional *caption* on the following line
        m = re.match(r"^!\[([^\]]*)\]\(([^)\s]+)\)\s*$", line)
        if m:
            caption = None
            if i + 1 < n:
                cm = re.match(r"^\*([^*]+)\*\s*$", lines[i + 1])
                if cm:
                    caption = cm.group(1).strip()
            blocks.append(("image", m.group(2), m.group(1), caption))
            i += 2 if caption else 1
            continue
        # raw HTML passthrough (roundtrip escape hatch)
        if re.match(r"^</?[a-zA-Z][^>]*>", line.strip()):
            raw = []
            while i < n and lines[i].strip():
                raw.append(lines[i])
                i += 1
            blocks.append(("raw", "\n".join(raw)))
            continue
        # paragraph
        para = [line]
        i += 1
        while i < n and lines[i].strip() and not _BLOCK_START.match(lines[i]):
            para.append(lines[i])
            i += 1
        blocks.append(("para", para))
    return blocks


def _render_block(b):
    kind = b[0]
    if kind == "para":
        return "<p>" + "<br>".join(_inline(l) for l in b[1]) + "</p>"
    if kind == "heading":
        return f"<h{b[1]}>{_inline(b[2])}</h{b[1]}>"
    if kind == "code":
        return f"<pre><code>{_esc(b[1])}</code></pre>"
    if kind == "quote":
        return "<blockquote>" + "".join(_render_block(x) for x in b[1]) + "</blockquote>"
    if kind == "check":
        chk = " checked" if b[1] else ""
        return (
            f'<div class="check-list"><input type="checkbox"{chk} disabled/>'
            f"<label>{_inline(b[2])}</label></div>"
        )
    if kind == "image":
        _, url, alt, caption = b
        alt_attr = f' alt="{_esc_attr(alt)}"' if alt else ""
        cap = f"<figcaption>{_inline(caption)}</figcaption>" if caption else ""
        return f'<figure><img src="{_esc_attr(url)}"{alt_attr} loading="lazy"/>{cap}</figure>'
    if kind == "raw":
        return b[1]
    if kind == "list":
        return _render_list(b[1])
    if kind == "table":
        return _render_table(b[1])
    raise AssertionError(f"unknown block {kind}")


def _render_list(items):
    html = ""
    pos = 0
    while pos < len(items):
        part, pos = _build_list(items, pos, items[pos][0])
        html += part
    return html


def _build_list(items, pos, indent):
    ordered = items[pos][1][0].isdigit()
    start = int(re.match(r"\d+", items[pos][1]).group(0)) if ordered else None
    lis = []
    while pos < len(items):
        ind, marker, text = items[pos]
        if ind < indent:
            break
        if ind > indent:
            sub, pos = _build_list(items, pos, ind)
            if lis:
                lis[-1] += sub
            else:  # over-indented first item; tolerate
                lis.append(sub)
            continue
        if marker[0].isdigit() != ordered:
            break  # list type switch at same level -> sibling list
        m = re.match(r"^\[([ xX])\]\s+(.*)$", text)
        if m:  # task item nested in a list
            chk = " checked" if m.group(1).lower() == "x" else ""
            lis.append(
                f'<div class="check-list"><input type="checkbox"{chk} disabled/>'
                f"<label>{_inline(m.group(2))}</label></div>"
            )
        else:
            lis.append(f"<p>{_inline(text)}</p>")
        pos += 1
    body = "".join(f"<li>{c}</li>" for c in lis)
    if ordered:
        attr = f' start="{start}"' if start and start != 1 else ""
        return f"<ol{attr}>{body}</ol>", pos
    return f"<ul>{body}</ul>", pos


def _split_row(line):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", line)]


def _render_table(tbl_lines):
    header = _split_row(tbl_lines[0])
    aligns = []
    for cell in _split_row(tbl_lines[1]):
        if cell.startswith(":") and cell.endswith(":"):
            aligns.append("center")
        elif cell.endswith(":"):
            aligns.append("right")
        elif cell.startswith(":"):
            aligns.append("left")
        else:
            aligns.append(None)
    def cell_html(tag, text, idx):
        align = aligns[idx] if idx < len(aligns) else None
        style = f' style="text-align:{align}"' if align else ""
        return f"<{tag}{style}>{_inline(text)}</{tag}>"

    thead = (
        "<thead><tr>"
        + "".join(cell_html("th", c, i) for i, c in enumerate(header))
        + "</tr></thead>"
    )
    body_rows = []
    for line in tbl_lines[2:]:
        cells = _split_row(line)
        body_rows.append(
            "<tr>" + "".join(cell_html("td", c, i) for i, c in enumerate(cells)) + "</tr>"
        )
    tbody = f"<tbody>{''.join(body_rows)}</tbody>" if body_rows else ""
    return f"<table>{thead}{tbody}</table>"


# ---------------------------------------------------------------------------
# HTML -> Markdown (mirrors frontend/src/utils/markdown.ts)
# ---------------------------------------------------------------------------

_VOID_TAGS = {"br", "img", "input", "hr", "meta", "link", "source"}


class _Node:
    __slots__ = ("tag", "attrs", "children", "text")

    def __init__(self, tag, attrs=None, text=""):
        self.tag = tag  # None for text nodes
        self.attrs = dict(attrs or [])
        self.children = []
        self.text = text

    def classes(self):
        return (self.attrs.get("class") or "").split()

    def find(self, tag):
        for c in self.children:
            if c.tag == tag:
                return c
            if c.tag is not None:
                found = c.find(tag)
                if found:
                    return found
        return None


class _TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node("root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = _Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in _VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(_Node(tag, attrs))

    def handle_endtag(self, tag):
        for idx in range(len(self.stack) - 1, 0, -1):
            if self.stack[idx].tag == tag:
                del self.stack[idx:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(_Node(None, text=data))


def _parse_html(html):
    builder = _TreeBuilder()
    builder.feed(html)
    return builder.root


def _clean_text(text):
    return re.sub(r"\s+", " ", text).replace("\xa0", " ")


def _raw_text(node):
    """Concatenated text content, whitespace preserved (for <pre>)."""
    if node.tag is None:
        return node.text.replace("\xa0", " ")
    return "".join(_raw_text(c) for c in node.children)


def _serialize(node):
    """Re-serialize an unrecognized node back to HTML (passthrough)."""
    if node.tag is None:
        return _esc(node.text)
    attrs = "".join(f' {k}="{v}"' if v is not None else f" {k}" for k, v in node.attrs.items())
    if node.tag in _VOID_TAGS and not node.children:
        return f"<{node.tag}{attrs}/>"
    inner = "".join(_serialize(c) for c in node.children)
    return f"<{node.tag}{attrs}>{inner}</{node.tag}>"


_MD_HEADINGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
_MD_INLINE_WRAP = {"strong": "**", "b": "**", "em": "*", "i": "*", "del": "~~", "s": "~~"}


def _inline_md(children):
    out = []
    after_tag = False  # previous piece was a hash tag

    def push(text, is_tag=False):
        """Append a rendered piece, keeping hash tags whitespace-separated.

        Adjacent hash-tag spans and tag-then-text carry no separator in the
        stored HTML (`<span>#a</span><span>#b</span>`). Emitting that verbatim
        would produce `#a#b`, which on write-back parses as a single tag and
        silently drops the rest — so a space is inserted on either side.
        """
        nonlocal after_tag
        if not text:
            return
        prev = out[-1] if out else ""
        if is_tag:
            if prev and not prev[-1].isspace():
                out.append(" ")
        elif after_tag and not text[0].isspace():
            out.append(" ")
        out.append(text)
        after_tag = is_tag

    for node in children:
        if node.tag is None:
            push(_clean_text(node.text))
        elif node.tag == "br":
            push("\n")
        elif node.tag in _MD_INLINE_WRAP:
            inner = _inline_md(node.children).strip()
            mark = _MD_INLINE_WRAP[node.tag]
            push(f"{mark}{inner}{mark}" if inner else "")
        elif node.tag == "code":
            code = _raw_text(node)
            fence = "``" if "`" in code else "`"
            push(f"{fence}{code}{fence}")
        elif node.tag in ("u", "mark", "label", "span", "font"):
            if node.tag == "span" and "hash-tag" in node.classes():
                push(_clean_text(_raw_text(node)).strip(), is_tag=True)
            else:
                push(_inline_md(node.children))
        elif node.tag == "a":
            text = _inline_md(node.children).strip()
            push(f"[{text}]({node.attrs.get('href', '')})")
        elif node.tag == "img":
            push(f"![{node.attrs.get('alt', '')}]({node.attrs.get('src', '')})")
        elif node.tag == "input":
            pass  # checkbox handled by parents
        else:
            push(_serialize(node))
    return "".join(out)


def _check_list_md(node):
    checked = "x" if node.find("input") is not None and "checked" in node.find("input").attrs else " "
    label = node.find("label")
    text = _inline_md(label.children).strip() if label else _clean_text(_raw_text(node)).strip()
    return f"- [{checked}] {text}"


def _list_md(node, indent=0):
    lines = []
    ordered = node.tag == "ol"
    try:
        num = int(node.attrs.get("start") or 1)
    except ValueError:
        num = 1
    for li in node.children:
        if li.tag != "li":
            continue
        marker = f"{num}. " if ordered else "- "
        num += 1
        inline_parts = []
        sub_blocks = []
        for child in li.children:
            if child.tag in ("ul", "ol"):
                sub_blocks.append(_list_md(child, indent + 2))
            elif child.tag == "div" and "check-list" in child.classes():
                sub_blocks.append(" " * (indent + 2) + _check_list_md(child))
            elif child.tag == "p":
                inline_parts.append(_inline_md(child.children).strip())
            elif child.tag == "input" and child.attrs.get("type") == "checkbox":
                marker += "[x] " if "checked" in child.attrs else "[ ] "
            elif child.tag is None or child.tag not in ("blockquote", "pre", "table", "figure"):
                inline_parts.append(_inline_md([child]))
            else:
                sub_blocks.append(" " * (indent + 2) + _block_md(child).replace("\n", " "))
        text = " ".join(p for p in (s.strip() for s in inline_parts) if p)
        lines.append(" " * indent + marker + text)
        lines.extend(b for b in sub_blocks if b.strip())
    return "\n".join(lines)


def _table_md(node):
    rows = []  # (is_header, [cell_md])
    def walk_rows(parent, in_thead):
        for child in parent.children:
            if child.tag in ("thead", "tbody", "tfoot"):
                walk_rows(child, child.tag == "thead")
            elif child.tag == "tr":
                cells = [c for c in child.children if c.tag in ("th", "td")]
                if not cells:
                    continue
                is_header = in_thead or all(c.tag == "th" for c in cells)
                mds, aligns = [], []
                for c in cells:
                    text = _inline_md(c.children).strip().replace("|", "\\|").replace("\n", " ")
                    mds.append(text)
                    style = c.attrs.get("style") or ""
                    m = re.search(r"text-align:\s*(left|center|right)", style, re.I)
                    align = (m.group(1).lower() if m else c.attrs.get("align", "") or None)
                    aligns.append(align)
                rows.append((is_header, mds, aligns))

    walk_rows(node, False)
    if not rows:
        return ""
    lines = []
    header = next((r for r in rows if r[0]), None)
    ncols = max(len(r[1]) for r in rows)
    if header is None:
        header = (True, [""] * ncols, [None] * ncols)
    body = [r for r in rows if r is not header]
    def fmt_row(cells):
        return "| " + " | ".join(cells + [""] * (ncols - len(cells))) + " |"

    lines.append(fmt_row(header[1]))
    seps = []
    for i in range(ncols):
        align = header[2][i] if i < len(header[2]) else None
        seps.append(
            {"center": ":---:", "right": "---:", "left": ":---"}.get(align, "---")
        )
    lines.append("| " + " | ".join(seps) + " |")
    for r in body:
        lines.append(fmt_row(r[1]))
    return "\n".join(lines)


def _block_md(node):
    tag = node.tag
    if tag is None:
        text = _clean_text(node.text).strip()
        return text or None
    if tag == "p":
        md = _inline_md(node.children)
        md = "\n".join(l.strip() for l in md.split("\n")).strip()
        return md or None  # drop empty paragraphs (matches Turndown)
    if tag in _MD_HEADINGS:
        return "#" * _MD_HEADINGS[tag] + " " + _inline_md(node.children).strip()
    if tag == "blockquote":
        inner = _blocks_md(node.children)
        return "\n".join("> " + l if l.strip() else ">" for l in inner.split("\n"))
    if tag == "pre":
        code = _raw_text(node).strip("\n")
        fence = "````" if "```" in code else "```"
        return f"{fence}\n{code}\n{fence}"
    if tag in ("ul", "ol"):
        return _list_md(node) or None
    if tag == "div" and "check-list" in node.classes():
        return _check_list_md(node)
    if tag in ("figure", "img"):
        img = node if tag == "img" else node.find("img")
        if img is None:
            return _blocks_md(node.children) or None
        md = f"![{img.attrs.get('alt', '')}]({img.attrs.get('src', '')})"
        cap = node.find("figcaption") if tag == "figure" else None
        if cap is not None:
            caption = _clean_text(_raw_text(cap)).strip()
            if caption:
                md += f"\n*{caption}*"
        return md
    if tag == "table":
        return _table_md(node) or None
    if tag == "hr":
        return "---"
    if tag in ("div", "section", "article"):
        return _blocks_md(node.children) or None
    # inline element at block level -> render as a paragraph line
    if tag in _MD_INLINE_WRAP or tag in ("a", "span", "code", "u", "mark", "label"):
        return _inline_md([node]).strip() or None
    return _serialize(node)  # unknown block -> raw HTML passthrough


def _blocks_md(children):
    out = ""
    prev_check = False
    for child in children:
        md = _block_md(child)
        if not md:
            continue
        is_check = child.tag == "div" and "check-list" in child.classes()
        if not out:
            out = md
        elif prev_check and is_check:  # adjacent task items form one list
            out += "\n" + md
        else:
            out += "\n\n" + md
        prev_check = is_check
    return out


def html_to_md(html):
    return _blocks_md(_parse_html(html).children)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def fmt_ts(ms):
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M")


def date_to_ms(date_str, end_of_day=False):
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise CLIError(f"invalid date {date_str!r}, expected YYYY-MM-DD")
    if end_of_day:
        dt = dt + timedelta(days=1) - timedelta(milliseconds=1)
    return int(dt.timestamp() * 1000)


def tz_offset_minutes():
    """JS-style getTimezoneOffset(): UTC minus local, in minutes."""
    return -int((time.altzone if time.daylight and time.localtime().tm_isdst else time.timezone) / 60)


def read_content(args, allow_pipe=True):
    if getattr(args, "content", None) is not None:
        return args.content
    if getattr(args, "file", None):
        return Path(args.file).read_text()
    if getattr(args, "stdin", False) or (allow_pipe and not sys.stdin.isatty()):
        data = sys.stdin.read()
        if not data.strip():
            raise CLIError("stdin was empty — refusing to use empty content")
        return data
    raise CLIError("no content given: use --content, --file, --stdin, or pipe via stdin")


def memo_meta_line(post):
    parts = [f"[{post['id']}]", fmt_ts(post["created_at"])]
    tags = post.get("tags") or []
    if tags:
        parts.append(" ".join("#" + t for t in tags))
    flags = []
    if post.get("color"):
        flags.append(post["color"])
    if post.get("shared"):
        flags.append("shared")
    if post.get("deleted_at"):
        flags.append("deleted")
    files = post.get("files")
    if files:
        flags.append(f"{len(files)} files")
    if post.get("children_count"):
        flags.append(f"{post['children_count']} replies")
    if post.get("score") is not None:
        flags.append(f"score {post['score']:.2f}")
    if post.get("parent"):
        flags.append(f"reply to {post['parent']['id']}")
    if flags:
        parts.append("(" + ", ".join(flags) + ")")
    return " ".join(parts)


_TAG_ONLY_LINE = re.compile(r"^(?:#[\w/-]+[\s,、，]*)+$")


def snippet(md, width=100):
    """First line with real content. Tags already show on the meta line, so a
    leading tag-only line (a very common memo shape) is skipped."""
    lines = [l.strip() for l in md.split("\n") if l.strip()]
    if not lines:
        return "(empty)"
    body = next((l for l in lines if not _TAG_ONLY_LINE.match(l)), lines[0])
    return body if len(body) <= width else body[: width - 1] + "…"


def post_to_json(post, include_html=False):
    out = {k: v for k, v in post.items() if k != "content"}
    out["content_md"] = html_to_md(post.get("content") or "")
    if include_html:
        out["content_html"] = post.get("content")
    if out.get("parent"):
        out["parent"] = post_to_json(out["parent"], include_html)
    return out


def print_posts(posts, as_json, include_html=False):
    if as_json:
        print(json.dumps([post_to_json(p, include_html) for p in posts], ensure_ascii=False, indent=2))
        return
    if not posts:
        print("no memos found")
        return
    for p in posts:
        print(memo_meta_line(p))
        print("    " + snippet(html_to_md(p.get("content") or "")))
    print(f"-- {len(posts)} memo(s)")


def fetch_posts(query, limit):
    """Cursor-paginate get-posts until `limit` collected or exhausted."""
    posts = []
    cursor = query.pop("cursor", None)
    while len(posts) < limit:
        q = dict(query)
        if cursor is not None:
            q["cursor"] = cursor
        page = api("GET", "get-posts", query=q)
        batch = page.get("posts") or []
        posts.extend(batch)
        cursor = page.get("cursor")
        if cursor == -1 or len(batch) < PAGE_SIZE:
            break
    return posts[:limit]


def confirm_or_exit(args, description):
    if not args.yes:
        print(f"DRY RUN: {description}")
        print("re-run with --yes to proceed")
        sys.exit(2)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_check(args):
    base, _ = load_config()
    # NOTE: don't probe /api/auth — nginx marks it `internal;` (it exists only for
    # auth_request on /uploads/), so it 404s from outside. Any authed endpoint
    # validates the token just as well: a bad token gives 401 here.
    counts = api("GET", "get-overall-counts")
    print(f"ok: {base} — {counts['post_count']} memos, {counts['tag_count']} tags, "
          f"{counts['day_count']} active days")


def cmd_list(args):
    query = {}
    if args.tag:
        query["tag"] = args.tag
    if args.deleted:
        query["deleted"] = True
    if args.color:
        query["color"] = args.color
    if args.shared:
        query["shared"] = True
    if args.has_files:
        query["has_files"] = True
    if args.untagged:
        query["untagged"] = True
    if args.parent is not None:
        query["parent_id"] = args.parent
    if args.start:
        query["start_date"] = date_to_ms(args.start)
    if args.end:
        query["end_date"] = date_to_ms(args.end, end_of_day=True)
    if args.order_by:
        query["order_by"] = args.order_by
    if args.asc:
        query["ascending"] = True
    if args.cursor is not None:
        query["cursor"] = args.cursor
    limit = FETCH_CAP if args.all else args.limit
    posts = fetch_posts(query, limit)
    if args.all and len(posts) == FETCH_CAP:
        print(f"warning: hit the {FETCH_CAP}-memo cap; results may be truncated", file=sys.stderr)
    print_posts(posts, args.json)


def cmd_get(args):
    post = api("GET", "get-post", query={"id": args.id})
    if args.json:
        print(json.dumps(post_to_json(post, include_html=args.html), ensure_ascii=False, indent=2))
        return
    print(memo_meta_line(post))
    print(f"    updated {fmt_ts(post['updated_at'])}")
    if post.get("parent"):
        print(f"    parent: {memo_meta_line(post['parent'])}")
    if post.get("files"):
        for f in post["files"]:
            print(f"    file: {f.get('url')}")
    print()
    print(post["content"] if args.html else html_to_md(post["content"]))


def cmd_create(args):
    body = {
        "content": md_to_html(read_content(args)),
        "files": [],
        "color": args.color,
        "shared": bool(args.shared),
        "parent_id": args.parent,
    }
    resp = api("POST", "create-post", body=body)
    print(f"created memo [{resp['id']}]")


def cmd_update(args):
    body = {"id": args.id}
    # full-content replacement is destructive: require an explicit source
    # (a merely-non-tty stdin, e.g. under an agent harness, must not count)
    if args.content is not None or args.file or args.stdin:
        body["content"] = md_to_html(read_content(args, allow_pipe=False))
    if args.color:
        body["color"] = args.color
    elif args.no_color:
        body["color"] = None
    if args.shared:
        body["shared"] = True
    elif args.no_shared:
        body["shared"] = False
    if args.parent is not None:
        body["parent_id"] = args.parent
    elif args.no_parent:
        body["parent_id"] = None
    if len(body) == 1:
        raise CLIError("nothing to update: pass new content and/or flags")
    api("POST", "update-post", body=body)
    print(f"updated memo [{args.id}]")


def cmd_append(args):
    post = api("GET", "get-post", query={"id": args.id})
    md = html_to_md(post["content"]).rstrip()
    addition = read_content(args).strip()
    new_md = (md + "\n\n" + addition) if md else addition
    api("POST", "update-post", body={"id": args.id, "content": md_to_html(new_md)})
    print(f"appended to memo [{args.id}]")


def cmd_delete(args):
    if args.hard:
        confirm_or_exit(args, f"PERMANENTLY delete memo [{args.id}] (cannot be undone)")
        try:
            api("POST", "delete-post", body={"id": args.id, "hard": False})
        except CLIError:
            pass  # already in trash or already soft-deleted
        api("POST", "delete-post", body={"id": args.id, "hard": True})
        print(f"permanently deleted memo [{args.id}]")
    else:
        api("POST", "delete-post", body={"id": args.id, "hard": False})
        print(f"moved memo [{args.id}] to trash (restore with: restore {args.id})")


def cmd_restore(args):
    api("POST", "restore-post", body={"id": args.id})
    # restore silently no-ops on non-deleted posts; verify
    try:
        api("GET", "get-post", query={"id": args.id})
        print(f"restored memo [{args.id}]")
    except CLIError:
        raise CLIError(f"memo [{args.id}] not found after restore — did it exist in the trash?")


def cmd_trash(args):
    if args.trash_action == "list":
        posts = fetch_posts({"deleted": True}, args.limit)
        print_posts(posts, args.json)
    else:  # clear
        posts = fetch_posts({"deleted": True}, FETCH_CAP)
        count = len(posts)
        suffix = "+" if count == FETCH_CAP else ""
        confirm_or_exit(args, f"PERMANENTLY delete {count}{suffix} memo(s) in the trash")
        api("POST", "clear-posts", body={})
        print(f"trash cleared ({count}{suffix} memos permanently deleted)")


def cmd_search(args):
    query = {"query": args.query, "limit": args.limit}
    if not getattr(args, "and_", False):
        query["partial"] = True
    result = api("GET", "search", query=query)
    posts = result.get("posts") or []
    print_posts(posts, args.json)


def cmd_tags(args):
    tags = api("GET", "get-tags")
    if args.json:
        print(json.dumps(tags, ensure_ascii=False, indent=2))
        return
    if not tags:
        print("no tags")
        return
    by_name = {t["name"]: t for t in tags}
    names = set(by_name)
    for name in list(names):  # ensure intermediate path nodes appear
        parts = name.split("/")
        for i in range(1, len(parts)):
            names.add("/".join(parts[:i]))
    for name in sorted(names):
        depth = name.count("/")
        tag = by_name.get(name)
        label = "  " * depth + "#" + name.split("/")[-1] if depth else "#" + name
        if tag:
            sticky = " *sticky*" if tag.get("sticky") else ""
            print(f"{label} ({tag['post_count']}){sticky}")
        else:
            print(label)
    print("-- counts include descendant tags and trashed memos")


def cmd_tag_rename(args):
    api("POST", "rename-tag", body={"name": args.old, "new_name": args.new})
    print(f"renamed tag #{args.old} -> #{args.new} (descendants moved, merged if target existed)")


def cmd_tag_stick(args):
    sticky = not args.off
    api("POST", "stick-tag", body={"name": args.name, "sticky": sticky})
    print(f"tag #{args.name} {'pinned' if sticky else 'unpinned'}")


def _tag_span_pattern(name, recursive):
    escaped = re.escape(name)
    sub = r"(?:/[^<]*)?" if recursive else ""
    return re.compile(rf'\s?<span class="hash-tag">#{escaped}{sub}</span>')


def cmd_tag_untag(args):
    posts = fetch_posts({"tag": args.name}, FETCH_CAP)
    if args.exact:
        posts = [p for p in posts if args.name in (p.get("tags") or [])]
    if not posts:
        print(f"no memos carry #{args.name}")
        return
    scope = f"#{args.name}" + ("" if args.exact else " (and descendant tags)")
    confirm_or_exit(
        args,
        f"remove {scope} from {len(posts)} memo(s) — memos are kept, only the tag text is removed",
    )
    pattern = _tag_span_pattern(args.name, recursive=not args.exact)
    done, failed = [], []
    for p in posts:
        try:
            new_content = pattern.sub("", p["content"])
            if new_content != p["content"]:
                api("POST", "update-post", body={"id": p["id"], "content": new_content})
            done.append(p["id"])
        except CLIError as e:
            failed.append((p["id"], str(e)))
    print(f"untagged {len(done)} memo(s): {done}")
    if failed:
        print(f"FAILED on {len(failed)} memo(s):", file=sys.stderr)
        for pid, err in failed:
            print(f"  [{pid}] {err}", file=sys.stderr)
        sys.exit(1)
    # note: the tag row itself lingers with count 0 (no API to remove it)


def cmd_tag_delete_memos(args):
    tags = api("GET", "get-tags")
    match = next((t for t in tags if t["name"] == args.name), None)
    count = match["post_count"] if match else "an unknown number of"
    confirm_or_exit(
        args,
        f"soft-delete ALL {count} memo(s) under #{args.name} and its descendant tags "
        "(they go to the trash; this does NOT merely remove the tag)",
    )
    api("POST", "delete-tag", body={"name": args.name})
    print(f"moved all memos under #{args.name} to trash")


def cmd_upload(args):
    path = Path(args.file)
    if not path.is_file():
        raise CLIError(f"file not found: {path}")
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    boundary = "----moteupload7f9a2b"
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        f"Content-Type: {mime}\r\n\r\n"
    ).encode()
    payload = head + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    info = api(
        "POST", "upload", data=payload,
        content_type=f"multipart/form-data; boundary={boundary}", timeout=120,
    )
    if args.json:
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return
    print(f"uploaded: {info['url']}")
    if info.get("thumb_url"):
        print(f"thumbnail: {info['thumb_url']}")
    print(f'embed it in a memo with: ![]({info["url"]})')


def cmd_stats(args):
    if args.daily:
        if not (args.start and args.end):
            raise CLIError("--daily requires --start and --end")
        counts = api("GET", "get-daily-post-counts", query={
            "start_date": args.start, "end_date": args.end,
            "offset": tz_offset_minutes(),
        })
        if args.json:
            print(json.dumps(counts))
            return
        day = datetime.strptime(args.start, "%Y-%m-%d")
        for c in counts:
            print(f"{day.strftime('%Y-%m-%d')}  {c}")
            day += timedelta(days=1)
        return
    overall = api("GET", "get-overall-counts")
    query = {}
    if args.start and args.end:
        query = {"start_date": args.start, "end_date": args.end,
                 "offset": tz_offset_minutes()}
    summary = api("GET", "get-stats-summary", query=query)
    if args.json:
        print(json.dumps({"overall": overall, "summary": summary}, ensure_ascii=False, indent=2))
        return
    print(f"memos: {overall['post_count']}  tags: {overall['tag_count']}  "
          f"active days: {overall['day_count']}")
    print(f"shared: {summary['shared_posts']}  with images: {summary['posts_with_images']}  "
          f"untagged: {summary['untagged_posts']}")
    if summary.get("first_post_at"):
        print(f"first memo: {fmt_ts(summary['first_post_at'])}  "
              f"last memo: {fmt_ts(summary['last_post_at'])}")
    colors = summary.get("color_counts") or []
    if colors:
        print("colors: " + "  ".join(f"{c['name']}: {c['count']}" for c in colors))
    top = summary.get("top_tags") or []
    if top:
        print("top tags: " + "  ".join(f"#{t['name']} ({t['count']})" for t in top))


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


def build_parser():
    parser = argparse.ArgumentParser(
        prog="mote.py", description="CLI for the mote memo server"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="output JSON")

    p = sub.add_parser("check", parents=[common], help="verify connectivity and credentials")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("list", parents=[common], help="list memos (filterable)")
    p.add_argument("--tag", help="filter by tag (includes descendant tags)")
    p.add_argument("--deleted", action="store_true", help="list the trash instead")
    p.add_argument("--color", choices=COLORS)
    p.add_argument("--shared", action="store_true", help="only shared (public) memos")
    p.add_argument("--has-files", action="store_true")
    p.add_argument("--untagged", action="store_true")
    p.add_argument("--parent", type=int, metavar="ID", help="children of a memo")
    p.add_argument("--start", metavar="YYYY-MM-DD")
    p.add_argument("--end", metavar="YYYY-MM-DD")
    p.add_argument("--order-by", choices=("created_at", "updated_at"))
    p.add_argument("--asc", action="store_true", help="oldest first")
    p.add_argument("--limit", type=int, default=PAGE_SIZE, help="max memos (default 10)")
    p.add_argument("--all", action="store_true", help=f"fetch all (capped at {FETCH_CAP})")
    p.add_argument("--cursor", type=int, help="resume from a pagination cursor (ms timestamp)")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("get", parents=[common], help="show one memo")
    p.add_argument("id", type=int)
    p.add_argument("--html", action="store_true", help="show raw HTML content")
    p.set_defaults(func=cmd_get)

    content_opts = argparse.ArgumentParser(add_help=False)
    content_opts.add_argument("--content", metavar="MARKDOWN", help="memo content as Markdown")
    content_opts.add_argument("--file", metavar="PATH", help="read Markdown from a file")
    content_opts.add_argument("--stdin", action="store_true", help="read Markdown from stdin")

    p = sub.add_parser("create", parents=[common, content_opts],
                       help="create a memo (content via --content/--file/stdin)")
    p.add_argument("--color", choices=COLORS)
    p.add_argument("--shared", action="store_true", help="publish publicly at /shared/<id>")
    p.add_argument("--parent", type=int, metavar="ID", help="reply to / quote another memo")
    p.set_defaults(func=cmd_create)

    p = sub.add_parser("update", parents=[common, content_opts],
                       help="update a memo (content replaces the whole body)")
    p.add_argument("id", type=int)
    p.add_argument("--color", choices=COLORS)
    p.add_argument("--no-color", action="store_true", help="clear the color")
    p.add_argument("--shared", action="store_true", help="publish publicly")
    p.add_argument("--no-shared", action="store_true", help="unpublish")
    p.add_argument("--parent", type=int, metavar="ID")
    p.add_argument("--no-parent", action="store_true", help="detach from parent")
    p.set_defaults(func=cmd_update)

    p = sub.add_parser("append", parents=[common, content_opts],
                       help="append a Markdown block to an existing memo")
    p.add_argument("id", type=int)
    p.set_defaults(func=cmd_append)

    p = sub.add_parser("delete", parents=[common], help="move a memo to trash (--hard: permanent)")
    p.add_argument("id", type=int)
    p.add_argument("--hard", action="store_true", help="permanent, unrecoverable")
    p.add_argument("--yes", action="store_true", help="confirm a --hard delete")
    p.set_defaults(func=cmd_delete)

    p = sub.add_parser("restore", parents=[common], help="restore a memo from trash")
    p.add_argument("id", type=int)
    p.set_defaults(func=cmd_restore)

    p = sub.add_parser("trash", parents=[common], help="list or clear the trash")
    p.add_argument("trash_action", choices=("list", "clear"))
    p.add_argument("--limit", type=int, default=PAGE_SIZE)
    p.add_argument("--yes", action="store_true", help="confirm clearing the trash")
    p.set_defaults(func=cmd_trash)

    p = sub.add_parser("search", parents=[common], help="full-text search (Chinese-aware)")
    p.add_argument("query")
    p.add_argument("--and", dest="and_", action="store_true",
                   help="require ALL terms (default: any term)")
    p.add_argument("--limit", type=int, default=20)
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("tags", parents=[common], help="list all tags as a tree")
    p.set_defaults(func=cmd_tags)

    tag = sub.add_parser("tag", help="tag operations (rename/stick/untag/delete-memos)")
    tag_sub = tag.add_subparsers(dest="tag_command", required=True)

    p = tag_sub.add_parser("rename", parents=[common], help="rename or merge a tag (cascades)")
    p.add_argument("old")
    p.add_argument("new")
    p.set_defaults(func=cmd_tag_rename)

    p = tag_sub.add_parser("stick", parents=[common], help="pin a tag (creates it if missing)")
    p.add_argument("name")
    p.add_argument("--off", action="store_true", help="unpin")
    p.set_defaults(func=cmd_tag_stick)

    p = tag_sub.add_parser("untag", parents=[common],
                           help="remove a tag from all memos, keeping the memos")
    p.add_argument("name")
    p.add_argument("--exact", action="store_true", help="don't touch descendant tags")
    p.add_argument("--yes", action="store_true")
    p.set_defaults(func=cmd_tag_untag)

    p = tag_sub.add_parser("delete-memos", parents=[common],
                           help="soft-delete ALL memos under a tag (the API's 'delete-tag')")
    p.add_argument("name")
    p.add_argument("--yes", action="store_true")
    p.set_defaults(func=cmd_tag_delete_memos)

    p = sub.add_parser("upload", parents=[common], help="upload a file, get its URL")
    p.add_argument("file")
    p.set_defaults(func=cmd_upload)

    p = sub.add_parser("stats", parents=[common], help="memo statistics")
    p.add_argument("--daily", action="store_true", help="daily post counts")
    p.add_argument("--start", metavar="YYYY-MM-DD")
    p.add_argument("--end", metavar="YYYY-MM-DD")
    p.set_defaults(func=cmd_stats)

    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except CLIError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
