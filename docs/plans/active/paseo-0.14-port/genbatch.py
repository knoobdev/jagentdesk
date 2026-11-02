import json, re, sys
sys.path.insert(0,'/tmp/port-scripts')
from batchmeta import META
scan={c['sha']:c for c in json.load(open('/tmp/port-scripts/scan.json'))}
ann={}
for l in open('/tmp/port-scripts/ann.txt'):
    if l.strip(): s,a,r,n=l.rstrip('\n').split('|',3); ann[s]=(a,r,n)
bi=json.load(open('/tmp/port-scripts/batchinfo.json'))
batches=[(l.split()[0],l.split()[1:]) for l in open('/tmp/port-scripts/batches.txt') if l.strip()]
RN={'P':'PORT','A':'ADAPT','S':'SKIP','D':'DEFER','H':'HAVE'}
def pr(s):
    m=re.search(r'\(#(\d+)\)\s*$',s); return ' '+'#'+m.group(1) if m else ''
L=["\n## Port order (batches)\n",
"Each batch is one coherent JAgentDesk commit. A coder agent can do it from a written story. Order: security and provider correctness first, then daemon and git, then plugin parity, then app/UI, with the high-conflict adapted batches last. Within a batch, apply the commits in the order listed (upstream order). After each batch:",
"",
"1. Rebrand every new string (`paseo`→`jagentdesk`, `Paseo`→`JAgentDesk`, `PASEO_`→`JAGENTDESK_`, `@getpaseo/`→`@jagentdesk/`) and file name (`paseo-tools.ts`→`jagentdesk-tools.ts`, `paseo.json`→`jagentdesk.json`).",
"2. Port the upstream tests in the same commits (most commits ship a `*.test.ts`).",
"3. Run `npm run typecheck` for the touched workspaces and `vitest run` on the touched folders.",
"4. Run `oxfmt` before committing (lefthook fails silently).",
"5. Bump the JAgentDesk version for daemon-side changes, so installed daemons restart.",
"6. Verify app changes in the real desktop or mobile app (CDP or `xcrun simctl`, without taking over the mouse).",
"",
"\"Sequential apply\" is the mechanical result of applying the batch's patches in order on a scratch copy of JAgentDesk HEAD, after the earlier batches: the number of files applied, and the source files that need a hand merge (test files not counted). It does not mean the batch compiles.",
"",
"| Batch | Title | Commits | Mix | Seq. apply: files applied / source files needing merge |",
"|---|---|---|---|---|"]
for b,shas in batches:
    i=bi[b]; mix={}
    for r in i['recs']: mix[RN[r]]=mix.get(RN[r],0)+1
    L.append(f"| {b} | {META[b][0]} | {len(shas)} | {', '.join(f'{k} {v}' for k,v in mix.items())} | {i['applied']} / {len(i['fails'])} |")
for b,shas in batches:
    i=bi[b]; t,verify,notes=META[b]
    L.append(f"\n### {b}: {t}\n")
    L.append("**Upstream commits (in order):**\n")
    for s in shas:
        c=scan[s]; a,r,n=ann[s]
        t2=re.sub(r" *\(#\d+\)$","",c["subj"]); L.append(f"- `{s}`{pr(c['subj'])} [{RN[r]}] {t2}")
    fl=[f for f in i['files'] if not f.startswith('plugins/') and 'i18n/resources/en.ts' not in f]
    L.append(f"\n**JAgentDesk files to touch** ({len(fl)}, paths rebranded): " + ', '.join(f'`{f}`' for f in fl[:30]) + (f" … +{len(fl)-30}" if len(fl)>30 else '') + (" (plus `app:i18n/resources/en.ts`)" if any('i18n/resources/en.ts' in f for f in i['files']) else ''))
    if i['fails']:
        L.append("\n**Needs hand merge (sequential apply):** " + '; '.join(f"`{k}` ({', '.join(v)})" for k,v in i['fails'].items()))
    else:
        L.append("\n**Sequential apply:** every source file applied cleanly.")
    L.append(f"\n**Verify:** {verify}\n\n**Notes:** {notes}")
open('/tmp/port-scripts/batches.md','w').write('\n'.join(L))
