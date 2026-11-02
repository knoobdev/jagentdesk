import subprocess, re, json, os, sys
UP="/Users/ngocchanh/Project/private/organisations/hdc/paseo-upstream"
JD="/tmp/jd-head"
def sh(args, cwd=UP, inp=None):
    r=subprocess.run(args,cwd=cwd,input=inp,capture_output=True)
    return r.returncode, r.stdout.decode('utf-8','replace'), r.stderr.decode('utf-8','replace')
def rb(s):
    s=s.replace('@getpaseo','@jagentdesk').replace('PASEO','JAGENTDESK').replace('Paseo','JAgentDesk').replace('paseo','jagentdesk')
    return s
SKIP_RE=re.compile(r'(\.test\.|\.spec\.|/e2e/|__tests__|/fixtures/|/test/|test-stubs|^docs/|^public-docs/|\.md$|CHANGELOG|package-lock\.json|^nix/|flake|\.lock$|^packages/website/|^\.github/|/i18n/resources/(?!en\.ts)|\.snap$|^scripts/release|^\.eas/|vitest\.config)')
_,log,_=sh(['git','log','--reverse','--format=%h\t%ad\t%s','--date=short','v0.10.2..v0.14.0'])
out=[]
for line in log.strip().split('\n'):
    sha,date,subj=line.split('\t',2)
    _,ns,_=sh(['git','show','--format=','--name-status','-M',sha])
    _,stat,_=sh(['git','show','--format=','--shortstat',sha])
    files=[]
    for l in ns.strip().split('\n'):
        if not l: continue
        p=l.split('\t'); st=p[0][0]; path=p[-1]; old=p[1] if st=='R' else path
        files.append((st,old,path))
    main=[f for f in files if not SKIP_RE.search(f[2])]
    res=[]
    for st,old,path in main[:40]:
        jdpath=rb(path); exists=os.path.exists(os.path.join(JD,jdpath))
        if st=='D':
            res.append((path,st,'D' if not exists else 'd')); continue
        _,patch,_=sh(['git','show','--format=','-M','--binary',sha,'--',old,path] if old!=path else ['git','show','--format=','--binary',sha,'--',path])
        patch=rb(patch)
        c,_,_=sh(['git','apply','--check','-'],cwd=JD,inp=patch.encode())
        if c==0: code='F'
        else:
            c2,_,_=sh(['git','apply','--check','-R','-'],cwd=JD,inp=patch.encode())
            if c2==0: code='R'
            elif st=='A' and exists: code='E'  # added upstream, exists in JD but differs
            elif not exists and st!='A': code='M'
            else: code='X'
        res.append((path,st,code))
    out.append(dict(sha=sha,date=date,subj=subj,nfiles=len(files),stat=stat.strip(),main=res,nmain=len(main)))
json.dump(out,open('/tmp/port-scripts/scan.json','w'),indent=0)
print(len(out))
