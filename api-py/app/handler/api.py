import os
from mimetypes import guess_extension
from os import path
from datetime import timedelta, datetime, timezone
from uuid import uuid4

from PIL import Image, ImageOps
from flask import (
    Blueprint,
    request,
    Response,
    current_app as app,
    url_for,
    stream_with_context,
)
from sqlalchemy.orm import subqueryload

from ..dto import *
from ..exception import bad_request, not_found, unauthorized
from ..models import HASH_PATTERN, Post, Tag
from ..extension import fts, db
from ..middleware import rate_limit, validate
from ..task import deindex_post, index_post, reindex_post

api = Blueprint('api', __name__)


def is_valid_password(password: str) -> bool:
    return password == os.getenv('MOTE_PASSWORD')


@api.get('/')
def index():
    return {'msg': 'hello world'}


@api.post('/login')
@rate_limit(max_count=10, expires=60)
@validate
def login(payload: LoginRequest) -> NoContent:
    password = payload.password
    if not is_valid_password(password):
        bad_request('wrong password')
    return NO_CONTENT


@api.get('/get-tags')
def get_tags() -> list[TagDto]:
    return [
        TagDto(name=name, sticky=sticky, post_count=count)
        for (name, sticky, count) in Tag.get_all_with_post_count()
    ]


@api.post('/stick-tag')
@validate
def stick_tag(payload: StickTagRequest) -> NoContent:
    Tag.insert_or_update(payload.name, payload.sticky)
    return NO_CONTENT


@api.post('/rename-tag')
@rate_limit(max_count=5, expires=60)
@validate
def rename_tag(payload: RenameTagRequest) -> NoContent:
    Tag.rename_or_merge(payload.name, payload.new_name)
    return NO_CONTENT


@api.post('/delete-tag')
@rate_limit(max_count=1, expires=10)
@validate
def delete_tag(payload: Name) -> NoContent:
    tag = Tag.find_by_name(payload.name)
    if not tag:
        bad_request('tag not found')
    tag.delete()

    return NO_CONTENT


@api.get('/search')
@validate(type='query')
def search(payload: SearchRequest) -> PostPagination:
    query, partial, limit = payload.query, payload.partial, payload.limit

    tokens, results = fts.search(query, partial, limit)

    if not results:
        return PostPagination(posts=[], cursor=-1, size=0)

    scores = {id: score for id, score in results}
    posts = Post.find_by_ids(scores.keys())

    posts_with_score = []
    for post in posts:  # noqa
        post = PostDto.from_model(post)
        post.content = mark_tokens_in_html(tokens, post.content)
        post.score = scores[post.id]
        posts_with_score.append(post)

    posts_with_score.sort(key=lambda x: (x.score, x.created_at), reverse=True)

    return PostPagination(posts=posts_with_score, cursor=-1, size=len(posts_with_score))


@api.get('/get-posts')
@validate(type='query')
def get_posts(payload: FilterPostRequest) -> PostPagination:
    posts = Post.filter_posts(
        **payload.model_dump(),
        per_page=app.config['POSTS_PER_PAGE'],
    )
    posts = [PostDto.from_model(post) for post in posts]

    return PostPagination(
        posts=posts, cursor=posts[-1].created_at if posts else -1, size=len(posts)
    )


@api.get('/get-post')
@validate(type='query')
def get_post(payload: Id) -> PostDto:
    post = (
        Post.query.options(
            subqueryload(Post.tags),
            subqueryload(Post.parent).subqueryload(Post.tags),
        )
        .filter(Post.id == payload.id)
        .one_or_none()
    )
    if post is None or post.deleted:
        not_found('post not found')

    return PostDto.from_model(post)


@api.post('/create-post')
@validate
def create_post(payload: CreatePostRequest) -> CreationDto:
    # orjson.dumps returns bytes, need to decode to str, or else blob will be stored in sqlite
    files = orjson.dumps(payload.files).decode('utf-8') if payload.files else None
    post = Post(
        content=payload.content,
        files=files,
        color=payload.color,
        shared=payload.shared or False,
        parent_id=payload.parent_id,
    )
    post.save()

    index_post(post.id, payload.content)

    return CreationDto(
        id=post.id,
        created_at=post.created_at,
        updated_at=post.updated_at,
    )


@api.post('/update-post')
@validate
def update_post(payload: UpdatePostRequest) -> NoContent:
    post = db.get_or_404(Post, payload.id, description='post not found')
    if post.deleted:
        not_found('post not found')

    old_content = post.content

    for field, value in payload.model_dump().items():
        if value is missing:
            continue

        if field == 'content':
            post.content = value
            post.tags = [
                Tag.find_or_create(tag) for tag in set(HASH_PATTERN.findall(value))
            ]
        elif field == 'files':
            post.files = orjson.dumps(value).decode('utf-8') if value else None
        elif field == 'parent_id':
            if post.parent_id is not None and value is None:
                post.parent.children_count -= 1
            elif post.parent_id is None and value is not None:
                post.parent.children_count += 1
            post.parent_id = value
        else:
            setattr(post, field, value)

    post.save()

    if payload.content is not None and post.content != old_content:
        reindex_post(post.id, payload.content)

    return NO_CONTENT


@api.post('/delete-post')
@validate
def delete_post(payload: DeletePostRequest) -> NoContent:
    hard, id = payload.hard, payload.id  # noqa
    post = db.get_or_404(Post, id, description='post not found')

    if hard:
        post.clear()
        deindex_post(id)
    else:
        post.delete()

    return NO_CONTENT


@api.post('/restore-post')
@validate
def restore_post(payload: Id) -> NoContent:
    post = db.get_or_404(Post, payload.id, description='post not found')
    post.restore()

    return NO_CONTENT


@api.post('/clear-posts')
def clear_posts() -> NoContent:
    ids = Post.clear_all()

    for _id in ids:
        deindex_post(_id)
    return NO_CONTENT


@api.get('/get-daily-post-counts')
@validate(type='query')
def get_daily_post_counts(payload: DateRange) -> list[int]:
    return Post.get_daily_counts(
        start_date=parse_date_with_timezone(payload.start_date, payload.offset),
        end_date=parse_date_with_timezone(
            payload.end_date, payload.offset, end_of_day=True
        ),
    )


@api.get('/get-overall-counts')
def get_stats() -> PostStats:
    return PostStats(
        post_count=Post.count(),
        tag_count=Tag.count(),
        day_count=Post.get_active_days(),
    )


@api.get('/get-stats-summary')
@validate(type='query')
def get_stats_summary(payload: StatsRange) -> dict:
    start_date = end_date = None
    if payload.start_date or payload.end_date:
        if not payload.start_date or not payload.end_date:
            raise bad_request('start_date and end_date must be provided together')
        start_date = parse_date_with_timezone(payload.start_date, payload.offset)
        end_date = parse_date_with_timezone(
            payload.end_date, payload.offset, end_of_day=True
        )
    return Post.get_stats_summary(
        start_date=start_date,
        end_date=end_date,
        offset=payload.offset,
    )


# For quick test
@api.get('/upload')
def file_form() -> str:
    return """
    <!doctype html>
    <html>
        <head><title>Upload file</title></head>
        <body>
            <form action="upload" method="post" enctype="multipart/form-data">
                <input type="file" name="file" multiple>
                <button type="submit">Upload</button>
            </form>
        </body>
    </html>
    """.strip()


@api.post('/upload')
def upload_file() -> FileInfo:
    config = app.config

    file = request.files.get('file')
    if not file:
        bad_request('no uploaded file')
    if not file.filename:
        bad_request('filename is required')

    filename = gen_secure_filename(file.filename)
    filepath = path.join(config['UPLOAD_PATH'], filename)

    ext = guess_extension(file.mimetype)

    if ext not in config['UPLOAD_IMAGE_FORMATS']:
        file.save(filepath)
        return FileInfo(
            url=url_for('uploaded_file', filename=filename),
            # NOTE: file.content_length is not reliable: https://stackoverflow.com/questions/15772975
            size=os.stat(filepath).st_size,
        )
    else:
        with Image.open(file.stream) as img:
            thumb_url = None
            if ext != '.gif':
                # https://stackoverflow.com/questions/13872331/rotating-an-image-with-orientation-specified-in-exif-using-python-without-pil-in
                img = ImageOps.exif_transpose(img)
                # TODO: sometimes thumbnail generation will fail, figure out why later
                image_thumb = gen_thumbnail(img, config['UPLOAD_THUMB_WIDTH'])
                filename_thumb = add_suffix(filename, '.thumb')
                image_thumb.save(
                    path.join(config['UPLOAD_PATH'], filename_thumb), quality=90
                )
                thumb_url = url_for('uploaded_file', filename=filename_thumb)

            # NOTE: Perhaps the image should be compressed
            # why `save_all`: https://stackoverflow.com/questions/24688802/saving-an-animated-gif-in-pillow
            img.save(filepath, save_all=ext == '.gif')

            return FileInfo(
                url=url_for('uploaded_file', filename=filename),
                size=os.stat(filepath).st_size,
                width=img.width,
                height=img.height,
                thumb_url=thumb_url,
            )


@api.get('/_dangerously_rebuild_all_indexes')
@rate_limit(max_count=3, expires=60 * 60)
def rebuild_indexes() -> Response:
    posts = Post.query.with_entities(Post.id, Post.content).all()

    def generate():
        yield 'Indexing...\n'
        fts.clear_all_indexes()
        for post in posts:
            fts.index(post.id, post.content)
        yield 'Done'

    return Response(stream_with_context(generate()), content_type='text/plain')


@api.get('/auth')
def auth() -> NoContent:
    return NO_CONTENT


@api.before_request
def check_permission() -> None:
    if request.path.endswith('login'):
        return

    token = request.cookies.get('token')

    if not token:
        auth_header = request.headers.get('Authorization')
        if not auth_header:
            unauthorized("missing authorization header")
        if not auth_header.startswith('Bearer '):
            unauthorized("invalid authorization header")

        token = auth_header[len('Bearer ') :].strip()

    if not is_valid_password(token):
        unauthorized("invalid authorization token")


# Helper functions


def mark_tokens_in_html(tokens: list[str], html: str) -> str:
    """
    Mark all occurrences of tokens in HTML text with <mark> tags,
    avoiding replacements in HTML tags and their attributes

    Args:
        tokens: List of tokens to be marked
        html: Original HTML text

    Returns:
        HTML text with tokens marked only in text content
    """
    if not tokens:
        return html

    # Add word boundaries for English tokens
    patterns = []
    for token in sorted(tokens, key=len, reverse=True):
        if any('\u4e00' <= char <= '\u9fff' for char in token):  # Chinese
            patterns.append(re.escape(token))
        else:  # English
            patterns.append(fr'\b{re.escape(token)}\b')

    # Single regex to match tokens but ignore HTML tags
    pattern = f'(?:<[^>]*>)|({"|".join(patterns)})'
    return re.sub(
        pattern,
        lambda m: m.group(0) if m.group(1) is None else f'<mark>{m.group(1)}</mark>',
        html,
    )


def parse_date_with_timezone(
    date_str: str, utc_offset: int, end_of_day=False
) -> datetime:
    """Parses a date string with a specified timezone offset.
    Args:
        date_str (str): Date string in "YYYY-MM-DD" format.
        utc_offset (int): Timezone offset in minutes from UTC.
        end_of_day (bool): If True, set time to 23:59:59.999, else to 00:00:00.000.
    Returns:
        datetime: A timezone-aware datetime object.
    Raises:
        ValueError: If the date format is invalid or timezone offset is out of range.
    """

    if abs(utc_offset) > 1440:
        raise ValueError(
            f'Timezone offset must be between -1440 and 1440 minutes: {utc_offset}'
        )

    # Parse the date string
    local_datetime = datetime.strptime(date_str, "%Y-%m-%d")

    # Create time component
    local_datetime = local_datetime.replace(
        hour=23 if end_of_day else 0,
        minute=59 if end_of_day else 0,
        second=59 if end_of_day else 0,
        microsecond=999000 if end_of_day else 0,
    )

    # Create timezone offset
    offset_hours, offset_minutes = divmod(utc_offset, 60)
    custom_timezone = timezone(timedelta(hours=offset_hours, minutes=offset_minutes))

    # Add timezone info for `datetime` object
    return local_datetime.replace(tzinfo=custom_timezone)


def gen_thumbnail(img: Image.Image, width: int) -> Image.Image:
    """Generates a thumbnail image with the specified width while maintaining the aspect ratio."""

    w_percent = width / img.width
    height = int(img.height * w_percent)
    return img.resize((width, height), Image.Resampling.LANCZOS)  # noqa


# not 汉字, digit, alphabet, -, _, .
INVALID_CHAR_PATTERN = re.compile(r'[^\w\-.\u4e00-\u9fa5]+')


def gen_secure_filename(filename: str, uuid_length=8) -> str:
    """Generates a secure, sanitized filename by replacing illegal characters with underscores
    and appending a unique suffix to avoid naming conflicts.

    It ensures the filename contains only valid characters (Chinese characters,
    digits, alphabets, hyphens, underscores, and periods) and appends an uuid to make it secure for storage.

    >>> gen_secure_filename("foo$&.jpg").startswith("foo_")
    True
    >>> '$&' not in gen_secure_filename("foo$&.jpg")
    True
    >>> gen_secure_filename("中文.jpg").startswith("中文")
    True
    """

    if not filename:
        raise ValueError('filename cannot be empty')

    if 8 > uuid_length > 32:
        raise ValueError('uuid_length must be between 8 and 32')

    filename = INVALID_CHAR_PATTERN.sub('_', filename)
    return add_suffix(filename, suffix='.' + uuid4().hex[0:uuid_length])


def add_suffix(filename: str, suffix: str) -> str:
    """
    Add a suffix to a filename before the file extension.
    >>> add_suffix("foo.jpg", suffix=".thumb")
    'foo.thumb.jpg'
    """

    parts = filename.rsplit('.', maxsplit=1)
    if len(parts) == 1:
        basename, ext = parts[0], ''
    else:
        basename, ext = parts[0], '.' + parts[1]
    return f'{basename}{suffix}{ext}'
