"""
Diagnostic test for the engine-internal periodic reindex.

Re-embedding is deferred work, so it needs a job that runs it — and the scheduler as it
stands can only run authored sequences and has no overlap protection. Two properties matter
for this one:

  - **coalescing**: a burst of writes must produce one follow-up sweep, not one per write,
    and two sweeps must never overlap (each embed is an HTTP round trip, and a second
    concurrent pass would re-embed records the first is already working through);
  - **isolation**: a space whose Ollama is down, or whose config is unreadable, must not stop
    the other spaces or kill the loop.

No database or network: the sweep body and the space list are stubbed.

Run (from repo root, with the project venv so the package imports resolve):
    .venv/bin/python tests/embeddings-scheduled-reindex.py
"""

import asyncio
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import config, embeddings as emb, scheduler, spaces  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


# --- the sweep itself: enabled-only, incremental, failure-isolated ------------
reindexed: list[tuple[str, bool]] = []
configs = {
    "SPACE_ON": {"enabled": True},
    "SPACE_OFF": {"enabled": False},
    "SPACE_BROKEN": {"enabled": True},
}

spaces.fetch_spaces = lambda: [{"id": sid} for sid in configs]  # type: ignore[assignment]
emb.resolve_config = lambda space_id: dict(configs[space_id])  # type: ignore[assignment]


def fake_reindex_space(space_id: str, *, only_stale: bool = False) -> dict[str, Any]:
    if space_id == "SPACE_BROKEN":
        raise emb.EmbeddingsUnavailable("Ollama is unavailable")
    reindexed.append((space_id, only_stale))
    return {"embedded": 2}


emb.reindex_space = fake_reindex_space  # type: ignore[assignment]

summary = scheduler.sweep_stale_embeddings()
check("only spaces with vector search enabled are swept", reindexed == [("SPACE_ON", True)])
check("the sweep is incremental, not a full rebuild", reindexed[0][1] is True)
check("a broken space is counted, not raised", summary == {"spaces": 1, "embedded": 2, "failed": 1})


def _raise_list() -> list[dict[str, Any]]:
    raise RuntimeError("catalog is locked")


spaces.fetch_spaces = _raise_list  # type: ignore[assignment]
check(
    "an unreadable catalog returns an empty summary instead of raising",
    scheduler.sweep_stale_embeddings() == {"spaces": 0, "embedded": 0, "failed": 0},
)
spaces.fetch_spaces = lambda: [{"id": sid} for sid in configs]  # type: ignore[assignment]


# --- coalescing: many requests during one sweep collapse into one follow-up ---
sweeps: list[float] = []
overlapping = False
in_flight = False


def slow_sweep() -> dict[str, Any]:
    global overlapping, in_flight
    if in_flight:
        overlapping = True
    in_flight = True
    time.sleep(0.15)
    in_flight = False
    sweeps.append(time.monotonic())
    return {"spaces": 1, "embedded": 0, "failed": 0}


scheduler.sweep_stale_embeddings = slow_sweep  # type: ignore[assignment]
# A long interval so every sweep in this test comes from an explicit request, not a tick.
config.embedding_reindex_seconds = lambda: 3600  # type: ignore[assignment]


async def exercise_coalescing() -> None:
    job = scheduler.EmbeddingReindexJob()
    await job.start()
    job.request()
    await asyncio.sleep(0.05)
    # Three writes land while the first sweep is still running.
    for _ in range(3):
        job.request()
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.45)
    await job.stop()


asyncio.run(exercise_coalescing())
check("two sweeps never overlap", overlapping is False)
check(f"a burst collapses into one follow-up sweep (ran {len(sweeps)})", len(sweeps) == 2)


# --- the off switch ----------------------------------------------------------
sweeps.clear()
config.embedding_reindex_seconds = lambda: 0  # type: ignore[assignment]


async def exercise_disabled() -> None:
    job = scheduler.EmbeddingReindexJob()
    await job.start()
    job.request()
    await asyncio.sleep(0.2)
    await job.stop()


asyncio.run(exercise_disabled())
check("a zero interval turns the periodic job off", sweeps == [])

# The module-level helper is a no-op until the job is started, so a write path can call it
# unconditionally (including from a test process with no scheduler running).
scheduler.request_embedding_sweep()
check("requesting a sweep with no scheduler running is harmless", True)

print()
if failures:
    print(f"embeddings-scheduled-reindex: {len(failures)} FAILED")
    for name in failures:
        print(f"  - {name}")
    sys.exit(1)
print("embeddings-scheduled-reindex: ok")
