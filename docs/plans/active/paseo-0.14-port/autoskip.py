import json,re
d=json.load(open('/tmp/port-scripts/scan.json'))
skip=[];keep=[]
R=re.compile(r'(website|lockfile signatures|chore\(release\)|^release:|^docs|changelog|store screenshots|store\)|^test\(|^Featured|paseo\.sh in Simplified|sponsor|^chore: normalize|^fix\(ci\)|Make full CI|Thumbnail plugin card|count a plugin install|plugin search term typed while the website|Clarify maintainer)',re.I)
for c in d:
    if R.search(c['subj']) or c['nmain']==0: skip.append(c)
    else: keep.append(c)
print(len(skip),len(keep))
json.dump([c['sha'] for c in keep],open('/tmp/port-scripts/keep.json','w'))
for c in skip: print('SKIP',c['sha'],c['subj'][:90])
