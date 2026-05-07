from app.models import Post


def test_create_post(session):
    post = Post(content="hello world")
    session.add(post)
    session.commit()

    assert post.id is not None
    assert post.content == 'hello world'
