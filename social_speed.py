"""Speed-ups for NLGEP Chat. Installed by hub.py; safe to remove (everything still works, just slower).

1. One shared HTTP connection pool to Supabase. chat_backend calls httpx.request()/httpx.get(),
   which open a brand-new TLS connection for every single database call. A click that needs five
   database calls was paying for five handshakes. Now they reuse warm connections.
2. The social endpoints remember "who is this session" for a few seconds instead of asking the
   database on every poll and click.
3. Profile lookups run their two queries at the same time instead of one after the other.
"""
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
from fastapi import HTTPException

import chat_backend as cb

SESSION_TTL = 10  # seconds a session lookup is reused (logout takes effect within this long)

_client = httpx.Client(
    timeout=10,
    transport=httpx.HTTPTransport(retries=2, limits=httpx.Limits(max_keepalive_connections=20, keepalive_expiry=30)),
)
_pool = ThreadPoolExecutor(max_workers=8)
_sessions: dict = {}


class _PooledHttpx:
    """Stands in for the httpx module inside chat_backend; anything else falls through to httpx."""

    def request(self, method, url, **kw):
        return _client.request(method, url, **kw)

    def get(self, url, **kw):
        return _client.get(url, **kw)

    def __getattr__(self, name):
        return getattr(httpx, name)


def install():
    import social_backend as sb

    cb.httpx = _PooledHttpx()
    original_session_user = cb.session_user

    def me_or_401(request):
        sid = cb.request_session_id(request)
        now = time.monotonic()
        hit = _sessions.get(sid) if sid else None
        if hit and hit[0] > now:
            return hit[1]
        me = original_session_user(request)
        if not me:
            _sessions.pop(sid, None)
            raise HTTPException(401, "Please sign in first.")
        if sid:
            if len(_sessions) > 2000:
                for k in [k for k, v in _sessions.items() if v[0] <= now]:
                    _sessions.pop(k, None)
            _sessions[sid] = (now + SESSION_TTL, me)
        return me

    def load_people(ids):
        ids = sorted({i for i in ids if i})
        if not ids:
            return {}
        flt = sb.in_list(ids)
        fu = _pool.submit(cb.supabase_rows, "chat_users", {"select": sb.USER_COLS, "user_id": flt, "limit": "1000"})
        fp = _pool.submit(cb.supabase_rows, "chat_profiles", {"select": sb.PROFILE_COLS, "user_id": flt, "limit": "1000"})
        profiles = {p["user_id"]: p for p in fp.result()}
        return {u["user_id"]: sb.public_user(u, profiles.get(u["user_id"])) for u in fu.result()}

    sb.me_or_401 = me_or_401
    sb.load_people = load_people
