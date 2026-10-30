/* NLGEP Chat - friends, profiles, direct messages and group chats.
   Loaded on top of /chat (see hub.py). It waits for the person to sign in, then adds a chats
   list, a friends popup, profiles and rooms. Everything comes from /api/social/*.
   User-written text is only ever put on the page with textContent, never as HTML. */
(function () {
  "use strict";
  if (window.__nlgepSocial) return;
  window.__nlgepSocial = true;

  const $ = id => document.getElementById(id);
  function E(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function I(name) { return E("i", "fas fa-" + name); }
  function btn(label, ico, cls, onclick) {
    const b = E("button", "tool-btn " + (cls || "")); b.type = "button";
    if (ico) b.append(I(ico));
    if (label) b.append(E("span", "", label));
    if (onclick) b.onclick = onclick;
    return b;
  }
  const say = m => { try { if (typeof toast === "function") toast(m); } catch (e) {} };
  const fx = ev => { try { window.NLGEP_FX && window.NLGEP_FX.play(ev); } catch (e) {} };
  const fmtTime = t => { try { return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } };
  const fmtDate = t => { try { return new Date(t).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" }); } catch (e) { return ""; } };
  const COLORS = ["#a9d4bb", "#8aefb0", "#f8dc75", "#ff9595", "#9ac7ff", "#c6a9ff", "#ffb86b", "#f4a6d7"];
  const EMOJIS = ["🙂", "😎", "🤓", "🥳", "😺", "🐶", "🦊", "🐼", "🐸", "🦄", "🔥", "⭐", "🌙", "🍕", "🎮", "🎧", "🚀", "🌈"];

  const S = {
    started: false, ready: false, isGuest: false, me: "",
    friends: { friends: [], incoming: [], outgoing: [] },
    rooms: { dms: [], groups: [], invites: [] },
    active: "global", lastId: "", seen: {}, lastBadge: null,
    msgPoll: null, listPoll: null, polling: false, listing: false, globalMain: null,
  };

  // ------------------------------------------------------------ api
  async function api(path, method, body) {
    const opts = { method: method || "GET", credentials: "same-origin", cache: "no-store",
                   headers: authHeaders(body ? { "Content-Type": "application/json" } : {}) };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(path, opts);
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 && typeof sessionExpired === "function") sessionExpired();
    if (!r.ok) {
      const e = new Error(typeof d.detail === "string" ? d.detail : "Something went wrong. Please try again.");
      e.status = r.status;
      throw e;
    }
    return d;
  }

  // ------------------------------------------------------------ small ui pieces
  function avatar(p, size) {
    const a = E("span", "av" + (size ? " " + size : ""), (p && p.avatar) || "🙂");
    const c = (p && p.color) || COLORS[0];
    a.style.background = c + "33";
    a.style.borderColor = c;
    return a;
  }
  function iconAvatar(name) { const a = E("span", "av"); a.append(I(name)); return a; }

  function modal(build) {
    const wrap = E("div", "modal show sx-modal");
    const box = E("div", "nl-glass sx-box");
    wrap.append(box);
    const close = () => wrap.remove();
    wrap.addEventListener("mousedown", e => { if (e.target === wrap) close(); });
    document.body.append(wrap);
    build(box, close);
    return close;
  }
  function head(title, close) {
    const h = E("div", "sx-head");
    h.append(E("strong", "", title), btn("", "xmark", "", close));
    return h;
  }
  function closeAllModals() { document.querySelectorAll(".sx-modal").forEach(m => m.remove()); }
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    const all = document.querySelectorAll(".sx-modal");
    if (all.length) all[all.length - 1].remove();
  });

  function personRow(p, actions) {
    const row = E("div", "sx-row");
    if (typeof p.online === "boolean") row.append(E("span", "sx-dot" + (p.online ? " on" : "")));
    row.append(avatar(p));
    const who = E("div", "who");
    who.append(E("strong", "", p.username));
    if (p.status) who.append(E("small", "", p.status));
    who.onclick = () => openProfile({ user_id: p.user_id });
    row.append(who);
    (actions || []).forEach(a => row.append(a));
    return row;
  }

  // ------------------------------------------------------------ data refresh
  async function refreshFriends() { const d = await api("/api/social/friends"); S.friends = d; updateBadge(); return d; }
  async function refreshRooms() {
    const d = await api("/api/social/rooms");
    S.rooms = d;
    renderList();
    updateBadge();
    if (S.active !== "global" && !findRoom(S.active)) { say("That chat is no longer available."); openGlobal(); }
    return d;
  }
  async function refreshLists() {
    if (S.listing || !S.ready || S.isGuest) return;
    S.listing = true;
    try { await Promise.all([refreshRooms(), refreshFriends()]); } catch (e) {} finally { S.listing = false; }
  }
  function updateBadge() {
    const n = S.friends.incoming.length + S.rooms.invites.length;
    const b = $("friendsBadge");
    if (b) { b.textContent = n; b.hidden = !n; }
    if (S.lastBadge !== null && n > S.lastBadge) { say("You have a new friend request or group invite."); fx("LEVEL_UPGRADE"); }
    S.lastBadge = n;
  }
  function findRoom(id) { return S.rooms.dms.concat(S.rooms.groups).find(r => r.room_id === id); }

  // ------------------------------------------------------------ build the page additions (once)
  function buildUI() {
    if ($("convos")) return;
    const card = document.querySelector(".chat-card");
    S.globalMain = card.querySelector(".chat-main");
    card.classList.add("social");

    const side = E("aside", "convos"); side.id = "convos";
    const sh = E("div", "convos-head");
    sh.append(E("strong", "", "Chats"));
    const fb = btn("", "user-group", "", () => openFriends("friends")); fb.id = "friendsBtn"; fb.title = "Friends";
    const badge = E("span", "sx-badge", "0"); badge.id = "friendsBadge"; badge.hidden = true; fb.append(badge);
    const gb = btn("", "users-rectangle", "", () => openNewGroup()); gb.id = "newGroupBtn"; gb.title = "New group chat";
    sh.append(fb, gb);
    const notice = E("div", "convo-notice"); notice.id = "convoNotice"; notice.hidden = true;
    const list = E("div", "convo-list"); list.id = "convoList";
    side.append(sh, notice, list);
    card.insertBefore(side, card.firstChild);

    const room = E("div", "chat-main room-main"); room.id = "roomMain"; room.hidden = true;
    const rh = E("div", "chat-head room-head");
    const rid = E("div", "room-id"); rid.id = "roomId";
    const acts = E("div", "room-actions"); acts.id = "roomActions";
    rh.append(rid, acts);
    const msgs = E("div", "messages"); msgs.id = "roomMessages";
    const form = E("form", "composer"); form.id = "roomComposer";
    const inp = E("input", "field"); inp.id = "roomInput"; inp.maxLength = 2000; inp.autocomplete = "off"; inp.placeholder = "Write a message…";
    const send = E("button", "tool-btn primary"); send.append(I("paper-plane"), document.createTextNode("Send"));
    form.append(inp, send);
    room.append(rh, msgs, form);
    card.insertBefore(room, S.globalMain.nextSibling);

    // titlebar: chats toggle (small screens) and my profile
    const tb = document.querySelector(".titlebar");
    const toggle = btn("", "bars", "", () => side.classList.toggle("open")); toggle.id = "convosToggle"; toggle.title = "Chats";
    tb.insertBefore(toggle, tb.firstChild);
    const pb = btn("Profile", "id-card", "", () => openProfile({ username: S.me })); pb.id = "myProfileBtn";
    tb.insertBefore(pb, $("onlineCount"));

    form.onsubmit = sendRoomMessage;
    $("users").addEventListener("click", e => { const u = e.target.closest(".user"); if (u) openProfile({ username: u.textContent.trim() }); });
    $("messages").addEventListener("click", e => { const n = e.target.closest(".name"); if (n) openProfile({ username: n.textContent.trim() }); });
    msgs.addEventListener("click", async e => {
      const nm = e.target.closest(".name");
      if (nm) { openProfile({ username: nm.textContent.trim() }); return; }
      const del = e.target.closest(".danger-btn");
      if (!del || typeof staffToken === "undefined" || !staffToken) return;
      const m = del.closest(".msg");
      try { await staffFetch("/api/staff/room-messages/" + encodeURIComponent(m.dataset.id), { method: "DELETE" }); m.remove(); say("Message deleted."); }
      catch (err) { say(err.message || "Could not delete."); }
    });
  }

  // ------------------------------------------------------------ chats list
  function isUnread(r) {
    return !!r.last_message_id && r.last_username !== S.me && S.active !== r.room_id && S.seen[r.room_id] !== String(r.last_message_id);
  }
  function convoItem(o) {
    const d = E("div", "convo" + (S.active === o.key ? " active" : ""));
    d.append(o.av);
    const ct = E("div", "ct"); ct.append(E("strong", "", o.title), E("small", "", o.sub || ""));
    d.append(ct);
    if (o.unread) d.append(E("span", "unread"));
    d.onclick = o.onclick;
    return d;
  }
  function renderList() {
    const box = $("convoList"); if (!box) return;
    box.replaceChildren();
    box.append(convoItem({ key: "global", av: iconAvatar("globe"), title: "Global Chat", sub: "Everyone", onclick: openGlobal }));
    if (S.isGuest || !S.ready) return;

    S.rooms.invites.forEach(inv => {
      const c = E("div", "sx-invite");
      c.append(E("strong", "", inv.name),
        E("small", "", "Invited by " + (inv.invited_by ? inv.invited_by.username : "someone") + " · " + inv.member_count + " in the group"));
      const row = E("div", "sx-invite-btns");
      row.append(btn("Join", "check", "primary", () => respondInvite(inv.room_id, true)), btn("Decline", "xmark", "", () => respondInvite(inv.room_id, false)));
      c.append(row);
      box.append(c);
    });

    box.append(E("div", "nl-title sx-sec", "Direct messages"));
    if (!S.rooms.dms.length) box.append(E("div", "sx-hint", "Add a friend, then message them here."));
    S.rooms.dms.forEach(r => box.append(convoItem({
      key: r.room_id, av: avatar(r.user), title: r.user.username,
      sub: r.last_preview ? (r.last_username === S.me ? "You: " : "") + r.last_preview : "Say hi!",
      unread: isUnread(r), onclick: () => openRoom(r.room_id),
    })));

    box.append(E("div", "nl-title sx-sec", "Group chats"));
    if (!S.rooms.groups.length) box.append(E("div", "sx-hint", "Make a group and invite your friends."));
    S.rooms.groups.forEach(r => box.append(convoItem({
      key: r.room_id, av: iconAvatar("users"), title: r.name,
      sub: r.last_preview ? (r.last_username === S.me ? "You: " : r.last_username + ": ") + r.last_preview : r.member_count + " people",
      unread: isUnread(r), onclick: () => openRoom(r.room_id),
    })));
  }

  // ------------------------------------------------------------ rooms
  function openGlobal() {
    S.active = "global"; S.lastId = "";
    clearInterval(S.msgPoll); S.msgPoll = null;
    if ($("roomMain")) $("roomMain").hidden = true;
    if (S.globalMain) S.globalMain.hidden = false;
    if ($("convos")) $("convos").classList.remove("open");
    renderList();
  }
  function openRoom(id) {
    const room = findRoom(id); if (!room) return;
    S.active = id; S.lastId = "";
    S.seen[id] = String(room.last_message_id || "");
    $("roomMessages").replaceChildren();

    const ident = $("roomId"), acts = $("roomActions");
    ident.replaceChildren(); acts.replaceChildren();
    const titles = E("div");
    if (room.kind === "dm") {
      ident.append(avatar(room.user, "lg"));
      titles.append(E("strong", "", room.user.username), E("div", "muted", room.user.status || "Direct message"));
      acts.append(btn("Profile", "id-card", "", () => openProfile({ user_id: room.user.user_id })));
    } else {
      ident.append(iconAvatar("users"));
      titles.append(E("strong", "", room.name), E("div", "muted", room.member_count + " people in this group"));
      acts.append(btn("People", "users", "", () => openMembers(id)),
                  btn("Invite", "user-plus", "", () => openInvite(id)),
                  btn("Leave", "right-from-bracket", "", () => leaveGroup(id, room.name)));
    }
    ident.append(titles);

    S.globalMain.hidden = true;
    $("roomMain").hidden = false;
    $("convos").classList.remove("open");
    clearInterval(S.msgPoll); S.msgPoll = setInterval(pollRoom, 1500);
    pollRoom();
    renderList();
    $("roomInput").focus();
  }

  function drawRoom(rows) {
    const el = $("roomMessages");
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    rows.forEach(m => {
      if (el.querySelector('.msg[data-id="' + m.message_id + '"]')) return;
      const d = E("div", "msg" + (m.username === S.me ? " me" : ""));
      d.dataset.id = m.message_id;
      d.append(E("div", "name", m.username), E("div", "body", m.content), E("div", "time", fmtTime(m.created_at)));
      const sa = E("div", "staff-actions");
      const del = E("button", "danger-btn"); del.type = "button"; del.append(I("trash"), document.createTextNode("Delete message"));
      sa.append(del); d.append(sa);
      el.append(d);
    });
    if (stick) el.scrollTop = el.scrollHeight;
  }
  async function pollRoom() {
    if (S.active === "global" || S.polling) return;
    S.polling = true;
    const id = S.active;
    try {
      const d = await api("/api/social/rooms/" + id + "/messages" + (S.lastId ? "?after=" + encodeURIComponent(S.lastId) : ""));
      if (id !== S.active) return;
      drawRoom(d.messages);
      if (d.messages.length) { S.lastId = String(d.messages[d.messages.length - 1].message_id); S.seen[id] = S.lastId; }
    } catch (e) {
      if (id === S.active && (e.status === 403 || e.status === 404)) { say("You're no longer in that chat."); openGlobal(); refreshLists(); }
    } finally { S.polling = false; }
  }
  async function sendRoomMessage(e) {
    e.preventDefault();
    const inp = $("roomInput"), content = inp.value.trim();
    if (!content || S.active === "global") return;
    inp.value = "";
    try {
      await api("/api/social/rooms/" + S.active + "/messages", "POST", { content });
      await pollRoom();
      refreshLists();
    } catch (err) { inp.value = content; say(err.message); }
  }

  async function startDm(userId) {
    try {
      const d = await api("/api/social/rooms/dm", "POST", { user_id: userId });
      await refreshRooms();
      closeAllModals();
      openRoom(d.room_id);
    } catch (e) { say(e.message); }
  }
  async function respondInvite(roomId, accept) {
    try {
      if (accept) { await api("/api/social/rooms/" + roomId + "/accept", "POST"); await refreshRooms(); openRoom(roomId); fx("LEVEL_UPGRADE"); }
      else { await api("/api/social/rooms/" + roomId + "/members/me", "DELETE"); await refreshRooms(); say("Invite declined."); }
    } catch (e) { say(e.message); refreshLists(); }
  }
  async function leaveGroup(id, name) {
    if (!confirm('Leave "' + name + '"? You will need a new invite to come back.')) return;
    try { await api("/api/social/rooms/" + id + "/members/me", "DELETE"); openGlobal(); await refreshRooms(); say("You left the group."); }
    catch (e) { say(e.message); }
  }

  // ------------------------------------------------------------ friends popup
  function openFriends(startTab) {
    let tab = startTab || "friends";
    modal((box, close) => {
      const tabs = E("div", "sx-tabs"), body = E("div", "sx-body");
      box.append(head("Friends", close), tabs, body);

      async function reload() { try { await refreshFriends(); } catch (e) {} draw(); }
      async function act(fn, ok) { try { await fn(); if (ok) say(ok); } catch (e) { say(e.message); } reload(); refreshLists(); }

      function draw() {
        const F = S.friends;
        tabs.replaceChildren();
        [["friends", "Friends (" + F.friends.length + ")"],
         ["requests", "Requests (" + (F.incoming.length + F.outgoing.length) + ")"],
         ["add", "Add friend"]].forEach(([k, label]) => tabs.append(btn(label, "", tab === k ? "on" : "", () => { tab = k; draw(); })));
        body.replaceChildren();

        if (tab === "friends") {
          if (!F.friends.length) body.append(E("div", "sx-empty", "No friends yet. Use \"Add friend\" to send a request."));
          F.friends.forEach(p => {
            const msg = btn("Message", "comment", "primary", () => startDm(p.user_id));
            const rm = btn("", "user-minus", "", () => { if (confirm("Remove " + p.username + " from your friends?")) act(() => api("/api/social/friends/" + p.user_id, "DELETE"), "Friend removed."); });
            rm.title = "Remove friend";
            body.append(personRow(p, [msg, rm]));
          });
        } else if (tab === "requests") {
          if (!F.incoming.length && !F.outgoing.length) body.append(E("div", "sx-empty", "No pending requests."));
          if (F.incoming.length) body.append(E("div", "sx-label", "Wants to be your friend"));
          F.incoming.forEach(p => body.append(personRow(p, [
            btn("Accept", "check", "primary", () => act(() => api("/api/social/friends/" + p.user_id + "/accept", "POST"), "You're now friends with " + p.username + "!")),
            btn("", "xmark", "", () => act(() => api("/api/social/friends/" + p.user_id, "DELETE"), "Request declined.")),
          ])));
          if (F.outgoing.length) body.append(E("div", "sx-label", "Waiting for them to accept"));
          F.outgoing.forEach(p => body.append(personRow(p, [
            btn("Cancel", "xmark", "", () => act(() => api("/api/social/friends/" + p.user_id, "DELETE"), "Request cancelled.")),
          ])));
        } else {
          drawAdd();
        }
      }

      function drawAdd() {
        const form = E("form", "sx-add");
        const inp = E("input", "field"); inp.maxLength = 24; inp.placeholder = "Their username"; inp.autocomplete = "off";
        const go = btn("Send request", "user-plus", "primary"); go.type = "submit";
        form.append(inp, go);
        const msg = E("div", "sx-msg"), results = E("div", "sx-body"); results.style.padding = "0"; results.style.overflow = "visible";
        body.append(form, msg, results);

        async function request(username) {
          msg.className = "sx-msg";
          try {
            const d = await api("/api/social/friends/request", "POST", { username });
            msg.textContent = d.status === "friends" ? "You're now friends with " + d.user.username + "!" : "Request sent to " + d.user.username + ".";
            inp.value = ""; results.replaceChildren();
            refreshFriends().catch(() => {});
          } catch (err) { msg.className = "sx-msg err"; msg.textContent = err.message; }
        }
        form.onsubmit = e => { e.preventDefault(); const u = inp.value.trim(); if (u) request(u); };

        let timer = null;
        inp.oninput = () => {
          clearTimeout(timer);
          const q = inp.value.trim();
          if (q.length < 2) { results.replaceChildren(); return; }
          timer = setTimeout(async () => {
            try {
              const d = await api("/api/social/users?q=" + encodeURIComponent(q));
              results.replaceChildren();
              d.users.forEach(u => {
                let action;
                if (u.relation === "none") action = btn("Add", "user-plus", "primary", () => request(u.username));
                else if (u.relation === "pending_in") action = btn("Accept", "check", "primary", () => act(() => api("/api/social/friends/" + u.user_id + "/accept", "POST"), "You're now friends with " + u.username + "!"));
                else action = E("span", "tag", u.relation === "friends" ? "FRIENDS" : "REQUESTED");
                results.append(personRow(u, [action]));
              });
              if (!d.users.length) results.append(E("div", "sx-empty", "Nobody found."));
            } catch (err) {}
          }, 300);
        };
        setTimeout(() => inp.focus(), 30);
      }

      draw();
      reload();
    });
  }

  // ------------------------------------------------------------ pick friends (new group / invite)
  async function friendPicker(opts) {
    try { await refreshFriends(); } catch (e) { say(e.message); return; }
    const pool = S.friends.friends.filter(p => !(opts.exclude && opts.exclude.has(p.user_id)));
    modal((box, close) => {
      const body = E("div", "sx-body");
      box.append(head(opts.title, close), body);
      let nameInput = null;
      if (opts.askName) {
        body.append(E("div", "sx-label", "Group name"));
        nameInput = E("input", "field"); nameInput.maxLength = 40; nameInput.placeholder = "e.g. Weekend squad"; nameInput.style.flex = "none";
        body.append(nameInput);
      }
      body.append(E("div", "sx-label", opts.askName ? "Invite friends (optional)" : "Pick friends"));
      const picks = new Set();
      if (!pool.length) {
        body.append(E("div", "sx-empty", S.friends.friends.length ? "All your friends are already in this group." : "You don't have any friends to invite yet."));
        if (!S.friends.friends.length) body.append(btn("Add friends", "user-plus", "primary", () => { close(); openFriends("add"); }));
      }
      pool.forEach(p => {
        const cb = E("input"); cb.type = "checkbox";
        cb.onchange = () => { if (cb.checked) picks.add(p.user_id); else picks.delete(p.user_id); };
        const row = personRow(p, [cb]);
        row.onclick = e => { if (e.target !== cb && !e.target.closest(".who")) { cb.checked = !cb.checked; cb.onchange(); } };
        body.append(row);
      });
      const err = E("div", "sx-msg err");
      const foot = E("div", "sx-foot");
      const go = btn(opts.submit, "check", "primary");
      go.onclick = async () => {
        const name = nameInput ? nameInput.value.trim() : "";
        if (opts.askName && !name) { err.textContent = "Give your group a name."; return; }
        if (!opts.askName && !picks.size) { err.textContent = "Pick at least one friend."; return; }
        go.disabled = true;
        try { await opts.onSubmit([...picks], name); close(); } catch (e) { err.textContent = e.message; go.disabled = false; }
      };
      foot.append(go, btn("Cancel", "", "", close));
      body.append(err);
      box.append(foot);
      if (nameInput) setTimeout(() => nameInput.focus(), 30);
    });
  }
  function openNewGroup() {
    friendPicker({
      title: "New group chat", askName: true, submit: "Create group",
      onSubmit: async (ids, name) => {
        const d = await api("/api/social/rooms/group", "POST", { name, member_ids: ids });
        await refreshRooms();
        openRoom(d.room_id);
        say(ids.length ? "Group created. Invites sent!" : "Group created.");
      },
    });
  }
  async function openInvite(roomId) {
    let exclude = new Set();
    try { const d = await api("/api/social/rooms/" + roomId + "/members"); exclude = new Set(d.members.map(m => m.user_id)); } catch (e) { say(e.message); return; }
    friendPicker({
      title: "Invite friends", askName: false, submit: "Send invites", exclude,
      onSubmit: async ids => { const d = await api("/api/social/rooms/" + roomId + "/invite", "POST", { user_ids: ids }); say(d.invited + " invite" + (d.invited === 1 ? "" : "s") + " sent."); },
    });
  }

  async function openMembers(roomId) {
    let d;
    try { d = await api("/api/social/rooms/" + roomId + "/members"); } catch (e) { say(e.message); return; }
    const iAmOwner = d.members.some(m => m.is_owner && m.username === S.me);
    modal((box, close) => {
      const body = E("div", "sx-body");
      box.append(head("People in this group", close), body);
      d.members.forEach(m => {
        const acts = [];
        if (m.is_owner) acts.push(E("span", "tag", "OWNER"));
        if (m.status === "invited") acts.push(E("span", "tag", "INVITED"));
        if (iAmOwner && m.username !== S.me) {
          const rm = btn("", "user-xmark", "", async () => {
            if (!confirm("Remove " + m.username + " from the group?")) return;
            try { await api("/api/social/rooms/" + roomId + "/members/" + m.user_id, "DELETE"); close(); openMembers(roomId); refreshLists(); }
            catch (e) { say(e.message); }
          });
          rm.title = "Remove from group";
          acts.push(rm);
        }
        body.append(personRow(m, acts));
      });
    });
  }

  // ------------------------------------------------------------ profiles
  async function openProfile(q) {
    let d;
    try {
      d = await api("/api/social/profile?" + (q.user_id ? "user_id=" + encodeURIComponent(q.user_id) : "username=" + encodeURIComponent(q.username)));
    } catch (e) { say(e.message); return; }
    const u = d.user, rel = d.relation;
    modal((box, close) => {
      const body = E("div", "sx-body");
      box.append(head("Profile", close), body);

      const top = E("div", "sx-prof");
      top.append(avatar(u, "xl"));
      const nm = E("div", "sx-pname"); nm.append(E("strong", "", u.username));
      if (u.is_guest) nm.append(E("span", "tag", "GUEST"));
      top.append(nm);
      if (u.status) top.append(E("div", "sx-pstatus", u.status));
      body.append(top);
      if (u.bio) body.append(E("div", "sx-pbio", u.bio));
      body.append(E("div", "sx-pmeta", (u.online ? "Online now" : "Offline") + (u.joined ? " · Joined " + fmtDate(u.joined) : "")));

      const acts = E("div", "sx-pacts");
      const redo = async fn => { try { await fn(); } catch (e) { say(e.message); return; } close(); openProfile({ user_id: u.user_id }); refreshLists(); };
      if (rel === "self") {
        if (S.isGuest) body.append(E("div", "sx-note", "Guests can't edit a profile. Create an account to make one."));
        else if (!S.ready) body.append(E("div", "sx-note", "Profiles will be editable once the database setup is finished."));
        else acts.append(btn("Edit profile", "pen", "primary", () => { close(); openEditProfile(u); }));
      } else if (S.isGuest || !S.ready || u.is_guest) {
        body.append(E("div", "sx-note", u.is_guest ? "Guests can't be added as friends." : S.isGuest ? "Create an account to add friends and send messages." : "Friends are almost ready."));
      } else if (rel === "none") {
        acts.append(btn("Add friend", "user-plus", "primary", () => redo(() => api("/api/social/friends/request", "POST", { username: u.username }))));
      } else if (rel === "pending_out") {
        const b = btn("Request sent", "clock", ""); b.disabled = true; acts.append(b);
        acts.append(btn("Cancel", "xmark", "", () => redo(() => api("/api/social/friends/" + u.user_id, "DELETE"))));
      } else if (rel === "pending_in") {
        acts.append(btn("Accept request", "check", "primary", () => redo(() => api("/api/social/friends/" + u.user_id + "/accept", "POST"))),
                    btn("Decline", "xmark", "", () => redo(() => api("/api/social/friends/" + u.user_id, "DELETE"))));
      } else if (rel === "friends") {
        acts.append(btn("Message", "comment", "primary", () => startDm(u.user_id)),
                    btn("Remove friend", "user-minus", "", () => { if (confirm("Remove " + u.username + " from your friends?")) redo(() => api("/api/social/friends/" + u.user_id, "DELETE")); }));
      }
      if (acts.children.length) body.append(acts);
    });
  }

  function openEditProfile(p) {
    modal((box, close) => {
      const body = E("div", "sx-body");
      box.append(head("Edit your profile", close), body);
      let avatarV = p.avatar || "🙂", colorV = p.color || COLORS[0];

      const top = E("div", "sx-edit-top");
      const prev = avatar({ avatar: avatarV, color: colorV }, "xl");
      const custom = E("input", "field"); custom.maxLength = 16; custom.value = avatarV; custom.placeholder = "Any emoji";
      top.append(prev, custom);
      const paint = () => { prev.textContent = avatarV; prev.style.background = colorV + "33"; prev.style.borderColor = colorV; };
      custom.oninput = () => { avatarV = custom.value.trim() || "🙂"; paint(); };

      const emo = E("div", "sx-emojis");
      EMOJIS.forEach(em => { const b = E("button", "sx-emoji", em); b.type = "button"; b.onclick = () => { avatarV = em; custom.value = em; paint(); }; emo.append(b); });
      const sw = E("div", "sx-swatches");
      COLORS.forEach(c => { const b = E("button", "sx-swatch"); b.type = "button"; b.style.background = c; b.onclick = () => { colorV = c; paint(); }; sw.append(b); });

      const status = E("input", "field"); status.maxLength = 60; status.value = p.status || ""; status.placeholder = "What's up? (optional)"; status.style.flex = "none";
      const bio = E("textarea", "field"); bio.maxLength = 200; bio.value = p.bio || ""; bio.placeholder = "Tell people about yourself (optional)"; bio.style.flex = "none";
      const err = E("div", "sx-msg err");

      body.append(top, E("div", "sx-label", "Pick an avatar"), emo, E("div", "sx-label", "Color"), sw,
                  E("div", "sx-label", "Status"), status, E("div", "sx-label", "About me"), bio, err);
      const foot = E("div", "sx-foot");
      const save = btn("Save", "check", "primary");
      save.onclick = async () => {
        save.disabled = true;
        try {
          await api("/api/social/profile", "PUT", { avatar: avatarV, color: colorV, status: status.value.trim(), bio: bio.value.trim() });
          say("Profile saved."); close(); refreshLists();
        } catch (e) { err.textContent = e.message; save.disabled = false; }
      };
      foot.append(save, btn("Cancel", "", "", close));
      box.append(foot);
    });
  }

  // ------------------------------------------------------------ start / stop
  async function start() {
    S.started = true;
    buildUI();
    try {
      const me = (await api("/api/chat-me")).user;
      if (!me) { S.started = false; return; }
      S.me = me.username;
      S.isGuest = /^guest/i.test(me.username);
      const cfg = await api("/api/social/config");
      S.ready = !!cfg.ready;
    } catch (e) { S.started = false; return; }

    const notice = $("convoNotice");
    const showTools = !S.isGuest && S.ready;
    $("friendsBtn").hidden = !showTools;
    $("newGroupBtn").hidden = !showTools;
    $("myProfileBtn").hidden = S.isGuest;
    notice.hidden = showTools;
    if (S.isGuest) notice.textContent = "Guests can only use Global Chat. Log out and create a free account to add friends, send direct messages and make group chats.";
    else if (!S.ready) notice.textContent = "Friends, DMs and group chats are almost ready. The database setup (supabase_social.sql) just needs to be run once.";
    openGlobal();
    renderList();
    if (showTools) { await refreshLists(); S.listPoll = setInterval(refreshLists, 4000); }
  }
  function stop() {
    S.started = false;
    clearInterval(S.msgPoll); clearInterval(S.listPoll);
    S.msgPoll = S.listPoll = null;
    S.friends = { friends: [], incoming: [], outgoing: [] };
    S.rooms = { dms: [], groups: [], invites: [] };
    S.seen = {}; S.lastBadge = null; S.polling = false; S.listing = false;
    closeAllModals();
    openGlobal();
  }

  // the page asks for a login every visit, so wait until one succeeds (and notice when it ends)
  setInterval(() => {
    const overlay = $("loginOverlay");
    const loggedIn = typeof token === "string" && !!token && overlay && overlay.style.display === "none";
    if (loggedIn && !S.started) start();
    else if (!loggedIn && S.started) stop();
  }, 600);
})();
