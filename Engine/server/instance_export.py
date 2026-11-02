"""Instance-admin download of the catalog and a local Neo4j store."""

from __future__ import annotations

import io
import os
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
from pathlib import Path
from urllib.parse import urlparse


def neo4j_is_local(uri: str) -> bool:
    text = (uri or "").strip()
    if not text:
        return False
    parsed = urlparse(text)
    host = (parsed.hostname or "").strip().lower()
    return host in {"localhost", "127.0.0.1", "::1"}


def build_export(catalog_path: Path, neo4j_uri: str, neo4j_data: Path | None = None) -> bytes:
    """Tar of the catalog SQLite plus a Neo4j dump when Bolt is on this machine."""
    if not neo4j_is_local(neo4j_uri):
        raise ValueError("This instance uses a remote Neo4j. Export the graph from the Aura console.")
    buffer = io.BytesIO()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        catalog_copy = root / "data.db"
        _backup_sqlite(catalog_path, catalog_copy)
        dump_note = _try_dump(root)
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            archive.add(catalog_copy, arcname="catalog/data.db")
            dump = root / "neo4j.dump"
            if dump.is_file():
                archive.add(dump, arcname="neo4j/neo4j.dump")
            elif neo4j_data and neo4j_data.is_dir():
                archive.add(neo4j_data, arcname="neo4j-store")
            note = root / "README.txt"
            note.write_text(dump_note, encoding="utf-8")
            archive.add(note, arcname="README.txt")
    return buffer.getvalue()


def _backup_sqlite(source: Path, dest: Path) -> None:
    if not source.is_file():
        raise ValueError("Catalog database was not found.")
    src = sqlite3.connect(source)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()


def _try_dump(root: Path) -> str:
    admin = (os.environ.get("NEO4J_ADMIN") or "/opt/neo4j/bin/neo4j-admin").strip()
    if not Path(admin).is_file() and not shutil.which(admin):
        return (
            "neo4j-admin is not on this machine, so the archive has the catalog only. "
            "On Hosted Basic the graph dump is included when neo4j-admin is installed.\n"
        )
    target = root / "neo4j-out"
    target.mkdir()
    try:
        subprocess.run(
            [admin, "database", "dump", "neo4j", f"--to-path={target}"],
            check=True,
            capture_output=True,
            text=True,
            timeout=180,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return (
            "neo4j-admin database dump did not finish. The catalog is in this archive. "
            "If a neo4j-store directory is present, it is a copy of the on-disk store.\n"
        )
    found = next(target.glob("*.dump"), None)
    if found is None:
        return "neo4j-admin finished without a dump file. The catalog is in this archive.\n"
    found.replace(root / "neo4j.dump")
    return "catalog/data.db is the pona flow catalog. neo4j/neo4j.dump is the Neo4j Community database.\n"
