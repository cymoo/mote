import re
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple, Self, Iterable, Literal

from flask import abort

from sqlalchemy.dialects.sqlite import insert

from sqlalchemy import func, or_, text
from sqlalchemy.orm import backref, subqueryload

from .extension import db


HASH_PATTERN = re.compile(r'<span class="hash-tag">#(.+?)</span>')


def utc_now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


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
            abort(400, f'cannot move "{name}" to a subtag of itself "{new_name}"')

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

        # delete the old tag
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
        for tag in [self] + self.descendants:
            for post in tag.posts:  # noqa
                post.deleted_at = deleted_at
                db.session.add(post)

        db.session.commit()

    def restore(self) -> None:
        """Restore all posts under this tag and its descendant tags."""

        for tag in [self] + self.descendants:
            for post in tag.posts:  # noqa
                post.deleted_at = None
                db.session.add(post)
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

        # Convert `datetime` to timestamp (in milliseconds)
        start_timestamp = int(start_date.timestamp() * 1000)
        end_timestamp = int(end_date.timestamp() * 1000)

        offset = int(start_date.utcoffset().total_seconds())

        # Use SQLite functions to group and count posts by date
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

        # Get daily post counts
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
            .options(subqueryload(Post.tags))  # noqa
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
        order_by: Literal['created_at', 'updated_at', 'deleted_at'] = 'created_at',
        ascending: bool = False,
        per_page: int = 20,
    ) -> list[Self]:
        """Find posts based on various optional filters and pagination parameters."""

        # `subqueryload`: load the relationship using a separate query.
        # The default is `lazyload`, meaning a query is triggered each time `post.tags` is accessed.
        # Other common modes include `joinedload` and `contains_eager`.
        # https://python.plainenglish.io/relationships-with-sqlalchemy-958b7358e16
        query = db.session.query(Post).options(subqueryload(Post.tags))  # noqa

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
                query = query.filter(Post.files.isnot(None))
            else:
                query = query.filter(Post.files.is_(None))

        order_field = getattr(Post, order_by)
        query = query.order_by(order_field.asc() if ascending else order_field.desc())

        if cursor:
            query = query.filter(
                order_field > cursor if ascending else order_field < cursor
            )

        query = query.limit(per_page)

        return query.all()

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


# Helper functions


# ============================================================================
# Drive models
# ============================================================================
#
# Plain row-container ORM classes for the cloud-drive feature. Mirrors the
# shape of api-go/internal/models/drive.go. We deliberately don't define
# SQLAlchemy relationships — the drive services issue raw SQL (recursive CTEs,
# partial-unique-index conflict handling, bitmask updates) that the ORM layer
# can't model gracefully. These rows exist mainly so `db.create_all()` can
# build the tables in tests, and so handlers can return them as dataclass-ish
# objects.

from sqlalchemy import Index, CheckConstraint, ForeignKey, text  # noqa: E402


class DriveNode(db.Model):
    __tablename__ = 'drive_nodes'

    id = db.Column(db.Integer, primary_key=True, nullable=False)
    parent_id = db.Column(
        db.Integer,
        ForeignKey('drive_nodes.id', ondelete='CASCADE'),
        nullable=True,
    )
    type = db.Column(db.Text, nullable=False)
    name = db.Column(db.Text, nullable=False)
    blob_path = db.Column(db.Text, nullable=True)
    size = db.Column(db.BigInteger, nullable=True)
    hash = db.Column(db.Text, nullable=True)
    deleted_at = db.Column(db.BigInteger, nullable=True)
    delete_batch_id = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.BigInteger, nullable=False)
    updated_at = db.Column(db.BigInteger, nullable=False)

    __table_args__ = (
        CheckConstraint("type IN ('folder', 'file')", name='ck_drive_nodes_type'),
        CheckConstraint(
            "(type = 'folder' AND blob_path IS NULL AND size IS NULL)"
            " OR (type = 'file' AND blob_path IS NOT NULL AND size IS NOT NULL)",
            name='ck_drive_nodes_shape',
        ),
        Index(
            'drive_nodes_unique_active',
            text('COALESCE(parent_id, 0)'),
            text('LOWER(name)'),
            unique=True,
            sqlite_where=text('deleted_at IS NULL'),
        ),
        Index('drive_nodes_parent', 'parent_id', 'deleted_at'),
        Index('drive_nodes_deleted', 'deleted_at'),
        Index('drive_nodes_name', text('LOWER(name)')),
        Index('drive_nodes_delete_batch', 'delete_batch_id'),
    )


class DriveUpload(db.Model):
    __tablename__ = 'drive_uploads'

    id = db.Column(db.Text, primary_key=True, nullable=False)
    parent_id = db.Column(
        db.Integer,
        ForeignKey('drive_nodes.id', ondelete='SET NULL'),
        nullable=True,
    )
    name = db.Column(db.Text, nullable=False)
    size = db.Column(db.BigInteger, nullable=False)
    chunk_size = db.Column(db.BigInteger, nullable=False)
    total_chunks = db.Column(db.Integer, nullable=False)
    received_mask = db.Column(db.LargeBinary, nullable=False)
    status = db.Column(db.Text, nullable=False)
    expires_at = db.Column(db.BigInteger, nullable=False)
    created_at = db.Column(db.BigInteger, nullable=False)
    updated_at = db.Column(db.BigInteger, nullable=False)

    __table_args__ = (
        CheckConstraint(
            "status IN ('uploading', 'assembling', 'done', 'failed')",
            name='ck_drive_uploads_status',
        ),
        Index('drive_uploads_expires', 'expires_at'),
    )


class DriveShare(db.Model):
    __tablename__ = 'drive_shares'

    id = db.Column(db.Integer, primary_key=True, nullable=False)
    node_id = db.Column(
        db.Integer,
        ForeignKey('drive_nodes.id', ondelete='CASCADE'),
        nullable=False,
    )
    token_hash = db.Column(db.Text, nullable=False, unique=True)
    token_prefix = db.Column(db.Text, nullable=False)
    password_hash = db.Column(db.Text, nullable=True)
    expires_at = db.Column(db.BigInteger, nullable=True)
    created_at = db.Column(db.BigInteger, nullable=False)

    __table_args__ = (
        Index('drive_shares_prefix', 'token_prefix'),
        Index('drive_shares_node', 'node_id'),
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
