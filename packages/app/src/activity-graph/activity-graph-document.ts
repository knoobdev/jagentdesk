import {
  ACTIVITY_GRAPH_SELECT_MESSAGE,
  ACTIVITY_GRAPH_STATUS_MESSAGE,
  type ActivityGraphNodeStatus,
} from "@jagentdesk/protocol/agent-activity-graph";
import {
  buildArchifyDocument,
  type ArchifyColorScheme,
} from "@/screens/agent-forum-archify/archify-document";

// Frame document for the agent activity graph (spec 31.3, 31.6): the daemon-rendered archify HTML
// inside the ADR-0021 sandbox (same CSP and shims as Team mode), plus
//   - a status overlay: `data-jad-status` on every `[data-node-id]`, painted with the design-system
//     status colors (docs/reference/paseo-design-system.md §1.4) and updated by message without
//     reloading the frame;
//   - a camera that keeps the graph at a readable size inside a scrollable canvas, with Fit, zoom
//     (archify's own zoom buttons, re-enabled) and pinch zoom on touch screens;
//   - exactly one outbound message, `jad-archify-select { nodeId }`, when a node is clicked.

// Message the app posts into the frame to drive the camera.
export const ACTIVITY_GRAPH_VIEW_MESSAGE = "jad-archify-view";

export type ActivityGraphViewAction = "fit" | "zoom-in" | "zoom-out" | "focus";

export interface ActivityGraphPalette {
  surface0: string;
  surface1: string;
  surface2: string;
  foreground: string;
  foregroundMuted: string;
  foregroundExtraMuted: string;
  border: string;
}

export interface ActivityGraphDocumentOptions {
  html: string;
  colorScheme: ArchifyColorScheme;
  palette: ActivityGraphPalette;
  statuses: readonly { id: string; status: ActivityGraphNodeStatus }[];
  // Node the camera centers on after load (the selected node, else the running one).
  focusNodeId: string | null;
  // Scale the reader last chose with Fit/zoom; null = readable default.
  scale: number | null;
  fit: boolean;
}

// docs/reference/paseo-design-system.md §1.4 (status dots: amber/red/blue/green 500).
export const ACTIVITY_STATUS_COLORS = {
  running: "#3b82f6",
  waiting: "#f59e0b",
  failed: "#ef4444",
  done: "#22c55e",
} as const;

function statusCss(palette: ActivityGraphPalette): string {
  const card = (status: string, stroke: string, fill: string) =>
    `[data-node-id][data-jad-status="${status}"]>rect:not(.c-mask){stroke:${stroke} !important;fill:${fill} !important;stroke-width:1.75px !important}` +
    `[data-node-id][data-jad-status="${status}"] text[data-detail="fine"]{fill:${stroke} !important}`;
  return [
    // App surfaces instead of archify's own navy, so the canvas sits inside the chat screen.
    `:root,[data-theme="dark"],[data-theme="light"]{--bg:${palette.surface0} !important;--mask:${palette.surface1} !important;--panel-border:${palette.border} !important;--text:${palette.foreground} !important;--text-muted:${palette.foregroundMuted} !important;--text-dim:${palette.foregroundExtraMuted} !important;--arrow:${palette.foregroundExtraMuted} !important;--canvas-dot:color-mix(in srgb, ${palette.foregroundExtraMuted} 22%, transparent) !important;--toolbar-bg:${palette.surface1} !important;--toolbar-border:${palette.border} !important;--toolbar-text:${palette.foreground} !important}`,
    `html,body{height:100% !important;overflow:hidden !important;background:${palette.surface0} !important}`,
    'html[data-jad-embed="true"] .container{max-width:none !important;margin:0 !important;padding:0 !important}',
    'html[data-jad-embed="true"] .diagram-container{position:relative !important;display:block !important;height:100vh !important;max-height:none !important;overflow:auto !important;padding:24px !important;box-sizing:border-box !important;scroll-behavior:auto !important;background-color:var(--bg) !important;touch-action:pan-x pan-y !important;-webkit-overflow-scrolling:touch}',
    'html[data-jad-embed="true"] .diagram-container>svg{display:block !important;flex:none !important;max-width:none !important;min-width:0 !important;min-height:0 !important;margin:0 auto !important;transform:none !important;transition:none !important}',
    'html[data-jad-embed="true"] .reader-rail{display:none !important}',
    // The graph re-renders as the agent works; archify's trace pass would replay on every render.
    "[data-animate]{animation:none !important}",
    // archify's zoom stepper stays (spec 31.4, mobile); its other tools are hidden in the embed.
    'html[data-jad-embed="true"] .diagram-nav{display:flex !important;position:fixed !important;right:12px !important;bottom:12px !important;left:auto !important;top:auto !important;transform:none !important;z-index:5 !important}',
    'html[data-jad-embed="true"] .diagram-nav>*:not(.diagram-nav-group):not([data-view]){display:none !important}',
    'html[data-jad-embed="true"] .diagram-nav button:not([data-view]){display:none !important}',
    // Node statuses (spec 31.3).
    card("done", ACTIVITY_STATUS_COLORS.done, "color-mix(in srgb, #22c55e 10%, var(--mask))"),
    card("running", ACTIVITY_STATUS_COLORS.running, "color-mix(in srgb, #3b82f6 16%, var(--mask))"),
    card("waiting", ACTIVITY_STATUS_COLORS.waiting, "color-mix(in srgb, #f59e0b 14%, var(--mask))"),
    card("failed", ACTIVITY_STATUS_COLORS.failed, "color-mix(in srgb, #ef4444 14%, var(--mask))"),
    // Overlay fills are dark/light tints, so labels use the theme text color (the tree root's own
    // label is drawn for archify's filled accent card otherwise).
    `[data-node-id][data-jad-status] text[data-node-label]{fill:var(--text) !important}`,
    `[data-node-id][data-jad-status="pending"]>rect:not(.c-mask){stroke:${palette.foregroundMuted} !important;stroke-dasharray:5 4 !important;fill:var(--mask) !important;stroke-width:1.25px !important}`,
    `[data-node-id][data-jad-status="pending"] text{opacity:0.82}`,
    `[data-node-id][data-jad-status="pending"] text[data-detail="fine"]{fill:${palette.foregroundMuted} !important}`,
    // Soft edge fades only on the sides with more graph to pan to.
    'html[data-jad-more-left="true"] .diagram-container{-webkit-mask-image:linear-gradient(to right,transparent 0,#000 40px,#000 100%);mask-image:linear-gradient(to right,transparent 0,#000 40px,#000 100%)}',
    'html[data-jad-more-right="true"] .diagram-container{-webkit-mask-image:linear-gradient(to left,transparent 0,#000 40px,#000 100%);mask-image:linear-gradient(to left,transparent 0,#000 40px,#000 100%)}',
    'html[data-jad-more-left="true"][data-jad-more-right="true"] .diagram-container{-webkit-mask-image:linear-gradient(to right,transparent 0,#000 40px,#000 calc(100% - 40px),transparent 100%);mask-image:linear-gradient(to right,transparent 0,#000 40px,#000 calc(100% - 40px),transparent 100%)}',
    "@keyframes jad-running-pulse{0%,100%{stroke-opacity:1;stroke-width:1.75px}50%{stroke-opacity:.35;stroke-width:3px}}",
    '[data-node-id][data-jad-status="running"]>rect:not(.c-mask){animation:jad-running-pulse 1.6s ease-in-out infinite !important}',
    '@media (prefers-reduced-motion: reduce){[data-node-id][data-jad-status="running"]>rect:not(.c-mask){animation:none !important}}',
    `[data-node-id][data-jad-selected="true"]>rect.c-mask{stroke:${palette.foreground} !important;stroke-width:1px !important;stroke-opacity:.55}`,
    "[data-node-id]{cursor:pointer}",
    `[data-node-id]:focus{outline:none}`,
  ].join("\n");
}

// Runs inside the sandbox. Statuses arrive from the parent window (web/Electron iframe) or are
// injected (iOS/Android WebView) through window.__jadActivity.
function activityScript(options: ActivityGraphDocumentOptions): string {
  const initial = {
    statuses: options.statuses,
    focus: options.focusNodeId,
    scale: options.scale,
    fit: options.fit,
  };
  return `(function(){
var initial=${JSON.stringify(initial).replace(/</g, "\\u003c")};
var SELECT=${JSON.stringify(ACTIVITY_GRAPH_SELECT_MESSAGE)};
var STATUS=${JSON.stringify(ACTIVITY_GRAPH_STATUS_MESSAGE)};
var VIEW=${JSON.stringify(ACTIVITY_GRAPH_VIEW_MESSAGE)};
var VALID={pending:1,running:1,waiting:1,failed:1,done:1};
var container=document.querySelector(".diagram-container");
var svg=container&&container.querySelector("svg");
if(!container||!svg)return;
var vb=svg.viewBox&&svg.viewBox.baseVal;
var vbW=vb&&vb.width?vb.width:svg.getBoundingClientRect().width||1;
var vbH=vb&&vb.height?vb.height:svg.getBoundingClientRect().height||1;
var MIN=0.1,MAX=2.5,MAX_READABLE=1.6,PAD=20;
var scale=1;
function nodeEl(id){return svg.querySelector('[data-node-id="'+String(id).replace(/["\\\\]/g,"")+'"]');}
function applyStatuses(list){
if(!list||!list.length)return;
for(var i=0;i<list.length;i++){var e=list[i];
if(!e||typeof e.id!=="string"||!VALID[e.status])continue;
var el=nodeEl(e.id);if(el)el.setAttribute("data-jad-status",e.status);}}
function percent(){var p=document.querySelector("[data-view-percent]");var text=Math.round(scale*100)+"%";if(p&&p.textContent!==text)p.textContent=text;}
// archify re-renders its own zoom label from its (unused) camera; keep showing this camera's scale.
var percentEl=document.querySelector("[data-view-percent]");
if(percentEl&&typeof MutationObserver==="function")new MutationObserver(percent).observe(percentEl,{childList:true,characterData:true,subtree:true});
function size(next){
scale=Math.max(MIN,Math.min(MAX,next));
svg.style.setProperty("width",(vbW*scale)+"px","important");
svg.style.setProperty("height",(vbH*scale)+"px","important");
// A graph shorter than the canvas sits in its vertical middle.
var spare=container.clientHeight-PAD*2-vbH*scale;
svg.style.setProperty("margin-top",(spare>0?spare/2:0)+"px","important");
percent();}
function fitScale(){
var w=Math.max(1,container.clientWidth-PAD*2),h=Math.max(1,container.clientHeight-PAD*2);
return Math.max(MIN,Math.min(1.25,Math.min(w/vbW,h/vbH)));}
// Zoom keeping the content point under (cx, cy) (default: the canvas center) in place.
function zoomAt(next,cx,cy){
var rect=container.getBoundingClientRect();
var px=cx===undefined?rect.left+rect.width/2:cx,py=cy===undefined?rect.top+rect.height/2:cy;
var before=svg.getBoundingClientRect();
var lx=(px-before.left)/scale,ly=(py-before.top)/scale;
size(next);
var after=svg.getBoundingClientRect();
container.scrollLeft+=after.left+lx*scale-px;container.scrollTop+=after.top+ly*scale-py;}
function center(id){
var el=id?nodeEl(id):null;if(!el)return false;
var r=el.getBoundingClientRect(),c=container.getBoundingClientRect();
if(!r.width&&!r.height)return false;
container.scrollLeft+=r.left+r.width/2-(c.left+c.width/2);
container.scrollTop+=r.top+r.height/2-(c.top+c.height/2);return true;}
function fit(){size(fitScale());container.scrollLeft=0;container.scrollTop=0;edges();}
function edges(){
var root=document.documentElement,max=container.scrollWidth-container.clientWidth;
root.setAttribute("data-jad-more-left",container.scrollLeft>2?"true":"false");
root.setAttribute("data-jad-more-right",container.scrollLeft<max-2?"true":"false");}
container.addEventListener("scroll",edges,{passive:true});
function view(action,nodeId){
if(action==="fit")fit();
else if(action==="zoom-in")zoomAt(Math.round((scale+0.25)*4)/4);
else if(action==="zoom-out")zoomAt(Math.max(MIN,Math.round((scale-0.25)*4)/4||scale/2));
else if(action==="focus")center(nodeId);}
function select(id){
var prev=svg.querySelector('[data-jad-selected="true"]');if(prev)prev.removeAttribute("data-jad-selected");
var el=nodeEl(id);if(el)el.setAttribute("data-jad-selected","true");
var message={type:SELECT,nodeId:String(id)};
if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(JSON.stringify(message));return;}
if(window.parent&&window.parent!==window)window.parent.postMessage(message,"*");}
// Node clicks select; archify's own focus mode (dimming, camera moves) is not used inside the
// panel, so its pointer/focus handlers never see the event.
function nodeOf(event){return event.target&&event.target.closest?event.target.closest("[data-node-id]"):null;}
function swallow(event){if(!nodeOf(event))return;event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();}
["pointerdown","mousedown","pointerup","mouseup","dblclick","focusin"].forEach(function(type){svg.addEventListener(type,swallow,true);});
svg.addEventListener("click",function(event){
var node=nodeOf(event);if(!node)return;
swallow(event);
select(node.getAttribute("data-node-id"));},true);
svg.addEventListener("keydown",function(event){
if(event.key!=="Enter"&&event.key!==" ")return;
var node=nodeOf(event);if(!node)return;swallow(event);select(node.getAttribute("data-node-id"));},true);
// archify's zoom buttons drive this camera instead of archify's transform.
var nav=document.querySelector(".diagram-nav");
if(nav)nav.addEventListener("click",function(event){
var button=event.target&&event.target.closest?event.target.closest("[data-view]"):null;
if(!button)return;event.preventDefault();event.stopPropagation();
var kind=button.getAttribute("data-view");
view(kind==="in"?"zoom-in":kind==="out"?"zoom-out":"fit");},true);
// Pinch zoom on touch screens (spec 31.4); one finger keeps native scrolling.
var pinch=null;
function dist(t){var dx=t[0].clientX-t[1].clientX,dy=t[0].clientY-t[1].clientY;return Math.sqrt(dx*dx+dy*dy);}
container.addEventListener("touchstart",function(event){
if(event.touches.length===2){pinch={d:dist(event.touches),s:scale};event.preventDefault();}},{passive:false});
container.addEventListener("touchmove",function(event){
if(!pinch||event.touches.length!==2)return;event.preventDefault();
var cx=(event.touches[0].clientX+event.touches[1].clientX)/2,cy=(event.touches[0].clientY+event.touches[1].clientY)/2;
zoomAt(pinch.s*dist(event.touches)/pinch.d,cx,cy);},{passive:false});
container.addEventListener("touchend",function(event){if(event.touches.length<2)pinch=null;});
// ctrl/cmd + wheel (and trackpad pinch on desktop) zooms; a plain wheel scrolls.
container.addEventListener("wheel",function(event){
if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();
zoomAt(scale*Math.exp(-event.deltaY*0.01),event.clientX,event.clientY);},{passive:false});
window.__jadActivity={status:applyStatuses,view:view};
window.addEventListener("message",function(event){
if(event.source!==window.parent)return;
var data=event.data;if(!data||typeof data!=="object")return;
if(data.type===STATUS&&Array.isArray(data.nodes))applyStatuses(data.nodes);
else if(data.type===VIEW&&typeof data.action==="string")view(data.action,typeof data.nodeId==="string"?data.nodeId:null);});
applyStatuses(initial.statuses);
// Smallest scale at which every node label renders at >= 12 px and every sublabel at >= 11 px
// (archify draws lifecycle labels at 12 px / sublabels at 9 px, tree labels at 13 px / 11 px, and
// shrinks long ones to fit their card).
function minFont(selector,fallback){
var list=svg.querySelectorAll(selector),min=Infinity;
for(var i=0;i<list.length;i++){var v=parseFloat(list[i].getAttribute("font-size"));if(v>0&&v<min)min=v;}
return min===Infinity?fallback:min;}
function readableScale(){
var label=minFont("[data-node-id] text[data-node-label]",12),sub=minFont('[data-node-id] text[data-detail="context"]',11);
return Math.min(MAX_READABLE,Math.ceil(Math.max(1,12/label,11/sub)*100)/100);}
function widthScale(){return Math.max(MIN,(container.clientWidth-PAD*2)/vbW);}
// First render and every structural re-render: the whole graph across the panel width when it is
// readable there; otherwise readable size with the focused (running) node centered, the start of
// the turn one pan away.
function start(){
if(initial.fit){fit();setTimeout(percent,250);return;}
var readable=readableScale(),wide=widthScale();
if(wide>=readable){
size(Math.min(wide,MAX_READABLE));container.scrollLeft=0;
if(!(svg.getBoundingClientRect().height>container.clientHeight&&center(initial.focus)))container.scrollTop=0;}
else{size(readable);if(!center(initial.focus)){container.scrollLeft=0;container.scrollTop=0;}}
edges();setTimeout(percent,250);}
// After archify's own load-time camera work (it settles on the next frames).
function boot(){requestAnimationFrame(function(){requestAnimationFrame(start);});}
if(document.readyState==="complete")boot();else window.addEventListener("load",boot);
})();`;
}

export function buildActivityGraphDocument(options: ActivityGraphDocumentOptions): string {
  return buildArchifyDocument(options.html, options.colorScheme, {
    css: statusCss(options.palette),
    script: activityScript(options),
  });
}
