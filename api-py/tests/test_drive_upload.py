"""Tests for chunked upload service: init, put_chunk, complete (collisions), cancel."""
from __future__ import annotations

import pytest
from flask import current_app

from app.services.drive_upload import (
    UploadCollision,
    UploadGone,
    UploadInvalid,
    UploadNotFound,
)

MIB = 1 << 20


@pytest.fixture()
def svc(app, clean_drive):
    with app.app_context():
        yield current_app.drive_upload_service


@pytest.fixture()
def drive_svc(app, clean_drive):
    with app.app_context():
        yield current_app.drive_service


def test_init_and_status(svc):
    # 3 chunks of 1MiB
    st = svc.init(None, 'a.bin', size=2 * MIB + 100, chunk_size=MIB)
    assert st.total_chunks == 3
    assert st.chunk_size == MIB
    assert st.received_chunks == []
    assert st.status == 'uploading'

    st2 = svc.get(st.upload_id)
    assert st2.total_chunks == 3


def test_init_invalid_size(svc):
    with pytest.raises(UploadInvalid):
        svc.init(None, 'a.bin', size=0, chunk_size=None)


def test_init_invalid_chunk_size(svc):
    # Below the 1 MiB minimum.
    with pytest.raises(UploadInvalid):
        svc.init(None, 'a.bin', size=100, chunk_size=10)


def test_get_unknown(svc):
    with pytest.raises(UploadNotFound):
        svc.get('nope')


def test_full_upload(svc):
    size = 2 * MIB + 100
    chunk = MIB
    st = svc.init(None, 'small.bin', size=size, chunk_size=chunk)
    payload = bytes(range(256)) * (size // 256 + 1)
    payload = payload[:size]

    svc.put_chunk(st.upload_id, 0, payload[:chunk])
    svc.put_chunk(st.upload_id, 1, payload[chunk:2 * chunk])
    svc.put_chunk(st.upload_id, 2, payload[2 * chunk:])

    s2 = svc.get(st.upload_id)
    assert s2.received_chunks == [0, 1, 2]

    node = svc.complete(st.upload_id, on_collision='ask')
    assert node.name == 'small.bin'
    assert node.size == size
    assert node.type == 'file'


def test_chunk_size_mismatch(svc):
    st = svc.init(None, 'a.bin', size=2 * MIB, chunk_size=MIB)
    with pytest.raises(UploadInvalid):
        svc.put_chunk(st.upload_id, 0, b'\0' * 100)


def test_chunk_idx_out_of_range(svc):
    st = svc.init(None, 'a.bin', size=MIB, chunk_size=MIB)
    with pytest.raises(UploadInvalid):
        svc.put_chunk(st.upload_id, 5, b'\0' * MIB)


def test_idempotent_chunk(svc):
    st = svc.init(None, 'a.bin', size=2 * MIB, chunk_size=MIB)
    svc.put_chunk(st.upload_id, 0, b'\0' * MIB)
    svc.put_chunk(st.upload_id, 0, b'\0' * MIB)
    s2 = svc.get(st.upload_id)
    assert s2.received_chunks == [0]


def test_cancel(svc):
    st = svc.init(None, 'gone.bin', size=MIB, chunk_size=MIB)
    svc.cancel(st.upload_id)
    with pytest.raises(UploadNotFound):
        svc.get(st.upload_id)


def test_complete_missing_chunks(svc):
    st = svc.init(None, 'partial.bin', size=2 * MIB, chunk_size=MIB)
    svc.put_chunk(st.upload_id, 0, b'\0' * MIB)
    with pytest.raises(UploadInvalid):
        svc.complete(st.upload_id, on_collision='ask')


def _do_upload(svc, name, content, parent_id=None, on_collision='ask'):
    # Pad content up to 1 MiB so it satisfies the chunk_size minimum.
    pad_size = max(MIB, len(content))
    body = content + b'\0' * (pad_size - len(content))
    st = svc.init(parent_id, name, size=pad_size, chunk_size=MIB)
    svc.put_chunk(st.upload_id, 0, body)
    return svc.complete(st.upload_id, on_collision=on_collision)


def test_collision_ask_raises(svc):
    _do_upload(svc, 'dup.bin', b'1234')
    with pytest.raises(UploadCollision):
        _do_upload(svc, 'dup.bin', b'5678', on_collision='ask')


def test_collision_skip_returns_existing(svc):
    n1 = _do_upload(svc, 'dup.bin', b'1234')
    n2 = _do_upload(svc, 'dup.bin', b'5678', on_collision='skip')
    assert n2.id == n1.id


def test_collision_rename(svc):
    _do_upload(svc, 'dup.bin', b'1234')
    n2 = _do_upload(svc, 'dup.bin', b'5678', on_collision='rename')
    assert n2.name != 'dup.bin'


def test_collision_overwrite(svc):
    n1 = _do_upload(svc, 'dup.bin', b'1234')
    n2 = _do_upload(svc, 'dup.bin', b'5678', on_collision='overwrite')
    assert n2.id == n1.id
