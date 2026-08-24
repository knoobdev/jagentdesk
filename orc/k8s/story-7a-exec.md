# MANIFEST — Story 7a: pod exec/shell (bidirectional stream) — daemon+protocol+client

Ban la CODER server+protocol+client branch k8s/s1a-kube-client. Them exec vao container theo pattern
streaming 2 chieu (start -> stdin push len + data push xuong -> close). Dung @kubernetes/client-node `Exec`.

## CAM: KHONG WebFetch. KHONG oxfmt toan repo. KHONG mock. KHONG sua file ngoai danh sach. KHONG hand-edit generated.

## CHI DUOC DOC
- `packages/protocol/src/cluster/rpc-schemas.ts` (xem cluster/logs/subscribe + chunk push da lam o S1d)
- `packages/protocol/src/messages.ts`
- `packages/server/src/server/session/cluster/cluster-session.ts` (co logSubscriptions map + teardown) + `session.ts`
- `packages/server/src/server/cluster/kube-client.ts` (them exec)
- `node_modules/@kubernetes/client-node/dist/index.d.ts` (class `Exec`: exec(namespace,pod,container,command,stdout,stderr,stdin,tty,statusCallback) tra WebSocket/Promise)
- `packages/client/src/daemon-client.ts` (pattern clusterLogsSubscribe da lam)

## A. kube-client.ts — them
- `async execInPod(namespace, pod, container: string|undefined, command: string[], onData: (text:string)=>void): Promise<{ write:(data:string)=>void, close:()=>void }>`
  - dung `new Exec(this.kc!)`. stdout/stderr = PassThrough -> onData(d.toString()). stdin = PassThrough (write vao khi client gui). tty=true.
  - `command` mac dinh ["/bin/sh"] neu rong. Tra { write(data){ stdinStream.write(data) }, close(){ ws?.close(); destroy streams } }.

## B. rpc-schemas.ts — messages
- `cluster/exec/start` (req {requestId,id,execId,namespace,pod,container?,command?:string[]}) -> `cluster/exec/start/response` {requestId,execId,error}
- `cluster/exec/stdin` (req {requestId?,execId,data:string}) — client->server (khong can response, hoac response rong)
- `cluster/exec/data` (PUSH) {execId, data:string}
- `cluster/exec/close` (req {requestId,execId}) -> response {requestId,ok}
Dang ky union (start+stdin+close vao Inbound; start/response + data + close/response vao Outbound). Regen validators.

## C. cluster-session.ts
- Field `private execSessions = new Map<string, { write:(d:string)=>void, close:()=>void }>();`
- handleExecStart: client.execInPod(..., data => host.emit({type:"cluster/exec/data", payload:{execId,data}})) -> luu handle vao map; emit start/response.
- handleExecStdin: `this.execSessions.get(execId)?.write(data)`.
- handleExecClose: goi close(), xoa map, emit response.
- Teardown: dong het exec trong map (them vao noi teardown da co cua logSubscriptions).
- THEM 3 case (exec/start, exec/stdin, exec/close) vao dispatchClusterMessage trong session.ts (KIEM co case).

## D. daemon-client.ts
- `clusterExecStart({id,namespace,pod,container?,command?}, onData): Promise<{execId, write:(d:string)=>void, close:()=>Promise<void>}>` — sinh execId, dang ky push listener "cluster/exec/data" loc theo execId -> onData; gui start; tra { execId, write(d){ send cluster/exec/stdin }, close(){ send cluster/exec/close } }.

## LENH TU CHAY:
1. `npm run generate:validators --workspace=@jagentdesk/protocol` -> ok
2. `npm run typecheck --workspace=@jagentdesk/protocol && cd packages/server && npx tsgo -p tsconfig.server.typecheck.json --noEmit && cd .. && npm run typecheck --workspace=@jagentdesk/client` -> 0
3. `npx oxlint packages/server/src/server/cluster/kube-client.ts packages/protocol/src/cluster packages/server/src/server/session/cluster/cluster-session.ts packages/server/src/server/session.ts packages/client/src/daemon-client.ts` -> 0 error
4. `grep -cE 'case "cluster/exec/(start|stdin|close)"' packages/server/src/server/session.ts` -> 3
Bao cao output.
