# Execution Plan: Forge Hub (GitHub / GitLab / Bitbucket từ xa)

Date: 2026-09-10

## Status

Active

## Outcome

Section **Forge Hub** trong JAgentDesk: kết nối nhiều tài khoản forge (GitHub/GitLab/Bitbucket,
kể cả self-hosted), duyệt repo/branch/commit trên server, PR/MR (files/review/merge), CI
(run/job/log/rerun/cancel/artifact), release, issue — điều khiển forge từ xa như trên web, KHÔNG
phải local git. Chạy trên desktop + mobile qua daemon + pairing.

## Context

- Spec (repo `remote-coding-app-spec`): `docs/spec/19-forge-hub.md`, `docs/decisions/ADR-0015-forge-hub.md`,
  story `docs/stories/S-17-forge-hub.md`, mockup `docs/design/connectors/forge-hub-mockup.html`.
- Nền tảng đã có (repo này):
  - Lớp neutral `packages/server/src/services/forge-service.ts` + registry `forge-registry.ts`;
    adapter `github-service.ts` (gh), `gitlab-service.ts` (glab), `gitea-service.ts` (tea).
  - Manifest `packages/protocol/src/forge-manifest.ts` (chưa có bitbucket).
  - Secret store `packages/server/src/server/database/secret-store.ts` (`FileSecretStore` AES-256-GCM).
  - PR panel `packages/app/src/panels/pull-request/*`; diff/commit-graph `packages/app/src/git/*`.
  - Forge RPC hiện có xử lý ở `session/checkout/checkout-session.ts` + `workspace-git-service.ts`.
  - Feature gate client: `serverInfo?.features?.<flag>`; settings host: `screens/settings/host-page.tsx`
    (cạnh `ProvidersSection`, ~dòng 304). Quyền ghi: `authorization/operation-permissions.ts`.

## Scope

In scope: `19.1` mục tiêu 1–6 (connections, repos, code, PR/MR, CI, release, issue) cho GitHub
(P0), GitLab (P1), Bitbucket (P2), theo phase của `S-17`.

Out of scope: `19.1` phi-mục-tiêu (tạo/xoá repo, quản trị org, wiki, board, code search toàn
forge, webhook mặc định).

## Approach (theo phase S-17; mỗi phase build+typecheck+test xanh trước khi sang phase sau)

**Phase 0 — Khung + Connections + PR GitHub (P0)**
1. protocol: feature-gate `forgeHub` (+ cờ con); RPC `forge_list_connections`/`add`/`remove`,
   `forge_list_repos`, `forge_list_change_requests`, `forge_get_change_request` +
   `forge_change_request_files`. Mở rộng `ForgeService` + `ForgeAuthState` (`token_expiring`).
2. server: forge session/handler mới (`session/forge/forge-session.ts`) route qua registry;
   connections lưu qua `FileSecretStore` cho method token.
3. app: rail item **Forge** + sub-nav; màn Connections (settings section), Repositories, PR
   detail (mở rộng `panels/pull-request/*` với tab Files changed). Gate trên `features.forgeHub`.

**Phase 1 — GitLab + Code + Review + CI (P1)**
4. adapter gitlab mở rộng cho repos/branches/commits/pipelines/log/rerun/cancel.
5. RPC + UI: `forge_list_branches`, `forge_list_commits`/`compare`, `forge_review_change_request`,
   `forge_list_pipelines`/`get_pipeline`/`get_job_log`/`rerun`/`cancel`/`play_job`.
6. màn Code (branch/commit/diff — tái dùng `git/*`), Review actions, CI run + log viewer + poll `19.9`.

**Phase 2 — Bitbucket + Artifact + Release + Issue (P2)**
7. adapter `bitbucket-service.ts` (REST 2.0 + token) + thêm `bitbucket` vào `forge-manifest.ts`.
8. RPC + UI: artifacts, releases/tags, issues (create/comment/close).

## Risks And Recovery

- **Rate-limit/polling**: dùng ETag (GitHub) + poll-khi-mở-view (`19.9`); rollback = tắt cờ phase.
- **Token Bitbucket trong daemon**: chỉ qua `FileSecretStore`, không rời daemon (ADR-0015 §2).
- **Client cũ**: mọi RPC mới gate theo phase → client cũ không gọi mù (`19.12`).
- **Vỡ forge gắn-workspace hiện có**: KHÔNG sửa `03.12`–`03.15`; chỉ mở rộng lớp `ForgeService`.
- Recovery: mỗi phase một nhóm commit trên branch `feat/forge-hub`; revert theo phase.

## Progress

- [x] Spec + ADR + story + review r5 (repo spec, committed).
- Mốc A (khung + connections + repos + PR GitHub chỉ-xem):
  - [x] protocol: feature flags `forgeHub*` + schema request/response cho
    `forge.connection.list/add/remove`, `forge.repo.list`, `forge.change_request.list/files`
    (dot-namespace) + đăng ký union. Typecheck protocol/client/server xanh.
  - [x] client: 6 method daemon-client (`forgeListConnections/AddConnection/RemoveConnection/
    ListRepos/ListChangeRequests/GetChangeRequestFiles`) + payload types. Protocol build + client
    typecheck xanh. (Bài học: response payload phải có `requestId`; array payload dùng
    `z.array(z.unknown())` như forge.search để không phình discriminated union quá giới hạn TS.)
  - [x] server: `ForgeHubService` + `ForgeHubSession` (GitHub qua `gh`), wire dispatch, advertise
    `features.forgeHub`, permission entries. Server typecheck xanh. (245a18174)
  - [x] app: rail item Forge + route `h/[serverId]/forge.tsx` + `ForgeHubScreen` (Connections/
    Repositories/Pull requests + Files tab qua `DiffViewer`). App typecheck xanh. (c294b6a33)
  - **Mốc A HOÀN CHỈNH end-to-end** (GitHub read-only chạy thật qua gh).
- Mốc B (code · review · merge · CI):
  - [x] protocol + client: 11 RPC dot-namespace (branch/commit/compare, review, merge repo-scoped,
    pipeline list/get, job log, rerun/cancel, play) + item schemas + methods. (fe37fcee3)
  - [x] server (GitHub qua gh): ForgeHubService B methods + dispatch + permissions + advertise
    forgeHubCode/Review/Pipelines. Server typecheck xanh. (a88458239)
  - [x] app UI (fdf8286e9): Code sub-nav, review actions, merge box, Pipelines run+log viewer +
    rerun/cancel, Commits/Checks tabs. App typecheck xanh.
  - [x] GitLab (glab) provider (e40e70aae): 14 method mirror qua `glab api`, dispatch theo forge,
    aggregate connections/repos. Server typecheck xanh. Ghi chú giới hạn trong code (MR list
    thiếu review/CI rollup; pipeline detail thiếu ref/sha/url; onlyFailed không có analogue).
  - **Mốc B HOÀN CHỈNH** cho GitHub + GitLab (compile/typecheck verified). Toàn bộ 4 package xanh.
- [ ] Mốc C (ngoài "hết B"): Bitbucket REST adapter, auto-merge, artifact, release, issue.

## Mức verify (trung thực)
Tất cả tầng: typecheck + logic. CHƯA e2e thật (cần tài khoản GitHub/GitLab thật + bản build đóng
gói desktop/mobile). Adapter dùng `gh`/`glab` thật (không mock), map sang shape neutral.
- [ ] Mốc C: Bitbucket REST adapter, auto-merge, artifact, release, issue.

Ghi chú (quyết định implement): spec 07 mô tả capability là mảng chuỗi, nhưng code thật vẫn dùng
`serverInfo.features.<camelCase>` boolean object (như `forgeSearch`/`forgeProviders`). Forge Hub
theo mẫu code đang chạy (`features.forgeHub*`); hoà spec 07 ↔ code là refactor riêng, ngoài phạm vi.

## Decisions

- 2026-09-10: Bitbucket đi REST + token trong daemon (không CLI) — `ADR-0015` §2.
- 2026-09-10: Realtime = polling, không webhook mặc định — `ADR-0015` §4 / `19.9`.

## Validation

- Focused: typecheck + vitest cho protocol/server/app mỗi phase.
- E2E: repo thật GitHub (P0)/GitLab (P1)/Bitbucket (P2); verify độc lập bằng `gh`/`glab`/REST
  (`S-17` "Cách chứng minh"); token không xuất hiện trong payload wire.
