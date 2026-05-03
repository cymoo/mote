from typing import Tuple

from flask import Blueprint, render_template, current_app
from datetime import datetime
import re
import orjson as json

from ..model import Post

blog = Blueprint('blog', __name__)


@blog.get('/')
def post_list():
    rows = (
        Post.query.filter(Post.shared)
        .filter(Post.deleted_at.is_(None))
        .order_by(Post.created_at.desc())
        .all()
    )
    posts = []
    for row in rows:
        title, description = extract_header_and_description_from_html(row.content)
        created_at = datetime.fromtimestamp(row.created_at // 1000).strftime('%Y-%m-%d')
        posts.append(
            {
                'id': row.id,
                'title': title,
                'description': description,
                'created_at': created_at,
            }
        )
    return render_template(
        'post-list.html', posts=posts, about_url=current_app.config['ABOUT_URL']
    )


@blog.get('/<int:id>')
def post_item(id: int):
    post = Post.query.filter_by(id=id).first()

    if not post:
        return render_template('404.html'), 404
    if not post.shared or post.deleted_at is not None:
        return render_template('404.html'), 404

    title, _ = extract_header_and_description_from_html(post.content)

    if post.files:
        post.files = json.loads(post.files)
    if not post:
        return render_template('404.html')

    return render_template(
        'post-item.html',
        title=title,
        post=post,
        about_url=current_app.config['ABOUT_URL'],
    )


HEADER_BOLD_PARAGRAPH_PATTERN = re.compile(
    r'<h[1-3][^>]*>(.*?)</h[1-3]>\s*(?:<p[^>]*><strong>(.*?)</strong></p>)?',
    re.IGNORECASE,
)
STRONG_TAG_PATTERN = re.compile(r'</?strong>')


def extract_header_and_description_from_html(
    html: str,
) -> Tuple[str | None, str | None]:
    match = HEADER_BOLD_PARAGRAPH_PATTERN.search(html)
    if match:
        title = match.group(1)
        bold_paragraph = match.group(2)
        if bold_paragraph:
            bold_paragraph = STRONG_TAG_PATTERN.sub('', bold_paragraph)
        return title, bold_paragraph
    else:
        return None, None
