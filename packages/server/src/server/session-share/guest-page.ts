// The guest web chat (spec §21.4/§21.5), served by the scoped ShareServer through the
// Cloudflare tunnel. Self-contained: no build, no framework, no external assets. Flow:
// request to join → wait for host Accept → enter the 6-digit code the host reads out → chat.

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

export function renderGuestPage(agentLabel: string): string {
  const label = escapeHtml(agentLabel);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>JAgentDesk — Shared session</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,Segoe UI,Roboto,sans-serif; background:#0b0b0d; color:#e9e9ee; height:100dvh; display:flex; flex-direction:column; }
  header { padding:10px 14px; border-bottom:1px solid #26262c; display:flex; align-items:center; gap:8px; font-size:14px; }
  header .dot { width:8px; height:8px; border-radius:50%; background:#16a34a; }
  header .muted { color:#8a8a93; }
  #presence { margin-left:auto; font-size:12px; color:#8a8a93; max-width:50%; text-align:right; }
  .pane { flex:1; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:14px; padding:24px; text-align:center; }
  .pane h1 { font-size:18px; font-weight:600; margin:0; }
  .pane p { color:#8a8a93; margin:0; max-width:320px; font-size:14px; }
  input[type=text], #code { padding:11px 12px; border-radius:10px; border:1px solid #33333b; background:#151519; color:#e9e9ee; font-size:15px; width:240px; text-align:center; }
  #code { font-size:28px; letter-spacing:10px; }
  #err { color:#f87171; font-size:13px; min-height:18px; }
  button { background:#20744A; color:#fff; border:0; border-radius:8px; padding:10px 16px; font-size:14px; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .spinner { width:22px; height:22px; border:3px solid #2a2a31; border-top-color:#20744A; border-radius:50%; animation:spin 1s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  #chat { flex:1; display:none; flex-direction:column; min-height:0; }
  #log { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px; }
  .msg { max-width:80%; padding:9px 12px; border-radius:12px; font-size:14px; line-height:1.45; white-space:pre-wrap; word-break:break-word; }
  .user { align-self:flex-end; background:#20744A; }
  .assistant { align-self:flex-start; background:#1b1b21; border:1px solid #2a2a31; }
  .tool { align-self:flex-start; background:transparent; color:#8a8a93; font-size:12px; font-family:ui-monospace,monospace; padding:2px 6px; }
  .error { align-self:flex-start; background:#3b1414; color:#fca5a5; }
  #composer { border-top:1px solid #26262c; padding:10px; display:flex; gap:8px; align-items:flex-end; }
  #input { flex:1; resize:none; min-height:44px; max-height:140px; padding:10px 12px; border-radius:10px; border:1px solid #33333b; background:#151519; color:#e9e9ee; font-size:14px; font-family:inherit; }
  #mode { padding:10px 12px; border-radius:10px; border:1px solid #33333b; background:#151519; color:#e9e9ee; font-size:13px; max-width:150px; }
  .hidden { display:none !important; }
</style>
</head>
<body>
<header><span class="dot"></span><b>${label}</b><span class="muted">· shared session</span><span id="presence"></span></header>

<div id="request" class="pane">
  <h1>Join this shared session</h1>
  <p>Your name (optional) — the host will see who is asking to join.</p>
  <input id="name" type="text" maxlength="40" placeholder="Your name" autocomplete="off" />
  <div id="reqErr" class="err" style="color:#f87171;font-size:13px;min-height:18px"></div>
  <button id="reqBtn">Request to join</button>
</div>

<div id="waiting" class="pane hidden">
  <div class="spinner"></div>
  <h1>Waiting for the host…</h1>
  <p>The host is deciding whether to let you in. Keep this tab open.</p>
</div>

<div id="gate" class="pane hidden">
  <h1>Enter the 6-digit code</h1>
  <p>The host approved you. Ask them for the 6-digit code now showing in their app.</p>
  <input id="code" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="••••••" />
  <div id="err"></div>
  <button id="join">Join</button>
</div>

<div id="chat">
  <div id="log"></div>
  <div id="composer">
    <select id="mode" class="hidden" title="Agent mode"></select>
    <textarea id="input" placeholder="Message the agent…"></textarea>
    <button id="send">Send</button>
  </div>
</div>

<div id="banner" class="pane hidden"></div>

<script>
(function(){
  var proto = location.protocol === "https:" ? "wss:" : "ws:";
  var ws, seen = {}, memberId = null, ended = false;
  var $ = function(id){ return document.getElementById(id); };
  var panes = ["request","waiting","gate","chat","banner"];
  function only(id){ panes.forEach(function(p){ var el=$(p); if(p===id){ el.classList.remove("hidden"); el.style.display = p==="chat"?"flex":"flex"; } else { el.classList.add("hidden"); } }); }

  function connect(){
    ws = new WebSocket(proto + "//" + location.host + "/guest");
    ws.onmessage = function(ev){
      var m; try { m = JSON.parse(ev.data); } catch(e){ return; }
      if (m.t === "pending") { only("waiting"); }
      else if (m.t === "approved") { only("gate"); $("code").focus(); }
      else if (m.t === "rejected") { end(m.reason || "The host declined the request."); }
      else if (m.t === "pair_result") {
        if (m.ok) { memberId = m.memberId; only("chat"); $("input").focus(); }
        else { $("err").textContent = m.error || "Incorrect code."; $("join").disabled=false; }
      }
      else if (m.t === "transcript") { $("log").innerHTML=""; seen={}; (m.rows||[]).forEach(addRow); scroll(); }
      else if (m.t === "append") { (m.rows||[]).forEach(addRow); scroll(); }
      else if (m.t === "presence") { renderPresence(m.members||[]); }
      else if (m.t === "modes") { renderModes(m); }
      else if (m.t === "error") { addRow({ seq:"e"+Date.now(), role:"error", text:m.message }); scroll(); }
      else if (m.t === "ended") { end(m.reason || "The session has ended."); }
    };
    ws.onclose = function(){ if(!ended) end("Disconnected."); };
    ws.onerror = function(){};
  }
  function end(reason){ ended = true; $("banner").innerHTML = "<h1>Session ended</h1><p>"+reason+"</p>"; only("banner"); }

  function addRow(r){ if(seen[r.seq])return; seen[r.seq]=1; var d=document.createElement("div"); d.className="msg "+(r.role||"assistant"); d.textContent=r.text||""; $("log").appendChild(d); }
  function scroll(){ var l=$("log"); l.scrollTop=l.scrollHeight; }
  function renderPresence(members){
    var others = members.filter(function(x){ return x.memberId !== memberId; });
    var typing = others.filter(function(x){ return x.typing; }).map(function(x){ return x.label; });
    var txt = others.length ? (others.length+" viewing") : "";
    if (typing.length) txt = typing.join(", ")+" typing…";
    $("presence").textContent = txt;
  }

  $("reqBtn").onclick = function(){
    var name = ($("name").value||"").trim().slice(0,40);
    $("reqBtn").disabled = true;
    if (!ws || ws.readyState !== 1) { connect(); setTimeout(function(){ ws.send(JSON.stringify({t:"request",name:name})); }, 250); }
    else ws.send(JSON.stringify({t:"request",name:name}));
  };
  $("join").onclick = function(){
    var code = ($("code").value||"").replace(/\\D/g,"").slice(0,6);
    if (code.length !== 6) { $("err").textContent="Enter all 6 digits."; return; }
    $("err").textContent=""; $("join").disabled=true;
    ws.send(JSON.stringify({t:"pair",code:code}));
  };
  $("code").addEventListener("keydown", function(e){ if(e.key==="Enter") $("join").click(); });
  $("name").addEventListener("keydown", function(e){ if(e.key==="Enter") $("reqBtn").click(); });

  var typingTimer=null;
  $("input").addEventListener("input", function(){
    if(!ws||ws.readyState!==1)return;
    ws.send(JSON.stringify({t:"typing",typing:true}));
    if(typingTimer)clearTimeout(typingTimer);
    typingTimer=setTimeout(function(){ ws.send(JSON.stringify({t:"typing",typing:false})); },1500);
  });
  function sendMsg(){ var text=$("input").value.trim(); if(!text||!ws||ws.readyState!==1)return; ws.send(JSON.stringify({t:"prompt",text:text})); $("input").value=""; ws.send(JSON.stringify({t:"typing",typing:false})); }
  $("send").onclick = sendMsg;

  // Mode picker (spec §21.6). Only shown when the host granted the model/mode right; the server
  // re-checks the grant on every change, so a stale UI can't bypass it.
  function renderModes(m){
    var sel = $("mode");
    if (!m.allowed || !(m.modes||[]).length) { sel.classList.add("hidden"); return; }
    sel.innerHTML = "";
    (m.modes||[]).forEach(function(mode){
      var o = document.createElement("option"); o.value = mode.id; o.textContent = mode.label;
      if (mode.id === m.currentModeId) o.selected = true;
      sel.appendChild(o);
    });
    sel.classList.remove("hidden");
  }
  $("mode").addEventListener("change", function(){
    if(!ws||ws.readyState!==1)return;
    ws.send(JSON.stringify({t:"set_mode",modeId:$("mode").value}));
  });
  $("input").addEventListener("keydown", function(e){ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); sendMsg(); }});

  only("request");
  connect();
})();
</script>
</body>
</html>`;
}
