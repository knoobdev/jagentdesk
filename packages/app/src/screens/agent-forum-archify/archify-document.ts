// Wraps the archify HTML the daemon rendered (spec 23.4, ADR-0021 §4) for the sandboxed ARCH-tab
// frame. The document is agent-authored data rendered by archify, so it gets the file-pane preview
// treatment: an opaque-origin frame (iframe sandbox="allow-scripts" / locked-down WebView) plus a
// Content Security Policy that forbids every network fetch.
//
// srcdoc has no query string, so archify's own `?theme=…&embed=1` switches are unavailable. This
// prologue supplies them instead:
//   - theme: archify resolves its theme from `prefers-color-scheme` when storage is unavailable (it
//     always is in the sandbox), so matchMedia answers that one query with the app's scheme.
//   - embed: archify's `data-embed` also disables the trace animation, which spec 23.5 wants to run
//     once and replay. `data-jad-embed` hides the same viewer chrome archify's embed mode hides and
//     leaves the Motion Governor running; shortcuts for the hidden chrome are swallowed.
// The epilogue adds a replay entry point that restarts archify's ambient trace pass.

export type ArchifyColorScheme = "light" | "dark";

// ADR-0021 §4, plus form-action/base-uri 'none' (default-src does not cover them).
export const ARCHIFY_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

// Message the host posts into the iframe to replay the trace animation.
export const ARCHIFY_REPLAY_MESSAGE = "jad-archify-replay";
// Message the frame posts to its host with the rendered content height, so the host can shrink the
// frame to fit instead of leaving an empty band under short diagrams.
export const ARCHIFY_SIZE_MESSAGE = "jad-archify-size";
// Script the native host injects into the WebView for the same purpose.
export const ARCHIFY_REPLAY_SCRIPT =
  "window.__jadArchifyReplay && window.__jadArchifyReplay(); true;";

const EMBED_CSS = [
  'html[data-jad-embed="true"] body{min-height:0 !important;padding:0 !important;background-image:none !important}',
  [
    ".toolbar",
    ".header",
    ".cards",
    ".diagram-nav",
    ".overview-map",
    ".focus-chip",
    ".route-probe",
    ".semantic-lens",
    ".diagram-guide",
    ".node-finder",
    ".node-outline",
  ]
    .map((selector) => `html[data-jad-embed="true"] ${selector}`)
    .join(",") + "{display:none !important}",
  'html[data-jad-embed="true"] .container{max-width:none !important}',
  'html[data-jad-embed="true"] .diagram-container{padding:0.5rem !important;border:0 !important;border-radius:0 !important;box-shadow:none !important}',
].join("\n");

// Shortcuts whose UI the embed hides (guide, finder, theme, style, export, stage, radar, lens,
// route). archify's global handler ignores events that are already defaultPrevented.
const HIDDEN_SHORTCUT_KEYS = "?/tTsSeEfFmMlLrR";

function prologueScript(colorScheme: ArchifyColorScheme): string {
  return `(function(){
var scheme=${JSON.stringify(colorScheme)};
var root=document.documentElement;
root.setAttribute("data-jad-embed","true");
var nativeMatch=window.matchMedia?window.matchMedia.bind(window):null;
function fixed(query,matches){return{matches:matches,media:query,onchange:null,
addEventListener:function(){},removeEventListener:function(){},addListener:function(){},
removeListener:function(){},dispatchEvent:function(){return false;}};}
window.matchMedia=function(query){
var q=String(query);
if(q.indexOf("prefers-color-scheme")!==-1){
return fixed(q,q.indexOf(scheme)!==-1);}
return nativeMatch?nativeMatch(q):fixed(q,false);};
var hidden=${JSON.stringify(HIDDEN_SHORTCUT_KEYS)};
window.addEventListener("keydown",function(e){
if(e.metaKey||e.ctrlKey||e.altKey)return;
if(e.key&&e.key.length===1&&hidden.indexOf(e.key)!==-1)e.preventDefault();},true);
})();`;
}

// Restart archify's one-shot ambient trace: drop the running state, force a style flush so the CSS
// animations restart, then settle once every animated edge/node has finished (as archify does).
// Nothing happens while archify holds the diagram still (system reduced motion).
const EPILOGUE_SCRIPT = `(function(){
var root=document.documentElement;
function replay(){
var svg=document.querySelector(".diagram-container svg");
if(!svg||svg.getAttribute("data-animation")!=="trace")return false;
if(root.getAttribute("data-motion")==="still")return false;
var animated=svg.querySelectorAll('[data-animate="edge"],[data-animate="node"]');
if(!animated.length)return false;
root.removeAttribute("data-ambient-motion");
root.removeAttribute("data-ambient-settle-reason");
void svg.getBoundingClientRect();
var pending=animated.length;
function done(event){
if(!event||!event.target||!event.target.hasAttribute||!event.target.hasAttribute("data-animate"))return;
pending-=1;
if(pending>0)return;
svg.removeEventListener("animationend",done,true);
svg.removeEventListener("animationcancel",done,true);
root.setAttribute("data-ambient-motion","settled");
root.setAttribute("data-ambient-settle-reason","complete");}
svg.addEventListener("animationend",done,true);
svg.addEventListener("animationcancel",done,true);
root.setAttribute("data-ambient-motion","running");
return true;}
window.__jadArchifyReplay=replay;
var lastHeight=0;
function reportSize(){
var body=document.body;if(!body)return;
// The root is at least the viewport tall, so measure where the content actually ends.
var h=Math.ceil(body.getBoundingClientRect().bottom+(window.scrollY||0));
if(!h||h===lastHeight)return;
lastHeight=h;
var message={type:${JSON.stringify(ARCHIFY_SIZE_MESSAGE)},height:h};
if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(JSON.stringify(message));return;}
if(window.parent&&window.parent!==window)window.parent.postMessage(message,"*");}
if(typeof ResizeObserver==="function"&&document.body){new ResizeObserver(reportSize).observe(document.body);}
window.addEventListener("load",reportSize);
reportSize();
window.addEventListener("message",function(event){
if(event.source!==window.parent)return;
var data=event.data;
if(data&&data.type===${JSON.stringify(ARCHIFY_REPLAY_MESSAGE)})replay();});
})();`;

const BOM = "﻿";

// Our doctype, then the policy (so it is always the first element of <head>), then the theme/embed
// shims, then archify's document verbatim, then the replay hook. The rendered file's own doctype
// becomes a stray token the parser ignores (see file-pane/html-preview-csp.ts for why the prologue
// is supplied rather than located).
export function buildArchifyDocument(html: string, colorScheme: ArchifyColorScheme): string {
  const body = html.startsWith(BOM) ? html.slice(BOM.length) : html;
  return [
    "<!doctype html>",
    `<meta http-equiv="Content-Security-Policy" content="${ARCHIFY_CSP}">`,
    `<script>${prologueScript(colorScheme)}</script>`,
    `<style id="jad-archify-embed">${EMBED_CSS}</style>`,
    body,
    `<script>${EPILOGUE_SCRIPT}</script>`,
  ].join("");
}
