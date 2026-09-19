"""Real, disposable PostgreSQL databases for runtime tests."""
import os
from uuid import uuid4

from psycopg import AsyncConnection, sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from practiq_ai.database import Database

DATABASES = []
SERVICES = []


async def new_database():
    base = os.environ['TEST_DATABASE_URI']
    name = 'practiq_test_' + uuid4().hex
    async with await AsyncConnection.connect(base, autocommit=True) as conn:
        await conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    DATABASES.append((base, name))
    settings = conninfo_to_dict(base)
    settings['dbname'] = name
    db = Database(make_conninfo('', **settings))
    await db.open()
    await db.initialize()
    return db


async def cleanup():
    while SERVICES:
        service = SERVICES.pop()
        if not service.stopping:
            await service.stop(timeout=0)
    while DATABASES:
        base, name = DATABASES.pop()
        async with await AsyncConnection.connect(base, autocommit=True) as conn:
            await conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
