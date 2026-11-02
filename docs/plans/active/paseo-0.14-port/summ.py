import json,collections
d=json.load(open('/tmp/port-scripts/scan.json'))
def ab(p):
    return p.replace('packages/app/src/','app:').replace('packages/server/src/server/','srv:').replace('packages/server/src/','srvsrc:').replace('packages/protocol/src/','proto:').replace('packages/client/src/','client:').replace('packages/cli/src/','cli:').replace('packages/desktop/src/','desk:').replace('packages/plugin/src/','plugin:')
for c in d:
    cnt=collections.Counter(x[2] for x in c['main'])
    codes=' '.join(f'{k}{v}' for k,v in sorted(cnt.items()))
    st=c['stat'].replace(' files changed','f').replace(' file changed','f').replace(' insertions(+)','+').replace(' insertion(+)','+').replace(' deletions(-)','-').replace(' deletion(-)','-')
    files=', '.join(ab(x[0]) for x in c['main'][:4])+(f' +{c["nmain"]-4}' if c['nmain']>4 else '')
    print(f"{c['sha']}|{c['subj'][:110]}|{st}|{codes}|{files}")
