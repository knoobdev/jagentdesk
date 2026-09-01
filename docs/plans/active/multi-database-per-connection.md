# Multi-database per connection (DataGrip-style server → databases → schemas)

## Vấn đề

Hiện tại 1 connection = 1 database (form add-connection có field `database` đơn; adapter connect vào đúng db đó). Không có tầng "databases của 1 server" như DataGrip (server → databases → schemas → tables). Người dùng muốn: trong 1 connection, xem/switch tất cả db names trên cùng server. Cho cả desktop lẫn mobile (app universal → 1 implementation).

## Thiết kế

Giữ nguyên model connection (không đổi persistence). Thêm khả năng liệt kê các database trên server và switch database đang active trong cùng connection bằng cách reconnect client tới db khác (cùng host/creds, khác dbname).

- Chỉ engine hai tầng (schema nằm trong database) bật tính năng: `postgres`, `mssql`. `mysql` (schema == database) và `sqlite`/`oracle`/`mongo`/`clickhouse` → không có → UI ẩn selector (giữ UX cũ).
- Switch = registry đóng client hiện tại, tạo client mới với `database` mới. Postgres không `USE` được trên cùng connection → phải reconnect. `activeDatabase` là runtime, KHÔNG persist (mở lại về db mặc định của connection).
- Chat agent dùng `getClient(id)` → sau switch tự trỏ db mới (đúng ngữ nghĩa "operating this connection").

## Trạng thái

Đã làm xong (commit `feat(db): multi-database per connection`):

- Daemon: `DbClient.listDatabases?()` + adapter postgres/mssql; registry `listDatabases(id)` + `useDatabase(id,name)` reconnect; `DatabaseInfo.currentDatabase`; DSN rewrite.
- Protocol: RPC `database/databases` + `database/use-database`.
- Session/client: handler + dispatch + `databaseDatabases`/`databaseUseDatabase`.
- App: selector `DATABASE` trên `SCHEMA` trong `sidebar-database-nav` (shared desktop + mobile), chỉ hiện khi `databases.length > 1`.

## Validation

- [x] Registry vs Postgres thật (shop_a → shop_b): listDatabases trả 3 db + current; useDatabase reconnect, introspection theo (orders → products).
- [ ] Desktop: DATABASE selector hiện + switch đổi tree. Screenshot.
- [ ] Mobile (bundle-swap): selector hiện trong compact nav + switch. Screenshot.
- [ ] sqlite: selector KHÔNG hiện (regression).
- [ ] Committed integration test (JAD_DB_E2E) cho listDatabases + useDatabase.
