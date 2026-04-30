import re
from dataclasses import dataclass
from enum import Enum
from typing import Optional, Self, Literal, TypeAlias, Annotated

import orjson
from pydantic import BaseModel, AfterValidator, Field

from .model import Post

NoContent: TypeAlias = tuple[Literal[''], Literal[204]]
NO_CONTENT = '', 204


class Missing:
    """A Singleton which indicates a value does not exist.

    >>> Missing() == Missing()
    True
    """

    _instance = None

    def __new__(cls, *args, **kw):
        if cls._instance is None:
            cls._instance = super().__new__(cls, *args, **kw)
        return cls._instance

    def __str__(self):
        return '<Missing>'

    __repr__ = __str__


missing = Missing()


def check_hashtag(value: str) -> str:
    if value.startswith('/') or value.endswith('/'):
        raise ValueError("Cannot start or end with '/'")
    if re.search(r'\s', value):
        raise ValueError("Cannot contain spaces")
    if '#' in value:
        raise ValueError("Cannot contain '#'")
    if '//' in value:
        raise ValueError("Cannot contain consecutive '/'")
    return value


def check_date(value: str) -> str:
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', value):
        raise ValueError("Invalid date format, must be YYYY-MM-DD")
    return value


class CategoryColor(str, Enum):
    RED = 'red'
    GREEN = 'green'
    BLUE = 'blue'


class SortingField(str, Enum):
    CREATED_AT = 'created_at'
    UPDATED_AT = 'updated_at'
    DELETED_AT = 'deleted_at'


class Id(BaseModel):
    id: int


class Name(BaseModel):
    name: str


class LoginRequest(BaseModel):
    password: str


class RenameTagRequest(BaseModel):
    name: str
    new_name: Annotated[str, AfterValidator(check_hashtag)]


class StickTagRequest(BaseModel):
    name: str
    sticky: bool


class DateRange(BaseModel):
    start_date: Annotated[str, AfterValidator(check_date)]
    end_date: Annotated[str, AfterValidator(check_date)]
    offset: int = 480  # timezone offset in minutes


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    partial: bool = False
    limit: int = 0


class FilterPostRequest(BaseModel):
    cursor: Optional[int] = None
    deleted: bool = False
    parent_id: Optional[int] = None
    color: Optional[CategoryColor] = None
    tag: Optional[str] = None
    shared: Optional[bool] = None
    has_files: Optional[bool] = None
    order_by: SortingField = SortingField.CREATED_AT
    ascending: bool = False

    start_date: Optional[int] = None
    end_date: Optional[int] = None


@dataclass
class FileInfo:
    url: str
    size: Optional[int] = None
    thumb_url: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None


class CreatePostRequest(BaseModel):
    content: str = Field(..., min_length=1)
    files: Optional[list[FileInfo]] = None
    color: Optional[CategoryColor] = None
    shared: Optional[bool] = None
    parent_id: Optional[int] = None


class UpdatePostRequest(BaseModel):
    id: int
    # https://github.com/pydantic/pydantic/issues/1223
    # How to have an “optional” field but if present required to conform to non None value?

    # a: Optional[int]  # this field is required bit can be given None (to be CHANGED in v2)
    # b: Optional[int] = None  # field is not required, can be given None or an int (current behaviour)
    # c: int = None  # this field isn't required but must be an int if it is provided (current behaviour)
    content: str = missing
    shared: bool = missing

    files: Optional[list[FileInfo]] = missing
    color: Optional[CategoryColor] = missing
    parent_id: Optional[int] = missing


class DeletePostRequest(BaseModel):
    id: int
    hard: bool = False


# ============================================================================
# Drive request DTOs (mirror api-go/internal/models/drive.go request shapes)
# ============================================================================


class DriveCreateFolderRequest(BaseModel):
    parent_id: Optional[int] = None
    name: str


class DriveRenameRequest(BaseModel):
    id: int
    name: str


class DriveMoveRequest(BaseModel):
    ids: list[int]
    new_parent_id: Optional[int] = None


class DriveDeleteRequest(BaseModel):
    ids: list[int]


class DriveRestoreRequest(BaseModel):
    id: int


class DrivePurgeRequest(BaseModel):
    ids: list[int]


class DriveUploadInitRequest(BaseModel):
    parent_id: Optional[int] = None
    name: str
    size: int
    chunk_size: Optional[int] = None


class DriveUploadCompleteRequest(BaseModel):
    upload_id: str
    on_collision: Optional[str] = None  # "ask"|"overwrite"|"rename"|"skip"


class DriveShareCreateRequest(BaseModel):
    node_id: int
    password: Optional[str] = None
    expires_at: Optional[int] = None  # epoch ms; nil/0 = never


class DriveShareRevokeRequest(BaseModel):
    share_id: int


class DriveListQuery(BaseModel):
    parent_id: Optional[int] = None
    q: Optional[str] = None
    order_by: Optional[str] = None
    sort: Optional[str] = None  # "asc" | "desc"


class DriveIdQuery(BaseModel):
    id: int


class DriveSharesAllQuery(BaseModel):
    include_expired: bool = False


@dataclass
class CreationDto:
    id: int
    created_at: int
    updated_at: int


@dataclass
class TagDto:
    name: str
    sticky: bool
    post_count: int


@dataclass
class PostDto:
    id: int
    content: str
    created_at: int
    updated_at: int
    children_count: int
    shared: bool

    files: Optional[list[FileInfo]] = None
    color: Optional[CategoryColor] = None

    deleted_at: Optional[int] = None
    parent: Optional[Self] = None
    tags: Optional[list[str]] = None

    score: Optional[float] = None

    @classmethod
    def from_model(cls, post: Post) -> Self:
        rv = cls(
            id=post.id,
            content=post.content,
            created_at=post.created_at,
            updated_at=post.updated_at,
            deleted_at=post.deleted_at,
            children_count=post.children_count,
            shared=post.shared,
            files=orjson.loads(post.files) if post.files else [],
            color=post.color,
            tags=[tag.name for tag in post.tags],
        )

        if post.parent and not post.parent.deleted:
            rv.parent = cls.from_model(post.parent)

        return rv


@dataclass
class PostPagination:
    posts: list[PostDto]
    cursor: int
    size: int


@dataclass
class PostStats:
    post_count: int
    tag_count: int
    day_count: int
