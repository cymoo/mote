import re
from datetime import datetime, timedelta
from typing import Iterable, Literal, Optional, Self, Tuple

from sqlalchemy import func, or_, text
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import backref, subqueryload

from ..exception import bad_request
from ..extension import db
from .base import utc_now_ms

HASH_PATTERN = re.compile(r'<span class="hash-tag">#(.+?)</span>')


tag_post_assoc = db.Table(
    'tag_post_assoc',
    db.Column(
        'tag_id',
        db.Integer,
        db.ForeignKey('tags.id', ondelete='CASCADE'),
        primary_key=True,
        nullable=False,
    ),
    db.Column(
        'post_id',
        db.Integer,
        db.ForeignKey('posts.id', ondelete='CASCADE'),
        primary_key=True,
        nullable=False,
    ),
)


def replace_prefix(s: str, from_str: str, to: str) -> str:
    """Replace the prefix of a string if it matches a given substring.
    >>> replace_prefix('foobar', 'foo', 'baz')
    'bazbar'
    >>> replace_prefix('foobar', 'bar', 'baz')
    'foobar'
    """
    if s.startswith(from_str):
        return to + s[len(from_str) :]
    else:
        return s


class Tag(db.Model):
    __tablename__ = 'tags'
    id = db.Column(db.Integer, primary_key=True, nullable=False)
    name = db.Column(db.Text, nullable=False, unique=True)
    sticky = db.Column(db.Boolean, nullable=False, default=False)

    created_at = db.Column(db.BigInteger, nullable=False, default=utc_now_ms)
    updated_at = db.Column(
        db.BigInteger,
        nullable=False,
        default=utc_now_ms,
        onupdate=utc_now_ms,
    )

    posts = db.relationship(
        'Post',
        secondary=tag_post_assoc,
        back_populates='tags',
        lazy='dynamic',
        cascade='all, delete',
    )

    @classmethod
    def find_or_create(cls, name: str) -> Self:
        return Tag.find_by_name(name) or Tag(name=name).save()

    @classmethod
    def find_by_name(cls, name: str) -> Optional[Self]:
        return Tag.query.filter_by(name=name).first()

    @staticmethod
    def get_all_with_post_count() -> list[Tuple[str, bool, int]]:
        """
        Retrieves all tags with their sticky status and associated post count.

        Returns:
            List of tuples containing (name: str, sticky: bool, post_count: int).
            Post count includes posts associated with the tag or its sub-tags.
        """
        result = db.session.execute(
            text(
                """
                SELECT t.name, t.sticky,
                    (
                        SELECT COUNT(DISTINCT a.post_id)
                        FROM tag_post_assoc a
                        WHERE a.tag_id IN (
                            SELECT id
                            FROM tags
                            WHERE name = t.name
                               OR name LIKE t.name || '/%'
                        )
                ) AS post_count
                FROM tags t;
                """
            )
        )

        return [(row.name, row.sticky, row.post_count) for row in result]

    @classmethod
    def count(cls) -> int:
        # NOTE: Avoid using `Tag.query.count()`, the generated SQL is so good...
        return db.session.query(func.count(Tag.id)).scalar()

    @classmethod
    def insert_or_update(cls, name: str, sticky: bool) -> None:
        now = utc_now_ms()
        stmt = (
            insert(Tag)
            .values(name=name, sticky=sticky, created_at=now, updated_at=now)
            .on_conflict_do_update(
                index_elements=['name'], set_={'sticky': sticky, 'updated_at': now}
            )
        )
        db.session.execute(stmt)
        db.session.commit()

    @classmethod
    def rename_or_merge(cls, name: str, new_name: str) -> None:
        """Rename a tag, and if the new tag already exists, merge the tags."""

        if name == new_name:
            return

        if new_name.startswith(name) and new_name.count('/') > name.count('/'):
            bad_request(f'cannot move "{name}" to a subtag of itself "{new_name}"')

        source_tag = Tag.find_or_create(name=name)
        target_tag = Tag.find_by_name(new_name)

        for descendant in source_tag.descendants:
            new_descendant_name = replace_prefix(descendant.name, name, new_name)
            new_descendant = Tag.find_by_name(new_descendant_name)
            if new_descendant:
                descendant._merge(new_descendant)
            else:
                descendant._rename(new_descendant_name)

        if target_tag:
            source_tag._merge(target_tag)
        else:
            source_tag._rename(new_name)

        db.session.commit()

    def _rename(self, new_name: str) -> None:
        old_name = self.name
        self.name = new_name
        db.session.add(self)

        for post in self.posts.all():
            post.content = post.content.replace(f'>#{old_name}<', f'>#{new_name}<')
            db.session.add(post)

    def _merge(self, new_tag: Self) -> None:
        old_name = self.name
        new_name = new_tag.name

        for post in self.posts.all():
            post.tags = [tag for tag in post.tags if tag.id != self.id] + [new_tag]
            post.content = post.content.replace(f'>#{old_name}<', f'>#{new_name}<')
            db.session.add(post)

        db.session.delete(self)

    @property
    def descendants(self) -> list[Self]:
        """Retrieve all descendants of the tag."""
        return Tag.query.filter(Tag.name.startswith(self.name + '/')).all()

    @property
    def post_count(self) -> int:
        """Count the number of direct posts under the tag."""
        return (
            self.posts.filter(Post.deleted_at.is_(None))
            .with_entities(func.count(Post.id))
            .scalar()
        )

    def delete(self) -> None:
        """Soft delete all posts under this tag and its descendant tags."""

        deleted_at = utc_now_ms()
        tag_ids = [tag.id for tag in [self] + self.descendants]
        post_ids = db.session.query(tag_post_assoc.c.post_id).filter(
            tag_post_assoc.c.tag_id.in_(tag_ids)
        )
        Post.query.filter(Post.id.in_(post_ids)).update(
            {Post.deleted_at: deleted_at},
            synchronize_session=False,
        )

        db.session.commit()

    def restore(self) -> None:
        """Restore all posts under this tag and its descendant tags."""

        tag_ids = [tag.id for tag in [self] + self.descendants]
        post_ids = db.session.query(tag_post_assoc.c.post_id).filter(
            tag_post_assoc.c.tag_id.in_(tag_ids)
        )
        Post.query.filter(Post.id.in_(post_ids)).update(
            {Post.deleted_at: None},
            synchronize_session=False,
        )
        db.session.commit()

    def save(self) -> Self:
        db.session.add(self)
        db.session.commit()
        return self

    def __repr__(self) -> str:
        return f'<Tag id={self.id} name="{self.name}">'


class Post(db.Model):
    __tablename__ = 'posts'

    id = db.Column(db.Integer, primary_key=True, nullable=False)

    content = db.Column(db.Text, nullable=False)
    files = db.Column(db.Text)
    color = db.Column(db.Text)  # red, green, blue

    shared = db.Column(db.Boolean, nullable=False, default=False)

    deleted_at = db.Column(db.BigInteger)
    created_at = db.Column(db.BigInteger, nullable=False, default=utc_now_ms)
    updated_at = db.Column(
        db.BigInteger,
        nullable=False,
        default=utc_now_ms,
        onupdate=utc_now_ms,
    )

    # https://stackoverflow.com/questions/51335298/concepts-of-backref-and-back-populate-in-sqlalchemy
    tags = db.relationship('Tag', secondary=tag_post_assoc, back_populates='posts')

    parent_id = db.Column(db.Integer, db.ForeignKey('posts.id', ondelete='SET NULL'))
    parent = db.relationship(
        'Post',
        backref=backref('children', lazy='dynamic'),
        remote_side=[id],
    )
    # NOTE: Add an extra field to simplify queries and improve speed.
    children_count = db.Column(db.Integer, nullable=False, default=0)

    # `__init__` will only be called when creating a new record,
    # it will not be called when constructing an instance from existing records in the database.
    # https://stackoverflow.com/questions/16156650/sqlalchemy-init-not-running
    def __init__(self, **kwargs):
        content, parent_id = kwargs.get('content'), kwargs.get('parent_id')
        tags = [Tag.find_or_create(tag) for tag in HASH_PATTERN.findall(content)]
        super().__init__(**kwargs, tags=tags)

        if parent_id:
            parent = db.get_or_404(Post, parent_id, description='parent not exist')
            parent.children_count += 1
            db.session.add(parent)

    @classmethod
    def get_daily_counts(cls, start_date: datetime, end_date: datetime) -> list[int]:
        """Get the number of posts for each day within a specified date range."""

        start_timestamp = int(start_date.timestamp() * 1000)
        end_timestamp = int(end_date.timestamp() * 1000)

        offset = int(start_date.utcoffset().total_seconds())

        daily_counts = (
            db.session.query(
                func.date(Post.created_at / 1000 + offset, 'unixepoch').label('date'),
                func.count(Post.id).label('count'),
            )
            .filter(Post.deleted_at.is_(None))
            .filter(Post.created_at.between(start_timestamp, end_timestamp))
            .group_by('date')
            .all()
        )

        daily_counts_map = dict(daily_counts)

        days = (end_date.date() - start_date.date()).days + 1
        return [
            daily_counts_map.get(
                (start_date.date() + timedelta(days=i)).strftime('%Y-%m-%d'), 0
            )
            for i in range(days)
        ]

    @classmethod
    def get_active_days(cls) -> int:  # noqa
        """Count the total number of active days."""

        return (
            Post.query.filter(Post.deleted_at.is_(None))
            .with_entities(
                func.count(
                    func.distinct(func.date(Post.created_at / 1000, 'unixepoch'))
                )
            )
            .scalar()
        )

    @classmethod
    def find_by_ids(cls, ids: Iterable[int]) -> list[Self]:
        query = (
            db.session.query(Post)
            # `subqueryload` generates a subquery for the related data,
            # loads all the required related data into memory in a single query,
            # and then SQLAlchemy associates this data with the main query result set, avoiding "N+1" query.
            .options(
                subqueryload(Post.tags),
                subqueryload(Post.parent).subqueryload(Post.tags),
            )
            .filter(Post.deleted_at.is_(None))
            .filter(Post.id.in_(ids))
        )

        return query.all()

    @classmethod
    def filter_posts(
        cls,
        *,
        cursor: Optional[float] = None,
        deleted: bool = False,
        parent_id: Optional[int] = None,
        color: Optional[str] = None,  # noqa
        tag: Optional[str] = None,
        start_date: int | None = None,
        end_date: int | None = None,
        shared: Optional[bool] = None,
        has_files: bool | None = None,
        untagged: bool | None = None,
        order_by: Literal['created_at', 'updated_at', 'deleted_at'] = 'created_at',
        ascending: bool = False,
        per_page: int = 20,
    ) -> list[Self]:
        """Find posts based on various optional filters and pagination parameters."""

        # `subqueryload`: load the relationship using a separate query.
        # The default is `lazyload`, meaning a query is triggered each time `post.tags` is accessed.
        # Other common modes include `joinedload` and `contains_eager`.
        # https://python.plainenglish.io/relationships-with-sqlalchemy-958b7358e16
        query = db.session.query(Post).options(
            subqueryload(Post.tags),
            subqueryload(Post.parent).subqueryload(Post.tags),
        )

        if deleted:
            query = query.filter(Post.deleted_at.isnot(None))
        else:
            query = query.filter(Post.deleted_at.is_(None))

        if parent_id is not None:
            query = query.filter(Post.parent_id == parent_id)

        if color:
            query = query.filter(Post.color == color)

        if tag:
            # NOTE: When using limit with join, the result may be fewer than the limit.
            # It can be resolved by using a subquery.
            # https://dncrews.com/limit-and-offset-can-work-with-join-f03327fa2ad3
            query = query.join(Post.tags).filter(
                or_(Tag.name == tag, Tag.name.startswith(tag + '/'))
            )

        if start_date:
            query = query.filter(Post.created_at >= start_date)

        if end_date:
            query = query.filter(Post.created_at <= end_date)

        if shared is not None:
            if shared:
                query = query.filter(Post.shared)
            else:
                query = query.filter(~Post.shared)

        if has_files is not None:
            if has_files:
                query = query.filter(Post.files.isnot(None), func.json_array_length(Post.files) > 0)
            else:
                query = query.filter(
                    or_(Post.files.is_(None), func.json_array_length(Post.files) <= 0)
                )

        if untagged is not None:
            if untagged:
                query = query.filter(~Post.tags.any())
            else:
                query = query.filter(Post.tags.any())

        order_field = getattr(Post, order_by)
        query = query.order_by(order_field.asc() if ascending else order_field.desc())

        if cursor:
            query = query.filter(
                order_field > cursor if ascending else order_field < cursor
            )

        query = query.limit(per_page)

        return query.all()

    @classmethod
    def get_stats_summary(
        cls,
        *,
        start_date: datetime | None = None,
        end_date: datetime | None = None,
        offset: int = 0,
    ):
        query = Post.query.filter(Post.deleted_at.is_(None))
        if start_date is not None and end_date is not None:
            start_timestamp = int(start_date.timestamp() * 1000)
            end_timestamp = int(end_date.timestamp() * 1000)
            query = query.filter(Post.created_at >= start_timestamp, Post.created_at < end_timestamp)

        rows = query.all()
        local_offset = timedelta(minutes=offset)
        total_posts = len(rows)
        active_days = len({
            (datetime.fromtimestamp(post.created_at / 1000) + local_offset).date()
            for post in rows
        })
        shared_posts = sum(1 for post in rows if post.shared)
        posts_with_images = sum(1 for post in rows if post.files)
        untagged_posts = sum(1 for post in rows if not post.tags)
        first_post_at = min((post.created_at for post in rows), default=None)
        last_post_at = max((post.created_at for post in rows), default=None)

        color_counts = [
            {'name': color, 'count': sum(1 for post in rows if post.color == color)}
            for color in ('red', 'green', 'blue')
        ]
        color_counts = [item for item in color_counts if item['count'] > 0]

        tag_counts = []
        for tag in Tag.query.all():
            count = sum(
                1
                for post in rows
                if any(t.name == tag.name or t.name.startswith(tag.name + '/') for t in post.tags)
            )
            if count > 0:
                tag_counts.append({'name': tag.name, 'count': count})
        tag_counts.sort(key=lambda item: (-item['count'], item['name']))

        return {
            'total_posts': total_posts,
            'active_days': active_days,
            'shared_posts': shared_posts,
            'posts_with_images': posts_with_images,
            'untagged_posts': untagged_posts,
            'first_post_at': first_post_at,
            'last_post_at': last_post_at,
            'color_counts': color_counts,
            'top_tags': tag_counts[:12],
        }

    @classmethod
    def clear_all(cls) -> list[int]:
        posts_to_delete = (
            db.session.query(Post.id).filter(Post.deleted_at.isnot(None)).all()
        )

        db.session.query(Post).filter(Post.deleted_at.isnot(None)).delete(
            synchronize_session='fetch'
        )
        db.session.commit()

        return [post[0] for post in posts_to_delete]

    @classmethod
    def count(cls) -> int:
        return (
            db.session.query(func.count(Post.id))
            .filter(Post.deleted_at.is_(None))
            .scalar()
        )

    @property
    def deleted(self) -> bool:
        return self.deleted_at is not None

    def delete(self) -> None:
        self.deleted_at = utc_now_ms()

        if self.parent_id:
            self.parent.children_count -= 1
            db.session.add(self.parent)

        self.save()

    def restore(self) -> None:
        self.deleted_at = None

        if self.parent_id:
            self.parent.children_count += 1
            db.session.add(self.parent)

        self.save()

    def clear(self) -> None:
        db.session.delete(self)
        db.session.commit()

    def save(self) -> Self:
        db.session.add(self)
        db.session.commit()
        return self
