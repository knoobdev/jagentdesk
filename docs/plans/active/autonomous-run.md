# Plan — Autonomous mode (autorun) · spec §20 · ADR-0017 · S-18

**Đã pivot toàn bộ (16/09/2026):** bỏ mô hình "run rời rạc + form objective/budget/ledger + màn
riêng". Autorun giờ là **một TOGGLE trong chat của agent** lái CHÍNH agent đang chat (giữ session +
tab browser). Không nhập gì — mục tiêu là câu người dùng đã nhắn. Reproduce câu chuyện Grok-outreach:
browser agent tự làm liên tục hàng giờ, xử lý reply mới, tới khi xong/tắt. **KHÔNG cron/schedule.**

## Cơ chế (engine)

- `AutorunService.drive(agentId)` (`packages/server/src/server/autorun/service.ts`):
  `while running: if hasInFlightRun(agentId) → chờ (nhường lượt người dùng); else runAgent(agentId,
tin_nối_lượt)`. Cùng agent nối lượt back-to-back (ms), giữ ngữ cảnh + browser.
- **Chống lặp = phần lõi:** tin nối lượt bảo agent "nhìn trạng thái thật hiện tại, làm cái MỚI, đừng
  lặp" + **sổ `doneItems` ngầm** (trên đĩa `$HOME/autoruns/{agentId}.json`, nhét lại mỗi lượt → sống
  qua compaction). Agent kết lượt bằng `AUTORUN_RESULT {done, nothing_new, note, done_items:[...]}`.
- Dừng: done / nothing-new(×3) / no-progress(×5) / error(×3) / chốt an toàn ẩn (500 lượt, 12h, $50).
  Không phơi budget ra UI.

## Protocol (agent-keyed, tối giản)

- `AutorunStateSchema {agentId, status:running|stopped, iteration, doneItems[], lastNote, spendUsd,
startedAt_ms, lastActivityAt_ms, stopReason, stopDetail}`.
- RPC `autorun.start/stop/get {agentId}` + `autorun.list` + event `autorun.stream {state}`.
- Client: `autorunStart/Stop(agentId)`, `autorunGet(agentId)→state|null`, `autorunList`,
  `subscribeAutorunStream((state)=>…)`.
- **Đã bỏ:** create/pause/resume/update/steer, objective/budget/config/ledger — đừng thêm lại.

## UI

- Toggle `packages/app/src/composer/agent-controls/autonomous-control.tsx` (icon ∞, sáng khi on),
  render trong `composer/index.tsx` renderLeftContent cạnh SkillsControl. Gate `useHostFeature
(autorun)`. Live qua `autorun.stream`. **Đã xoá** màn `autorun-screen.tsx` + route + nav rail.
- Feature bật/tắt: `daemon.autorun.enabled` (default OFF, restart-to-apply) → `features.autorun` +
  `features.autorunApproval`. Settings card `settings/autorun-card.tsx`.

## Trạng thái

- Backend + client + UI rebuild theo model mới; 4 package build sạch; app tsc sạch; **10/10** unit
  test `autorun/service.test.ts` (drive, done, feed-back sổ đã-làm, dedup, nothing-new, no-progress,
  error, user-stop, busy-wait, durable, onStopped).
- Đang rebuild desktop (daemon-side) + EAS iOS dev-simulator để test thật.
- **CHƯA:** smoke-test với agent thật (sẽ tốn token); **spec §20 doc vẫn mô tả model CŨ (objective/
  budget/ledger) — cần viết lại**; chưa commit / chưa bump version.
- Pre-existing fail không liên quan: `websocket-server.notifications.test.ts` 6/6 (positional ctor).
