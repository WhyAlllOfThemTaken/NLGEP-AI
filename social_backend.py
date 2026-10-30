"""NLGEP Chat social features: profiles, friends, direct messages and group chats.

A router that plugs into hub.py next to chat_backend. It reuses chat_backend's sessions,
rate limiting and Supabase helper, so signing in works exactly as before.

  /api/social/config                      are the database tables set up?
  /api/social/profile                     GET (by username or user_id) / PUT (my own)
  /api/social/users?q=                    find accounts to add
  /api/social/friends                     list friends and requests
  /api/social/friends/request             send a request (or accept one that is waiting)
  /api/social/friends/{id}/accept         accept   |  DELETE /api/social/friends/{id}  remove/decline/cancel
  /api/social/rooms                       my DMs, groups and invites
  /api/social/rooms/dm  /rooms/group      open a DM / create a group
  /api/social/rooms/{id}/messages|members|invite|accept
  /api/social/rooms/{id}/members/{user}   leave ("me") or remove someone (owner)

Guests (throwaway accounts) can read profiles but cannot use friends, DMs or groups.
Run supabase_social.sql once in Supabase to create the tables.
"""
import re
import time
import uuid
from collections import defaultdict

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import chat_backend as cb
from chat_backend import supabase_rows

router = APIRouter()

ID_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
SEARCH_STRIP = re.compile(r"[^A-Za-z0-9_ .-]")
COLOR_RE = r"^#[0-9a-fA-F]{6}$"
MAX_GROUP_MEMBERS = 50
USER_COLS = "user_id,username,created_at,is_guest"
PROFILE_COLS = "user_id,bio,status,avatar,color"
ROOM_COLS = "room_id,kind,name,owner_id,dm_key,created_at,last_message_at,last_message_id,last_username,last_preview"
GUEST_MSG = "Create a free account to use friends, direct messages and group chats."
TABLES = ("chat_profiles", "chat_friendships", "chat_rooms", "chat_room_members", "chat_room_messages")


# ---------------------------------------------------------------- request bodies

class ProfileUpdate(BaseModel):
    bio: str = Field(default="", max_length=200)
    status: str = Field(default="", max_length=60)
    avatar: str = Field(default="🙂", min_length=1, max_length=16)
    color: str = Field(default="#a9d4bb", pattern=COLOR_RE)


class FriendRequest(BaseModel):
    username: str = Field(min_length=2, max_length=24)


class DmRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)


class GroupRequest(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    member_ids: list[str] = Field(default_factory=list, max_length=49)


class InviteRequest(BaseModel):
    user_ids: list[str] = Field(min_length=1, max_length=49)


class RoomMessage(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


# ---------------------------------------------------------------- helpers

def safe_id(value: str) -> str:
    value = (value or "").strip()
    if not ID_RE.match(value):
        raise HTTPException(400, "Invalid id.")
    return value


def safe_room(value: str) -> str:
    try:
        return str(uuid.UUID((value or "").strip()))
    except ValueError:
        raise HTTPException(400, "Invalid chat id.")


def in_list(ids) -> str:
    return "in.(" + ",".join(ids) + ")"


def is_guest_name(name: str) -> bool:
    # Registration reserves every name starting with "Guest", so this identifies throwaway accounts.
    return (name or "").lower().startswith("guest")


def me_or_401(request: Request):
    me = cb.session_user(request)
    if not me:
        raise HTTPException(401, "Please sign in first.")
    return me


def member_or_403(request: Request, write: bool = False):
    if write:
        cb.check_rate_limit(request)
    me = me_or_401(request)
    if is_guest_name(me["username"]):
        raise HTTPException(403, GUEST_MSG)
    return me


def is_duplicate(exc: HTTPException) -> bool:
    return exc.status_code == 502 and "duplicate key" in str(exc.detail).lower()


def public_user(user: dict, profile: dict | None = None) -> dict:
    profile = profile or {}
    return {
        "user_id": user["user_id"],
        "username": user["username"],
        "avatar": profile.get("avatar") or "🙂",
        "color": profile.get("color") or "#a9d4bb",
        "status": profile.get("status") or "",
    }


def load_people(ids) -> dict:
    ids = sorted({i for i in ids if i})
    if not ids:
        return {}
    flt = in_list(ids)
    users = supabase_rows("chat_users", {"select": USER_COLS, "user_id": flt, "limit": "1000"})
    profiles = {p["user_id"]: p for p in supabase_rows("chat_profiles", {"select": PROFILE_COLS, "user_id": flt, "limit": "1000"})}
    return {u["user_id"]: public_user(u, profiles.get(u["user_id"])) for u in users}


def online_ids(ids) -> set:
    ids = sorted({i for i in ids if i})
    if not ids:
        return set()
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 120))
    rows = supabase_rows("chat_sessions", {"select": "user_id", "user_id": in_list(ids),
                                           "last_seen": f"gt.{cutoff}", "expires_at": f"gt.{cb.utc_now()}"})
    return {r["user_id"] for r in rows}


def user_by_id(uid: str):
    rows = supabase_rows("chat_users", {"select": USER_COLS, "user_id": f"eq.{uid}", "limit": "1"})
    return rows[0] if rows else None


def pair_filter(a: str, b: str) -> str:
    return f"(and(requester_id.eq.{a},addressee_id.eq.{b}),and(requester_id.eq.{b},addressee_id.eq.{a}))"


def friendship_between(a: str, b: str):
    rows = supabase_rows("chat_friendships", {"select": "friendship_id,requester_id,addressee_id,status",
                                              "or": pair_filter(a, b), "limit": "1"})
    return rows[0] if rows else None


def my_friendships(me_id: str):
    return supabase_rows("chat_friendships", {
        "select": "friendship_id,requester_id,addressee_id,status,created_at",
        "or": f"(requester_id.eq.{me_id},addressee_id.eq.{me_id})",
        "order": "created_at.desc", "limit": "500"})


def other_side(row: dict, me_id: str) -> str:
    return row["addressee_id"] if row["requester_id"] == me_id else row["requester_id"]


def relation(me_id: str, other_id: str, row) -> str:
    if me_id == other_id:
        return "self"
    if not row:
        return "none"
    if row["status"] == "accepted":
        return "friends"
    return "pending_out" if row["requester_id"] == me_id else "pending_in"


def accepted_friend_ids(me_id: str) -> set:
    return {other_side(r, me_id) for r in my_friendships(me_id) if r["status"] == "accepted"}


def get_room(rid: str):
    rows = supabase_rows("chat_rooms", {"select": ROOM_COLS, "room_id": f"eq.{rid}", "limit": "1"})
    return rows[0] if rows else None


def membership(rid: str, uid: str):
    rows = supabase_rows("chat_room_members", {"select": "room_id,user_id,status,invited_by",
                                               "room_id": f"eq.{rid}", "user_id": f"eq.{uid}", "limit": "1"})
    return rows[0] if rows else None


def require_active(rid: str, uid: str):
    m = membership(rid, uid)
    if not m or m["status"] != "active":
        raise HTTPException(403, "You're not a member of this chat.")
    return m


# ---------------------------------------------------------------- setup check

@router.get("/api/social/config")
def social_config():
    if not cb.supabase_configured():
        return {"ready": False, "reason": "chat"}
    try:
        for table in TABLES:
            supabase_rows(table, {"select": "*", "limit": "1"})
    except HTTPException:
        return {"ready": False, "reason": "setup"}
    return {"ready": True}


# ---------------------------------------------------------------- profiles

@router.get("/api/social/profile")
def get_profile(request: Request, username: str = "", user_id: str = ""):
    me = me_or_401(request)
    if user_id:
        user = user_by_id(safe_id(user_id))
    elif username:
        found = cb.find_user(cb.clean_username(username))
        user = user_by_id(found["user_id"]) if found else None
    else:
        raise HTTPException(400, "Say whose profile you want.")
    if not user:
        raise HTTPException(404, "That account doesn't exist (any more).")
    profiles = supabase_rows("chat_profiles", {"select": PROFILE_COLS, "user_id": f"eq.{user['user_id']}", "limit": "1"})
    profile = profiles[0] if profiles else {}
    out = public_user(user, profile)
    out.update(bio=profile.get("bio") or "", joined=user.get("created_at"),
               is_guest=bool(user.get("is_guest")) or is_guest_name(user["username"]),
               online=user["user_id"] in online_ids([user["user_id"]]))
    rel = "self" if user["user_id"] == me["user_id"] else "none"
    if rel == "none" and not is_guest_name(me["username"]) and not out["is_guest"]:
        rel = relation(me["user_id"], user["user_id"], friendship_between(me["user_id"], user["user_id"]))
    return {"user": out, "relation": rel}


@router.put("/api/social/profile")
def update_profile(body: ProfileUpdate, request: Request):
    me = member_or_403(request, write=True)
    payload = {"user_id": me["user_id"], "bio": body.bio.strip(), "status": body.status.strip(),
               "avatar": body.avatar.strip() or "🙂", "color": body.color, "updated_at": cb.utc_now()}
    supabase_rows("chat_profiles", method="POST", payload=payload,
                  prefer="resolution=merge-duplicates,return=minimal")
    return {"ok": True}


@router.get("/api/social/users")
def search_users(request: Request, q: str = ""):
    me = member_or_403(request)
    q = SEARCH_STRIP.sub("", q).strip()[:24]
    if len(q) < 2:
        return {"users": []}
    rows = supabase_rows("chat_users", {"select": USER_COLS, "username": f"ilike.{q}*", "is_guest": "not.is.true",
                                        "user_id": f"neq.{me['user_id']}", "order": "username.asc", "limit": "10"})
    rows = [r for r in rows if not is_guest_name(r["username"])]
    people = load_people([r["user_id"] for r in rows])
    rels = {other_side(f, me["user_id"]): f for f in my_friendships(me["user_id"])}
    users = []
    for r in rows:
        p = people.get(r["user_id"])
        if p:
            users.append(dict(p, relation=relation(me["user_id"], r["user_id"], rels.get(r["user_id"]))))
    return {"users": users}


# ---------------------------------------------------------------- friends

@router.get("/api/social/friends")
def list_friends(request: Request):
    me = member_or_403(request)
    me_id = me["user_id"]
    rows = my_friendships(me_id)
    others = [other_side(r, me_id) for r in rows]
    people = load_people(others)
    accepted = [o for r, o in zip(rows, others) if r["status"] == "accepted"]
    online = online_ids(accepted)
    out = {"friends": [], "incoming": [], "outgoing": []}
    for r, oid in zip(rows, others):
        p = people.get(oid)
        if not p:
            continue
        if r["status"] == "accepted":
            out["friends"].append(dict(p, online=oid in online))
        elif r["requester_id"] == me_id:
            out["outgoing"].append(p)
        else:
            out["incoming"].append(p)
    out["friends"].sort(key=lambda p: (not p["online"], p["username"].lower()))
    return out


@router.post("/api/social/friends/request")
def friend_request(body: FriendRequest, request: Request):
    me = member_or_403(request, write=True)
    me_id = me["user_id"]
    target = cb.find_user(cb.clean_username(body.username))
    if not target:
        raise HTTPException(404, "No account with that username.")
    if target["user_id"] == me_id:
        raise HTTPException(400, "That's you!")
    if target.get("is_guest") or is_guest_name(target["username"]):
        raise HTTPException(400, "Guests can't be added. Ask them to create an account first.")
    person = load_people([target["user_id"]]).get(target["user_id"]) or {"user_id": target["user_id"], "username": target["username"]}
    existing = friendship_between(me_id, target["user_id"])
    if existing:
        if existing["status"] == "accepted":
            raise HTTPException(409, "You're already friends.")
        if existing["requester_id"] == me_id:
            raise HTTPException(409, "You already sent them a request.")
        # they asked first, so asking back means yes
        supabase_rows("chat_friendships", {"friendship_id": f"eq.{existing['friendship_id']}"}, method="PATCH",
                      payload={"status": "accepted"}, prefer="return=minimal")
        return {"status": "friends", "user": person}
    try:
        supabase_rows("chat_friendships", method="POST",
                      payload={"requester_id": me_id, "addressee_id": target["user_id"], "status": "pending"},
                      prefer="return=minimal")
    except HTTPException as e:
        if is_duplicate(e):
            raise HTTPException(409, "A request between you two already exists.")
        raise
    return {"status": "pending", "user": person}


@router.post("/api/social/friends/{user_id}/accept")
def accept_friend(user_id: str, request: Request):
    me = member_or_403(request, write=True)
    other = safe_id(user_id)
    row = friendship_between(me["user_id"], other)
    if not row or row["status"] != "pending" or row["requester_id"] != other:
        raise HTTPException(404, "There's no request from that person.")
    supabase_rows("chat_friendships", {"friendship_id": f"eq.{row['friendship_id']}"}, method="PATCH",
                  payload={"status": "accepted"}, prefer="return=minimal")
    return {"ok": True}


@router.delete("/api/social/friends/{user_id}")
def remove_friend(user_id: str, request: Request):
    me = member_or_403(request, write=True)
    other = safe_id(user_id)
    supabase_rows("chat_friendships", {"or": pair_filter(me["user_id"], other)}, method="DELETE")
    return {"ok": True}


# ---------------------------------------------------------------- rooms: list / create

@router.get("/api/social/rooms")
def list_rooms(request: Request):
    me = member_or_403(request)
    me_id = me["user_id"]
    mine = supabase_rows("chat_room_members", {"select": "room_id,status,invited_by", "user_id": f"eq.{me_id}", "limit": "300"})
    out = {"dms": [], "groups": [], "invites": []}
    if not mine:
        return out
    state = {m["room_id"]: m for m in mine}
    flt = in_list(list(state))
    rooms = supabase_rows("chat_rooms", {"select": ROOM_COLS, "room_id": flt, "limit": "300"})
    members = supabase_rows("chat_room_members", {"select": "room_id,user_id,status", "room_id": flt, "limit": "5000"})
    by_room = defaultdict(list)
    for m in members:
        by_room[m["room_id"]].append(m)
    wanted = set()
    for room in rooms:
        if room["kind"] == "dm":
            wanted.update(m["user_id"] for m in by_room[room["room_id"]] if m["user_id"] != me_id)
    wanted.update(m["invited_by"] for m in mine if m.get("invited_by"))
    people = load_people(wanted)

    def last(room):
        return {"last_message_id": room.get("last_message_id"), "last_username": room.get("last_username"),
                "last_preview": room.get("last_preview") or "", "last_message_at": room.get("last_message_at")}

    for room in rooms:
        rid = room["room_id"]
        active = [m for m in by_room[rid] if m["status"] == "active"]
        if state[rid]["status"] == "invited":
            if room["kind"] == "group":
                out["invites"].append({"room_id": rid, "name": room["name"], "member_count": len(active),
                                       "invited_by": people.get(state[rid].get("invited_by"))})
            continue
        if room["kind"] == "dm":
            other = next((m["user_id"] for m in by_room[rid] if m["user_id"] != me_id), None)
            if other in people:
                out["dms"].append(dict(last(room), room_id=rid, kind="dm", user=people[other]))
        else:
            out["groups"].append(dict(last(room), room_id=rid, kind="group", name=room["name"],
                                      owner_id=room.get("owner_id"), member_count=len(active)))
    for key in ("dms", "groups"):
        out[key].sort(key=lambda r: r.get("last_message_at") or "", reverse=True)
    return out


def find_dm(key: str):
    rows = supabase_rows("chat_rooms", {"select": "room_id", "dm_key": f"eq.{key}", "limit": "1"})
    return rows[0] if rows else None


@router.post("/api/social/rooms/dm")
def open_dm(body: DmRequest, request: Request):
    me = member_or_403(request, write=True)
    me_id = me["user_id"]
    other = safe_id(body.user_id)
    if other == me_id:
        raise HTTPException(400, "You can't message yourself.")
    fr = friendship_between(me_id, other)
    if not fr or fr["status"] != "accepted":
        raise HTTPException(403, "You can only message friends. Send a friend request first.")
    key = ":".join(sorted([me_id, other]))
    room = find_dm(key)
    if not room:
        try:
            room = supabase_rows("chat_rooms", {"select": "room_id"}, method="POST",
                                 payload={"kind": "dm", "name": "", "dm_key": key}, prefer="return=representation")[0]
        except HTTPException as e:
            if not is_duplicate(e):
                raise
            room = find_dm(key)
        if not room:
            raise HTTPException(502, "Could not open that conversation.")
    supabase_rows("chat_room_members", method="POST",
                  payload=[{"room_id": room["room_id"], "user_id": me_id, "status": "active"},
                           {"room_id": room["room_id"], "user_id": other, "status": "active"}],
                  prefer="resolution=ignore-duplicates,return=minimal")
    return {"room_id": room["room_id"]}


@router.post("/api/social/rooms/group")
def create_group(body: GroupRequest, request: Request):
    me = member_or_403(request, write=True)
    me_id = me["user_id"]
    name = " ".join(body.name.split())
    if not name:
        raise HTTPException(400, "Give your group a name.")
    ids = []
    for raw in body.member_ids:
        i = safe_id(raw)
        if i != me_id and i not in ids:
            ids.append(i)
    if ids and not set(ids) <= accepted_friend_ids(me_id):
        raise HTTPException(403, "You can only invite your friends.")
    room = supabase_rows("chat_rooms", {"select": "room_id"}, method="POST",
                         payload={"kind": "group", "name": name, "owner_id": me_id}, prefer="return=representation")[0]
    rows = [{"room_id": room["room_id"], "user_id": me_id, "status": "active"}]
    rows += [{"room_id": room["room_id"], "user_id": i, "status": "invited", "invited_by": me_id} for i in ids]
    supabase_rows("chat_room_members", method="POST", payload=rows, prefer="return=minimal")
    return {"room_id": room["room_id"]}


# ---------------------------------------------------------------- rooms: messages / members

@router.get("/api/social/rooms/{room_id}/messages")
def room_messages(room_id: str, request: Request, after: str = ""):
    me = member_or_403(request)
    rid = safe_room(room_id)
    require_active(rid, me["user_id"])
    select = "message_id,user_id,username,content,created_at"
    if after and after.isdigit():
        rows = supabase_rows("chat_room_messages", {"select": select, "room_id": f"eq.{rid}", "message_id": f"gt.{after}",
                                                    "order": "message_id.asc", "limit": "100"})
    else:
        rows = list(reversed(supabase_rows("chat_room_messages", {"select": select, "room_id": f"eq.{rid}",
                                                                  "order": "message_id.desc", "limit": "100"})))
    return {"messages": rows, "me": me["username"]}


@router.post("/api/social/rooms/{room_id}/messages")
def send_room_message(room_id: str, body: RoomMessage, request: Request):
    me = member_or_403(request, write=True)
    me_id = me["user_id"]
    rid = safe_room(room_id)
    content = body.content.strip()
    if not content:
        raise HTTPException(400, "Message cannot be empty.")
    room = get_room(rid)
    if not room:
        raise HTTPException(404, "That chat no longer exists.")
    require_active(rid, me_id)
    if room["kind"] == "dm":
        other = next((i for i in (room.get("dm_key") or "").split(":") if i and i != me_id), "")
        fr = friendship_between(me_id, other) if other else None
        if not fr or fr["status"] != "accepted":
            raise HTTPException(403, "You're no longer friends, so you can't send messages here.")
    row = supabase_rows("chat_room_messages", method="POST",
                        payload={"room_id": rid, "user_id": me_id, "username": me["username"], "content": content},
                        prefer="return=representation")[0]
    try:
        supabase_rows("chat_rooms", {"room_id": f"eq.{rid}"}, method="PATCH", prefer="return=minimal",
                      payload={"last_message_at": row["created_at"], "last_message_id": row["message_id"],
                               "last_username": me["username"], "last_preview": content[:80]})
    except HTTPException:
        pass
    return {"message": row}


@router.get("/api/social/rooms/{room_id}/members")
def room_members(room_id: str, request: Request):
    me = member_or_403(request)
    rid = safe_room(room_id)
    require_active(rid, me["user_id"])
    room = get_room(rid)
    if not room:
        raise HTTPException(404, "That chat no longer exists.")
    rows = supabase_rows("chat_room_members", {"select": "user_id,status,joined_at", "room_id": f"eq.{rid}",
                                               "order": "joined_at.asc", "limit": "100"})
    people = load_people([r["user_id"] for r in rows])
    members = [dict(people[r["user_id"]], status=r["status"], is_owner=r["user_id"] == room.get("owner_id"))
               for r in rows if r["user_id"] in people]
    return {"members": members, "owner_id": room.get("owner_id"), "kind": room["kind"]}


@router.post("/api/social/rooms/{room_id}/invite")
def invite_to_group(room_id: str, body: InviteRequest, request: Request):
    me = member_or_403(request, write=True)
    me_id = me["user_id"]
    rid = safe_room(room_id)
    room = get_room(rid)
    if not room or room["kind"] != "group":
        raise HTTPException(404, "That group doesn't exist.")
    require_active(rid, me_id)
    ids = []
    for raw in body.user_ids:
        i = safe_id(raw)
        if i != me_id and i not in ids:
            ids.append(i)
    if not set(ids) <= accepted_friend_ids(me_id):
        raise HTTPException(403, "You can only invite your friends.")
    existing = {r["user_id"] for r in supabase_rows("chat_room_members", {"select": "user_id", "room_id": f"eq.{rid}", "limit": "200"})}
    fresh = [i for i in ids if i not in existing]
    if len(existing) + len(fresh) > MAX_GROUP_MEMBERS:
        raise HTTPException(400, f"Groups can have up to {MAX_GROUP_MEMBERS} people.")
    if fresh:
        supabase_rows("chat_room_members", method="POST",
                      payload=[{"room_id": rid, "user_id": i, "status": "invited", "invited_by": me_id} for i in fresh],
                      prefer="resolution=ignore-duplicates,return=minimal")
    return {"invited": len(fresh)}


@router.post("/api/social/rooms/{room_id}/accept")
def accept_invite(room_id: str, request: Request):
    me = member_or_403(request, write=True)
    rid = safe_room(room_id)
    rows = supabase_rows("chat_room_members", {"room_id": f"eq.{rid}", "user_id": f"eq.{me['user_id']}", "status": "eq.invited"},
                         method="PATCH", payload={"status": "active"}, prefer="return=representation")
    if not rows:
        raise HTTPException(404, "That invite isn't there any more.")
    return {"room_id": rid}


@router.delete("/api/social/rooms/{room_id}/members/{user_id}")
def remove_member(room_id: str, user_id: str, request: Request):
    """Leave a group (user_id = "me"), decline an invite, or - as the owner - remove someone."""
    me = member_or_403(request, write=True)
    me_id = me["user_id"]
    rid = safe_room(room_id)
    target = me_id if user_id == "me" else safe_id(user_id)
    room = get_room(rid)
    if not room:
        raise HTTPException(404, "That chat no longer exists.")
    if room["kind"] != "group":
        raise HTTPException(400, "Direct messages can't be left.")
    if target != me_id and room.get("owner_id") != me_id:
        raise HTTPException(403, "Only the group owner can remove people.")
    supabase_rows("chat_room_members", {"room_id": f"eq.{rid}", "user_id": f"eq.{target}"}, method="DELETE")
    rest = supabase_rows("chat_room_members", {"select": "user_id", "room_id": f"eq.{rid}", "status": "eq.active",
                                               "order": "joined_at.asc", "limit": "1"})
    if not rest:
        supabase_rows("chat_rooms", {"room_id": f"eq.{rid}"}, method="DELETE")  # nobody left: messages go too
        return {"ok": True, "deleted_room": True}
    if room.get("owner_id") in (None, target):
        supabase_rows("chat_rooms", {"room_id": f"eq.{rid}"}, method="PATCH",
                      payload={"owner_id": rest[0]["user_id"]}, prefer="return=minimal")
    return {"ok": True}


# ---------------------------------------------------------------- staff

@router.delete("/api/staff/room-messages/{message_id}")
def staff_delete_room_message(message_id: int, request: Request):
    cb.require_staff(request)
    supabase_rows("chat_room_messages", {"message_id": f"eq.{message_id}"}, method="DELETE")
    return {"ok": True, "deleted": message_id}
