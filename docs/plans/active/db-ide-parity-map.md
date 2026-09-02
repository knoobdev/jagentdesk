# DB IDE parity — bản đồ ĐẦY ĐỦ (từ tài liệu chính thức JetBrains) + gap

Nguồn: tài liệu Database Explorer / Data Editor chính thức (Database Explorer, Data Editor) + features overview.
✅ JAgentDesk đã có · ⚠️ một phần · ❌ chưa có. Mục tiêu: parity đúng thứ dùng thật.

## A. Data Sources / Connections / Drivers

- ⚠️ Nhiều engine (reference IDE 50+, JAD 7). ✅ add/connect/disconnect(deactivate)/delete.
- ❌ Data Sources & Drivers dialog (properties), Test Connection.
- ❌ SSH / SSL tunnel. ❌ Read-only mode per-connection.
- ❌ Introspection level; Force Refresh (xoá cache load lại); Forget schema cache.
- ❌ Per-source **color**, **folders**, **bookmarks**, **Duplicate data source**.

## B. Database Explorer (cây) + toolbar

- ⚠️ Cây: connection → database → schema → **tables** (JAD). reference IDE còn: **Views, Routines
  (functions/procedures), Sequences, Columns, Keys(PK/FK), Indexes, Triggers, Constraints** làm node con.
- ❌ **Refresh (Ctrl+F5)** / Force Refresh / Forget cache trong UI.
- ❌ Expand all / Collapse all. ❌ **Go to DDL (Ctrl+B)**. ❌ Jump to Query Console.
- ✅ Compare Schema Structure (đã build → **user yêu cầu GỠ**).
- ❌ View options: **filter theo loại, group by (schema/kind/prefix), sort, ẩn empty/generated,
  indent guides**. ❌ **Speed search** (gõ để tìm trong cây). ❌ Scroll from/to editor.
- ❌ Manage shown schemas.

## C. Context menu (chuột phải) — GẦN NHƯ CHƯA CÓ (đây là lỗ hổng lớn nhất)

Trên table/view:

- ❌ New ▸ (role/db/schema/table/column/index/key/constraint)
- ❌ **Rename (Shift+F6)**, **Drop**, **Duplicate**, **Truncate**
- ❌ Modify Comment, Modify Grants, Enable/Disable triggers/constraints
- ❌ **Copy / Copy Reference (schema.table đầy đủ)**, Quick Documentation
- ⚠️ Edit Data (F4/double-click) — JAD tap mở được
- ❌ **Export Data to File**, **Import Data from File(s) (CSV/TSV)**, **Copy Table to** (schema/source khác)
- ❌ Dump (mysqldump/pg_dump) / Restore
- ❌ **SQL Generator (Ctrl+Alt+G)**, **Generate DDL to clipboard/console**, Request & copy original DDL
- ❌ **Full-text Search** (tìm dữ liệu toàn DB), ✅ Show Diagram (ER có)

## D. Data Editor / Grid — JAD mạnh phần lõi, thiếu nhiều tính năng dùng thật

- ⚠️ View modes: reference IDE có **Table / Tree / Text / Transpose**; JAD chỉ Table.
- ❌ **Record view** (panel sửa 1 hàng). ⚠️ Pagination (JAD prev/next; reference IDE first/prev/next/last + page size).
- ❌ **Go to Row**. ❌ **Foreign key navigation (Related Rows)** — nhảy tới hàng tham chiếu.
- ❌ **Sort click-header** (server/client). ❌ **Filter (WHERE bar + per-column local filter)**. ❌ Full-text search trong grid.
- ✅ Inline edit. ❌ auto-complete khi sửa ô. ❌ **Value editor ô lớn (text/JSON/XML/image/BLOB)**.
- ⚠️ Add/Delete rows ✅; ❌ **Clone row**, set NULL/DEFAULT, gen UUID, load file vào ô, save LOB ra đĩa.
- ✅ Submit/Revert, Preview DML. ⚠️ Tx Auto/Manual ✅; ❌ isolation level.
- ❌ **Aggregate view** (chọn nhiều ô → sum/count/avg ở status bar). ❌ Charts. ❌ Geo viewer.
- ⚠️ Export (JAD có); ❌ **Data extractors** (CSV/TSV/JSON/SQL/custom output). ❌ Copy to database (cross table/schema).
- ❌ **Column reorder/hide/show**. ❌ Binary display format. ❌ Xem/sửa câu query sinh ra grid.

## E. SQL Editor / Console

- ✅ Query, EXPLAIN (plan), History.
- ❌ **Schema-aware auto-complete** (bảng/cột). ❌ **Inspections + error highlight + quick-fix**. ❌ SQL refactor (đổi tên lan truyền).
- ❌ Run **selection / current statement / script** (JAD chạy cả query). ❌ Nhiều result tab. ❌ Compare result sets.
- ❌ Format SQL, live templates, parameters. ❌ Local history / Git cho file SQL.

## F. Import / Export

- ⚠️ Export kết quả grid (JAD có). ❌ **Import CSV/TSV vào bảng**. ❌ Export bảng/DB ra file (CSV/JSON/SQL/Excel). ❌ dump/restore.

## G. Navigation / Search

- ❌ **Full-text search** dữ liệu toàn DB. ❌ Go to object (search everywhere). ❌ Speed search cây. ❌ Scroll from/to editor.

## H. Diagrams

- ✅ ER/UML diagram (canvas).

## I. AI (reference IDE mới có)

- ✅ **JAD hơn ở đây**: chat schema-grounded, NL→SQL, sql_query/sql_exec, multi-step agent.

## J. VCS / Files

- ❌ Local history, Git cho SQL files, quản lý file SQL/CSV/JSON (JAD cố ý không có editor).

---

## Tổng kết gap (cái thiếu nhiều nhất, theo mức độ "dùng hằng ngày")

1. **Context menu chuột phải** (cả cây) — gần như trắng. Refresh/Rename/Drop/Truncate/Copy/
   Copy reference/Import/Export/Generate DDL/Full-text search.
2. **Refresh** thật (nút + F5 + tự sau DDL) — structure view hiện KHÔNG cập nhật khi thêm cột.
3. **Cây thiếu node**: Views/Routines/Sequences/Columns/Keys/Indexes/Triggers.
4. **Grid**: sort, filter (WHERE), value editor ô lớn, FK-navigation, aggregate, view modes, clone row.
5. **SQL console**: auto-complete + inspections (đây là "linh hồn" reference IDE).
6. **Import CSV vào bảng** + data extractors.
7. **Full-text search** dữ liệu.
8. **Kiến trúc cây**: bỏ list "Overview/SQL/Compare/ER", cây là trung tâm, action qua menu/toolbar/tab.

## E-bis. SQL editor / coding assistance (bổ sung từ docs)

- ❌ Completion schema-aware (bảng/cột/keyword/alias). ❌ Quick Documentation (Ctrl+Q) xem DDL.
- ❌ Structure view (Alt+7) liệt kê statement. ❌ Run scope: all / single statement / selection / script.
- ❌ Parameters (positional + named, regex pattern). ❌ Execute stored function/proc.
- ❌ Resolve mode Playground/Script. ❌ Tabbed results (Services). ❌ Execute-to-File. ❌ Cancel query.
- ✅ Query history (JAD có).

## L. Full object model (reference IDE quản lý các loại object)

tables, columns, indexes, PK, FK, unique/check constraints, views, **materialized views**,
functions, **stored procedures**, triggers, sequences, schemas, databases, **users/roles + grants**,
collations, custom types/domains, extensions, synonyms, packages (Oracle), foreign tables,
collections (Mongo). → JAD hiện chỉ introspect tables/views/columns/PK/FK.
reference IDE có **dialog Modify Table / New … trực quan** cho tạo/sửa; JAD ❌.

## UI SPEC — chuẩn hiện đại (JetBrains New UI), KHÔNG cổ đại/trẻ con

Layout kiểu IDE, 3 khu:

- **Trái**: Database Explorer = **cây dày đặc** (row cao ~22–24px, icon 16px monochrome, indent guide
  mảnh, chevron nhỏ). Toolbar mảnh trên cây: Refresh / New / Collapse-all / filter / speed-search.
- **Giữa**: khu **tab** — mỗi table mở data editor 1 tab; SQL console 1 tab; ER 1 tab. Có tab bar + breadcrumb.
- **Dưới**: **status bar** (rows, elapsed, tx mode, connection, encoding).
- Data grid: **monospace**, header dày, zebra tối, cột resize/sort, cell chọn được, cột số canh phải.

Nguyên tắc:

- **Dark-first**, tương phản thấp, nền phẳng; KHÔNG chip bo tròn, KHÔNG màu xanh/đỏ/vàng trang trí.
- Màu chỉ dùng: trạng thái kết nối (1 chấm nhỏ), lỗi (đỏ mờ khi thật sự lỗi). Còn lại xám/foreground.
- Icon nhỏ tinh (lucide 14–16). Font UI hệ thống, font data monospace.
- Hành động qua **toolbar + chuột phải + double-click + phím tắt**, KHÔNG phải list item "Overview/SQL/Compare/ER".
- Mật độ cao (như IDE), không padding phồng, không nút to.

## Ràng buộc

- GỠ Compare + màu xanh/đỏ/vàng.
- Không màu trang trí, không chip trẻ con; dày đặc kiểu IDE; dark-first.
- Test trên app desktop đóng gói THẬT.
