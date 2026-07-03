"""CardMirror card-sharing relay — standalone, self-hostable.

A content-agnostic store-and-forward mailbox with live push:

  POST   /relay/messages              store one addressed (encrypted) bundle
  GET    /relay/messages?recipient=   pull everything addressed to a code
  GET    /relay/stream?recipient=     SSE push: live-delivers new bundles
  DELETE /relay/messages/{msg_id}     acknowledge / remove one delivered bundle
  GET    /relay/health                liveness (no auth)

This is the same wire contract CardMirror's official relay speaks, so
pointing the app at your own deployment is just Settings → Card Sharing →
Custom relay URL + Custom relay token. Everyone sharing cards with each
other must use the same relay.

Design notes:
  - Directed addressing: a sender POSTs to the recipient's routing code;
    the recipient receives only its own code and never sends to itself,
    so there is no self-echo.
  - Store-then-push: POST writes the row first (durability), then
    live-pushes to any open /relay/stream connections. Clients catch up
    via GET on every (re)connect, so delivery is at-least-once and the
    client's per-message dedupe absorbs overlap.
  - Messages are swept after 3 hours whether or not they were fetched
    (lazy expiry via a created_at cutoff on reads + a background sweeper).
  - The in-process push registry requires a SINGLE worker process (run
    plain `uvicorn`, no --workers).
  - DB-touching handlers are sync `def` on purpose: Starlette runs them
    in its threadpool, keeping the blocking psycopg2 driver off the
    event loop (which must stay free to serve SSE streams and accept
    connections). The pool is sized to the threadpool; exhaustion sheds
    as 503. Run uvicorn with `--limit-concurrency` sized WELL ABOVE the
    expected number of concurrent SSE streams (it counts long-lived
    connections) — e.g. 4096 — as a connection-storm backstop.

PRIVACY: the card payload is end-to-end encrypted by the CardMirror
client. This server stores the bundle OPAQUELY (the `body` column) and
must never log or inspect it — only routing codes, ids, and counts are
ever touched here.

Env:
  RELAY_TOKEN    required — the shared bearer your CardMirror clients
                 configure as "Custom relay token".
  DATABASE_URL   required — Postgres, e.g.
                 postgresql://user:pass@localhost:5432/relay
  PORT           optional (default 8000; the Dockerfile wires this up).

See README.md for one-command deployment with docker compose.
"""
import asyncio
import gzip
import hmac
import json
import logging
import os
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from sqlalchemy import Column, DateTime, Index, String, create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import TimeoutError as SATimeoutError
from sqlalchemy.orm import Session, declarative_base, sessionmaker

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("relay")

# ── Storage ──────────────────────────────────────────────────────────

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable is required")

# Pool sized to Starlette's sync-handler threadpool (AnyIO default: 40
# tokens) so worker threads never convoy behind connection checkout. A
# short pool_timeout turns exhaustion into a clean 503 (see the
# TimeoutError handler below) instead of an unbounded queue.
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_size=40,
    max_overflow=0,
    pool_timeout=5,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


class RelayMessage(Base):
    __tablename__ = "relay_messages"

    id = Column(String, primary_key=True)
    recipient_code = Column(String, nullable=False)
    body = Column(JSONB, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    __table_args__ = (
        Index("ix_relay_messages_recipient_created", "recipient_code", "created_at"),
    )


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── Limits / lifecycle ───────────────────────────────────────────────

MAX_BYTES = 25 * 1024 * 1024  # decompressed payload cap
MAX_COMPRESSED_BYTES = 30 * 1024 * 1024  # gzip-bomb guard
TTL = timedelta(hours=3)
MAX_PER_POLL = 100
HEARTBEAT_SECONDS = 25
STREAM_QUEUE_MAX = 100

# routing code → open stream queues (single-worker only; see module doc)
_streams: dict[str, set["asyncio.Queue[dict]"]] = {}

# The server's one event loop, captured at startup. Sync (threadpool)
# handlers must never touch _streams or its asyncio.Queues directly —
# they are loop-owned and not thread-safe. All push fan-out is scheduled
# onto the loop via call_soon_threadsafe(_push_to_streams, …).
_loop: Optional[asyncio.AbstractEventLoop] = None


def _push_to_streams(recipient: str, message: dict) -> None:
    """Runs ON the event loop. A full queue sheds the push — the
    client's next catch-up poll covers it (at-least-once delivery)."""
    queues = _streams.get(recipient)
    if not queues:
        return
    for q in list(queues):
        try:
            q.put_nowait(message)
        except asyncio.QueueFull:
            pass


def _sweep(db: Session) -> int:
    cutoff = datetime.utcnow() - TTL
    removed = (
        db.query(RelayMessage)
        .filter(RelayMessage.created_at < cutoff)
        .delete(synchronize_session=False)
    )
    db.commit()
    return removed


def _sweeper_loop() -> None:
    while True:
        time.sleep(300)
        db = SessionLocal()
        try:
            removed = _sweep(db)
            if removed:
                logger.info("[relay] swept %d expired message(s)", removed)
        except Exception as e:  # never let the sweeper kill the thread
            logger.warning("[relay] sweep error: %s", e)
        finally:
            db.close()


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    global _loop
    _loop = asyncio.get_running_loop()
    Base.metadata.create_all(engine)
    threading.Thread(target=_sweeper_loop, daemon=True).start()
    yield


app = FastAPI(title="CardMirror relay", lifespan=_lifespan)


@app.exception_handler(SATimeoutError)
async def _pool_exhausted(_request: Request, _exc: SATimeoutError) -> JSONResponse:
    # Connection-pool checkout timed out: the server is at capacity.
    # Shed with a clean 503 — clients retry (send is user-driven; polls
    # retry next interval; streams reconnect with backoff).
    return JSONResponse({"detail": "relay busy, retry shortly"}, status_code=503)


# ── Auth ─────────────────────────────────────────────────────────────


def require_relay_token(authorization: Optional[str] = Header(None)) -> None:
    """Shared bearer token. This stops the relay being an open public
    service; it is NOT the privacy mechanism (payloads are end-to-end
    encrypted, and the per-recipient routing code is the isolation
    boundary)."""
    expected = os.getenv("RELAY_TOKEN", "")
    if not expected:
        raise HTTPException(500, "RELAY_TOKEN not configured on server")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    if not hmac.compare_digest(authorization[len("Bearer "):], expected):
        raise HTTPException(401, "Invalid relay token")


def _epoch_ms(dt: datetime) -> int:
    return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)


# ── Routes ───────────────────────────────────────────────────────────


@app.get("/relay/health")
def relay_health() -> dict:
    return {"ok": True}


async def _raw_body(request: Request) -> bytes:
    """Reads the request body on the event loop (a sync handler cannot
    await); everything after this runs on a worker thread."""
    return await request.body()


# Deliberately a sync `def`: Starlette runs it in the threadpool, so the
# blocking psycopg2 commit never executes on the event loop. Under
# sustained load the loop previously convoyed and stopped reading new
# connections entirely (permanent accept-path stall at ~200 msg/s,
# CPU idle); threadpool execution + the pool sizing above removes the
# failure mode — overload now degrades to clean 503s instead.
@app.post("/relay/messages", status_code=202, dependencies=[Depends(require_relay_token)])
def post_message(
    raw: bytes = Depends(_raw_body),
    content_encoding: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> JSONResponse:
    if len(raw) > MAX_COMPRESSED_BYTES:
        raise HTTPException(413, "payload too large")

    if "gzip" in (content_encoding or "").lower():
        try:
            data = gzip.decompress(raw)
        except Exception:
            raise HTTPException(400, "invalid gzip body")
    else:
        data = raw

    if len(data) > MAX_BYTES:
        raise HTTPException(413, "payload too large")

    try:
        payload = json.loads(data) if data else {}
    except Exception:
        raise HTTPException(400, "invalid json")

    if not isinstance(payload, dict):
        raise HTTPException(400, "invalid payload")
    recipient = payload.get("recipientCode")
    if not isinstance(recipient, str) or not recipient:
        raise HTTPException(400, "missing recipientCode")

    msg_id = uuid.uuid4().hex
    row = RelayMessage(id=msg_id, recipient_code=recipient, body=payload)
    db.add(row)
    db.commit()
    logger.info("[relay] POST recipient=%s… msgId=%s", recipient[:8], msg_id[:8])

    # Store-then-push. This runs on a worker thread; asyncio.Queues are
    # loop-owned and NOT thread-safe, so the fan-out is scheduled onto
    # the loop rather than touched here.
    if _loop is not None:
        message = {**payload, "msgId": msg_id, "receivedAt": _epoch_ms(row.created_at)}
        _loop.call_soon_threadsafe(_push_to_streams, recipient, message)
    return JSONResponse({"msgId": msg_id}, status_code=202)


@app.get("/relay/messages", dependencies=[Depends(require_relay_token)])
def get_messages(
    recipient: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
) -> dict:
    # Lazy expiry via cutoff filter; the sweeper owns actual deletion.
    cutoff = datetime.utcnow() - TTL
    rows = (
        db.query(RelayMessage)
        .filter(
            RelayMessage.recipient_code == recipient,
            RelayMessage.created_at >= cutoff,
        )
        .order_by(RelayMessage.created_at.asc())
        .limit(MAX_PER_POLL)
        .all()
    )
    messages = [
        {**row.body, "msgId": row.id, "receivedAt": _epoch_ms(row.created_at)}
        for row in rows
    ]
    return {"messages": messages}


@app.get("/relay/stream", dependencies=[Depends(require_relay_token)])
async def stream_messages(
    request: Request,
    recipient: str = Query(..., min_length=1),
) -> StreamingResponse:
    """SSE push channel: `event: hello` on connect, one `data:` frame per
    newly POSTed bundle, heartbeat comments while idle."""
    queue: "asyncio.Queue[dict]" = asyncio.Queue(maxsize=STREAM_QUEUE_MAX)
    _streams.setdefault(recipient, set()).add(queue)

    async def gen() -> AsyncIterator[str]:
        try:
            yield "event: hello\ndata: {}\n\n"
            while True:
                if await request.is_disconnected():
                    return
                try:
                    message = await asyncio.wait_for(
                        queue.get(), timeout=HEARTBEAT_SECONDS
                    )
                    yield f"data: {json.dumps(message, separators=(',', ':'))}\n\n"
                except asyncio.TimeoutError:
                    yield ": hb\n\n"
        finally:
            peers = _streams.get(recipient)
            if peers is not None:
                peers.discard(queue)
                if not peers:
                    _streams.pop(recipient, None)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete(
    "/relay/messages/{msg_id}",
    status_code=204,
    dependencies=[Depends(require_relay_token)],
)
def delete_message(msg_id: str, db: Session = Depends(get_db)) -> Response:
    db.query(RelayMessage).filter(RelayMessage.id == msg_id).delete(
        synchronize_session=False
    )
    db.commit()
    return Response(status_code=204)
