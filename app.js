import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, doc, setDoc, updateDoc, deleteDoc, deleteField, arrayUnion, arrayRemove,
  collection, addDoc, query, orderBy, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// =====================================================
//  Firebase config (yahin hai, alag file ki zaroorat nahi)
// =====================================================
const firebaseConfig = {
  apiKey: "AIzaSyCVmjkg9rSw0UoVYZtcCT6I2PU9zR5LSVw",
  authDomain: "chat-app-8150e.firebaseapp.com",
  projectId: "chat-app-8150e",
  storageBucket: "chat-app-8150e.firebasestorage.app",
  messagingSenderId: "234980444229",
  appId: "1:234980444229:web:343731642ea520aa543b2c"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);

// small safe wrapper around localStorage
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};

let mode = "login";
let me = null;
let allUsers = [];
let currentChatUser = null;
let currentChatId = null;
let lastDocs = [];
let keepBottom = true;
let stickNow = true;
let unsubMessages = null;
let unsubUsers = null;
let unsubStatus = null;
let statuses = [];
let pendingAdd = new URLSearchParams(location.search).get("add");

/* =========================================================
   Dark / Light mode
   ========================================================= */
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  store.set("viochat_theme", t);
  $("themeBtn").textContent = t === "dark" ? "\u2600\uFE0F" : "\uD83C\uDF19";
}
applyTheme(store.get("viochat_theme") || "dark");
$("themeBtn").onclick = () => {
  applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
};

/* =========================================================
   Sign in / Sign up
   ========================================================= */
function setMode(m) {
  mode = m;
  $("tabLogin").classList.toggle("active", m === "login");
  $("tabSignup").classList.toggle("active", m === "signup");
  $("signupFields").classList.toggle("hidden", m === "login");
  $("authBtn").textContent = m === "login" ? "Sign in \u2192" : "Create account \u2192";
  $("authError").textContent = "";
}
$("tabLogin").onclick = () => setMode("login");
$("tabSignup").onclick = () => setMode("signup");

function friendlyError(code) {
  const map = {
    "auth/email-already-in-use": "This email is already registered. Please sign in.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/invalid-email": "That email address is not valid.",
    "auth/invalid-credential": "Wrong email or password.",
    "auth/user-not-found": "No account found. Please sign up first.",
    "auth/wrong-password": "Wrong password.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "auth/network-request-failed": "Network error. Check your internet."
  };
  return map[code] || ("Something went wrong: " + code);
}

$("authBtn").onclick = async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  const name = $("name").value.trim();
  const phone = $("phone").value.trim();
  $("authError").textContent = "";

  if (!email || !password) { $("authError").textContent = "Please enter your email and password."; return; }
  if (mode === "signup" && (!name || !phone)) { $("authError").textContent = "Please enter your name and phone number."; return; }

  $("authBtn").disabled = true;
  try {
    if (mode === "signup") {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name });
      await setDoc(doc(db, "users", cred.user.uid), {
        uid: cred.user.uid, name, phone, email,
        online: true, lastSeen: serverTimestamp()
      });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (e) {
    $("authError").textContent = friendlyError(e.code);
  }
  $("authBtn").disabled = false;
};

$("logoutBtn").onclick = async () => {
  cancelRecording();
  stopPresence();
  await setPresence(false);
  await signOut(auth);
};

/* =========================================================
   Online / Offline
   ========================================================= */
const ONLINE_WINDOW = 70 * 1000;
let heartbeat = null;
let refreshTimer = null;

function setPresence(online) {
  if (!me) return Promise.resolve();
  return setDoc(doc(db, "users", me.uid), { online, lastSeen: serverTimestamp() }, { merge: true }).catch(() => {});
}

function startPresence() {
  stopPresence();
  setPresence(true);
  heartbeat = setInterval(() => {
    if (document.visibilityState === "visible") setPresence(true);
  }, 25000);
  refreshTimer = setInterval(() => { renderUsers(); updateChatHeader(); }, 20000);
}
function stopPresence() { clearInterval(heartbeat); clearInterval(refreshTimer); }

document.addEventListener("visibilitychange", () => {
  if (!me) return;
  setPresence(document.visibilityState === "visible");
  markRead();
});
window.addEventListener("pagehide", () => { if (me) setPresence(false); });

function isOnline(u) {
  if (!u || !u.online) return false;
  const ms = u.lastSeen && u.lastSeen.toMillis ? u.lastSeen.toMillis() : Date.now();
  return Date.now() - ms < ONLINE_WINDOW;
}

function lastSeenText(u) {
  if (!u || !u.lastSeen || !u.lastSeen.toDate) return "Offline";
  const d = u.lastSeen.toDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return "Last seen today at " + time;
  return "Last seen " + d.toLocaleDateString([], { day: "numeric", month: "short" }) + " at " + time;
}

/* =========================================================
   After login
   ========================================================= */
onAuthStateChanged(auth, (user) => {
  if (user) {
    me = { uid: user.uid, name: user.displayName || user.email };
    $("auth").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("meName").textContent = me.name;
    $("meAvatar").textContent = me.name.charAt(0).toUpperCase();
    loadUsers();
    loadStatuses();
    startPresence();
  } else {
    me = null;
    stopPresence();
    if (unsubMessages) unsubMessages();
    if (unsubUsers) unsubUsers();
    if (unsubStatus) unsubStatus();
    statuses = [];
    closeStory();
    currentChatUser = null;
    currentChatId = null;
    $("app").classList.add("hidden");
    $("app").classList.remove("in-chat");
    $("auth").classList.remove("hidden");
    closeChatUI();
  }
});

/* =========================================================
   Friends list
   ========================================================= */
function loadUsers() {
  if (unsubUsers) unsubUsers();
  unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
    allUsers = snap.docs.map(d => d.data()).filter(u => u.uid !== me.uid);
    if (currentChatUser) {
      const fresh = allUsers.find(u => u.uid === currentChatUser.uid);
      if (fresh) currentChatUser = fresh;
    }
    renderUsers();
    updateChatHeader();
    if (pendingAdd) {
      const u = allUsers.find(x => x.uid === pendingAdd);
      if (u) { pendingAdd = null; history.replaceState(null, "", location.pathname); openChat(u); }
    }
  });
}

function makeAvatar(u) {
  const av = document.createElement("div");
  av.className = "avatar";
  av.textContent = (u.name || "?").charAt(0).toUpperCase();
  const dot = document.createElement("i");
  dot.className = "dot" + (isOnline(u) ? " online" : "");
  av.appendChild(dot);
  return av;
}

function makeUserRow(u, onClick, active) {
  const row = document.createElement("div");
  row.className = "user" + (active ? " active" : "");
  const info = document.createElement("div");
  info.className = "info";
  const n = document.createElement("div");
  n.className = "name";
  n.textContent = u.name;
  const s = document.createElement("div");
  const on = isOnline(u);
  s.className = "sub" + (on ? " on" : "");
  s.textContent = on ? "Online" : "Offline";
  info.append(n, s);
  row.append(makeAvatar(u), info);
  row.onclick = onClick;
  return row;
}

function renderUsers() {
  const q = $("searchBox").value.trim().toLowerCase();
  const list = allUsers
    .filter(u => (u.name || "").toLowerCase().includes(q) || (u.phone || "").includes(q))
    .sort((a, b) => Number(isOnline(b)) - Number(isOnline(a)));

  const box = $("userList");
  box.innerHTML = "";
  if (!list.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = allUsers.length ? "No one found." : "No friends yet. Create another account with a different email to test.";
    box.appendChild(d);
    return;
  }
  list.forEach(u => {
    box.appendChild(makeUserRow(u, () => openChat(u), currentChatUser && currentChatUser.uid === u.uid));
  });
}
$("searchBox").oninput = renderUsers;

/* =========================================================
   Open a chat
   ========================================================= */
function closeChatUI() {
  $("noChat").classList.remove("hidden");
  $("chatHead").classList.add("hidden");
  $("messages").classList.add("hidden");
  $("composer").classList.add("hidden");
  $("recBar").classList.add("hidden");
}

function updateChatHeader() {
  if (!currentChatUser) return;
  const on = isOnline(currentChatUser);
  $("chatName").textContent = currentChatUser.name;
  const st = $("chatStatus");
  st.textContent = on ? "Online" : lastSeenText(currentChatUser);
  st.className = "chat-status" + (on ? " on" : "");
  const av = $("chatAvatar");
  av.textContent = (currentChatUser.name || "?").charAt(0).toUpperCase();
  const dot = document.createElement("i");
  dot.className = "dot" + (on ? " online" : "");
  av.appendChild(dot);
}

function openChat(user) {
  cancelRecording();
  currentChatUser = user;
  currentChatId = [me.uid, user.uid].sort().join("_");
  lastDocs = [];
  keepBottom = true;
  renderUsers();
  $("noChat").classList.add("hidden");
  $("chatHead").classList.remove("hidden");
  $("messages").classList.remove("hidden");
  $("composer").classList.remove("hidden");
  $("app").classList.add("in-chat");
  $("messages").innerHTML = "";
  updateChatHeader();
  applyWallpaper();

  if (unsubMessages) unsubMessages();
  const q = query(collection(db, "chats", currentChatId, "messages"), orderBy("createdAt"));
  unsubMessages = onSnapshot(q, (snap) => {
    lastDocs = snap.docs;
    renderMessages();
    markRead();
  });
  $("msgInput").focus();
}

$("backBtn").onclick = () => {
  cancelRecording();
  $("app").classList.remove("in-chat");
  currentChatUser = null;
  currentChatId = null;
  if (unsubMessages) unsubMessages();
  closeChatUI();
  renderUsers();
};

/* =========================================================
   Messages (text, photo, file, contact, voice) + blue ticks
   ========================================================= */
function timeOf(m) {
  const d = m.createdAt && m.createdAt.toDate ? m.createdAt.toDate() : new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function prettySize(bytes) {
  if (!bytes) return "";
  return bytes < 1024 * 1024 ? Math.round(bytes / 1024) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
}

function buildMessage(d) {
  const m = d.data();
  const mine = m.sender === me.uid;
  const div = document.createElement("div");
  div.className = "msg" + (mine ? " mine" : "");
  const type = m.type || "text";

  if (type === "image") {
    div.classList.add("media");
    const img = document.createElement("img");
    img.className = "msg-img";
    img.src = m.data;
    img.onclick = () => openViewer(m.data);
    img.onload = () => { if (stickNow) $("messages").scrollTop = $("messages").scrollHeight; };
    div.appendChild(img);
  } else if (type === "file") {
    const a = document.createElement("a");
    a.className = "file-card";
    a.href = m.data;
    a.download = m.fileName || "file";
    const ic = document.createElement("span");
    ic.className = "ficon";
    ic.textContent = "\uD83D\uDCC4";
    const box = document.createElement("div");
    const fn = document.createElement("div");
    fn.className = "fname";
    fn.textContent = m.fileName || "File";
    const fs = document.createElement("div");
    fs.className = "fsize";
    fs.textContent = prettySize(m.fileSize) + " \u2022 tap to download";
    box.append(fn, fs);
    a.append(ic, box);
    div.appendChild(a);
  } else if (type === "voice") {
    const au = document.createElement("audio");
    au.controls = true;
    au.preload = "metadata";
    au.src = m.data;
    div.appendChild(au);
  } else if (type === "contact") {
    const c = m.contact || {};
    const card = document.createElement("div");
    card.className = "contact-card";
    const av = document.createElement("div");
    av.className = "avatar sm";
    av.textContent = (c.name || "?").charAt(0).toUpperCase();
    const info = document.createElement("div");
    const cn = document.createElement("div");
    cn.className = "cname";
    cn.textContent = c.name || "Contact";
    const cp = document.createElement("div");
    cp.className = "cphone";
    cp.textContent = c.phone || "";
    info.append(cn, cp);
    card.append(av, info);
    const friend = allUsers.find(u => u.uid === c.uid);
    if (friend) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Message";
      b.onclick = () => openChat(friend);
      card.appendChild(b);
    }
    div.appendChild(card);
  } else {
    const span = document.createElement("span");
    span.textContent = m.text;
    div.appendChild(span);
  }

  const meta = document.createElement("span");
  meta.className = "t";
  meta.textContent = timeOf(m);
  if (mine) {
    const tk = document.createElement("b");
    tk.className = "tick" + (m.read ? " seen" : "");
    tk.textContent = m.read ? "\u2713\u2713" : "\u2713";
    tk.title = m.read ? "Seen" : "Sent";
    meta.append(" ", tk);
  }
  div.appendChild(meta);

  if (m.reactions) {
    const counts = {};
    Object.values(m.reactions).forEach(e => { counts[e] = (counts[e] || 0) + 1; });
    const row = document.createElement("div");
    row.className = "reacts";
    Object.entries(counts).forEach(([e, n]) => {
      const chip = document.createElement("span");
      chip.className = "chip" + (m.reactions[me.uid] === e ? " mine-r" : "");
      chip.textContent = e + (n > 1 ? " " + n : "");
      row.appendChild(chip);
    });
    div.appendChild(row);
  }

  div.addEventListener("click", (ev) => {
    if (ev.target.closest("a, audio, button, img")) return;
    ev.stopPropagation();
    showPicker(div, d, m);
  });
  return div;
}

function renderMessages() {
  const box = $("messages");
  const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
  const oldTop = box.scrollTop;
  stickNow = keepBottom || gap < 150;      // keepBottom = "force scroll down" (chat just opened / I just sent)
  keepBottom = false;
  box.innerHTML = "";
  lastDocs.forEach(d => box.appendChild(buildMessage(d)));
  box.scrollTop = stickNow ? box.scrollHeight : oldTop;
}

// when the other person opens the chat, their messages become "seen" (blue ticks)
function markRead() {
  if (!me || !currentChatUser || document.visibilityState !== "visible") return;
  lastDocs.forEach(d => {
    const m = d.data();
    if (m.sender !== me.uid && !m.read) updateDoc(d.ref, { read: true }).catch(() => {});
  });
}

async function sendPayload(p) {
  if (!currentChatUser || !currentChatId) return;
  keepBottom = true;
  try {
    await addDoc(collection(db, "chats", currentChatId, "messages"), {
      sender: me.uid, read: false, createdAt: serverTimestamp(), ...p
    });
    setPresence(true);
  } catch (e) {
    alert(e.code === "invalid-argument" ? "This is too big to send on the free plan." : "Message failed: " + e.code);
  }
}

function sendText() {
  const text = $("msgInput").value.trim();
  if (!text) return;
  $("msgInput").value = "";
  sendPayload({ type: "text", text });
}
$("sendBtn").onclick = sendText;
$("msgInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendText(); });

/* =========================================================
   Attach menu: photo / file / contact
   ========================================================= */
$("attachBtn").onclick = (e) => { e.stopPropagation(); $("attachMenu").classList.toggle("hidden"); };
document.addEventListener("click", () => $("attachMenu").classList.add("hidden"));
document.querySelectorAll("[data-attach]").forEach(b => {
  b.onclick = () => {
    $("attachMenu").classList.add("hidden");
    const k = b.dataset.attach;
    if (k === "photo") $("photoInput").click();
    else if (k === "file") $("fileInput").click();
    else openContactPicker();
  };
});

function readAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

// shrink a photo so it fits inside a free Firestore message
function compressImage(file, maxSide, quality, maxLen) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * s);
      const h = Math.round(img.height * s);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      let q = quality;
      let out = c.toDataURL("image/jpeg", q);
      while (out.length > maxLen && q > 0.3) { q -= 0.1; out = c.toDataURL("image/jpeg", q); }
      URL.revokeObjectURL(url);
      out.length > maxLen ? reject(new Error("too big")) : resolve(out);
    };
    img.onerror = () => reject(new Error("bad image"));
    img.src = url;
  });
}

$("photoInput").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const data = await compressImage(f, 1024, 0.7, 750000);
    await sendPayload({ type: "image", data });
  } catch {
    alert("Could not send this photo. Try a smaller one.");
  }
};

$("fileInput").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (f.size > 600 * 1024) {
    alert("On the free plan, files must be smaller than 600 KB.");
    return;
  }
  try {
    const data = await readAsDataURL(f);
    await sendPayload({ type: "file", data, fileName: f.name, fileSize: f.size });
  } catch {
    alert("Could not read this file.");
  }
};

function openContactPicker() {
  const box = $("contactList");
  box.innerHTML = "";
  if (!allUsers.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "No contacts yet.";
    box.appendChild(d);
  }
  allUsers.forEach(u => {
    box.appendChild(makeUserRow(u, () => {
      sendPayload({ type: "contact", contact: { uid: u.uid, name: u.name, phone: u.phone || "" } });
      $("contactModal").classList.add("hidden");
    }, false));
  });
  $("contactModal").classList.remove("hidden");
}

/* =========================================================
   Voice notes
   ========================================================= */
let recorder = null;
let recStream = null;
let recChunks = [];
let recTimer = null;
let recStart = 0;
let recCancelled = false;

function showRecording(on) {
  $("composer").classList.toggle("hidden", on);
  $("recBar").classList.toggle("hidden", !on);
}

async function startRecording() {
  if (!currentChatUser) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) { alert("Voice notes are not supported in this browser."); return; }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    alert("Please allow microphone access to record a voice note.");
    return;
  }
  const opts = { audioBitsPerSecond: 16000 };
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) opts.mimeType = "audio/webm;codecs=opus";
  recorder = new MediaRecorder(recStream, opts);
  recChunks = [];
  recCancelled = false;
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = async () => {
    recStream.getTracks().forEach(t => t.stop());
    clearInterval(recTimer);
    showRecording(false);
    if (recCancelled || !currentChatUser) return;
    const blob = new Blob(recChunks, { type: recorder.mimeType || "audio/webm" });
    const data = await readAsDataURL(blob);
    if (data.length > 900000) { alert("This voice note is too long."); return; }
    sendPayload({ type: "voice", data, duration: Math.round((Date.now() - recStart) / 1000) });
  };
  recorder.start();
  recStart = Date.now();
  $("recTime").textContent = "0:00";
  showRecording(true);
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $("recTime").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    if (s >= 90) recorder.stop();
  }, 500);
}

function cancelRecording() {
  if (recorder && recorder.state === "recording") {
    recCancelled = true;
    recorder.stop();
  }
}

$("micBtn").onclick = startRecording;
$("recCancel").onclick = cancelRecording;
$("recSend").onclick = () => { if (recorder && recorder.state === "recording") recorder.stop(); };

/* =========================================================
   Chat wallpaper
   ========================================================= */
const WALLS = [
  { id: "default", name: "Default", css: "" },
  { id: "neon",    name: "Neon night", css: "linear-gradient(160deg,#1a0b3d,#3b1478 60%,#12072b)" },
  { id: "aurora",  name: "Aurora",     css: "linear-gradient(160deg,#0f2a5c,#6a3df0 55%,#d946ef)" },
  { id: "sunset",  name: "Sunset",     css: "linear-gradient(160deg,#ff9a9e,#c084fc 60%,#7c3aed)" },
  { id: "mint",    name: "Mint",       css: "linear-gradient(160deg,#d1fae5,#a7f3d0 50%,#c4b5fd)" },
  { id: "dots",    name: "Sparkle",    css: "radial-gradient(circle at 25% 25%, rgba(196,161,255,.35) 0 2px, transparent 3px) 0 0/30px 30px, #140a2c" }
];

function wallKey() { return "viochat_wall_" + currentChatId; }

function applyWallpaper() {
  const box = $("messages");
  const v = store.get(wallKey()) || "default";
  if (v.startsWith("data:")) {
    box.style.background = 'center / cover no-repeat url("' + v + '")';
  } else {
    const w = WALLS.find(x => x.id === v);
    box.style.background = w && w.css ? w.css : "";
  }
}

function buildWallGrid() {
  const grid = $("wallGrid");
  grid.innerHTML = "";
  const cur = store.get(wallKey()) || "default";
  WALLS.forEach(w => {
    const b = document.createElement("div");
    b.className = "wall-item" + (cur === w.id ? " active" : "");
    if (w.css) b.style.background = w.css;
    const s = document.createElement("span");
    s.textContent = w.name;
    b.appendChild(s);
    b.onclick = () => { store.set(wallKey(), w.id); applyWallpaper(); buildWallGrid(); };
    grid.appendChild(b);
  });
}

$("wallBtn").onclick = () => { buildWallGrid(); $("wallModal").classList.remove("hidden"); };

$("wallUpload").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const data = await compressImage(f, 1280, 0.6, 600000);
    if (!store.set(wallKey(), data)) { alert("Not enough space to save this wallpaper. Try a smaller photo."); return; }
    applyWallpaper();
    buildWallGrid();
  } catch {
    alert("Could not use this photo.");
  }
};

$("wallReset").onclick = () => { store.del(wallKey()); applyWallpaper(); buildWallGrid(); };

/* =========================================================
   Windows (modals) + photo viewer
   ========================================================= */
document.querySelectorAll(".modal").forEach(m => {
  m.addEventListener("click", (e) => {
    if (e.target === m || e.target.hasAttribute("data-close")) {
      m.classList.add("hidden");
      if (m.id === "qrModal") stopScan();
    }
  });
});

function openViewer(src) {
  $("viewerImg").src = src;
  $("viewer").classList.remove("hidden");
}
$("viewer").onclick = () => $("viewer").classList.add("hidden");


/* =========================================================
   Emoji reactions (tap a message)
   ========================================================= */
const REACTS = ["\uD83D\uDC4D", "\u2764\uFE0F", "\uD83D\uDE02", "\uD83D\uDE2E", "\uD83D\uDE22", "\uD83D\uDE4F"];

function closePicker() { document.querySelectorAll(".react-picker").forEach(p => p.remove()); }
document.addEventListener("click", closePicker);

function showPicker(bubble, d, m) {
  closePicker();
  const bar = document.createElement("div");
  bar.className = "react-picker";
  REACTS.forEach(e => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = e;
    b.onclick = (ev) => { ev.stopPropagation(); closePicker(); setReaction(d, m, e); };
    bar.appendChild(b);
  });
  bubble.appendChild(bar);
}

function setReaction(d, m, emoji) {
  const same = m.reactions && m.reactions[me.uid] === emoji;   // tapping the same emoji removes it
  updateDoc(d.ref, { ["reactions." + me.uid]: same ? deleteField() : emoji }).catch(() => {});
}

/* =========================================================
   Sidebar tabs: Chats / Status
   ========================================================= */
function setSideTab(t) {
  $("tabChats").classList.toggle("active", t === "chats");
  $("tabStatus").classList.toggle("active", t === "status");
  $("searchWrap").classList.toggle("hidden", t !== "chats");
  $("userList").classList.toggle("hidden", t !== "chats");
  $("statusPanel").classList.toggle("hidden", t !== "status");
  if (t === "status") renderStatusList();
}
$("tabChats").onclick = () => setSideTab("chats");
$("tabStatus").onclick = () => setSideTab("status");

/* =========================================================
   Status (disappears after 24 hours)
   ========================================================= */
const STATUS_BGS = [
  "linear-gradient(135deg,#7c4dff,#c04df0)",
  "linear-gradient(135deg,#0f2a5c,#6a3df0)",
  "linear-gradient(135deg,#ff6a88,#ff99ac)",
  "linear-gradient(135deg,#11998e,#38ef7d)",
  "linear-gradient(135deg,#f7971e,#ffd200)",
  "linear-gradient(135deg,#232526,#414345)"
];
let statusMode = "text";
let statusBg = STATUS_BGS[0];
let statusPhoto = null;
const story = { items: [], idx: 0, timer: null };

function msOf(s) { return s.createdAt && s.createdAt.toMillis ? s.createdAt.toMillis() : Date.now(); }

function timeLabel(ms) {
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (d.toDateString() === new Date().toDateString() ? "Today, " : "Yesterday, ") + t;
}

function loadStatuses() {
  if (unsubStatus) unsubStatus();
  const q = query(collection(db, "statuses"), orderBy("createdAt", "desc"));
  unsubStatus = onSnapshot(q, (snap) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    statuses = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => msOf(s) > cutoff);
    renderStatusList();
  });
}

function groupStatuses() {
  const g = new Map();
  statuses.slice().sort((a, b) => msOf(a) - msOf(b)).forEach(s => {
    if (!g.has(s.uid)) g.set(s.uid, []);
    g.get(s.uid).push(s);
  });
  return g;
}

function statusRow(name, subText, hasStatus, onClick, extra) {
  const row = document.createElement("div");
  row.className = "user";
  const av = document.createElement("div");
  av.className = "avatar" + (hasStatus ? " ring" : "");
  av.textContent = (name || "?").charAt(0).toUpperCase();
  const info = document.createElement("div");
  info.className = "info grow";
  const n = document.createElement("div");
  n.className = "name";
  n.textContent = name;
  const s = document.createElement("div");
  s.className = "sub";
  s.textContent = subText;
  info.append(n, s);
  row.append(av, info);
  if (extra) row.appendChild(extra);
  row.onclick = onClick;
  return row;
}

function renderStatusList() {
  if (!me) return;
  const box = $("statusList");
  box.innerHTML = "";
  const g = groupStatuses();

  const mine = g.get(me.uid) || [];
  const add = document.createElement("button");
  add.type = "button";
  add.className = "add-mini";
  add.textContent = "+";
  add.title = "Add status";
  add.onclick = (e) => { e.stopPropagation(); openStatusModal(); };
  box.appendChild(statusRow(
    "My status",
    mine.length ? mine.length + " update" + (mine.length > 1 ? "s" : "") + " \u2022 " + timeLabel(msOf(mine[mine.length - 1])) : "Tap + to add a status",
    mine.length > 0,
    () => { mine.length ? openStory(me.uid) : openStatusModal(); },
    add
  ));

  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = "Recent updates";
  box.appendChild(title);

  const others = [...g.entries()]
    .filter(([uid]) => uid !== me.uid)
    .sort((a, b) => msOf(b[1][b[1].length - 1]) - msOf(a[1][a[1].length - 1]));

  if (!others.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "No status updates from your friends yet.";
    box.appendChild(d);
  }
  others.forEach(([uid, items]) => {
    const last = items[items.length - 1];
    box.appendChild(statusRow(last.name || "Friend", timeLabel(msOf(last)), true, () => openStory(uid)));
  });
}

/* --- add a status --- */
function setStatusMode(m) {
  statusMode = m;
  $("stTabText").classList.toggle("active", m === "text");
  $("stTabPhoto").classList.toggle("active", m === "photo");
  $("stTextBox").classList.toggle("hidden", m !== "text");
  $("stPhotoBox").classList.toggle("hidden", m !== "photo");
}
$("stTabText").onclick = () => setStatusMode("text");
$("stTabPhoto").onclick = () => setStatusMode("photo");

function buildStatusColors() {
  const box = $("statusColors");
  box.innerHTML = "";
  STATUS_BGS.forEach(bg => {
    const i = document.createElement("i");
    i.style.background = bg;
    if (bg === statusBg) i.className = "active";
    i.onclick = () => { statusBg = bg; $("statusText").style.background = bg; buildStatusColors(); };
    box.appendChild(i);
  });
}

function openStatusModal() {
  statusPhoto = null;
  statusBg = STATUS_BGS[0];
  $("statusText").value = "";
  $("statusText").style.background = statusBg;
  $("statusPreview").classList.add("hidden");
  setStatusMode("text");
  buildStatusColors();
  $("statusModal").classList.remove("hidden");
}

$("statusPhotoInput").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    statusPhoto = await compressImage(f, 900, 0.65, 700000);
    $("statusPreview").src = statusPhoto;
    $("statusPreview").classList.remove("hidden");
  } catch {
    alert("Could not use this photo. Try a smaller one.");
  }
};

$("statusPost").onclick = async () => {
  const base = { uid: me.uid, name: me.name, createdAt: serverTimestamp() };
  let payload;
  if (statusMode === "text") {
    const text = $("statusText").value.trim();
    if (!text) { alert("Please type something."); return; }
    payload = { ...base, type: "text", text, bg: statusBg };
  } else {
    if (!statusPhoto) { alert("Please choose a photo."); return; }
    payload = { ...base, type: "image", data: statusPhoto };
  }
  try {
    await addDoc(collection(db, "statuses"), payload);
    $("statusModal").classList.add("hidden");
  } catch (e) {
    alert("Could not post status: " + e.code);
  }
};

/* --- view statuses --- */
function openStory(uid) {
  const items = groupStatuses().get(uid);
  if (!items || !items.length) return;
  story.items = items;
  story.idx = 0;
  $("story").classList.remove("hidden");
  showStory();
}

function showStory() {
  clearTimeout(story.timer);
  const s = story.items[story.idx];
  if (!s) { closeStory(); return; }

  const bars = $("storyBars");
  bars.innerHTML = "";
  story.items.forEach((_, i) => {
    const b = document.createElement("div");
    b.className = "bar";
    const f = document.createElement("i");
    if (i < story.idx) f.style.width = "100%";
    else if (i === story.idx) f.className = "run";
    b.appendChild(f);
    bars.appendChild(b);
  });

  $("storyName").textContent = s.uid === me.uid ? "My status" : (s.name || "Friend");
  $("storyTime").textContent = timeLabel(msOf(s));
  const c = $("storyContent");
  c.innerHTML = "";
  if (s.type === "image") {
    c.style.background = "#000";
    const img = document.createElement("img");
    img.src = s.data;
    c.appendChild(img);
  } else {
    c.style.background = s.bg || STATUS_BGS[0];
    const t = document.createElement("div");
    t.className = "story-text";
    t.textContent = s.text;
    c.appendChild(t);
  }
  $("storyDelete").classList.toggle("hidden", s.uid !== me.uid);
  story.timer = setTimeout(nextStory, 5000);
}

function nextStory() { story.idx++; showStory(); }
function prevStory() { story.idx = Math.max(0, story.idx - 1); showStory(); }
function closeStory() { clearTimeout(story.timer); $("story").classList.add("hidden"); }

$("storyContent").onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  (e.clientX - r.left < r.width / 3) ? prevStory() : nextStory();
};
$("storyClose").onclick = closeStory;
$("storyDelete").onclick = async () => {
  const s = story.items[story.idx];
  if (!s) return;
  try { await deleteDoc(doc(db, "statuses", s.id)); } catch { /* ignore */ }
  closeStory();
};
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeStory(); });

/* =========================================================
   QR code: show my QR / scan a friend's QR
   ========================================================= */
let scanStream = null;
let scanRAF = null;

function myLink() { return location.origin + location.pathname + "?add=" + me.uid; }

function setQrTab(t) {
  $("qrTabMy").classList.toggle("active", t === "my");
  $("qrTabScan").classList.toggle("active", t === "scan");
  $("qrMy").classList.toggle("hidden", t !== "my");
  $("qrScan").classList.toggle("hidden", t !== "scan");
  if (t === "my") stopScan();
}
$("qrTabMy").onclick = () => setQrTab("my");
$("qrTabScan").onclick = () => setQrTab("scan");

function openQr() {
  setQrTab("my");
  const link = myLink();
  $("qrLink").textContent = link;
  const box = $("qrBox");
  box.innerHTML = "";
  if (window.QRCode) {
    new window.QRCode(box, { text: link, width: 200, height: 200, colorDark: "#1a0b3d", colorLight: "#ffffff" });
  } else {
    box.textContent = "QR could not load. Check your internet.";
  }
  $("qrCopy").textContent = "Copy link";
  $("qrModal").classList.remove("hidden");
}
$("qrBtn").onclick = openQr;

$("qrCopy").onclick = async () => {
  try { await navigator.clipboard.writeText(myLink()); $("qrCopy").textContent = "Copied!"; }
  catch { $("qrCopy").textContent = "Copy it by hand"; }
};

function uidFromText(t) {
  try { return new URL(t).searchParams.get("add"); } catch { return (t || "").trim(); }
}

function handleScanned(text) {
  stopScan();
  const uid = uidFromText(text);
  const u = allUsers.find(x => x.uid === uid);
  if (u) {
    $("qrModal").classList.add("hidden");
    setSideTab("chats");
    openChat(u);
  } else {
    $("scanMsg").textContent = uid === me.uid ? "That is your own QR code." : "This QR code is not a VioChat user.";
  }
}

async function startScan() {
  if (!window.jsQR) { alert("Scanner could not load. Check your internet."); return; }
  if (!navigator.mediaDevices) { alert("Camera is not supported here."); return; }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch {
    alert("Please allow camera access.");
    return;
  }
  const v = $("scanVideo");
  v.srcObject = scanStream;
  v.setAttribute("playsinline", "");
  await v.play();
  v.classList.remove("hidden");
  $("scanMsg").textContent = "Point the camera at a VioChat QR code...";
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const tick = () => {
    if (!scanStream) return;
    if (v.readyState === v.HAVE_ENOUGH_DATA) {
      cv.width = v.videoWidth;
      cv.height = v.videoHeight;
      ctx.drawImage(v, 0, 0);
      const img = ctx.getImageData(0, 0, cv.width, cv.height);
      const code = window.jsQR(img.data, img.width, img.height);
      if (code && code.data) { handleScanned(code.data); return; }
    }
    scanRAF = requestAnimationFrame(tick);
  };
  tick();
}

function stopScan() {
  if (scanRAF) cancelAnimationFrame(scanRAF);
  scanRAF = null;
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  const v = $("scanVideo");
  v.srcObject = null;
  v.classList.add("hidden");
}
$("scanStart").onclick = startScan;

/* =========================================================
   Emoji picker (adds an emoji to the message box)
   ========================================================= */
const EMOJI_LIST = ["😀","😁","😂","🤣","😊","😍","😘","😎","🤔","😢","😭","😡","👍","👎","👏","🙏",
                    "💪","🎉","💜","🔥","✨","🌸","🐱","😴","🥰","😅","🙌","👀","💯","😇","🤗","😋"];

$("emojiBtn").onclick = (e) => {
  e.stopPropagation();
  const panel = $("emojiPanel");
  if (!panel.childElementCount) {
    EMOJI_LIST.forEach(em => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = em;
      b.onclick = (ev) => { ev.stopPropagation(); $("msgInput").value += em; $("msgInput").focus(); };
      panel.appendChild(b);
    });
  }
  $("attachMenu").classList.add("hidden");
  panel.classList.toggle("hidden");
};
document.addEventListener("click", (e) => {
  if (!e.target.closest("#emojiPanel")) $("emojiPanel").classList.add("hidden");
});