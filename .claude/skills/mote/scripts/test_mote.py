#!/usr/bin/env python3
"""Offline tests for mote.py's Markdown <-> HTML converter. Run: python3 test_mote.py"""

import unittest

from mote import _tag_span_pattern, html_to_md, md_to_html, snippet


class MdToHtml(unittest.TestCase):
    def test_paragraph_and_marks(self):
        self.assertEqual(
            md_to_html("hello **bold** *it* ~~gone~~ `x<y`"),
            "<p>hello <strong>bold</strong> <em>it</em> <del>gone</del> <code>x&lt;y</code></p>",
        )

    def test_bold_italic(self):
        self.assertEqual(md_to_html("***both***"), "<p><em><strong>both</strong></em></p>")

    def test_headings(self):
        self.assertEqual(md_to_html("# One"), "<h1>One</h1>")
        self.assertEqual(md_to_html("##### Five"), "<h5>Five</h5>")
        self.assertEqual(md_to_html("###### Six caps to five"), "<h5>Six caps to five</h5>")

    def test_heading_vs_hashtag(self):
        # '# x' with a space is a heading; '#x' without is a hash tag
        self.assertEqual(md_to_html("# title"), "<h1>title</h1>")
        self.assertEqual(
            md_to_html("#title"), '<p><span class="hash-tag">#title</span></p>'
        )

    def test_hashtag_inline(self):
        self.assertEqual(
            md_to_html("note about #tech/go and #生活/随想 here"),
            '<p>note about <span class="hash-tag">#tech/go</span> and '
            '<span class="hash-tag">#生活/随想</span> here</p>',
        )

    def test_hashtag_not_midword_or_in_url(self):
        self.assertEqual(md_to_html("C# rocks"), "<p>C# rocks</p>")
        self.assertEqual(
            md_to_html("[doc](https://ex.com/page#anchor)"),
            '<p><a href="https://ex.com/page#anchor" target="_blank" rel="noreferrer nofollow">doc</a></p>',
        )
        # bare URL fragments are not tags
        self.assertEqual(
            md_to_html("see https://ex.com/#top now"), "<p>see https://ex.com/#top now</p>"
        )

    def test_hashtag_after_punctuation(self):
        # regression: a tag right after CJK/quote punctuation used to be skipped,
        # so only the later space-preceded tag became a tag
        for prefix in ("。", "”", "》", "」", "—", ")", "%", ".", '"'):
            with self.subTest(prefix=prefix):
                html = md_to_html(f"words{prefix}#quote #literature")
                self.assertEqual(html.count('class="hash-tag"'), 2)

    def test_hashtag_after_cjk_word_char_blocked(self):
        # matches the editor: a '#' glued to a word character starts no tag
        self.assertEqual(md_to_html("文学#quote"), "<p>文学#quote</p>")

    def test_hashtag_escaped(self):
        self.assertEqual(md_to_html(r"\#literal"), "<p>#literal</p>")

    def test_soft_break(self):
        self.assertEqual(md_to_html("line one\nline two"), "<p>line one<br>line two</p>")

    def test_code_block(self):
        self.assertEqual(
            md_to_html("```\nif a < b:\n    pass\n```"),
            "<pre><code>if a &lt; b:\n    pass</code></pre>",
        )

    def test_blockquote(self):
        self.assertEqual(
            md_to_html("> quoted\n> more"), "<blockquote><p>quoted<br>more</p></blockquote>"
        )

    def test_check_list(self):
        self.assertEqual(
            md_to_html("- [ ] todo\n- [x] done"),
            '<div class="check-list"><input type="checkbox" disabled/><label>todo</label></div>'
            '<div class="check-list"><input type="checkbox" checked disabled/><label>done</label></div>',
        )

    def test_nested_list(self):
        self.assertEqual(
            md_to_html("- a\n  - b\n- c"),
            "<ul><li><p>a</p><ul><li><p>b</p></li></ul></li><li><p>c</p></li></ul>",
        )

    def test_ordered_list_start(self):
        self.assertEqual(
            md_to_html("3. three\n4. four"),
            '<ol start="3"><li><p>three</p></li><li><p>four</p></li></ol>',
        )

    def test_image_with_caption(self):
        self.assertEqual(
            md_to_html("![alt text](/uploads/a.png)\n*my caption*"),
            '<figure><img src="/uploads/a.png" alt="alt text" loading="lazy"/>'
            "<figcaption>my caption</figcaption></figure>",
        )

    def test_table(self):
        md = "| a | b |\n| :--- | ---: |\n| 1 | 2 |"
        self.assertEqual(
            md_to_html(md),
            '<table><thead><tr><th style="text-align:left">a</th>'
            '<th style="text-align:right">b</th></tr></thead>'
            "<tbody><tr><td style=\"text-align:left\">1</td>"
            '<td style="text-align:right">2</td></tr></tbody></table>',
        )

    def test_raw_html_passthrough(self):
        self.assertEqual(md_to_html("<video src='x.mp4'></video>"), "<video src='x.mp4'></video>")


class HtmlToMd(unittest.TestCase):
    def test_marks(self):
        self.assertEqual(
            html_to_md("<p><em><strong>x</strong></em> and <del>y</del> and <code>a&lt;b</code></p>"),
            "***x*** and ~~y~~ and `a<b`",
        )

    def test_unwrap_mark_and_u(self):
        self.assertEqual(html_to_md("<p>a <mark>hit</mark> <u>under</u></p>"), "a hit under")

    def test_hash_tag_span(self):
        self.assertEqual(
            html_to_md('<p>see <span class="hash-tag">#tech/go</span> now</p>'),
            "see #tech/go now",
        )

    def test_check_list(self):
        html = (
            '<div class="check-list"><input type="checkbox" checked disabled/>'
            "<label>done</label></div>"
        )
        self.assertEqual(html_to_md(html), "- [x] done")

    def test_github_task_li(self):
        html = '<ul><li><input type="checkbox" checked> task</li></ul>'
        self.assertEqual(html_to_md(html), "- [x] task")

    def test_figure(self):
        html = '<figure><img src="/u/a.png" alt="pic" loading="lazy"/><figcaption>cap</figcaption></figure>'
        self.assertEqual(html_to_md(html), "![pic](/u/a.png)\n*cap*")

    def test_empty_paragraph_dropped(self):
        self.assertEqual(html_to_md("<p>a</p><p><br></p><p>b</p>"), "a\n\nb")

    def test_link(self):
        html = '<a href="https://x.io" target="_blank" rel="noreferrer nofollow">x</a>'
        self.assertEqual(html_to_md(f"<p>{html}</p>"), "[x](https://x.io)")

    def test_pre_preserves_whitespace(self):
        html = "<pre><code>def f():\n    return 1&lt;2</code></pre>"
        self.assertEqual(html_to_md(html), "```\ndef f():\n    return 1<2\n```")

    def test_unknown_element_passthrough(self):
        self.assertEqual(html_to_md('<video src="x.mp4"></video>'), '<video src="x.mp4"></video>')

    def test_table_without_thead(self):
        html = "<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>"
        self.assertEqual(html_to_md(html), "|  |  |\n| --- | --- |\n| a | b |")


CANONICAL_MD = """# Journal

today I learned about #tech/go and #生活 stuff

## Details

a *soft* break here
with **bold** and `code` and [a link](https://ex.com)

> quoted wisdom
> spanning lines

- first
  - nested
- second

1. one
2. two

- [ ] open task
- [x] done task

```
if a < b:
    print("hi")
```

![diagram](/uploads/d.png)
*the caption*

| name | count |
| :--- | ---: |
| go | 2 |"""


class Roundtrip(unittest.TestCase):
    def test_md_html_md(self):
        html = md_to_html(CANONICAL_MD)
        self.assertEqual(html_to_md(html), CANONICAL_MD)

    def test_html_md_html(self):
        html = md_to_html(CANONICAL_MD)
        self.assertEqual(md_to_html(html_to_md(html)), html)

    def test_update_flow_stability(self):
        # read -> edit (append) -> write must not corrupt untouched content
        html = md_to_html(CANONICAL_MD)
        md = html_to_md(html)
        edited = md + "\n\nnew paragraph #note"
        html2 = md_to_html(edited)
        self.assertTrue(html2.startswith(html))
        self.assertIn('<span class="hash-tag">#note</span>', html2)


class TagSpanPattern(unittest.TestCase):
    def test_exact(self):
        pat = _tag_span_pattern("tech", recursive=False)
        html = '<p>a <span class="hash-tag">#tech</span> b <span class="hash-tag">#tech/go</span></p>'
        self.assertEqual(pat.sub("", html), '<p>a b <span class="hash-tag">#tech/go</span></p>')

    def test_recursive(self):
        pat = _tag_span_pattern("tech", recursive=True)
        html = '<p>a <span class="hash-tag">#tech</span> b <span class="hash-tag">#tech/go</span></p>'
        self.assertEqual(pat.sub("", html), "<p>a b</p>")

    def test_no_false_prefix_match(self):
        pat = _tag_span_pattern("tech", recursive=True)
        html = '<p><span class="hash-tag">#technology</span></p>'
        self.assertEqual(pat.sub("", html), html)


class Helpers(unittest.TestCase):
    def test_snippet(self):
        self.assertEqual(snippet("\n\n  hello world  \nmore"), "hello world")
        self.assertEqual(snippet(""), "(empty)")
        self.assertTrue(snippet("x" * 200).endswith("…"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
