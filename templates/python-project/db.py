"""
db.py — the smallest useful database layer.

Normal Python + normal SQLite (via the standard library's sqlite3 — no
ORM, no extra dependency). This is intentionally NOT trying to be a full
ORM: it's `create` / `find` / `find_by_id` / `update` / `delete` on plain
dicts, against tables you define with plain SQL. If you outgrow this,
swap it for SQLAlchemy, or Postgres via psycopg — main.py only imports
from this file, so replacing it doesn't touch your routes.
"""

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / "app.db"


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(schema_sql: str):
    """Run once at startup with a CREATE TABLE IF NOT EXISTS block."""
    conn = get_connection()
    try:
        conn.executescript(schema_sql)
        conn.commit()
    finally:
        conn.close()


def create(table: str, fields: dict) -> int:
    columns = ", ".join(fields.keys())
    placeholders = ", ".join("?" for _ in fields)
    conn = get_connection()
    try:
        cur = conn.execute(
            f"INSERT INTO {table} ({columns}) VALUES ({placeholders})",
            list(fields.values()),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def find(table: str, where: dict | None = None) -> list[dict]:
    conn = get_connection()
    try:
        if where:
            clause = " AND ".join(f"{k} = ?" for k in where)
            rows = conn.execute(f"SELECT * FROM {table} WHERE {clause}", list(where.values()))
        else:
            rows = conn.execute(f"SELECT * FROM {table}")
        return [dict(r) for r in rows.fetchall()]
    finally:
        conn.close()


def find_by_id(table: str, id_: int) -> dict | None:
    rows = find(table, {"id": id_})
    return rows[0] if rows else None


def update(table: str, id_: int, fields: dict) -> None:
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    conn = get_connection()
    try:
        conn.execute(
            f"UPDATE {table} SET {set_clause} WHERE id = ?",
            list(fields.values()) + [id_],
        )
        conn.commit()
    finally:
        conn.close()


def delete(table: str, id_: int) -> None:
    conn = get_connection()
    try:
        conn.execute(f"DELETE FROM {table} WHERE id = ?", (id_,))
        conn.commit()
    finally:
        conn.close()
