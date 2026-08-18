"""Study group service tests with fake pools (no database required)."""

# Test doubles intentionally implement only the pool methods exercised here.
# pyright: reportArgumentType=false

from datetime import datetime, timedelta, timezone

import pytest

from server import envelope
from server.auth.runtime import User
from server.services import analytics
from server.services import study_groups as sg
from tests.fakes import FakeCursor, FakePool

TS = datetime(2026, 8, 12, 3, 30, 2, 558000, tzinfo=timezone.utc)

ORG_GATE = ('SELECT membership, trial_ends_at FROM users', FakeCursor([('organization', None)]))
OWNER_ROLE = ('SELECT m.role FROM study_group_members', FakeCursor([('owner',)]))
MEMBER_ROLE = ('SELECT m.role FROM study_group_members', FakeCursor([('member',)]))
NO_ROLE = ('SELECT m.role FROM study_group_members', FakeCursor([]))


def _user(user_id: int = 1, membership: str = 'organization') -> User:
    return User(id=user_id, username='owner', email=None, is_active=True, role='user', membership=membership)


def _group_row(group_id: int = 10) -> tuple:
    return (group_id, 'Group', 'desc', 1, TS, TS)


def _member_user_row(user_id: int = 2, role: str = 'member') -> tuple:
    return (user_id, 'bob', None, True, 'user', 'free', None, role)


# ------------------------------------------------------------------- create


async def test_create_group_requires_organization():
    for membership_value, trial in (
        ('pro', None),
        ('free', None),
        ('free', datetime.now(timezone.utc) + timedelta(days=1)),  # trial only grants pro
    ):
        pool = FakePool([('SELECT membership, trial_ends_at FROM users', FakeCursor([(membership_value, trial)]))])
        with pytest.raises(envelope.APIError) as exc_info:
            await sg.create_group(pool, _user(membership=membership_value), 'Group', None)
        assert exc_info.value.status == 403
        assert exc_info.value.code == 'ORGANIZATION_REQUIRED'


async def test_create_group_success():
    pool = FakePool([
        ORG_GATE,
        ('INSERT INTO study_groups (', FakeCursor([_group_row()])),
        ('INSERT INTO study_group_members', FakeCursor()),
    ])
    created = await sg.create_group(pool, _user(), '  Group  ', 'desc')
    assert created['id'] == 10
    assert created['name'] == 'Group'
    assert created['createdBy'] == 1
    assert created['createdAt'].endswith('Z')
    assert created['updatedAt'].endswith('Z')
    assert pool.record[1][1][0] == 'Group'  # name stripped
    owner_sql, owner_params = pool.record[2]
    assert 'INSERT INTO study_group_members' in owner_sql
    assert "'owner'" in owner_sql
    assert owner_params == (10, 1)


# --------------------------------------------------------------------- read


async def test_list_my_groups():
    row = _group_row() + ('owner', 3, 1)
    pool = FakePool([('FROM study_groups g', FakeCursor([row]))])
    groups = await sg.list_my_groups(pool, _user())
    assert len(groups) == 1
    assert groups[0]['role'] == 'owner'
    assert groups[0]['memberCount'] == 3
    assert groups[0]['bankCount'] == 1
    assert groups[0]['createdBy'] == 1


async def test_get_group_member_view():
    pool = FakePool([
        MEMBER_ROLE,
        ('FROM study_groups WHERE id', FakeCursor([_group_row()])),
        ('SELECT m.user_id, u.username', FakeCursor([
            (1, 'owner', 'owner', TS),
            (2, 'bob', 'member', TS),
        ])),
        ('FROM study_group_banks sb', FakeCursor([(5, 'Bank', 'math', TS)])),
    ])
    detail = await sg.get_group(pool, _user(user_id=2), 10)
    assert detail['id'] == 10
    assert detail['role'] == 'member'
    assert [m['username'] for m in detail['members']] == ['owner', 'bob']
    assert detail['members'][0]['userId'] == 1
    assert detail['members'][0]['joinedAt'].endswith('Z')
    assert detail['banks'] == [{
        'bankId': 5, 'name': 'Bank', 'subject': 'math', 'linkedAt': detail['banks'][0]['linkedAt'],
    }]
    assert detail['banks'][0]['linkedAt'].endswith('Z')


async def test_get_group_non_member_404():
    pool = FakePool([NO_ROLE])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.get_group(pool, _user(), 10)
    assert exc_info.value.status == 404
    assert exc_info.value.code == 'STUDY_GROUP_NOT_FOUND'


# ------------------------------------------------- update / delete (owner)


async def test_update_group_permissions():
    with pytest.raises(envelope.APIError):
        await sg.update_group(None, _user(), 10, None, None)  # nothing to update
    pool = FakePool([NO_ROLE])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.update_group(pool, _user(), 10, 'New', None)
    assert exc_info.value.code == 'STUDY_GROUP_NOT_FOUND'
    pool = FakePool([MEMBER_ROLE])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.update_group(pool, _user(), 10, 'New', None)
    assert exc_info.value.code == 'FORBIDDEN'
    pool = FakePool([
        OWNER_ROLE,
        ORG_GATE,
        ('UPDATE study_groups', FakeCursor([_group_row()])),
    ])
    updated = await sg.update_group(pool, _user(), 10, 'New', None)
    assert updated['id'] == 10


async def test_group_management_requires_organization():
    pool = FakePool([
        OWNER_ROLE,
        ('SELECT membership, trial_ends_at FROM users', FakeCursor([('pro', None)])),
    ])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.delete_group(pool, _user(membership='pro'), 10)
    assert exc_info.value.code == 'ORGANIZATION_REQUIRED'


async def test_delete_group_permissions():
    pool = FakePool([MEMBER_ROLE])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.delete_group(pool, _user(), 10)
    assert exc_info.value.code == 'FORBIDDEN'
    pool = FakePool([
        OWNER_ROLE,
        ORG_GATE,
        ('DELETE FROM study_groups WHERE id', FakeCursor()),
    ])
    await sg.delete_group(pool, _user(), 10)
    assert len(pool.record) == 3


# ------------------------------------------------------------------ members


async def test_add_member():
    # non-owner requester -> 403
    pool = FakePool([MEMBER_ROLE])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.add_member(pool, _user(), 10, 'bob')
    assert exc_info.value.code == 'FORBIDDEN'
    # target missing or inactive -> 404 MEMBER_NOT_FOUND
    pool = FakePool([
        OWNER_ROLE,
        ORG_GATE,
        ('SELECT id, username FROM users', FakeCursor([])),
    ])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.add_member(pool, _user(), 10, 'ghost')
    assert exc_info.value.code == 'MEMBER_NOT_FOUND'
    # already a member -> 409 MEMBER_CONFLICT
    pool = FakePool([
        OWNER_ROLE,
        ORG_GATE,
        ('SELECT id, username FROM users', FakeCursor([(2, 'bob')])),
        ('INSERT INTO study_group_members', FakeCursor([])),
    ])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.add_member(pool, _user(), 10, 'bob')
    assert exc_info.value.status == 409
    assert exc_info.value.code == 'MEMBER_CONFLICT'
    # success
    pool = FakePool([
        OWNER_ROLE,
        ORG_GATE,
        ('SELECT id, username FROM users', FakeCursor([(2, 'bob')])),
        ('INSERT INTO study_group_members', FakeCursor([(TS,)])),
    ])
    member = await sg.add_member(pool, _user(), 10, ' BOB ')
    assert member['userId'] == 2
    assert member['username'] == 'bob'
    assert member['role'] == 'member'
    assert member['joinedAt'].endswith('Z')
    assert pool.record[2][1] == ('BOB',)  # case-insensitive lookup, stripped


async def test_remove_member():
    # non-owner requester -> 403
    pool = FakePool([MEMBER_ROLE])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.remove_member(pool, _user(), 10, 2)
    assert exc_info.value.code == 'FORBIDDEN'
    # target not a member -> 404 MEMBER_NOT_FOUND
    pool = FakePool([
        OWNER_ROLE,
        ORG_GATE,
        ('SELECT u.id, u.username, u.email', FakeCursor([])),
    ])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.remove_member(pool, _user(), 10, 99)
    assert exc_info.value.code == 'MEMBER_NOT_FOUND'
    # target is the owner row -> 409 CANNOT_REMOVE_OWNER
    pool = FakePool([
        OWNER_ROLE,
        ORG_GATE,
        ('SELECT u.id, u.username, u.email', FakeCursor([_member_user_row(1, 'owner')])),
    ])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.remove_member(pool, _user(), 10, 1)
    assert exc_info.value.status == 409
    assert exc_info.value.code == 'CANNOT_REMOVE_OWNER'
    # success
    pool = FakePool([
        OWNER_ROLE,
        ORG_GATE,
        ('SELECT u.id, u.username, u.email', FakeCursor([_member_user_row(2)])),
        ('DELETE FROM study_group_members', FakeCursor(rowcount=1)),
    ])
    await sg.remove_member(pool, _user(), 10, 2)
    assert pool.record[2][1] == (10, 2)


# -------------------------------------------------------------------- banks


async def test_link_bank():
    # non-owner requester -> 403
    pool = FakePool([MEMBER_ROLE])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.link_bank(pool, _user(), 10, 5)
    assert exc_info.value.code == 'FORBIDDEN'
    # group owner does not own the bank -> 403 BANK_NOT_OWNED
    pool = FakePool([
        OWNER_ROLE,
        ORG_GATE,
        ('FROM user_bank_links ubl', FakeCursor([])),
    ])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.link_bank(pool, _user(), 10, 5)
    assert exc_info.value.status == 403
    assert exc_info.value.code == 'BANK_NOT_OWNED'
    # duplicate link -> 409 BANK_LINK_CONFLICT
    pool = FakePool([
        OWNER_ROLE,
        ORG_GATE,
        ('FROM user_bank_links ubl', FakeCursor([(5,)])),
        ('INSERT INTO study_group_banks', FakeCursor([])),
    ])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.link_bank(pool, _user(), 10, 5)
    assert exc_info.value.code == 'BANK_LINK_CONFLICT'
    # success
    pool = FakePool([
        OWNER_ROLE,
        ORG_GATE,
        ('FROM user_bank_links ubl', FakeCursor([(5,)])),
        ('INSERT INTO study_group_banks', FakeCursor([(TS,)])),
    ])
    link = await sg.link_bank(pool, _user(), 10, 5)
    assert link['groupId'] == 10
    assert link['bankId'] == 5
    assert link['linkedAt'].endswith('Z')
    assert pool.record[3][1] == (10, 5, 1)  # linked_by is the requester


async def test_unlink_bank():
    pool = FakePool([
        OWNER_ROLE,
        ORG_GATE,
        ('DELETE FROM study_group_banks', FakeCursor(rowcount=0)),
    ])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.unlink_bank(pool, _user(), 10, 5)
    assert exc_info.value.status == 404
    assert exc_info.value.code == 'BANK_LINK_NOT_FOUND'
    pool = FakePool([
        OWNER_ROLE,
        ORG_GATE,
        ('DELETE FROM study_group_banks', FakeCursor(rowcount=1)),
    ])
    await sg.unlink_bank(pool, _user(), 10, 5)


# ------------------------------------------------------------- member stats


async def test_get_member_stats(monkeypatch):
    # non-owner requester -> 403
    pool = FakePool([MEMBER_ROLE])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.get_member_stats(pool, _user(), 10, 2)
    assert exc_info.value.code == 'FORBIDDEN'
    # target not a member -> 404 MEMBER_NOT_FOUND
    pool = FakePool([
        OWNER_ROLE,
        ORG_GATE,
        ('SELECT u.id, u.username, u.email', FakeCursor([])),
    ])
    with pytest.raises(envelope.APIError) as exc_info:
        await sg.get_member_stats(pool, _user(), 10, 99)
    assert exc_info.value.code == 'MEMBER_NOT_FOUND'
    # owner -> delegates to analytics snapshot built for the member
    captured = {}

    async def fake_snapshot(_pool, member):
        captured['member'] = member
        return {'summary': {}, 'recentSessions': [], 'weakQuestions': []}

    monkeypatch.setattr(analytics, 'get_user_stats_snapshot', fake_snapshot)
    pool = FakePool([
        OWNER_ROLE,
        ORG_GATE,
        ('SELECT u.id, u.username, u.email', FakeCursor([_member_user_row(2)])),
    ])
    stats = await sg.get_member_stats(pool, _user(), 10, 2)
    assert stats['summary'] == {}
    assert captured['member'].id == 2
    assert captured['member'].username == 'bob'
    assert captured['member'].membership == 'free'
