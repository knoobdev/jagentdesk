import json, re, collections
scan={c['sha']:c for c in json.load(open('/tmp/port-scripts/scan.json'))}
order=[c['sha'] for c in json.load(open('/tmp/port-scripts/scan.json'))]
ann={}
for l in open('/tmp/port-scripts/ann.txt'):
    if l.strip():
        s,a,r,n=l.rstrip('\n').split('|',3); ann[s]=(a,r,n)
seq=json.load(open('/tmp/port-scripts/seq.json'))
batches=[(l.split()[0],l.split()[1:]) for l in open('/tmp/port-scripts/batches.txt') if l.strip()]
AREAS=[('CLA','Agents: Claude'),('CDX','Agents: Codex'),('OC','Agents: OpenCode'),('OMP','Agents: Oh My Pi (OMP)'),('PI','Agents: Pi'),('ACP','Agents: ACP / Cursor / Copilot'),('PRV','Providers: catalog, config, plugin providers'),('SUBA','Agent orchestration: subagents, agent-to-agent, notifications'),('PLG','Plugins (SDK, host, registry)'),('USG','Usage / quotas'),('CHAT','Chat / timeline'),('MD','Markdown rendering'),('CMP','Composer'),('CC','Command Center'),('SBR','Sidebar / navigation'),('MOB','Mobile / tablet layout'),('SET','Settings'),('UI','Shared UI components'),('I18N','Localization'),('KBD','Keyboard shortcuts'),('FILES','Files / Explorer / downloads'),('GIT','Git / Changes / worktrees / PRs'),('WS','Workspaces / scripts / services / setup'),('TERM','Terminal'),('VOICE','Voice / dictation'),('DMN','Daemon / server robustness'),('PERF','Performance (app + daemon)'),('CLI','CLI'),('PROTO','Protocol / client SDK'),('HOST','Hosts / connections / pairing / relay'),('SCHED','Schedules'),('BRW','Desktop browser automation'),('DESK','Desktop shell'),('NOTIF','Notifications'),('HL','Syntax highlighting'),('SKILL','Skills'),('NATIVE','Native build / packaging')]
AN=dict(AREAS)
RN={'P':'PORT','A':'ADAPT','S':'SKIP','D':'DEFER','H':'HAVE'}
def pr(s):
    m=re.search(r'\(#(\d+)\)\s*$',s); return '#'+m.group(1) if m else '-'
def title(s): return re.sub(r'\s*\(#\d+\)\s*$','',s).replace('|','/')
def ab(p):
    for a,b in [('packages/app/src/','app:'),('packages/server/src/server/','srv:'),('packages/server/src/','srvsrc:'),('packages/protocol/src/','proto:'),('packages/client/src/','client:'),('packages/cli/src/','cli:'),('packages/desktop/src/','desk:'),('packages/plugin/src/','plugin:'),('packages/highlight/src/','hl:')]:
        if p.startswith(a): return b+p[len(a):]
    return p
def files(c,n=3):
    m=[x for x in c['main'] if not re.search(r'(\.test\.|e2e|test-utils|fixture|/i18n/)',x[0])]
    s=', '.join('`'+ab(x[0])+'`' for x in m[:n]); 
    if len(m)>n: s+=f' +{len(m)-n}'
    return s or '-'
def codes(c):
    cnt=collections.Counter(x[2] for x in c['main']); return ' '.join(f'{k}{v}' for k,v in sorted(cnt.items())) or '-'
L=[]
w=L.append
cnt=collections.Counter(v[1] for v in ann.values())
autoskip=[s for s in order if s not in ann]
# categorize autoskip
def cat(s):
    t=scan[s]['subj']
    if re.search(r'lockfile signatures',t): return 'lockfile/Nix hash bot'
    if re.search(r'chore\(release\)|^release:|changelog|docs\(release\)',t,re.I): return 'release cut / changelog'
    if re.search(r'website|Featured|plugin gallery|What.s new plugins|sponsor|thanks page|Hub access FAQ|Hub plan|paseo\.sh|Report a bug button|Vercel Sandbox|landing|plugin install once|Thumbnail plugin|search term typed|gallery cards|first listing',t,re.I): return 'website / marketing'
    if re.search(r'^docs|skill',t,re.I): return 'docs / Paseo skill text'
    if re.search(r'^test|ci\b|CI |Playwright|^fix\(ci\)|^chore\(ci\)|NODE_ENV|typechecking after Expo|Cover child|Check generated IDs',t,re.I): return 'tests / CI'
    if re.search(r'nix',t,re.I): return 'Nix packaging'
    if re.search(r'store',t,re.I): return 'store screenshots'
    return 'other'
ac=collections.defaultdict(list)
for s in autoskip: ac[cat(s)].append(s)
open('/tmp/port-scripts/autoskip-cats.json','w').write(json.dumps(ac))
json.dump({'cnt':cnt,'auto':len(autoskip)},open('/tmp/port-scripts/counts.json','w'))
# area tables
for code,name in AREAS:
    rows=[s for s in order if s in ann and ann[s][0]==code]
    if not rows: continue
    c2=collections.Counter(ann[s][1] for s in rows)
    w(f"\n### {name} ({len(rows)}: " + ', '.join(f"{RN[k]} {c2[k]}" for k in 'PAHDS' if c2[k]) + ")\n")
    w("| sha | PR | Upstream change | Main files | Apply | Rec | JAgentDesk status / risk / reason |")
    w("|---|---|---|---|---|---|---|")
    for s in rows:
        c=scan[s]; a,r,n=ann[s]
        w(f"| `{s}` | {pr(c['subj'])} | {title(c['subj'])} | {files(c)} | {codes(c)} | **{RN[r]}** | {n} |")
open('/tmp/port-scripts/area-tables.md','w').write('\n'.join(L))
# autoskip section
L2=[]
for k,v in sorted(ac.items(), key=lambda kv:-len(kv[1])):
    L2.append(f"- **{k}** ({len(v)}): " + ', '.join(f"`{s}`" for s in v))
open('/tmp/port-scripts/autoskip.md','w').write('\n'.join(L2))
# batch file summaries
L3={}
for b,shas in batches:
    fl=collections.OrderedDict()
    for s in shas:
        for x in scan[s]['main']:
            if re.search(r'(\.test\.|e2e|test-utils|fixture|/i18n/resources/(?!en))',x[0]): continue
            p=x[0].replace('paseo','jagentdesk').replace('Paseo','JAgentDesk')
            fl[ab(p)]=1
    res=seq[b]
    fails=collections.OrderedDict()
    for sha,ok,bad in res:
        for y in bad:
            if '(test)' in y: continue
            fails.setdefault(y,[]).append(sha)
    applied=sum(r[1] for r in res)
    L3[b]=dict(files=list(fl), applied=applied, fails={k:v for k,v in fails.items()}, recs=[ann[s][1] for s in shas])
json.dump(L3,open('/tmp/port-scripts/batchinfo.json','w'),indent=1)
print(cnt, len(autoskip), {k:len(v) for k,v in ac.items()})
