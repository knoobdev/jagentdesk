// The guest web chat (spec §21.4/§21.5), served by the scoped ShareServer through the
// Cloudflare tunnel. Self-contained: no build, no framework, no external assets. Flow:
// request to join → wait for host Accept → enter the 6-digit code the host reads out → chat.
// Assistant replies are markdown, rendered with a small safe renderer (escape-then-format, no raw
// HTML passthrough) so tables/lists/code look like the desktop app rather than raw asterisks.

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

export function renderGuestPage(agentLabel: string): string {
  const label = escapeHtml(agentLabel);
  const initial = escapeHtml((agentLabel.trim()[0] || "A").toUpperCase());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
<title>${label} — JAgentDesk</title>
<style>
  :root { color-scheme: dark; --accent:#2f9e63; --accent-2:#20744A; --bg:#0c0d10; --surface:#141518; --surface-2:#191b1f; --border:#26282e; --border-2:#2f323a; --text:#eceef2; --muted:#9aa0aa; }
  * { box-sizing: border-box; }
  html, body { height:100%; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text); height:100dvh; display:flex; flex-direction:column; -webkit-font-smoothing:antialiased; }
  header { padding:12px 18px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:11px; background:rgba(20,21,24,.7); backdrop-filter:saturate(140%) blur(8px); }
  .avatar { width:32px; height:32px; border-radius:9px; background:linear-gradient(140deg,var(--accent),var(--accent-2)); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:15px; color:#fff; flex:none; }
  .hmeta { display:flex; flex-direction:column; min-width:0; }
  .hmeta b { font-size:14.5px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .hsub { font-size:12px; color:var(--muted); display:flex; align-items:center; gap:6px; }
  .live { width:7px; height:7px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 3px rgba(47,158,99,.18); }
  #presence { margin-left:auto; font-size:12px; color:var(--muted); text-align:right; max-width:45%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

  .pane { flex:1; display:flex; align-items:center; justify-content:center; padding:24px; }
  .card { width:100%; max-width:380px; background:var(--surface); border:1px solid var(--border); border-radius:18px; padding:28px 24px; text-align:center; box-shadow:0 12px 40px rgba(0,0,0,.35); display:flex; flex-direction:column; align-items:center; gap:14px; }
  .card .big { width:52px; height:52px; border-radius:14px; background:linear-gradient(140deg,var(--accent),var(--accent-2)); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:24px; color:#fff; }
  .card h1 { font-size:19px; font-weight:650; margin:0; }
  .card p { color:var(--muted); margin:0; font-size:13.5px; line-height:1.5; }
  input[type=text], #code { width:100%; padding:12px 14px; border-radius:12px; border:1px solid var(--border-2); background:#101114; color:var(--text); font-size:15px; text-align:center; }
  input[type=text]:focus, #code:focus { outline:none; border-color:var(--accent); }
  #code { font-size:30px; letter-spacing:12px; padding-left:12px; font-variant-numeric:tabular-nums; }
  #err { color:#f87171; font-size:13px; min-height:18px; }
  .btn { width:100%; background:var(--accent-2); color:#fff; border:0; border-radius:12px; padding:12px 16px; font-size:14.5px; font-weight:650; cursor:pointer; transition:background .15s; }
  .btn:hover:not(:disabled) { background:var(--accent); }
  .btn:disabled { opacity:.5; cursor:default; }
  .spinner { width:26px; height:26px; border:3px solid #2a2c33; border-top-color:var(--accent); border-radius:50%; animation:spin .9s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }

  #chat { flex:1; display:none; flex-direction:column; min-height:0; }
  #log { flex:1; overflow-y:auto; padding:22px 16px; }
  #logInner { max-width:768px; margin:0 auto; width:100%; display:flex; flex-direction:column; gap:18px; }
  .turn { display:flex; gap:10px; align-items:flex-start; }
  .turn.user { flex-direction:row-reverse; }
  .av { width:26px; height:26px; border-radius:7px; flex:none; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; margin-top:2px; }
  .turn.assistant .av { background:linear-gradient(140deg,var(--accent),var(--accent-2)); color:#fff; }
  .turn.user .av { background:#2a2d34; color:#c9ccd3; }
  .bubblewrap { min-width:0; max-width:calc(100% - 44px); display:flex; flex-direction:column; gap:3px; }
  .turn.user .bubblewrap { align-items:flex-end; }
  .name { font-size:11.5px; color:#7f8590; padding:0 2px; }
  .msg { padding:11px 14px; border-radius:14px; font-size:14.5px; line-height:1.6; word-break:break-word; overflow-wrap:anywhere; }
  .assistant .msg { background:var(--surface-2); border:1px solid var(--border); border-top-left-radius:5px; }
  .user .msg { background:var(--accent-2); color:#fff; border-top-right-radius:5px; white-space:pre-wrap; }
  .error .msg { background:#3a1518; color:#fca5a5; border:1px solid #5a1d1d; }
  .tool { align-self:flex-start; margin-left:36px; color:var(--muted); font-size:12.5px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; opacity:.85; }
  /* markdown */
  .msg p { margin:0 0 9px; } .msg p:last-child { margin-bottom:0; }
  .msg h1,.msg h2,.msg h3 { font-size:15.5px; font-weight:650; margin:4px 0 8px; }
  .msg ul,.msg ol { margin:4px 0 9px; padding-left:20px; } .msg li { margin:2px 0; }
  .msg code { background:#0e0f12; border:1px solid var(--border); border-radius:5px; padding:1px 5px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.8px; }
  .msg pre { background:#0e0f12; border:1px solid var(--border); border-radius:10px; padding:11px 13px; overflow-x:auto; margin:6px 0 9px; }
  .msg pre code { background:none; border:0; padding:0; font-size:12.6px; line-height:1.5; }
  .msg a { color:#7cc4ff; text-decoration:none; } .msg a:hover { text-decoration:underline; }
  .msg table { border-collapse:collapse; margin:6px 0 9px; font-size:13px; display:block; overflow-x:auto; }
  .msg th,.msg td { border:1px solid var(--border-2); padding:6px 10px; text-align:left; }
  .msg th { background:#0e0f12; font-weight:600; }
  .msg strong { font-weight:650; }

  #composerWrap { padding:8px 16px 16px; }
  #composer { max-width:768px; margin:0 auto; background:var(--surface); border:1px solid var(--border-2); border-radius:20px; padding:10px 10px 8px 16px; transition:border-color .15s, box-shadow .15s; }
  #composer:focus-within { border-color:var(--accent); box-shadow:0 0 0 3px rgba(47,158,99,.12); }
  #input { display:block; width:100%; resize:none; min-height:24px; max-height:200px; padding:2px 0; border:0; background:transparent; color:var(--text); font-size:15px; line-height:1.55; font-family:inherit; }
  #input:focus { outline:none; }
  #composerBar { display:flex; align-items:center; gap:8px; margin-top:6px; }
  #composerSpacer { flex:1; }
  #hint { font-size:11px; color:#636973; }
  #mode { padding:7px 10px; border-radius:9px; border:1px solid var(--border-2); background:var(--surface-2); color:#c9ccd3; font-size:12.5px; max-width:170px; }
  #send { width:36px; height:36px; padding:0; border-radius:50%; background:var(--accent-2); color:#fff; display:flex; align-items:center; justify-content:center; border:0; cursor:pointer; transition:background .15s, transform .05s; }
  #send:disabled { opacity:.35; cursor:default; }
  #send:hover:not(:disabled) { background:var(--accent); }
  #send:active:not(:disabled) { transform:scale(.94); }
  .hidden { display:none !important; }
</style>
</head>
<body>
<header>
  <div class="avatar">${initial}</div>
  <div class="hmeta">
    <b>${label}</b>
    <span class="hsub"><span class="live"></span>Shared session</span>
  </div>
  <span id="presence"></span>
</header>

<div id="request" class="pane">
  <div class="card">
    <div class="big">${initial}</div>
    <h1>Join this session</h1>
    <p>Chat with <b>${label}</b>. Enter your name so the host knows who is asking to join.</p>
    <input id="name" type="text" maxlength="40" placeholder="Your name" autocomplete="name" />
    <div id="reqErr" style="color:#f87171;font-size:13px;min-height:16px"></div>
    <button id="reqBtn" class="btn">Request to join</button>
  </div>
</div>

<div id="waiting" class="pane hidden">
  <div class="card">
    <div class="spinner"></div>
    <h1>Waiting for the host…</h1>
    <p>The host is deciding whether to let you in. Keep this tab open.</p>
  </div>
</div>

<div id="gate" class="pane hidden">
  <div class="card">
    <div class="big">#</div>
    <h1>Enter the 6-digit code</h1>
    <p>The host approved you. Ask them for the code showing in their app — it verifies automatically.</p>
    <input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="••••••" />
    <div id="err"></div>
  </div>
</div>

<div id="chat">
  <div id="log"><div id="logInner"></div></div>
  <div id="composerWrap">
    <div id="composer">
      <textarea id="input" rows="1" placeholder="Message the agent…"></textarea>
      <div id="composerBar">
        <select id="mode" class="hidden" title="Agent mode"></select>
        <span id="hint">Enter to send · Shift+Enter for newline</span>
        <span id="composerSpacer"></span>
        <button id="send" aria-label="Send message" title="Send">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>
        </button>
      </div>
    </div>
  </div>
</div>

<div id="banner" class="pane hidden"></div>

<script>
(function(){
  var proto = location.protocol === "https:" ? "wss:" : "ws:";
  var ws, memberId = null, ended = false;
  var $ = function(id){ return document.getElementById(id); };
  var panes = ["request","waiting","gate","chat","banner"];
  function only(id){ panes.forEach(function(p){ var el=$(p); if(p===id){ el.classList.remove("hidden"); el.style.display="flex"; } else { el.classList.add("hidden"); } }); }

  // ---- safe markdown (escape first, then format; never inject raw HTML) ----
  var BT = String.fromCharCode(96);
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
  function inline(s){
    var codeRe = new RegExp(BT+"([^"+BT+"]+)"+BT,"g");
    s = s.replace(codeRe, function(_,c){ return "<code>"+c+"</code>"; });
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>");
    s = s.replace(/(^|[^*])\\*([^*\\n]+)\\*(?!\\*)/g,"$1<em>$2</em>");
    s = s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/(^|[\\s(])((https?:\\/\\/)[^\\s<)]+)/g,'$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    return s;
  }
  function isTableSep(line){ return /^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)+\\|?\\s*$/.test(line); }
  function splitRow(line){ var t=line.trim().replace(/^\\|/,"").replace(/\\|$/,""); return t.split("|").map(function(c){return c.trim();}); }
  function renderMarkdown(src){
    var BTBT = BT+BT+BT;
    var lines = esc(String(src==null?"":src)).split("\\n");
    var out=[], i=0;
    while(i<lines.length){
      var line=lines[i];
      // code fence
      if(line.indexOf(BTBT)===0){
        var buf=[]; i++;
        while(i<lines.length && lines[i].indexOf(BTBT)!==0){ buf.push(lines[i]); i++; }
        i++; out.push("<pre><code>"+buf.join("\\n")+"</code></pre>"); continue;
      }
      // heading
      var h=line.match(/^(#{1,6})\\s+(.*)$/);
      if(h){ out.push("<h3>"+inline(h[2])+"</h3>"); i++; continue; }
      // table
      if(line.indexOf("|")>=0 && i+1<lines.length && isTableSep(lines[i+1])){
        var head=splitRow(line); i+=2; var rows=[];
        while(i<lines.length && lines[i].indexOf("|")>=0 && lines[i].trim()){ rows.push(splitRow(lines[i])); i++; }
        var th="<tr>"+head.map(function(c){return "<th>"+inline(c)+"</th>";}).join("")+"</tr>";
        var tb=rows.map(function(r){return "<tr>"+r.map(function(c){return "<td>"+inline(c)+"</td>";}).join("")+"</tr>";}).join("");
        out.push("<table><thead>"+th+"</thead><tbody>"+tb+"</tbody></table>"); continue;
      }
      // lists
      if(/^\\s*([-*+])\\s+/.test(line)){
        var items=[];
        while(i<lines.length && /^\\s*([-*+])\\s+/.test(lines[i])){ items.push("<li>"+inline(lines[i].replace(/^\\s*[-*+]\\s+/,""))+"</li>"); i++; }
        out.push("<ul>"+items.join("")+"</ul>"); continue;
      }
      if(/^\\s*\\d+\\.\\s+/.test(line)){
        var oi=[];
        while(i<lines.length && /^\\s*\\d+\\.\\s+/.test(lines[i])){ oi.push("<li>"+inline(lines[i].replace(/^\\s*\\d+\\.\\s+/,""))+"</li>"); i++; }
        out.push("<ol>"+oi.join("")+"</ol>"); continue;
      }
      // blank
      if(!line.trim()){ i++; continue; }
      // paragraph (gather until blank/block)
      var para=[line]; i++;
      while(i<lines.length && lines[i].trim() && lines[i].indexOf(BTBT)!==0 && !/^(#{1,6})\\s/.test(lines[i]) && !/^\\s*([-*+]|\\d+\\.)\\s/.test(lines[i])){ para.push(lines[i]); i++; }
      out.push("<p>"+inline(para.join("<br>"))+"</p>");
    }
    return out.join("");
  }

  function connect(){
    ws = new WebSocket(proto + "//" + location.host + "/guest");
    ws.onmessage = function(ev){
      var m; try { m = JSON.parse(ev.data); } catch(e){ return; }
      if (m.t === "pending") { only("waiting"); }
      else if (m.t === "approved") { only("gate"); $("code").focus(); }
      else if (m.t === "rejected") { end(m.reason || "The host declined the request."); }
      else if (m.t === "pair_result") {
        pairing = false;
        if (m.ok) { memberId = m.memberId; only("chat"); $("input").focus(); }
        else { $("err").textContent = m.error || "Incorrect code."; $("code").value=""; $("code").focus(); }
      }
      else if (m.t === "transcript") { renderTranscript(m.rows||[]); }
      else if (m.t === "presence") { renderPresence(m.members||[]); }
      else if (m.t === "modes") { renderModes(m); }
      else if (m.t === "error") { showError(m.message); }
      else if (m.t === "ended") { end(m.reason || "The session has ended."); }
    };
    ws.onclose = function(){ if(!ended) end("Disconnected."); };
    ws.onerror = function(){};
  }
  function end(reason){ ended = true; $("banner").innerHTML = '<div class="card"><div class="big">✕</div><h1>Session ended</h1><p>'+esc(reason)+'</p></div>'; only("banner"); }

  var lastRenderJson = "";
  function avText(role){ return role==="user"?"You".slice(0,1):"◆"; }
  function nameText(role){ return role==="user"?"You":role==="assistant"?"Agent":role==="error"?"Error":""; }
  function renderTranscript(rows){
    var json = JSON.stringify(rows);
    if (json === lastRenderJson) return;
    lastRenderJson = json;
    var log = $("log");
    var atBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 100;
    var inner = $("logInner");
    inner.innerHTML = "";
    (rows||[]).forEach(function(r){
      if (r.role === "tool") { var t=document.createElement("div"); t.className="tool"; t.textContent=r.text||""; inner.appendChild(t); return; }
      var turn=document.createElement("div"); turn.className="turn "+(r.role||"assistant");
      var av=document.createElement("div"); av.className="av"; av.textContent=avText(r.role); turn.appendChild(av);
      var wrap=document.createElement("div"); wrap.className="bubblewrap";
      var nm=document.createElement("div"); nm.className="name"; nm.textContent=nameText(r.role); wrap.appendChild(nm);
      var d=document.createElement("div"); d.className="msg";
      if (r.role === "assistant") d.innerHTML = renderMarkdown(r.text||""); else d.textContent = r.text||"";
      wrap.appendChild(d); turn.appendChild(wrap); inner.appendChild(turn);
    });
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  function showError(msg){
    var inner=$("logInner"); if(!inner)return;
    var turn=document.createElement("div"); turn.className="turn error";
    var av=document.createElement("div"); av.className="av"; av.textContent="!"; turn.appendChild(av);
    var wrap=document.createElement("div"); wrap.className="bubblewrap";
    var d=document.createElement("div"); d.className="msg"; d.textContent=msg||"Something went wrong."; wrap.appendChild(d);
    turn.appendChild(wrap); inner.appendChild(turn); scroll();
  }
  function scroll(){ var l=$("log"); l.scrollTop=l.scrollHeight; }
  function renderPresence(members){
    var others = (members||[]).filter(function(x){ return x.memberId !== memberId; });
    var typing = others.filter(function(x){ return x.typing; }).map(function(x){ return x.label; });
    var txt = others.length ? (others.length+(others.length===1?" other viewing":" others viewing")) : "";
    if (typing.length) txt = typing.join(", ")+" typing…";
    $("presence").textContent = txt;
  }

  $("reqBtn").onclick = function(){
    var name = ($("name").value||"").trim().slice(0,40);
    $("reqBtn").disabled = true;
    if (!ws || ws.readyState !== 1) { connect(); setTimeout(function(){ ws.send(JSON.stringify({t:"request",name:name})); }, 300); }
    else ws.send(JSON.stringify({t:"request",name:name}));
  };
  var pairing = false;
  $("code").addEventListener("input", function(){
    var digits = ($("code").value||"").replace(/\\D/g,"").slice(0,6);
    if ($("code").value !== digits) $("code").value = digits;
    if (digits.length > 0) $("err").textContent = "";
    if (digits.length === 6 && !pairing && ws && ws.readyState === 1) { pairing = true; ws.send(JSON.stringify({t:"pair",code:digits})); }
  });
  $("name").addEventListener("keydown", function(e){ if(e.key==="Enter") $("reqBtn").click(); });

  var typingTimer=null;
  function autoGrow(){ var el=$("input"); el.style.height="auto"; el.style.height=Math.min(el.scrollHeight,200)+"px"; }
  function refreshSend(){ $("send").disabled = !$("input").value.trim(); }
  $("input").addEventListener("input", function(){
    autoGrow(); refreshSend();
    if(!ws||ws.readyState!==1)return;
    ws.send(JSON.stringify({t:"typing",typing:true}));
    if(typingTimer)clearTimeout(typingTimer);
    typingTimer=setTimeout(function(){ ws.send(JSON.stringify({t:"typing",typing:false})); },1500);
  });
  function sendMsg(){ var text=$("input").value.trim(); if(!text||!ws||ws.readyState!==1)return; ws.send(JSON.stringify({t:"prompt",text:text})); $("input").value=""; autoGrow(); refreshSend(); ws.send(JSON.stringify({t:"typing",typing:false})); }
  $("send").onclick = sendMsg;
  $("input").addEventListener("keydown", function(e){ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); sendMsg(); }});
  refreshSend();

  function renderModes(m){
    var sel = $("mode");
    if (!m.allowed || !(m.modes||[]).length) { sel.classList.add("hidden"); return; }
    sel.innerHTML = "";
    (m.modes||[]).forEach(function(mode){
      var o=document.createElement("option"); o.value=mode.id; o.textContent=mode.label;
      if (mode.id === m.currentModeId) o.selected = true; sel.appendChild(o);
    });
    sel.classList.remove("hidden");
  }
  $("mode").addEventListener("change", function(){
    if(!ws||ws.readyState!==1)return;
    ws.send(JSON.stringify({t:"set_mode",modeId:$("mode").value}));
  });

  only("request");
  connect();
})();
</script>
</body>
</html>`;
}
