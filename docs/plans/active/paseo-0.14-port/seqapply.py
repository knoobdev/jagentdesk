import subprocess, re, os, sys, json
UP="/Users/ngocchanh/Project/private/organisations/hdc/paseo-upstream"
W="/tmp/jd-seq"
def sh(a,cwd=UP,inp=None):
    r=subprocess.run(a,cwd=cwd,input=inp,capture_output=True); return r.returncode,r.stdout.decode('utf-8','replace'),r.stderr.decode('utf-8','replace')
def rb(s): return s.replace('@getpaseo','@jagentdesk').replace('PASEO','JAGENTDESK').replace('Paseo','JAgentDesk').replace('paseo','jagentdesk')
EXC=re.compile(r'(^docs/|^public-docs/|\.md$|CHANGELOG|package-lock\.json|^nix/|^packages/website/|^\.github/|/i18n/resources/(?!en\.ts)|^fastlane/)')
out={}
for line in open('/tmp/port-scripts/batches.txt'):
    p=line.split(); b=p[0]; res=[]
    for sha in p[1:]:
        _,ns,_=sh(['git','show','--format=','--name-only',sha])
        files=[f for f in ns.split('\n') if f and not EXC.search(f)]
        ok=0; bad=[]
        for f in files:
            _,patch,_=sh(['git','show','--format=','--binary',sha,'--',f])
            if not patch.strip(): continue
            patch=rb(patch)
            c,_,e=sh(['git','apply','-'],cwd=W,inp=patch.encode())
            if c==0: ok+=1
            else:
                c2,_,_=sh(['git','apply','--check','-R','-'],cwd=W,inp=patch.encode())
                bad.append(('R:' if c2==0 else '')+f.replace('packages/','').split('/')[-1] + (' (test)' if re.search(r'\.test\.|e2e|test-utils|fixture',f) else ''))
        res.append((sha,ok,bad))
    out[b]=res
    tot=sum(r[1] for r in res); nb=sum(len([x for x in r[2] if '(test)' not in x]) for r in res); nbt=sum(len([x for x in r[2] if '(test)' in x]) for r in res)
    print(f"{b}: commits={len(res)} files_applied={tot} src_fail={nb} test_fail={nbt}")
json.dump(out,open('/tmp/port-scripts/seq.json','w'))
