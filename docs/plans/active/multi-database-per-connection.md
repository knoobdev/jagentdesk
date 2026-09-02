# Multi-database per connection — object tree + cross-db compare

## Chốt hướng (user xác nhận)

- Cây expand **nhiều database cùng lúc** trong 1 connection (KHÔNG phải dropdown-select-switch).
- So sánh chéo **cả cấu trúc + dữ liệu** giữa 2 db name.
- Làm trọn gói rồi test 1 lần (desktop + mobile).

## Kiến trúc: composite-id (ít xâm lấn nhất)

Mỗi database mở ra trong cây = **một DbClient con** đăng ký dưới id ghép `parentId::dbName`. Nhờ đó TOÀN BỘ component sẵn có (data editor, structure, sql console, ER, chat, schema-diff) tái dùng nguyên vẹn vì chúng chỉ nhận `databaseId` — không cần luồn tham số `database` đi khắp nơi.

- Bỏ model reconnect-1-active (activeDatabase/useDatabase) tao vừa làm sai.
- Daemon giữ nhiều client/1 connection; con là runtime-only, không persist.

## Các bước

### Daemon

- Registry: `openDatabase(parentId, dbName)` tạo client con (config cha + secret + database=dbName), đăng ký dưới `parentId::dbName`, trả DatabaseInfo{id: composite}. Bỏ activeDatabase/useDatabase. disconnect(parent) đóng luôn con. getClient(compositeId) hoạt động sẵn.
- Giữ `database/databases` (list tên db cho cây).

### Protocol / session / client

- Thay `database/use-database` → `database/open-database` {id, database} → child DatabaseInfo.
- daemon-client: `databaseOpenDatabase({id, database})`.

### App

- `sidebar-database-nav`: viết lại thành CÂY. Engine nhiều-db (postgres/mssql): node database (từ listDatabases) → expand gọi openDatabase → dùng child id load schema/table. Nhiều db expand song song. Engine 1-db: giữ phẳng.
- nav store: `selectedObject` thêm `databaseId` (child/parent) + trạng thái expand cây.
- browse screen: content pane dùng `selectedObject.databaseId ?? routeId`.
- Compare: tổng quát `database-schema-diff` thành chọn (dbId, schema) trái/phải khác db + thêm **data diff** (so hàng theo PK).

### Mobile

- Sửa lỗi object-nav overlay biến mất chỉ còn chat FAB; có đường quay lại nav rõ ràng.

## Validation

- Registry: openDatabase con + nhiều client song song (Postgres shop_a + shop_b cùng mở).
- Desktop: cây 2 db expand cùng lúc + compare cấu trúc + data giữa 2 db. Screenshot.
- Mobile: cây + quay lại nav OK. Screenshot.
- sqlite: giữ phẳng (regression).
