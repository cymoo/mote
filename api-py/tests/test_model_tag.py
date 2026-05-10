from app.models import Post, Tag


def make_tagged_post(tag: Tag, content: str) -> Post:
    post = Post(content='placeholder')
    post.content = content
    post.tags = [tag]
    return post


def test_rename_virtual_parent_with_subtags(session):
    source_child = Tag(name='foo1/bar')
    target = Tag(name='foo')
    post1 = make_tagged_post(source_child, '<span class="hash-tag">#foo1/bar</span>')
    post2 = make_tagged_post(target, '<span class="hash-tag">#foo</span>')
    session.add_all([source_child, target, post1, post2])
    session.commit()

    Tag.rename_or_merge('foo1', 'foo')

    names = [tag.name for tag in Tag.query.order_by(Tag.name).all()]
    assert names == ['foo', 'foo/bar']
    assert post1.content == '<span class="hash-tag">#foo/bar</span>'


def test_rename_virtual_parent_creates_target_parent(session):
    source_child = Tag(name='foo1/bar')
    post = make_tagged_post(source_child, '<span class="hash-tag">#foo1/bar</span>')
    session.add_all([source_child, post])
    session.commit()

    Tag.rename_or_merge('foo1', 'foo')

    names = [tag.name for tag in Tag.query.order_by(Tag.name).all()]
    assert names == ['foo', 'foo/bar']
    assert post.content == '<span class="hash-tag">#foo/bar</span>'
